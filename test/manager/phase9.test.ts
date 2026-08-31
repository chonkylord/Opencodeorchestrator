/**
 * §11 Phase 9's manager changes, each against the failure that produced it.
 *
 * All four came out of one real run rather than from reading the code, and the
 * suite is written the same way round: produce the state the run reached, then
 * assert on what the orchestrator does about it.
 *
 * The state that matters most is the one nothing could rescue. A worker reaches
 * `blocked`, the process holding its session dies, and a second process opens
 * the same database. The row still says `blocked` and is telling the truth about
 * what the worker was doing; the session is gone. Before this phase
 * `worker_message` reported the answer delivered, `worker_recover` refused
 * because the state was not `interrupted`, and the worker sat there until its
 * blocked deadline killed it. Producing that needs a real crash — `halt()`,
 * which writes nothing and drops the registry — so that is what
 * {@link orphanedBlockedWorker} does.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { OCMock } from "../ocmock/server.js";
import { ServeBackend } from "../../src/opencode/index.js";
import { WorkerManager } from "../../src/manager/index.js";
import { Store } from "../../src/store/index.js";
import { buildBrief } from "../../src/briefs/index.js";
import { scratchPath } from "../../src/workspace/index.js";
import { makeGoldenRepo } from "../fixtures/golden.js";
import { sleep } from "../helpers.js";
import type { WorkerSpec } from "../../src/manager/types.js";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await Promise.resolve(fn()).catch(() => {});
});

const BLOCKED = {
  status: "blocked",
  summary: "I need a decision",
  changes: [] as unknown[],
  risks: [] as string[],
  questions: ["May I write my scratch file to /tmp?"],
  followUps: [] as string[],
};

const DONE = {
  status: "completed",
  summary: "Created hello.txt.",
  changes: [{ file: "hello.txt", action: "added" }],
  risks: [],
  questions: [],
  followUps: [],
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
): Promise<Harness> {
  const repo = makeGoldenRepo("p9");
  cleanup.push(repo.cleanup);
  const mock = await OCMock.start({ heartbeatMs: 20, report: DONE, writeFiles: true, ...mockOpts });
  cleanup.push(() => mock.stop());
  const backend = new ServeBackend({ baseUrl: mock.baseUrl });
  cleanup.push(() => backend.dispose());
  await backend.start();
  const store = new Store(join(repo.path, "orchestrator.db"));
  cleanup.push(() => store.close());
  const manager = new WorkerManager({
    backend,
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
  runID: "run-9",
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

/**
 * A worker left `blocked` by a process that no longer exists.
 *
 * The mock asks a question, the manager parks the worker in `blocked`, and then
 * `halt()` drops the registry without writing anything — which is what a crash
 * looks like from the database's side. The second manager over the same file is
 * the restart, and deliberately does **not** call `recover()`: the point is a
 * row that is still `blocked` when a tool reaches for it.
 */
async function orphanedBlockedWorker(): Promise<{ h: Harness; next: WorkerManager; id: string }> {
  const h = await harness({ report: BLOCKED, dropPromptsWithinMs: 30 });
  const id = (await h.manager.spawn(spec())).workerID;
  await waitFor(() => h.manager.get(id)?.state === "blocked", 5_000, "the worker to block");
  h.manager.halt();

  const backend = new ServeBackend({ baseUrl: h.mock.baseUrl });
  cleanup.push(() => backend.dispose());
  await backend.start();
  const next = new WorkerManager({
    backend,
    store: h.store,
    repoRoot: h.repo,
    defaultWorkspace: "isolated",
    tickMs: 10,
    verifyTests: false,
  });
  cleanup.push(() => next.dispose());
  return { h, next, id };
}

describe("answerability — a write that did not land must not look like one", () => {
  test("a blocked worker this process holds is answerable", async () => {
    const h = await harness({ report: BLOCKED, dropPromptsWithinMs: 30 });
    const id = (await h.manager.spawn(spec())).workerID;
    await waitFor(() => h.manager.get(id)?.state === "blocked", 5_000, "the worker to block");
    expect(h.manager.answerability(id)).toEqual({ ok: true });
  });

  test("a worker nobody has ever heard of is `unknown`", async () => {
    const h = await harness();
    const a = h.manager.answerability("w-nope");
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.code).toBe("unknown");
  });

  test("a running worker is `not_blocked`, because nothing is waiting for an answer", async () => {
    const h = await harness({ workMs: 400 });
    const id = (await h.manager.spawn(spec())).workerID;
    await waitFor(() => h.manager.get(id)?.state === "running", 5_000, "the worker to run");
    const a = h.manager.answerability(id);
    expect(a.ok).toBe(false);
    if (!a.ok) expect(a.code).toBe("not_blocked");
  });

  test("a worker left blocked by a dead process is `orphaned`, and answering it throws rather than pretending", async () => {
    const { next, id } = await orphanedBlockedWorker();

    // The row still says blocked, which is the whole trap: it is accurate about
    // what the worker was doing and says nothing about whether it is reachable.
    expect(next.get(id)?.state).toBe("blocked");

    const a = next.answerability(id);
    expect(a.ok).toBe(false);
    if (!a.ok) {
      expect(a.code).toBe("orphaned");
      expect(a.message).toContain("previous orchestrator process");
    }
    await expect(next.answer(id, "the palette file")).rejects.toThrow(/previous orchestrator process/);
  });
});

describe("worker_recover keys off session reachability, not one state name", () => {
  test("a worker orphaned in `blocked` can be recovered, and the trail says why", async () => {
    const { h, next, id } = await orphanedBlockedWorker();

    // The refusal this replaces: "this one has settled; read worker_result",
    // said about a worker that was waiting for an answer nothing could send.
    const outcome = next.recoverWorker(id, "discard");
    expect(outcome.kind).toBe("settled");
    expect(next.get(id)?.state).toBe("cancelled");

    const kinds = h.store.listEvents(id, { limit: 200 });
    const interrupted = kinds.find((e) => e.kind === "state:interrupted");
    expect(interrupted).toBeDefined();
    expect(interrupted?.detail["reason"]).toBe("session_unreachable");
    expect(interrupted?.detail["from"]).toBe("blocked");
  });

  test("a worker this process is actually running is still refused", async () => {
    const h = await harness({ workMs: 600 });
    const id = (await h.manager.spawn(spec())).workerID;
    await waitFor(() => h.manager.get(id)?.state === "running", 5_000, "the worker to run");
    expect(() => h.manager.recoverWorker(id, "resume")).toThrow(/live in this process/);
  });

  test("a settled worker is refused, because there is nothing to reach it for", async () => {
    const h = await harness();
    const id = (await h.manager.spawn(spec())).workerID;
    await waitFor(() => h.manager.get(id)?.state === "completed", 8_000, "the worker to complete");
    expect(h.manager.isOrphaned(id)).toBe(false);
    expect(() => h.manager.recoverWorker(id, "resume")).toThrow(/read worker_result/);
  });
});

describe("structured output is a per-model fact, and it survives the process", () => {
  test("one model's refusal does not silence another, and is remembered next time", async () => {
    const h = await harness();
    expect(h.manager.supportsStructuredOutput("acme/good")).toBe(true);
    expect(h.manager.supportsStructuredOutput("acme/bad")).toBe(true);

    // What `onEvent` writes when a provider rejects the constrained request.
    h.store.putModelCapability("acme/bad", { structuredOutput: false, at: Date.now(), code: "api", message: "tool_choice required" });

    // This manager was built before the row existed, so it does not know yet —
    // the latch is per process as well as per model.
    expect(h.manager.supportsStructuredOutput("acme/bad")).toBe(true);

    const backend = new ServeBackend({ baseUrl: h.mock.baseUrl });
    cleanup.push(() => backend.dispose());
    await backend.start();
    const next = new WorkerManager({ backend, store: h.store, repoRoot: h.repo, tickMs: 10, verifyTests: false });
    cleanup.push(() => next.dispose());

    // The new process pays nothing to learn it.
    expect(next.supportsStructuredOutput("acme/bad")).toBe(false);
    expect(next.supportsStructuredOutput("acme/good")).toBe(true);
    expect(next.modelCapability("acme/bad")?.code).toBe("api");
    expect(next.modelCapability("acme/good")).toBeUndefined();
  });

  test("`structuredOutput: false` turns it off for every model at once", async () => {
    const h = await harness({}, { structuredOutput: false });
    expect(h.manager.supportsStructuredOutput("acme/anything")).toBe(false);
  });
});

describe("every implement worker gets scratch space inside its jail", () => {
  test("the directory is made, the brief names it, and nothing in it reaches the diff", async () => {
    const h = await harness();
    const id = (await h.manager.spawn(spec({ ownedPaths: ["hello.txt"] }))).workerID;
    await waitFor(() => h.manager.get(id)?.worktree !== "", 5_000, "the worktree");
    const rec = h.manager.get(id)!;
    const scratch = scratchPath(rec.worktree, id);
    await waitFor(() => existsSync(scratch), 5_000, "the scratch directory");

    const brief = h.manager.briefOf(id);
    expect(brief?.system).toContain(scratch);
    expect(brief?.system).toContain("Do not write scratch files to /tmp");

    // The load-bearing half: a file written there is invisible to the
    // reconciliation, so a worker's own working notes can never be reported as
    // an unclaimed change.
    writeFileSync(join(scratch, "verify.js"), "console.log('scratch')\n");
    await waitFor(() => h.manager.get(id)?.state === "completed", 10_000, "the worker to complete");
    const result = h.manager.get(id)?.result;
    expect(result?.changes.paths ?? []).not.toContain(".orchestrator/scratch/${id}/verify.js");
    for (const p of result?.changes.paths ?? []) expect(p).not.toContain("scratch");
    for (const d of result?.discrepancies ?? []) expect(d.file ?? "").not.toContain("scratch");
  });

  test("read-only modes get none, because they cannot write anyway", async () => {
    const h = await harness();
    const id = (await h.manager.spawn(spec({ mode: "research" }))).workerID;
    await waitFor(() => h.manager.get(id)?.worktree !== "", 5_000, "the worktree");
    const rec = h.manager.get(id)!;
    await sleep(80);
    expect(existsSync(scratchPath(rec.worktree, id))).toBe(false);
    expect(h.manager.briefOf(id)?.system ?? "").not.toContain("Scratch space");
  });

  test("a brief built without a scratch path says nothing about scratch", () => {
    const brief = buildBrief({
      workerID: "w-001",
      spec: { task: "t" },
      mode: "implement",
      budget: { tokens: 1000, wallClockMs: 1000, idleMs: 1000, blockedMs: 1000 },
      baseSha: "abc",
      worktree: "/tmp/wt",
    });
    expect(brief.system).not.toContain("Scratch space");
  });
});

describe("the observer sees the run loop, and cannot break it", () => {
  test("a worker's frames reach the observer in the orchestrator's own vocabulary", async () => {
    const seen: Array<{ id: string; kind: string }> = [];
    const h = await harness({}, { observer: { activity: (id, e) => seen.push({ id, kind: e.kind }) } });
    const id = (await h.manager.spawn(spec())).workerID;
    await waitFor(() => h.manager.get(id)?.state === "completed", 10_000, "the worker to complete");

    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((e) => e.id === id)).toBe(true);
    // `note` is the orchestrator's own side of the conversation; without it a
    // resumed worker appears to start talking again for no reason.
    expect(seen.some((e) => e.kind === "note")).toBe(true);
    // Liveness ticks are not activity and must never reach the dashboard.
    expect(seen.some((e) => e.kind === "heartbeat" || e.kind === "status")).toBe(false);
  });

  test("an observer that throws does not fail the worker", async () => {
    const h = await harness({}, {
      observer: {
        activity: () => {
          throw new Error("the dashboard is on fire");
        },
      },
    });
    const id = (await h.manager.spawn(spec())).workerID;
    await waitFor(() => h.manager.get(id)?.state === "completed", 10_000, "the worker to complete despite the observer");
    expect(h.manager.get(id)?.state).toBe("completed");
  });
});

describe("the store's hooks are the one seam the dashboard needs", () => {
  test("every worker write and every event reaches a subscriber, and a throwing one is survivable", async () => {
    const repo = makeGoldenRepo("p9-hooks");
    cleanup.push(repo.cleanup);
    const workers: string[] = [];
    const events: string[] = [];
    const store = new Store(join(repo.path, "hooks.db"), {
      onWorker: (r) => workers.push(`${r.workerID}:${r.state}`),
      onEvent: (e) => {
        events.push(e.kind);
        if (e.kind === "boom") throw new Error("subscriber exploded");
      },
    });
    cleanup.push(() => store.close());

    const now = Date.now();
    store.putWorker({
      workerID: "w-001", runID: "r", state: "running", mode: "implement", model: "m", task: "t",
      spec: { task: "t" }, worktree: "", branch: "", baseSha: "", createdAt: now, updatedAt: now,
      totalTokens: 0, cost: 0, resumes: 0, revisions: 0, questions: [],
    });
    store.appendEvent("w-001", "state:running", { from: "preparing" });
    // A subscriber that throws must not take the write with it: the row is
    // already committed by the time the hook runs, and failing an orchestration
    // because a browser tab is in a bad state is the wrong trade.
    store.appendEvent("w-001", "boom", {});
    expect(store.listEvents("w-001").map((e) => e.kind)).toEqual(["state:running", "boom"]);
    expect(workers).toEqual(["w-001:running"]);
    expect(events).toEqual(["state:running", "boom"]);
    expect(readdirSync(repo.path).length).toBeGreaterThan(0);
  });
});
