/**
 * §11 Phase 10: the two permission modes, and the fork between them.
 *
 * ADR-0011 makes three decisions and this suite is organised as three groups of
 * the same shape: produce a permission request, then assert what each mode does
 * about it. The request itself is identical in every test — `ocmock`'s `blocked`
 * scenario raises one without consulting the session's ruleset, which is the
 * only way to reach the auto-grant path at all. A live OpenCode 1.18.25 does
 * consult it, grants `external_directory` and `*` up front, and therefore never
 * raises the request; `docs/phase0-facts.md` §5 records that measurement and
 * what it means for the code exercised here.
 *
 * The fallthrough tests wrap the backend rather than racing the manager for the
 * mock's outstanding request. What is under test is the *contract* —
 * "`respond()` said no, so escalate" — and a wrapper states that directly
 * instead of arranging a timing accident that produces it.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { OCMock } from "../ocmock/server.js";
import { ServeBackend } from "../../src/opencode/index.js";
import { WorkerManager } from "../../src/manager/index.js";
import { Store } from "../../src/store/index.js";
import { makeGoldenRepo } from "../fixtures/golden.js";
import { sleep } from "../helpers.js";
import type { OpenCodeBackend } from "../../src/opencode/index.js";
import type { WorkerSpec } from "../../src/manager/types.js";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await Promise.resolve(fn()).catch(() => {});
});

const DONE = {
  status: "completed",
  summary: "Created hello.txt.",
  changes: [{ file: "hello.txt", action: "added" }],
  risks: [],
  questions: [],
  followUps: [],
};

/** A worker asking Claude something substantive, rather than asking for a permission. */
const ASKING = {
  status: "blocked",
  summary: "I need a decision",
  changes: [] as unknown[],
  risks: [] as string[],
  questions: ["Should the cache be per-request or per-process?"],
  followUps: [] as string[],
};

interface Harness {
  mock: OCMock;
  manager: WorkerManager;
  store: Store;
  repo: string;
}

async function harness(
  mockOpts: Parameters<typeof OCMock.start>[0] = {},
  managerOpts: Partial<ConstructorParameters<typeof WorkerManager>[0]> = {},
  /** Wraps the backend, for the tests about what happens when `respond()` fails. */
  wrap: (b: OpenCodeBackend) => OpenCodeBackend = (b) => b,
): Promise<Harness> {
  const repo = makeGoldenRepo("p10");
  cleanup.push(repo.cleanup);
  const mock = await OCMock.start({ heartbeatMs: 20, report: DONE, writeFiles: true, ...mockOpts });
  cleanup.push(() => mock.stop());
  const backend = new ServeBackend({ baseUrl: mock.baseUrl });
  cleanup.push(() => backend.dispose());
  await backend.start();
  const store = new Store(join(repo.path, "orchestrator.db"));
  cleanup.push(() => store.close());
  const manager = new WorkerManager({
    backend: wrap(backend),
    store,
    repoRoot: repo.path,
    defaultWorkspace: "isolated",
    tickMs: 10,
    budgetPollMs: 20,
    abortGraceMs: 300,
    retrySettleMs: 20,
    verifyTests: false,
    ...managerOpts,
  });
  cleanup.push(() => manager.dispose());
  return { mock, manager, store, repo: repo.path };
}

const spec = (over: Partial<WorkerSpec> = {}): WorkerSpec => ({
  runID: "run-10",
  task: "create hello.txt",
  mode: "implement",
  ...over,
});

async function waitFor(pred: () => boolean, ms = 5_000, what = "a condition"): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

const kindsOf = (h: Harness, id: string): string[] => h.store.listEvents(id, { limit: 200 }).map((e) => e.kind);

/** The session-creation body, which is where a mode's permissions actually land. */
const sessionPermissions = (h: Harness): unknown =>
  (h.mock.requests.find((r) => r.method === "POST" && r.path === "/session")!.body as Record<string, unknown>)["permission"];

// ---------------------------------------------------------------------------
// Decision 1 — what each mode grants at the session
// ---------------------------------------------------------------------------

const FULL_SET = [
  { permission: "edit", pattern: "**", action: "allow" },
  { permission: "bash", pattern: "**", action: "allow" },
  { permission: "webfetch", pattern: "**", action: "allow" },
  { permission: "external_directory", pattern: "**", action: "allow" },
  { permission: "doom_loop", pattern: "**", action: "allow" },
  // The load-bearing entry: a permission this adapter has never heard of gets
  // `allow` rather than the provider's default, and that default in a headless
  // run is `ask`, which is a worker waiting on nobody until a watchdog kills it.
  { permission: "*", pattern: "**", action: "allow" },
];

/** The pre-Phase-10 set. `external_directory` is absent, which is the whole point. */
const JAILED_SET = [
  { permission: "edit", pattern: "**", action: "allow" },
  { permission: "bash", pattern: "**", action: "allow" },
  { permission: "doom_loop", pattern: "**", action: "allow" },
];

/** Spawn one implement worker, let it settle, and report what its session was granted. */
async function grantedFor(managerOpts: Partial<ConstructorParameters<typeof WorkerManager>[0]>): Promise<unknown> {
  const h = await harness({}, managerOpts);
  const w = await h.manager.spawn(spec());
  await h.manager.wait(w.workerID, 5_000);
  return sessionPermissions(h);
}

describe("what a mode grants (ADR-0011 decision 1)", () => {
  test("`full` grants the wildcard, so an unknown permission cannot deadlock a headless run", async () => {
    expect(await grantedFor({ permissionMode: "full" })).toEqual(FULL_SET);
  });

  test("`jailed` restores the pre-Phase-10 set, `external_directory` left to ask", async () => {
    // A `jailed` set that quietly included `external_directory` would be `full`
    // under another name, so the absence is asserted rather than assumed.
    expect(await grantedFor({ permissionMode: "jailed" })).toEqual(JAILED_SET);
  });

  test("the default is `full` — a caller that says nothing gets the mode the product runs in", async () => {
    // `DEFAULT_PERMISSION_MODE` is a product decision, and a regression in it
    // would be silent everywhere else: every existing suite would keep passing
    // while every worker quietly started stopping at walls again.
    expect(await grantedFor({})).toEqual(FULL_SET);
  });
});

// ---------------------------------------------------------------------------
// Decision 2 — a request that arrives anyway
// ---------------------------------------------------------------------------

describe("a permission request that arrives anyway (ADR-0011 decision 2)", () => {
  test("`full` answers it in band and the worker never blocks", async () => {
    const h = await harness({ scenario: "blocked" }, { permissionMode: "full" });
    const w = await h.manager.spawn(spec());
    const done = await h.manager.wait(w.workerID, 8_000);

    // The property the whole mode exists for: it finished, rather than stopping.
    expect(done.state).toBe("completed");
    expect(h.mock.permissionRepliesOf(done.sessionID!)).toEqual(["once"]);

    const kinds = kindsOf(h, w.workerID);
    expect(kinds).toContain("permission_auto_granted");
    // Not an escalation, and not recorded as one. Claude was never asked
    // anything, so a trail row saying it was is a lie the dashboard would draw
    // as a blocked worker.
    expect(kinds).not.toContain("escalation");
    expect(kinds).not.toContain("state:blocked");
    // The turn was never aborted and never re-prompted — one prompt, start to
    // finish, which is the difference between a partial turn and a whole one.
    expect(kinds).not.toContain("abort_requested");
    expect(h.mock.requests.filter((q) => q.path.includes("/prompt"))).toHaveLength(1);
  });

  test("the auto-grant records what it granted, and that it landed", async () => {
    const h = await harness({ scenario: "blocked" }, { permissionMode: "full" });
    const w = await h.manager.spawn(spec());
    await h.manager.wait(w.workerID, 8_000);

    const row = h.store.listEvents(w.workerID, { limit: 200 }).find((e) => e.kind === "permission_auto_granted")!;
    expect(row).toBeDefined();
    expect(row.detail).toMatchObject({ permission: "bash", accepted: true });
  });

  test("`jailed` still escalates the same request to Claude", async () => {
    const h = await harness({ scenario: "blocked" }, { permissionMode: "jailed" });
    const w = await h.manager.spawn(spec());
    await waitFor(() => h.manager.get(w.workerID)!.state === "blocked", 5_000, "blocked");

    const blocked = h.manager.get(w.workerID)!;
    expect(blocked.reason).toBe("permission_required");
    expect(blocked.questions[0]).toContain("bash");

    const kinds = kindsOf(h, w.workerID);
    expect(kinds).toContain("escalation");
    expect(kinds).not.toContain("permission_auto_granted");
  });

  test("a substantive question is not a permission, and `full` does not answer it", async () => {
    // ADR-0011 decision 2's exception. No permission setting makes "should I use
    // approach A or B?" answerable by a rule, so this worker stops in `full`
    // exactly as it would in `jailed` — and stopping is correct.
    const h = await harness({ report: ASKING }, { permissionMode: "full" });
    const w = await h.manager.spawn(spec());
    await waitFor(() => h.manager.get(w.workerID)!.state === "blocked", 5_000, "blocked");

    expect(h.manager.get(w.workerID)!.questions[0]).toContain("per-request or per-process");
    expect(kindsOf(h, w.workerID)).not.toContain("permission_auto_granted");
  });
});

// ---------------------------------------------------------------------------
// The fallthrough, which is the part that keeps a worker from wedging
// ---------------------------------------------------------------------------

describe("when the in-band grant does not land", () => {
  /** A backend whose `respond()` reports the request is not there any more. */
  const staleRespond = (b: OpenCodeBackend): OpenCodeBackend =>
    new Proxy(b, { get: (t, p, r) => (p === "respond" ? async () => false : Reflect.get(t, p, r)) });

  /** A backend whose `respond()` fails outright, rather than answering "no". */
  const brokenRespond = (b: OpenCodeBackend): OpenCodeBackend =>
    new Proxy(b, {
      get: (t, p, r) =>
        p === "respond"
          ? async () => {
              throw new Error("adapter cannot answer");
            }
          : Reflect.get(t, p, r),
    });

  test("a stale request escalates rather than leaving the worker waiting on a grant that went nowhere", async () => {
    // `respond()` answering `false` is the ordinary outcome when the turn that
    // raised the request has already moved on. The worker must end up somewhere
    // a human can act on, and `blocked` is that place — the pre-Phase-10 route,
    // still there, used only when the new one is unavailable.
    const h = await harness({ scenario: "blocked" }, { permissionMode: "full" }, staleRespond);
    const w = await h.manager.spawn(spec());
    await waitFor(() => h.manager.get(w.workerID)!.state === "blocked", 6_000, "blocked");

    const kinds = kindsOf(h, w.workerID);
    // Both rows: the attempt is recorded with `accepted: false`, and then the
    // escalation it fell through to. Recording only the second would lose the
    // fact that the fast path was tried.
    expect(kinds).toContain("permission_auto_granted");
    expect(kinds).toContain("escalation");
    const row = h.store.listEvents(w.workerID, { limit: 200 }).find((e) => e.kind === "permission_auto_granted")!;
    expect(row.detail).toMatchObject({ accepted: false });
    // Deliberately no abort before the fallthrough: `enterBlocked` documents at
    // length why the abort's own terminal events get read as an abort nobody
    // asked for.
    expect(kinds).not.toContain("abort_requested");
  });

  test("an adapter that cannot answer at all is a worker that escalates, not one that dies", async () => {
    const h = await harness({ scenario: "blocked" }, { permissionMode: "full" }, brokenRespond);
    const w = await h.manager.spawn(spec());
    await waitFor(() => h.manager.get(w.workerID)!.state === "blocked", 6_000, "blocked");

    const kinds = kindsOf(h, w.workerID);
    expect(kinds).toContain("permission_reply_failed");
    expect(kinds).toContain("escalation");
    expect(h.manager.get(w.workerID)!.reason).toBe("permission_required");
  });
});

// ---------------------------------------------------------------------------
// Decision 3 — DD-10 is a correctness property, not a safety setting
// ---------------------------------------------------------------------------

describe("read-only modes are not part of this (ADR-0011 decision 3)", () => {
  const READ_ONLY = [
    { permission: "edit", pattern: "**", action: "deny" },
    { permission: "bash", pattern: "**", action: "deny" },
  ];

  for (const mode of ["full", "jailed"] as const) {
    for (const workerMode of ["research", "review"] as const) {
      test(`a ${workerMode} worker is read-only in \`${mode}\`, at the session and at the prompt`, async () => {
        // Not an inconsistency. Reconciliation *depends* on this: for a worker
        // that cannot write, `claimed_not_changed` is switched off, and the
        // reverse check — a read-only worker whose diff is not empty has done
        // something it could not do — is one of the strongest signals this
        // system produces. Granting reviewers write access would delete it.
        const h = await harness(
          { report: { status: "completed", summary: "read it", changes: [] } },
          { permissionMode: mode },
        );
        const w = await h.manager.spawn(spec({ mode: workerMode, task: "where is the settings store?" }));
        await h.manager.wait(w.workerID, 5_000);

        expect(sessionPermissions(h)).toEqual(READ_ONLY);
        const prompt = h.mock.requests.find((r) => r.path.endsWith("/prompt_async"))!;
        expect((prompt.body as Record<string, unknown>)["tools"]).toMatchObject({ bash: false, edit: false });
      });
    }
  }

  test("`full` does not auto-grant on behalf of a read-only worker either", async () => {
    // The auto-grant is keyed off the mode of the request, not off the worker,
    // so this is worth pinning: a `research` worker that somehow raises a
    // permission request is a worker doing something DD-10 says it cannot, and
    // the answer is to surface it rather than to wave it through.
    const h = await harness({ scenario: "blocked" }, { permissionMode: "full" });
    const w = await h.manager.spawn(spec({ mode: "research", task: "read the store" }));
    await waitFor(
      () => ["blocked", "completed", "failed"].includes(h.manager.get(w.workerID)!.state),
      6_000,
      "the research worker to settle or stop",
    );

    expect(sessionPermissions(h)).toEqual(READ_ONLY);
  });
});
