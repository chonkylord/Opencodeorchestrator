/**
 * The review loop at the manager level (`projectplan.md` §11 Phase 6).
 *
 * Phase 6 makes the run loop **re-entrant**, and re-entrancy is the second-best
 * way after concurrency to write a bug that passes every unit test and goes
 * wrong in production. So these tests are aimed at the joins rather than at the
 * feature: the concurrency slot a revision has to re-acquire, the fields that
 * survive `settle()` and are wrong on a second turn, the `done` promise
 * `dispose()` awaits, and the waiter that must not resolve instantly with the
 * pre-revision record.
 *
 * The parts that are only *about* the feature — that feedback reaches the worker
 * and that a second round can fix what the first got wrong — are in
 * `test/mcp/revise.test.ts`, over the wire, where Claude would meet them.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { OCMock } from "../ocmock/server.js";
import { ServeBackend } from "../../src/opencode/index.js";
import { WorkerManager } from "../../src/manager/index.js";
import { Store } from "../../src/store/index.js";
import { makeGoldenRepo } from "../fixtures/golden.js";
import { sleep } from "../helpers.js";
import type { WorkerSpec } from "../../src/manager/types.js";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await Promise.resolve(fn()).catch(() => {});
});

const report = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  workerId: "w-001",
  status: "completed",
  summary: "Created hello.txt as asked.",
  changes: [{ file: "hello.txt", action: "added", rationale: "the deliverable" }],
  tests: { command: "npm test", passed: 3, failed: 0, skipped: 0 },
  risks: [],
  questions: [],
  followUps: [],
  ...over,
});

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
  const repo = makeGoldenRepo("revise");
  cleanup.push(repo.cleanup);
  const mock = await OCMock.start({ heartbeatMs: 20, report: report(), writeFiles: true, ...mockOpts });
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
    // Phase 8 made `shared` the product default; these suites exercise the
    // isolated path (worktrees, branches, snapshots) and say so rather than
    // depending on a default.
    defaultWorkspace: "isolated",
    tickMs: 10,
    budgetPollMs: 20,
    abortGraceMs: 400,
    retrySettleMs: 30,
    verifyTests: false,
    ...managerOpts,
  });
  cleanup.push(() => manager.dispose());
  return { mock, manager, store, repo: repo.path };
}

const spec = (over: Partial<WorkerSpec> = {}): WorkerSpec => ({
  runID: "run-1",
  task: "create hello.txt",
  mode: "implement",
  ...over,
});

async function waitFor(pred: () => boolean, ms = 3_000, what = "a condition"): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

/** Spawn one worker and let it settle. The starting point for most of these. */
async function settled(h: Harness, over: Partial<WorkerSpec> = {}): Promise<string> {
  const r = await h.manager.spawn(spec(over));
  const done = await h.manager.wait(r.workerID, 5_000);
  expect(done.state).toBe("completed");
  return r.workerID;
}

// ---------------------------------------------------------------------------

describe("a revision reuses the session and takes another turn", () => {
  test("the same session id carries every round, and the worker keeps its context", async () => {
    // §5's whole argument for revising rather than respawning. Phase 0 verified
    // that a second prompt to the same session retains context; this asserts the
    // manager actually takes that path rather than opening a second session.
    const h = await harness();
    const id = await settled(h);
    const first = h.manager.get(id)!.sessionID;
    expect(first).toBeTruthy();

    const outcome = h.manager.revise(id, "hello.txt should say goodbye instead");
    expect(outcome.kind).toBe("started");

    const done = await h.manager.wait(id, 5_000);
    expect(done.state).toBe("completed");
    expect(done.sessionID).toBe(first!);
    expect(done.revisions).toBe(1);

    // One session on the backend, prompted twice — not two sessions.
    const created = h.mock.requests.filter((r) => r.method === "POST" && r.path === "/session");
    expect(created).toHaveLength(1);
    const prompts = h.mock.requests.filter((r) => r.path.includes("/prompt"));
    expect(prompts.length).toBeGreaterThanOrEqual(2);
  });

  test("the feedback reaches the worker, quoted rather than interpolated", async () => {
    const h = await harness();
    const id = await settled(h);
    h.manager.revise(id, "the sum is off by one");
    await h.manager.wait(id, 5_000);

    const prompts = h.mock.requests.filter((r) => r.path.includes("/prompt"));
    const last = JSON.stringify(prompts[prompts.length - 1]!.body);
    expect(last).toContain("the sum is off by one");
    // DD-8: it arrives as quoted material, not as a bare instruction line.
    expect(last).toContain("> the sum is off by one");
    expect(last).toContain("Revision 1 of");
  });

  test("`revisions` counts rounds and `resumes` still counts unblock-resumes", async () => {
    // The two were rendered as one number before Phase 6, which was harmless
    // only while nothing could make them disagree.
    const h = await harness();
    const id = await settled(h);
    h.manager.revise(id, "again please");
    await h.manager.wait(id, 5_000);
    const r = h.manager.get(id)!;
    expect(r.revisions).toBe(1);
    expect(r.resumes).toBe(0);
  });
});

describe("the fields that survive settling", () => {
  test("the new report replaces the old one rather than being appended to it", async () => {
    // `replyText` uncleared makes the second round's reply the first one with the
    // second stuck on the end — and `parseReport` takes the FIRST usable object,
    // so the stale report wins and the revision looks like it changed nothing.
    const h = await harness();
    const id = await settled(h);
    const sessionID = h.manager.get(id)!.sessionID!;

    h.mock.setReport(sessionID, report({ summary: "Renamed it to goodbye.txt as asked." }));
    h.manager.revise(id, "rename it");
    const done = await h.manager.wait(id, 5_000);

    expect(done.result!.summary).toBe("Renamed it to goodbye.txt as asked.");
    expect(done.result!.summary).not.toContain("Created hello.txt");
  });

  test("a worker that was stopped can be revised, and does not bail on the old cancel", async () => {
    // `cancelRequested` is sticky and Phase 5 made it load-bearing: it is checked
    // at four step boundaries. A revision that did not clear it would abandon its
    // round instantly with a reason from the worker's previous life.
    const h = await harness({ workMs: 3_000, abortDelayMs: 0 });
    const r = await h.manager.spawn(spec());
    await waitFor(() => h.manager.get(r.workerID)!.state === "running", 3_000, "running");
    await h.manager.cancel(r.workerID, "wrong approach");
    expect(h.manager.get(r.workerID)!.state).toBe("cancelled");

    // A fast turn for the revision, so the round finishes rather than hanging.
    const sessionID = h.manager.get(r.workerID)!.sessionID!;
    h.mock.setReport(sessionID, report({ summary: "Took the other approach." }));
    h.mock.setScenario(sessionID, "success");

    const outcome = h.manager.revise(r.workerID, "take the other approach instead");
    expect(outcome.kind).toBe("started");
    const done = await h.manager.wait(r.workerID, 8_000);
    expect(done.state).toBe("completed");
    expect(done.reason).toBeUndefined();
    expect(done.result!.summary).toBe("Took the other approach.");
  });

  test("a revision waits out the settle guard before prompting", async () => {
    // `lastTerminalAt` must be KEPT across the settle. OpenCode 1.18.25 accepts a
    // prompt sent within tens of milliseconds of a terminal event with a 204 and
    // then silently drops it — and a revision prompts a session that has just
    // gone terminal, which is exactly that case. A cleared `lastTerminalAt` here
    // is a revision that does nothing at all, with no error to explain it.
    const h = await harness({ dropPromptsWithinMs: 250 }, { retrySettleMs: 400 });
    const id = await settled(h);
    const sessionID = h.manager.get(id)!.sessionID!;

    h.manager.revise(id, "again");
    const done = await h.manager.wait(id, 8_000);

    expect(done.state).toBe("completed");
    expect(done.revisions).toBe(1);
    // Nothing was dropped: the guard held the prompt until the session was ready.
    expect(h.mock.droppedPromptsOf(sessionID)).toBe(0);
  });

  test("the round gets a fresh wall clock, and the tokens keep accumulating", async () => {
    // Two budgets that behave differently on purpose. The wall clock is a hang
    // detector and belongs to the turn; the tokens are a spend cap and belong to
    // the session, because every round re-sends the whole context.
    const h = await harness({ tokensPerPrompt: 1_000 });
    const id = await settled(h, { budget: { wallClockMs: 2_500 } });
    const before = h.manager.get(id)!.totalTokens;
    expect(before).toBeGreaterThan(0);

    h.manager.revise(id, "again");
    const done = await h.manager.wait(id, 6_000);
    // A fresh wall clock: the round is not killed by the first round's elapsed.
    expect(done.state).toBe("completed");
    expect(done.totalTokens).toBeGreaterThan(before);
  });

  test("elapsed time spans every round, because startedAt is not reset", async () => {
    const h = await harness();
    const id = await settled(h);
    const firstStart = h.manager.get(id)!.startedAt!;
    await sleep(30);
    h.manager.revise(id, "again");
    await h.manager.wait(id, 5_000);
    expect(h.manager.get(id)!.startedAt).toBe(firstStart);
  });
});

describe("a revision goes back through the concurrency queue", () => {
  test("with the cap full, a revision waits — and the record says why", async () => {
    // The trap Phase 5 created. A settled worker holds no slot, so a revision
    // that re-entered the run loop without re-acquiring one would put a session
    // on the shared backend that nothing counts: three revisions plus three
    // running workers is six concurrent under a cap of three, with no error and
    // no log line. Asserted by observation, the way Phase 5's cap is.
    const h = await harness({ workMsFor: { "w-002": 4_000, "w-003": 4_000 } }, { maxConcurrent: 2 });

    const first = await settled(h); // w-001, done, holding nothing
    // Two long-running workers now fill the cap.
    const busy1 = await h.manager.spawn(spec({ task: "long one" }));
    const busy2 = await h.manager.spawn(spec({ task: "long two" }));
    await waitFor(
      () => [busy1, busy2].every((b) => h.manager.get(b.workerID)!.state === "running"),
      4_000,
      "both long workers running",
    );

    const outcome = h.manager.revise(first, "have another go");
    expect(outcome.kind).toBe("started");

    // It is registered, it has left `completed`, and it is NOT prompting.
    const queued = h.manager.get(first)!;
    expect(queued.state).toBe("spawned");
    expect(queued.reason).toBe("queued");
    const hint = h.manager.queueHint(first);
    expect(hint).toBeDefined();
    expect(hint!.running).toBe(2);
    expect(hint!.maxConcurrent).toBe(2);

    // And the revision has not counted itself yet: the cap counts rounds taken.
    expect(queued.revisions).toBe(0);

    await h.manager.wait(first, 12_000);
    expect(h.manager.get(first)!.revisions).toBe(1);
  });

  test("the trail records the admission, so the cap can be audited after the fact", async () => {
    const h = await harness();
    const id = await settled(h);
    h.manager.revise(id, "again");
    await h.manager.wait(id, 5_000);

    const kinds = h.store.listEvents(id, { limit: 200 }).map((e) => e.kind);
    expect(kinds).toContain("revision_requested");
    expect(kinds).toContain("revision_started");
    // Two admissions for one worker: the spawn's and the revision's.
    expect(kinds.filter((k) => k === "admitted")).toHaveLength(2);
  });

  test("a dependent still queued waits for a dependency that goes back to revising", async () => {
    // `outcomeOf` reads live state, so a completed dependency that starts
    // revising flips from `satisfied` back to `waiting`. That is the behaviour
    // this phase chose and it is the safe one: the dependency's output is about
    // to change, and starting the dependent against the pre-revision output is
    // precisely what `dependsOn` exists to prevent (ADR-0005).
    const h = await harness({ workMsFor: { "w-002": 3_000 } }, { maxConcurrent: 1 });
    const dep = await settled(h); // w-001

    // Fill the single slot so the dependent cannot start immediately.
    const blocker = await h.manager.spawn(spec({ task: "occupies the slot" }));
    await waitFor(() => h.manager.get(blocker.workerID)!.state === "running", 3_000, "blocker running");

    const dependent = await h.manager.spawn(spec({ task: "needs w-001", dependsOn: [dep] }));
    // Now revise the dependency while the dependent is still queued.
    h.manager.revise(dep, "another pass");

    const hint = h.manager.queueHint(dependent.workerID);
    expect(hint).toBeDefined();
    expect(hint!.reason).toBe("waiting_on_dependencies");
    expect(hint!.waitingFor).toContain(dep);

    // Everything still finishes: the revision is not a deadlock.
    await h.manager.wait(dep, 12_000);
    const finished = await h.manager.wait(dependent.workerID, 12_000);
    expect(finished.state).toBe("completed");
  });
});

describe("the revision cap", () => {
  test("refuses at the cap with a report rather than an error", async () => {
    const h = await harness({}, { maxRevisions: 2 });
    const id = await settled(h);

    for (const round of [1, 2]) {
      const outcome = h.manager.revise(id, `round ${round} feedback`);
      expect(outcome.kind).toBe("started");
      await h.manager.wait(id, 5_000);
      expect(h.manager.get(id)!.revisions).toBe(round);
    }

    const refused = h.manager.revise(id, "one more time");
    expect(refused.kind).toBe("refused");
    if (refused.kind !== "refused") throw new Error("unreachable");
    expect(refused.reason).toBe("revision_cap");
    expect(refused.report.revisions).toBe(2);
    expect(refused.report.maxRevisions).toBe(2);
    // The worker is untouched by the refusal: it is still where it settled.
    expect(h.manager.get(id)!.state).toBe("completed");
  });

  test("the report names every round, what it was asked for and what it produced", async () => {
    // §13's mitigation is "revision caps with terminal ACTIONABLE reports", and
    // actionable is the load-bearing word. A cap that stops the loop and returns
    // nothing Claude can act on has converted a runaway into a dead end.
    const h = await harness({}, { maxRevisions: 1 });
    const id = await settled(h);
    h.manager.revise(id, "the off-by-one in sum() is still there");
    await h.manager.wait(id, 5_000);

    const refused = h.manager.revise(id, "again");
    if (refused.kind !== "refused") throw new Error("expected a refusal");
    const rounds = refused.report.rounds;
    // Round 0 is the original attempt; round 1 is the revision.
    expect(rounds.map((r) => r.round)).toEqual([0, 1]);
    expect(rounds[0]!.feedback).toBeUndefined();
    expect(rounds[0]!.settled).toBe(true);
    expect(rounds[1]!.feedback).toContain("off-by-one in sum()");
    expect(rounds[1]!.settled).toBe(true);
    expect(rounds[1]!.state).toBe("completed");
  });

  test("an over-budget worker is revisable by state, and refused on its tokens", async () => {
    // Both halves of one decision. `over_budget --revise--> spawned` exists
    // because the fresh wall clock makes a narrower instruction survivable — but
    // the tokens do NOT reset, because every round re-sends the accumulated
    // context. So the state check passes and the token check refuses, which is
    // the honest answer: admitting it would prompt the worker and let the first
    // budget poll kill it, and that reads as a revision that silently did
    // nothing.
    const h = await harness({ tokensPerPrompt: 4_000 });
    const r = await h.manager.spawn(spec({ budget: { tokens: 100 } }));
    const done = await h.manager.wait(r.workerID, 5_000);
    expect(done.state).toBe("over_budget");
    expect(done.totalTokens).toBeGreaterThan(100);

    const refused = h.manager.revise(r.workerID, "again, but smaller");
    expect(refused.kind).toBe("refused");
    if (refused.kind !== "refused") throw new Error("unreachable");
    // Not `revision_cap`: it has taken no rounds. The tokens are the reason.
    expect(refused.reason).toBe("token_budget");
    expect(refused.report.revisions).toBe(0);
    expect(refused.report.totalTokens).toBeGreaterThan(refused.report.tokenBudget);
  });

  test("a failed or timed-out worker with headroom is revisable", async () => {
    // `failed` covers `stream_error` and `server_gone`, which are not the
    // worker's fault at all, and a timed-out session is usually still alive. The
    // cap is what bounds the cost of being wrong about either.
    const h = await harness({ scenario: "hang", heartbeatMs: 15 });
    const r = await h.manager.spawn(spec({ budget: { idleMs: 120, wallClockMs: 4_000 } }));
    const done = await h.manager.wait(r.workerID, 8_000);
    expect(done.state).toBe("timed_out");

    const sessionID = h.manager.get(r.workerID)!.sessionID!;
    h.mock.setScenario(sessionID, "success");
    h.mock.setReport(sessionID, report({ summary: "Finished it on the second attempt." }));

    const outcome = h.manager.revise(r.workerID, "you wedged on the first tool call; do the simple thing instead");
    expect(outcome.kind).toBe("started");
    const revised = await h.manager.wait(r.workerID, 8_000);
    expect(revised.state).toBe("completed");
    expect(revised.revisions).toBe(1);
  });

  test("a cap of zero turns revisions off and still explains itself", async () => {
    const h = await harness({}, { maxRevisions: 0 });
    const id = await settled(h);
    const refused = h.manager.revise(id, "please");
    expect(refused.kind).toBe("refused");
    if (refused.kind !== "refused") throw new Error("unreachable");
    expect(refused.report.rounds[0]!.round).toBe(0);
  });
});

describe("which states may be revised", () => {
  test("`merged` may not be, and the refusal says what to do instead", async () => {
    const h = await harness();
    const id = await settled(h);
    h.manager.markMerged(id, { mergeID: "m-001", integrationBranch: "integration/m-001" });
    expect(() => h.manager.revise(id, "again")).toThrow(/merged/);
    expect(() => h.manager.revise(id, "again")).toThrow(/spawn a new worker/i);
  });

  test("a `blocked` worker is pointed at worker_message rather than revised", async () => {
    const h = await harness({ scenario: "blocked" });
    const r = await h.manager.spawn(spec());
    await waitFor(() => h.manager.get(r.workerID)!.state === "blocked", 4_000, "blocked");
    expect(() => h.manager.revise(r.workerID, "here is the answer")).toThrow(/worker_message/);
  });

  test("a running worker is not revisable, and the error says to wait", async () => {
    const h = await harness({ workMs: 3_000 });
    const r = await h.manager.spawn(spec());
    await waitFor(() => h.manager.get(r.workerID)!.state === "running", 3_000, "running");
    expect(() => h.manager.revise(r.workerID, "change course")).toThrow(/still working/);
  });

  test("two revisions in the same tick: the second is refused, not queued behind the first", async () => {
    // §9's adversarial re-read. Without a guard, both calls find a settled
    // worker, both pass the cap check, and both start a run loop over one
    // session — two subscriptions, two prompts, and a `done` that only tracks
    // the second of them.
    const h = await harness();
    const id = await settled(h);
    const first = h.manager.revise(id, "first");
    expect(first.kind).toBe("started");
    expect(() => h.manager.revise(id, "second")).toThrow();
    await h.manager.wait(id, 5_000);
    expect(h.manager.get(id)!.revisions).toBe(1);
  });

  test("a worker from a previous process cannot be revised, because its session is gone", async () => {
    const h = await harness();
    const id = await settled(h);
    // `recover()` rebuilds rows without live sessions; `halt()` produces exactly
    // that state by dropping the in-memory registry the way a crash does.
    h.manager.halt();
    expect(() => h.manager.revise(id, "again")).toThrow(/previous manager process|unknown worker/);
  });
});

describe("waiters, cancellation and shutdown during a revision", () => {
  test("worker_wait after worker_revise waits, instead of returning the old record", async () => {
    // The single most likely way for a revision loop to look like it works and
    // do nothing: `wait()` resolves on any settled state, so a revision that had
    // not yet left `completed` when it returned would hand the caller back the
    // pre-revision record instantly, and Claude would read the old result as the
    // new one.
    const h = await harness({ workMs: 400 });
    const id = await settled(h);
    const before = h.manager.get(id)!;
    expect(before.state).toBe("completed");

    h.manager.revise(id, "again");
    // Synchronously after the call, it has already left `completed`.
    expect(h.manager.get(id)!.state).not.toBe("completed");

    const startedAt = Date.now();
    const after = await h.manager.wait(id, 6_000);
    expect(Date.now() - startedAt).toBeGreaterThan(50);
    expect(after.state).toBe("completed");
    expect(after.revisions).toBe(1);
  });

  test("dispose() does not return while a revision is still prompting", async () => {
    // `w.done` is a single field and `dispose()` awaits it. A settled worker's
    // `done` resolved long ago, so a revision that installed its new one late —
    // or not at all — lets a shutdown return with a prompt in flight.
    const h = await harness({ workMs: 2_000 });
    const id = await settled(h);
    h.manager.revise(id, "a long round");
    await waitFor(() => h.manager.get(id)!.state === "running", 4_000, "the revision to start");

    await h.manager.dispose();
    // Whatever it settled as, it is settled: nothing is still in flight.
    const after = h.manager.get(id)!;
    expect(["cancelled", "completed"]).toContain(after.state);
  });

  test("cancel() finds something to abort in a revising worker", async () => {
    const h = await harness({ workMs: 2_000 });
    const id = await settled(h);
    h.manager.revise(id, "a long round");
    await waitFor(() => h.manager.get(id)!.state === "running", 4_000, "the revision to start");

    const stopped = await h.manager.cancel(id, "changed my mind");
    expect(stopped.state).toBe("cancelled");
    expect(stopped.reason).toBe("changed my mind");
  });

  test("a revision cancelled while queued keeps the result of the round that did run", async () => {
    // Nothing was spent: no prompt went out and the worktree is as the previous
    // round left it. Re-running the reconciliation here would overwrite a real
    // result describing real work with one describing a round that never
    // happened.
    const h = await harness({ workMsFor: { "w-002": 4_000 } }, { maxConcurrent: 1 });
    const id = await settled(h);
    const summaryBefore = h.manager.get(id)!.result!.summary;

    const blocker = await h.manager.spawn(spec({ task: "occupies the slot" }));
    await waitFor(() => h.manager.get(blocker.workerID)!.state === "running", 4_000, "blocker running");

    h.manager.revise(id, "another pass");
    expect(h.manager.queueHint(id)).toBeDefined();

    const stopped = await h.manager.cancel(id, "never mind");
    expect(stopped.state).toBe("cancelled");
    expect(stopped.revisions).toBe(0);
    // The previous round's result is intact rather than rebuilt.
    expect(stopped.result!.summary).toBe(summaryBefore);
    const kinds = h.store.listEvents(id, { limit: 200 }).map((e) => e.kind);
    expect(kinds).toContain("revision_abandoned");
  });

  test("a refusal at the queue does not outlive the round it refused", async () => {
    // Found by re-reading the diff rather than by a failure. The scheduler
    // remembers refusals so a cascade resolves in one pump, and that was sound
    // while a refusal was permanent — a refused *spawn* settles as `cancelled`
    // and stays there. A revision re-enqueues a worker that already settled, and
    // `cancelled` is revisable, so a worker can now be refused at the queue,
    // revised again, and complete. A stale refusal would make the scheduler keep
    // answering "failed" about a `completed` worker, and the next worker to
    // depend on it would be rejected with a message naming its own
    // contradiction: "will never complete: w-001 (completed)".
    const h = await harness({ workMsFor: { "w-002": 4_000 } }, { maxConcurrent: 1 });
    const id = await settled(h);

    const blocker = await h.manager.spawn(spec({ task: "occupies the slot" }));
    await waitFor(() => h.manager.get(blocker.workerID)!.state === "running", 4_000, "blocker running");

    h.manager.revise(id, "another pass");
    expect(h.manager.queueHint(id)).toBeDefined();
    await h.manager.cancel(id, "never mind");
    expect(h.manager.get(id)!.state).toBe("cancelled");

    // Revise it again; this time let it run.
    await h.manager.cancel(blocker.workerID, "make room").catch(() => {});
    h.manager.revise(id, "actually, do it after all");
    const revived = await h.manager.wait(id, 12_000);
    expect(revived.state).toBe("completed");

    // The scheduler must now agree that it completed. Before the fix this threw.
    const dependent = await h.manager.spawn(spec({ task: "needs it", dependsOn: [id] }));
    const done = await h.manager.wait(dependent.workerID, 12_000);
    expect(done.state).toBe("completed");
    expect(done.reason).toBeUndefined();
  });

  test("a manager that dies mid-revision leaves an interrupted row with its worktree", async () => {
    // A revision leaves the row in `running`, so `recover()` meets it exactly as
    // it meets any mid-flight worker — worth one test rather than one assumption.
    const h = await harness({ workMs: 3_000 });
    const id = await settled(h);
    h.manager.revise(id, "a long round");
    await waitFor(() => h.manager.get(id)!.state === "running", 4_000, "the revision to start");
    h.manager.halt();

    const backend = new ServeBackend({ baseUrl: h.mock.baseUrl });
    cleanup.push(() => backend.dispose());
    await backend.start();
    const second = new WorkerManager({ backend, store: h.store, repoRoot: h.repo, verifyTests: false });
    cleanup.push(() => second.dispose());

    const recovered = await second.recover();
    const row = recovered.find((r) => r.workerID === id)!;
    expect(row.state).toBe("interrupted");
    // Not `manager_restart_while_queued`: it had a worktree and real work in it.
    expect(row.reason).toBe("manager_restart");
  });
});
