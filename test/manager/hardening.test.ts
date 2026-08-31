/**
 * §11 Phase 7's hardening, against `ocmock` and real git worktrees.
 *
 * The AC is three sentences and each one is a failure mode this suite has to be
 * able to *produce* before it can check the response:
 *
 * - **`kill -9` the manager mid-run → restart → clean recovery.** `halt()` is
 *   that kill: it writes nothing and drops the registry, which is precisely what
 *   distinguishes a crash from a shutdown. Then a second manager over the same
 *   database is the restart.
 * - **A budget-exceeded worker pauses and surfaces.** The measure of "pauses"
 *   rather than "dies" is whether the work can be carried on afterwards, so the
 *   test grants and continues rather than asserting on a state name.
 * - **Orphans pruned.** In `test/workspace/cleanup.test.ts`, where the TTL is.
 *
 * The retry tests need a provider that fails in a way the *provider* calls
 * retryable, which is why `ocmock` grew `failTimes` rather than the suite
 * reaching for a real one.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { OCMock } from "../ocmock/server.js";
import { ServeBackend } from "../../src/opencode/index.js";
import { WorkerManager, backoffMs, fileMetrics } from "../../src/manager/index.js";
import { Store } from "../../src/store/index.js";
import { GOLDEN_TEST_COMMAND, makeGoldenRepo } from "../fixtures/golden.js";
import { sleep } from "../helpers.js";
import type { WorkerSpec } from "../../src/manager/types.js";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await Promise.resolve(fn()).catch(() => {});
});

const TRUTHFUL = {
  status: "completed",
  summary: "Created hello.txt as asked.",
  changes: [{ file: "hello.txt", action: "added", rationale: "the deliverable" }],
  tests: { command: GOLDEN_TEST_COMMAND, passed: 3, failed: 0, skipped: 0 },
  risks: [],
  questions: [],
  followUps: [],
};

interface Harness {
  mock: OCMock;
  manager: WorkerManager;
  store: Store;
  repo: string;
  dbPath: string;
  backend: ServeBackend;
}

async function harness(
  mockOpts: Parameters<typeof OCMock.start>[0] = {},
  managerOpts: Partial<ConstructorParameters<typeof WorkerManager>[0]> = {},
): Promise<Harness> {
  const repo = makeGoldenRepo("harden");
  cleanup.push(repo.cleanup);
  const mock = await OCMock.start({ heartbeatMs: 20, report: TRUTHFUL, writeFiles: true, ...mockOpts });
  cleanup.push(() => mock.stop());
  const backend = new ServeBackend({ baseUrl: mock.baseUrl });
  cleanup.push(() => backend.dispose());
  await backend.start();

  const dbPath = join(repo.path, "orchestrator.db");
  const store = new Store(dbPath);
  cleanup.push(() => store.close());

  const manager = new WorkerManager({
    backend,
    store,
    repoRoot: repo.path,
    // Phase 8 made `shared` the product default; these suites exercise the
    // isolated path (worktrees, branches, snapshots) and say so rather than
    // depending on a default.
    defaultWorkspace: "isolated",
    tickMs: 10,
    budgetPollMs: 20,
    abortGraceMs: 400,
    retrySettleMs: 30,
    retryBackoffMs: 5,
    verifyTests: false,
    ...managerOpts,
  });
  cleanup.push(() => manager.dispose());
  return { mock, manager, store, repo: repo.path, dbPath, backend };
}

const spec = (over: Partial<WorkerSpec> = {}): WorkerSpec => ({
  runID: "run-1",
  task: "create hello.txt",
  mode: "implement",
  ...over,
});

async function waitFor(pred: () => boolean, ms = 4_000, what = "a condition"): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

/** A second manager over the same database — the restart half of a crash test. */
async function restart(
  h: Harness,
  opts: Partial<ConstructorParameters<typeof WorkerManager>[0]> = {},
  /**
   * A *different* server, which is what a real restart usually gets.
   *
   * The manager spawns its own OpenCode, so a restarted one talks to a fresh
   * process that has never heard of the old sessions. Pointing the second
   * manager at the same mock reproduces the other case — a shared server that
   * outlived the manager — and the two take genuinely different code paths.
   */
  freshServer?: OCMock,
): Promise<WorkerManager> {
  const backend = new ServeBackend({ baseUrl: (freshServer ?? h.mock).baseUrl });
  cleanup.push(() => backend.dispose());
  await backend.start();
  let seq = 0;
  const m = new WorkerManager({
    backend,
    store: h.store,
    repoRoot: h.repo,
    defaultWorkspace: "isolated",
    tickMs: 10,
    budgetPollMs: 20,
    abortGraceMs: 400,
    retrySettleMs: 30,
    verifyTests: false,
    // A restarted manager mints ids from `w-001` again, so anything it spawns
    // collides with the rows the dead one left. That is a real property of the
    // id generator worth knowing about — a restarted process must be given a
    // distinct namespace — and here it is just this harness being careful.
    newWorkerID: () => `r-${(++seq).toString().padStart(3, "0")}`,
    ...opts,
  });
  cleanup.push(() => m.dispose());
  return m;
}

// ---------------------------------------------------------------------------

describe("§11 Phase 7 AC: kill -9 mid-run, restart, clean recovery", () => {
  test("the session is gone: the worker is salvaged from its worktree, with a real result", async () => {
    // The crash: `halt()` writes nothing and drops the registry, which is what
    // separates it from `dispose()`. The row is left saying `running`, which is
    // a lie the next process has to deal with.
    const h = await harness({ workMs: 3_000 });
    const spawned = await h.manager.spawn(spec({ testCommand: GOLDEN_TEST_COMMAND }));
    await waitFor(() => h.manager.get(spawned.workerID)!.state === "running", 4_000, "running");
    const worktree = h.manager.get(spawned.workerID)!.worktree;
    h.manager.halt();

    // A restarted manager spawns a *fresh* OpenCode, which has never heard of
    // the old session. This is that, and it is the ordinary case.
    const fresh = await OCMock.start({ heartbeatMs: 20, report: TRUTHFUL, writeFiles: true });
    cleanup.push(() => fresh.stop());

    // `recover()` turns the lie into `interrupted`, which §9 calls a decision
    // point rather than a verdict.
    const second = await restart(h, { verifyTests: true, recoverGraceMs: 200 }, fresh);
    const recovered = await second.recover();
    expect(recovered.map((r) => r.workerID)).toContain(spawned.workerID);
    expect(second.get(spawned.workerID)!.state).toBe("interrupted");
    expect(existsSync(worktree)).toBe(true);

    const outcome = second.recoverWorker(spawned.workerID, "resume");
    expect(outcome.kind).toBe("resuming");
    // It left `interrupted` before the call returned, so a wait actually waits.
    expect(second.get(spawned.workerID)!.state).not.toBe("interrupted");

    const done = await second.wait(spawned.workerID, 12_000);
    expect(done.state).toBe("completed");
    const result = done.result!;
    // The measurements survived even though the worker's own report did not:
    // the file it wrote is in the diff, and the test command was re-run here.
    expect(result.changes.paths).toContain("hello.txt");
    expect(result.snapshot?.committed).toBe(true);
    expect(result.tests?.command).toBe(GOLDEN_TEST_COMMAND);
    const kinds = h.store.listEvents(spawned.workerID, { limit: 200 }).map((e) => e.kind);
    expect(kinds).toContain("recovery_salvaged");
  }, 30_000);

  test("the session survived and its turn is still running: it is re-attached and monitored", async () => {
    // The other half, and the reason `resume` is one action rather than two:
    // which path runs is a fact about the backend, not a choice.
    const h = await harness({ workMs: 1_200 }, { recoverGraceMs: 4_000 });
    const spawned = await h.manager.spawn(spec());
    await waitFor(() => h.manager.get(spawned.workerID)!.state === "running", 4_000, "running");
    h.manager.halt();

    // Same mock: a server that outlived the manager, which is what
    // ORCHESTRATOR_BASE_URL produces in practice.
    const second = await restart(h, { recoverGraceMs: 4_000 });
    await second.recover();
    second.recoverWorker(spawned.workerID, "resume");

    const done = await second.wait(spawned.workerID, 12_000);
    expect(done.state).toBe("completed");
    const kinds = h.store.listEvents(spawned.workerID, { limit: 200 }).map((e) => e.kind);
    expect(kinds).toContain("recovery_resumed");
    // The turn's own terminal event is what ended it, not the salvage window —
    // which is the distinction that matters, and the one visible from outside.
    // (`recovery_live` is only appended when a *non-terminal* event arrives after
    // re-attaching; a turn whose next event is its last produces none, and is
    // still a genuine re-attach.)
    expect(kinds).not.toContain("recovery_salvaged");
  }, 30_000);

  test("the session survived but its turn ended while we were dead: salvaged, not hung", async () => {
    // Found by writing the test rather than by reasoning: a subscription is not
    // replayed, so the terminal event that ended the old turn is simply gone. A
    // recovered worker that waited for one would sit through the entire idle
    // watchdog — three minutes by default — and then be recorded as wedged, when
    // in fact its work was finished and sitting on disk the whole time.
    const h = await harness({ workMs: 600 }, { recoverGraceMs: 300 });
    const spawned = await h.manager.spawn(spec());
    await waitFor(() => h.manager.get(spawned.workerID)!.state === "running", 4_000, "running");
    // Kill the manager while the turn is genuinely in flight, then let the mock
    // finish it with nobody subscribed. The terminal event is emitted to an
    // empty room and is not replayed to the next subscriber — which is the
    // whole of the problem this test exists for.
    h.manager.halt();
    await sleep(800);

    const second = await restart(h, { recoverGraceMs: 300 });
    await second.recover();
    second.recoverWorker(spawned.workerID, "resume");

    const started = Date.now();
    const done = await second.wait(spawned.workerID, 10_000);
    expect(done.state).toBe("completed");
    // Seconds, not the idle watchdog's minutes.
    expect(Date.now() - started).toBeLessThan(5_000);
    const salvaged = h.store
      .listEvents(spawned.workerID, { limit: 200 })
      .filter((e) => e.kind === "recovery_salvaged");
    expect(salvaged).toHaveLength(1);
    expect(salvaged[0]!.detail["reason"]).toBe("session_alive_but_turn_over");
  }, 30_000);

  test("a recovered worker's branch is mergeable, which is what makes recovery worth doing", async () => {
    const h = await harness({ workMs: 2_000 });
    const spawned = await h.manager.spawn(spec());
    await waitFor(() => h.manager.get(spawned.workerID)!.state === "running", 4_000, "running");
    h.manager.halt();

    const second = await restart(h);
    await second.recover();
    second.recoverWorker(spawned.workerID, "resume");
    const done = await second.wait(spawned.workerID, 10_000);

    expect(done.state).toBe("completed");
    // `completed` is the state the merge gate requires, and the snapshot commit
    // is what it merges. A recovery that stopped at `interrupted` would leave the
    // work on a branch nothing could take.
    expect(done.result!.snapshot?.sha).toBeTruthy();
  }, 30_000);

  test("`fail` and `discard` settle the row and keep the worktree", async () => {
    // DD-7: a worker's branch is the only copy of what it produced, so neither
    // of these deletes anything. `workspace_cleanup` is the tool that deletes.
    for (const [action, want] of [
      ["fail", "failed"],
      ["discard", "cancelled"],
    ] as const) {
      const h = await harness({ workMs: 2_000 });
      const spawned = await h.manager.spawn(spec());
      await waitFor(() => h.manager.get(spawned.workerID)!.state === "running", 4_000, "running");
      const worktree = h.manager.get(spawned.workerID)!.worktree;
      h.manager.halt();

      const second = await restart(h);
      await second.recover();
      const outcome = second.recoverWorker(spawned.workerID, action);
      expect(outcome.kind).toBe("settled");
      expect(second.get(spawned.workerID)!.state).toBe(want);
      expect(existsSync(worktree)).toBe(true);
    }
  }, 30_000);

  test("recovering a worker that is not interrupted is refused, and the refusal says what it is", async () => {
    const h = await harness();
    const spawned = await h.manager.spawn(spec());
    await h.manager.wait(spawned.workerID, 5_000);
    expect(() => h.manager.recoverWorker(spawned.workerID, "resume")).toThrow(/not interrupted/);
    expect(() => h.manager.recoverWorker(spawned.workerID, "resume")).toThrow(/worker_result/);
  });

  test("a recovery re-enters the concurrency queue rather than running unaccounted", async () => {
    // The same trap Phase 6's revisions had: a worker settled or interrupted
    // holds no slot, so work restarted for it must re-acquire one or the cap
    // stops meaning anything.
    // `recoverGraceMs` is 8s in production, which is right for a real provider
    // mid-response and longer than a unit test should ever sit still for.
    const h = await harness({ workMs: 3_000 }, { maxConcurrent: 1, recoverGraceMs: 200 });
    const spawned = await h.manager.spawn(spec());
    await waitFor(() => h.manager.get(spawned.workerID)!.state === "running", 4_000, "running");
    h.manager.halt();

    const second = await restart(h, { maxConcurrent: 1, recoverGraceMs: 200 });
    await second.recover();
    // Fill the single slot with a live worker first.
    const blocker = await second.spawn(spec({ task: "occupies the slot" }));
    await waitFor(() => second.get(blocker.workerID)!.state === "running", 4_000, "blocker running");

    second.recoverWorker(spawned.workerID, "resume");
    const hint = second.queueHint(spawned.workerID);
    expect(hint).toBeDefined();
    expect(hint!.running).toBe(1);
    expect(hint!.maxConcurrent).toBe(1);

    const done = await second.wait(spawned.workerID, 15_000);
    expect(done.state).toBe("completed");
  }, 30_000);
});

describe("§11 Phase 7 AC: a budget-exceeded worker pauses and surfaces", () => {
  test("the grant is additive, is recorded, and survives into the row", async () => {
    const h = await harness({ tokensPerPrompt: 4_000 });
    const r = await h.manager.spawn(spec({ budget: { tokens: 100 } }));
    const done = await h.manager.wait(r.workerID, 6_000);
    expect(done.state).toBe("over_budget");

    const granted = h.manager.grantBudget(r.workerID, { tokens: 500_000 });
    expect(granted.budget.tokens).toBe(500_100);
    // Onto the spec, so the next process reads it too — a grant kept in memory
    // would be forgotten exactly when it is most needed.
    expect(h.store.getWorker(r.workerID)!.spec.budget?.tokens).toBe(500_100);
    const kinds = h.store.listEvents(r.workerID, { limit: 200 }).map((e) => e.kind);
    expect(kinds).toContain("budget_granted");
  });

  test("granting then revising carries the worker on — which is what 'pauses' has to mean", async () => {
    // §8 says an over-budget worker should pause and surface, not die. The only
    // honest measure of that is whether the work can be continued afterwards,
    // with the session and everything in it intact.
    const h = await harness({ tokensPerPrompt: 4_000 });
    const r = await h.manager.spawn(spec({ budget: { tokens: 100 } }));
    const stopped = await h.manager.wait(r.workerID, 6_000);
    expect(stopped.state).toBe("over_budget");
    const sessionID = stopped.sessionID!;

    // Before the grant, a revision is refused — and refused for the tokens.
    const refused = h.manager.revise(r.workerID, "carry on");
    expect(refused.kind).toBe("refused");
    if (refused.kind !== "refused") throw new Error("unreachable");
    expect(refused.reason).toBe("token_budget");

    h.manager.grantBudget(r.workerID, { tokens: 500_000 });
    const started = h.manager.revise(r.workerID, "carry on where you left off");
    expect(started.kind).toBe("started");

    const done = await h.manager.wait(r.workerID, 10_000);
    expect(done.state).toBe("completed");
    // The same session throughout: the grant bought another round of the worker
    // it already had, not a replacement for it.
    expect(done.sessionID).toBe(sessionID);
  });

  test("a grant reaches a worker that is still running, without restarting it", async () => {
    const h = await harness({ workMs: 1_500, tokensPerPrompt: 1_000 });
    const r = await h.manager.spawn(spec());
    await waitFor(() => h.manager.get(r.workerID)!.state === "running", 4_000, "running");
    const granted = h.manager.grantBudget(r.workerID, { wallClockMs: 60_000 });
    expect(granted.budget.wallClockMs).toBeGreaterThan(60_000);
    expect(h.manager.get(r.workerID)!.state).toBe("running");
    const done = await h.manager.wait(r.workerID, 10_000);
    expect(done.state).toBe("completed");
  });

  test("a grant of nothing is refused rather than silently doing nothing", async () => {
    const h = await harness();
    const r = await h.manager.spawn(spec());
    await h.manager.wait(r.workerID, 5_000);
    expect(() => h.manager.grantBudget(r.workerID, {})).toThrow(/nothing was asked for/);
  });
});

describe("§8's global run cap", () => {
  test("a spawn is refused once the run has spent its budget, and the refusal names both numbers", async () => {
    const h = await harness({ tokensPerPrompt: 4_000 }, { runBudgetTokens: 1_000 });
    const first = await h.manager.spawn(spec());
    const done = await h.manager.wait(first.workerID, 6_000);
    expect(done.totalTokens).toBeGreaterThan(1_000);

    // No row is written for the refused spawn: a spawn that cannot be honoured
    // is a refusal to read, not a worker that appears and dies.
    const before = h.manager.list({ runID: "run-1" }).length;
    expect(() => h.manager.spawn(spec({ task: "one too many" }))).toThrow(/run cap/);
    await sleep(20);
    expect(h.manager.list({ runID: "run-1" }).length).toBe(before);
  });

  test("the cap is per run, so a fresh runID is unaffected", async () => {
    const h = await harness({ tokensPerPrompt: 4_000 }, { runBudgetTokens: 1_000 });
    const first = await h.manager.spawn(spec());
    await h.manager.wait(first.workerID, 6_000);
    expect(() => h.manager.spawn(spec())).toThrow(/run cap/);

    const other = await h.manager.spawn(spec({ runID: "run-2", task: "a different run" }));
    const done = await h.manager.wait(other.workerID, 6_000);
    expect(done.state).toBe("completed");
  });

  test("a queued worker is stopped at the session, not only at the spawn", async () => {
    // The spend that matters accrues *while a worker waits*. Both workers are
    // accepted under the cap; by the time the second is admitted the first has
    // blown it, and the point of a cap is that it binds when the money would be
    // spent rather than when it was requested.
    const h = await harness({ tokensPerPrompt: 4_000, workMsFor: { "w-001": 400 } }, { maxConcurrent: 1, runBudgetTokens: 1_000 });
    const a = await h.manager.spawn(spec({ task: "spends the run's budget" }));
    const b = await h.manager.spawn(spec({ task: "arrives to find it gone" }));

    await h.manager.wait(a.workerID, 8_000);
    const second = await h.manager.wait(b.workerID, 8_000);
    expect(second.state).toBe("over_budget");
    expect(second.reason).toBe("run_budget");
    // It never opened a session, so it never spent anything of its own.
    expect(second.sessionID).toBeUndefined();
    expect(second.result!.reportSource).toBe("not_started");
  });

  test("a run cap of zero disables it entirely", async () => {
    const h = await harness({ tokensPerPrompt: 4_000 }, { runBudgetTokens: 0 });
    const first = await h.manager.spawn(spec());
    await h.manager.wait(first.workerID, 6_000);
    const second = await h.manager.spawn(spec({ task: "still fine" }));
    expect((await h.manager.wait(second.workerID, 6_000)).state).toBe("completed");
  });
});

describe("retries with backoff", () => {
  test("the exponent is bounded, and a base of zero means no wait at all", () => {
    expect(backoffMs(1, 1_000)).toBe(1_000);
    expect(backoffMs(2, 1_000)).toBe(2_000);
    expect(backoffMs(3, 1_000)).toBe(4_000);
    // Capped rather than doubling forever: a tenth retry must not sleep for a
    // fortnight, and the wall-clock budget is still running underneath.
    expect(backoffMs(20, 1_000)).toBe(30_000);
    expect(backoffMs(1, 0)).toBe(0);
  });

  test("a retryable provider error is retried and the worker still completes", async () => {
    // The provider's own judgement decides this, not the message text: the
    // adapter reads `isRetryable` off the error and the manager acts on it.
    const h = await harness({ failTimes: 1, failRetryable: true });
    const r = await h.manager.spawn(spec());
    const done = await h.manager.wait(r.workerID, 10_000);

    expect(done.state).toBe("completed");
    const events = h.store.listEvents(r.workerID, { limit: 200 });
    const retried = events.filter((e) => e.kind === "turn_retried");
    expect(retried).toHaveLength(1);
    expect(retried[0]!.detail["attempt"]).toBe(1);
    expect(events.some((e) => e.kind === "retry_backoff")).toBe(true);
  });

  test("a NON-retryable error is failed on the first try rather than retried", async () => {
    // A content filter or a malformed request reproduces exactly. Retrying it
    // spends the budget three times to reach the same answer.
    const h = await harness({ failTimes: 5, failRetryable: false });
    const r = await h.manager.spawn(spec());
    const done = await h.manager.wait(r.workerID, 10_000);

    expect(done.state).toBe("failed");
    expect(h.store.listEvents(r.workerID, { limit: 200 }).filter((e) => e.kind === "turn_retried")).toHaveLength(0);
  });

  test("retries are capped, and the reason says how many were spent", async () => {
    const h = await harness({ failTimes: 99, failRetryable: true }, { maxRetries: 2 });
    const r = await h.manager.spawn(spec());
    const done = await h.manager.wait(r.workerID, 15_000);

    expect(done.state).toBe("failed");
    expect(done.reason).toContain("after_2_retries");
    expect(h.store.listEvents(r.workerID, { limit: 200 }).filter((e) => e.kind === "turn_retried")).toHaveLength(2);
  });

  test("maxRetries of zero turns retries off", async () => {
    const h = await harness({ failTimes: 1, failRetryable: true }, { maxRetries: 0 });
    const done = await h.manager.wait((await h.manager.spawn(spec())).workerID, 10_000);
    expect(done.state).toBe("failed");
  });

  test("a transient error does not spend the one-shot schema retry", async () => {
    // Both paths re-send the same turn on an `api` error, so before Phase 7 the
    // provider hiccup that happened to arrive first was diagnosed as a schema
    // rejection: it burned the format retry AND latched structured output off
    // for every later worker on the backend, over something that had nothing to
    // do with schemas. Retryability is the field that tells them apart.
    const h = await harness({ failTimes: 1, failRetryable: true });
    const r = await h.manager.spawn(spec());
    await h.manager.wait(r.workerID, 10_000);
    const kinds = h.store.listEvents(r.workerID, { limit: 200 }).map((e) => e.kind);
    expect(kinds).toContain("turn_retried");
    expect(kinds).not.toContain("structured_output_unsupported");
  });
});

describe("answering a permission in band", () => {
  // Every test here needs a worker that *stops* — the whole subject is what
  // happens once one has. §11 Phase 10 made `full` the default, and in `full`
  // the manager grants the request itself and the worker never blocks, so these
  // pin `jailed` rather than riding on a default that no longer holds. The
  // `full` side of the same fork is `test/manager/phase10.test.ts`.
  const jailed = { permissionMode: "jailed" } as const;

  test("the turn is never aborted, and the worker carries on from where it stopped", async () => {
    // `docs/phase0-facts.md` "Unresolved" 5, closed. Before Phase 7 the manager
    // had to convert a permission ask into an escalation — abort the turn,
    // surface the question, deliver the answer as the *next* prompt — because
    // the adapter could raise an ask and not reply to one. Phase 6's demo
    // measured what that cost: three asks in one four-worker run, and the worker
    // that escalated twice ended on 47,531 tokens against 7,715 for the one that
    // never did.
    const h = await harness({ scenario: "blocked" }, jailed);
    const r = await h.manager.spawn(spec());
    await waitFor(() => h.manager.get(r.workerID)!.state === "blocked", 4_000, "blocked");
    const blocked = h.manager.get(r.workerID)!;
    expect(blocked.reason).toBe("permission_required");
    expect(blocked.questions.length).toBeGreaterThan(0);

    await h.manager.answer(r.workerID, "yes, that is inside its own worktree");
    const done = await h.manager.wait(r.workerID, 8_000);
    expect(done.state).toBe("completed");

    const sessionID = done.sessionID!;
    expect(h.mock.permissionRepliesOf(sessionID)).toEqual(["once"]);
    const kinds = h.store.listEvents(r.workerID, { limit: 200 }).map((e) => e.kind);
    expect(kinds).toContain("permission_answered");
    // The turn was never aborted and never re-prompted — which is the whole
    // point, and the difference between a partial turn and none.
    expect(kinds).not.toContain("abort_requested");
    const prompts = h.mock.requests.filter((q) => q.path.includes("/prompt"));
    expect(prompts).toHaveLength(1);
  });

  test("`deny` refuses the request rather than granting it quietly", async () => {
    // Guessing allow/deny from free text in the permissive direction would
    // defeat exactly the jail signal §8 keeps `external_directory` at `ask` for.
    const h = await harness({ scenario: "blocked" }, jailed);
    const r = await h.manager.spawn(spec());
    await waitFor(() => h.manager.get(r.workerID)!.state === "blocked", 4_000, "blocked");

    await h.manager.answer(r.workerID, "no — that is outside your worktree", "deny");
    const done = await h.manager.wait(r.workerID, 8_000);
    expect(h.mock.permissionRepliesOf(done.sessionID!)).toEqual(["reject"]);
  });

  test("a stale request falls back to the escalation rather than wedging", async () => {
    // The reply can fail for reasons that are nobody's fault: the turn moved on,
    // or the request was answered twice. The pre-Phase-7 path still works and is
    // one prompt away, so the fallback is a partial turn rather than a dead
    // worker — the old cost, paid only when the new route is unavailable.
    const h = await harness({ scenario: "blocked" }, jailed);
    const r = await h.manager.spawn(spec());
    await waitFor(() => h.manager.get(r.workerID)!.state === "blocked", 4_000, "blocked");

    // Answer it out from under the manager, so its own reply finds nothing.
    const sessionID = h.manager.get(r.workerID)!.sessionID!;
    h.mock.resolveBlock(sessionID);
    // …and stop the mock blocking again on the fallback prompt, or the worker
    // would legitimately block a second time and this would be testing that.
    h.mock.setScenario(sessionID, "success");

    await h.manager.answer(r.workerID, "go ahead");
    const done = await h.manager.wait(r.workerID, 10_000);
    expect(done.state).toBe("completed");
    const kinds = h.store.listEvents(r.workerID, { limit: 200 }).map((e) => e.kind);
    expect(kinds).toContain("permission_stale");
  });
});

describe("the metrics log", () => {
  test("a settled worker writes one line, and it is never on the wire", async () => {
    const h = await harness({}, {});
    const repo = h.repo;
    const manager = new WorkerManager({
      backend: h.backend,
      store: h.store,
      repoRoot: repo,
      tickMs: 10,
      verifyTests: false,
      metrics: fileMetrics(repo),
    });
    cleanup.push(() => manager.dispose());

    const r = await manager.spawn(spec({ runID: "metrics-run" }));
    await manager.wait(r.workerID, 6_000);

    const dir = join(repo, ".orchestrator", "metrics");
    const files = readdirSync(dir);
    expect(files).toHaveLength(1);
    const lines = readFileSync(join(dir, files[0]!), "utf8").trim().split("\n");
    const settled = lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((m) => m["kind"] === "worker_settled");
    expect(settled).toHaveLength(1);
    expect(settled[0]!["runID"]).toBe("metrics-run");
    expect(settled[0]!["workerID"]).toBe(r.workerID);
    expect(typeof settled[0]!["durationMs"]).toBe("number");
  });

  test("a metrics sink that throws never fails a worker", async () => {
    // Telemetry is never worth a run, and the only way to be sure is to break it
    // deliberately and watch the worker finish anyway.
    const h = await harness({}, {
      metrics: {
        record: () => {
          throw new Error("disk full");
        },
      },
    });
    const done = await h.manager.wait((await h.manager.spawn(spec())).workerID, 6_000);
    expect(done.state).toBe("completed");
  });
});
