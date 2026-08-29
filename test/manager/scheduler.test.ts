/**
 * Phase 5's parallelism, against `ocmock` and real git worktrees.
 *
 * Every property here is asserted **by observation** rather than by asking the
 * semaphore about its own counter. A test that reads `scheduler.running` passes
 * whether or not the gate is wired into the run loop at all; a test that spawns
 * six workers against a cap of three and watches how many reach `preparing`
 * fails the moment it is not.
 *
 * Timing is arranged with `ocmock`'s `workMsFor`, not raced. "Worker A is still
 * running when C is admitted" has to be a fact, and the only honest way to make
 * it one is to say how long each worker takes.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { OCMock } from "../ocmock/server.js";
import { ServeBackend } from "../../src/opencode/index.js";
import { DependencyError, Scheduler, WorkerManager, findCycle, clampConcurrency } from "../../src/manager/index.js";
import { Store } from "../../src/store/index.js";
import { makeGoldenRepo } from "../fixtures/golden.js";
import { sleep } from "../helpers.js";
import type { WorkerRecord, WorkerSpec } from "../../src/manager/types.js";
import type { WorkerState } from "../../src/manager/state.js";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await Promise.resolve(fn()).catch(() => {});
});

const TRUTHFUL = {
  status: "completed",
  summary: "Created the file as asked.",
  changes: [],
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
  const repo = makeGoldenRepo("sched");
  cleanup.push(repo.cleanup);
  const mock = await OCMock.start({ heartbeatMs: 20, report: TRUTHFUL, ...mockOpts });
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
  task: "create a file",
  mode: "implement",
  ...over,
});

/** States in which a worker has been admitted and holds a slot. */
const ADMITTED: readonly WorkerState[] = ["preparing", "running", "blocked"];

async function waitFor(pred: () => boolean, ms = 8_000, what = "a condition"): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(4);
  }
}

const stateOf = (m: WorkerManager, id: string): WorkerState => m.get(id)!.state;

// ---------------------------------------------------------------------------

describe("the concurrency cap", () => {
  test("never more than maxConcurrent workers get past `spawned`, observed rather than counted", async () => {
    const { manager } = await harness({ workMs: 250 }, { maxConcurrent: 3 });

    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push((await manager.spawn(spec({ task: `task ${i}` }))).workerID);

    // Sample the observable states while the wave runs. The assertion is on what
    // the *records* say, so a semaphore that counts correctly and gates nothing
    // fails here.
    let peak = 0;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const admitted = ids.filter((id) => ADMITTED.includes(stateOf(manager, id))).length;
      peak = Math.max(peak, admitted);
      expect(admitted).toBeLessThanOrEqual(3);
      if (ids.every((id) => stateOf(manager, id) === "completed")) break;
      await sleep(5);
    }

    expect(ids.map((id) => stateOf(manager, id))).toEqual(Array(6).fill("completed"));
    // …and the cap is a cap, not a serializer: with six workers and three slots
    // it must actually have reached three, or this suite would pass on a
    // scheduler that ran everything one at a time.
    expect(peak).toBe(3);
  }, 30_000);

  test("a queued worker starts when a slot frees, and says why it has not while it waits", async () => {
    const { manager } = await harness({ workMs: 150 }, { maxConcurrent: 1 });

    const a = (await manager.spawn(spec({ task: "first" }))).workerID;
    const b = (await manager.spawn(spec({ task: "second" }))).workerID;

    // The record says so immediately — a status line taken one millisecond after
    // worker_spawn returned must already explain the silence.
    expect(manager.get(b)!.state).toBe("spawned");
    expect(manager.get(b)!.reason).toBe("queued");
    const hint = manager.queueHint(b)!;
    expect(hint.reason).toBe("queued");
    expect(hint.position).toBe(1);
    expect(hint.running).toBe(1);
    expect(hint.maxConcurrent).toBe(1);
    expect(manager.queueHint(a)).toBeUndefined();

    await waitFor(() => stateOf(manager, a) === "completed", 8_000, "the first worker to complete");
    await waitFor(() => stateOf(manager, b) === "completed", 8_000, "the queued worker to run and complete");
    // The queue reason has to stop being true when it stops being true.
    expect(manager.get(b)!.reason).toBeUndefined();
    expect(manager.queueHint(b)).toBeUndefined();
  }, 30_000);

  test("queue time is not work time: a queued worker keeps its whole wall-clock budget", async () => {
    // The regression this exists for: starting the budget clock when a worker is
    // *accepted* rather than when it is *prompted*. It passes every unit test
    // about semaphores and kills the second worker of every wave.
    const { manager } = await harness({ workMsFor: { "w-001": 600 }, workMs: 20 }, { maxConcurrent: 1 });

    const a = (await manager.spawn(spec({ task: "slow" }))).workerID;
    // A budget far shorter than the time this worker will spend in the queue.
    const b = (await manager.spawn(spec({ task: "queued", budget: { wallClockMs: 250 } }))).workerID;
    expect(manager.get(b)!.reason).toBe("queued");

    await waitFor(() => stateOf(manager, b) === "completed", 10_000, "the queued worker to complete");
    expect(stateOf(manager, a)).toBe("completed");

    const rec = manager.get(b)!;
    // Two different elapsed numbers, on purpose. `durationMs` runs from the
    // first prompt and is what the budget is measured against; wall time since
    // the spawn includes the queue and is what a status line shows a human.
    const sinceSpawn = rec.endedAt! - rec.createdAt;
    expect(rec.result!.durationMs).toBeLessThan(250);
    expect(sinceSpawn).toBeGreaterThan(500);
  }, 30_000);
});

// ---------------------------------------------------------------------------

describe("dependsOn", () => {
  test("a dependent does not start until its dependency has completed", async () => {
    const { manager } = await harness({ workMsFor: { "w-001": 300 }, workMs: 20 }, { maxConcurrent: 4 });

    const a = (await manager.spawn(spec({ task: "the dependency" }))).workerID;
    const b = (await manager.spawn(spec({ task: "the dependent", dependsOn: [a] }))).workerID;

    expect(manager.get(b)!.reason).toBe("waiting_on_dependencies");
    expect(manager.queueHint(b)!.waitingFor).toEqual([a]);

    // There are three free slots, so nothing but the dependency is holding it.
    await sleep(120);
    expect(stateOf(manager, a)).toBe("running");
    expect(stateOf(manager, b)).toBe("spawned");

    await waitFor(() => stateOf(manager, b) === "completed", 10_000, "the dependent to run");
    const [ra, rb] = [manager.get(a)!, manager.get(b)!];
    expect(ra.state).toBe("completed");
    // The ordering property, stated as a fact about time rather than about
    // states: the dependent was not prompted until the dependency had settled.
    expect(rb.startedAt!).toBeGreaterThanOrEqual(ra.endedAt!);
  }, 30_000);

  test("a worker waiting on a dependency holds no slot, and does not block the queue behind it", async () => {
    // The deadlock generator, in its most benign form. With a cap of 2: `a` runs,
    // `b` cannot (its dependency is `a`), and `c` — spawned last — must run
    // anyway. A scheduler that counts a waiting worker against the cap, or that
    // stops at the head of the queue, leaves `c` idle behind a worker that is
    // itself waiting for the worker in front of it.
    const { manager } = await harness({ workMsFor: { "w-001": 400 }, workMs: 30 }, { maxConcurrent: 2 });

    const a = (await manager.spawn(spec({ task: "long" }))).workerID;
    const b = (await manager.spawn(spec({ task: "dependent", dependsOn: [a] }))).workerID;
    const c = (await manager.spawn(spec({ task: "independent" }))).workerID;

    await waitFor(() => stateOf(manager, c) === "completed", 8_000, "the independent worker to finish");
    // While `c` came and went, `a` was still going and `b` had never started.
    expect(stateOf(manager, a)).toBe("running");
    expect(stateOf(manager, b)).toBe("spawned");
    expect(manager.queueHint(b)!.waitingFor).toEqual([a]);

    await waitFor(() => stateOf(manager, b) === "completed", 10_000, "the dependent to finish last");
    expect(manager.get(b)!.startedAt!).toBeGreaterThan(manager.get(c)!.endedAt!);
  }, 30_000);

  test("a dependency that is cancelled cancels its dependents, naming it, and cascades", async () => {
    // The policy decision ADR-0004 records. The alternative — leave them queued —
    // is a run that hangs forever with nothing in the system reporting it.
    const { manager } = await harness({ workMsFor: { "w-001": 3_000 }, workMs: 20 }, { maxConcurrent: 4 });

    const a = (await manager.spawn(spec({ task: "will be cancelled" }))).workerID;
    const b = (await manager.spawn(spec({ task: "depends on a", dependsOn: [a] }))).workerID;
    const c = (await manager.spawn(spec({ task: "depends on b", dependsOn: [b] }))).workerID;

    await waitFor(() => stateOf(manager, a) === "running", 5_000, "the dependency to start");
    await manager.cancel(a, "cancelled_by_request");

    await waitFor(() => stateOf(manager, c) === "cancelled", 8_000, "the cascade to reach the far end");
    expect(manager.get(b)!.state).toBe("cancelled");
    expect(manager.get(b)!.reason).toBe(`dependency_failed:${a}`);
    expect(manager.get(c)!.reason).toBe(`dependency_failed:${b}`);

    // A cancelled-while-queued worker never started, and its result says exactly
    // that rather than reading as a worker that ran and achieved nothing.
    const result = manager.get(b)!.result!;
    expect(result.reportSource).toBe("not_started");
    expect(result.changes.files).toBe(0);
    expect(result.discrepancies).toEqual([]);
    expect(manager.get(b)!.worktree).toBe("");
  }, 30_000);

  test("a dependency that times out cancels its dependents too", async () => {
    const { manager } = await harness(
      { scenario: "hang", workMs: 20 },
      { maxConcurrent: 4, budget: { idleMs: 150, wallClockMs: 60_000, tokens: 1_000_000, blockedMs: 60_000 } },
    );

    const a = (await manager.spawn(spec({ task: "hangs" }))).workerID;
    const b = (await manager.spawn(spec({ task: "waits on it", dependsOn: [a] }))).workerID;

    await waitFor(() => stateOf(manager, a) === "timed_out", 10_000, "the idle watchdog to fire");
    await waitFor(() => stateOf(manager, b) === "cancelled", 5_000, "the dependent to be cancelled");
    expect(manager.get(b)!.reason).toBe(`dependency_failed:${a}`);
  }, 30_000);

  test("a dependency on a worker that does not exist is rejected at spawn, leaving no row", async () => {
    const { manager, store } = await harness({}, { maxConcurrent: 2 });
    let error: unknown;
    try {
      await manager.spawn(spec({ dependsOn: ["w-404"] }));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(DependencyError);
    expect((error as Error).message).toMatch(/w-404/);
    expect(store.listWorkers()).toEqual([]);
  });

  test("a dependency that has already failed is rejected at spawn, not accepted and then cancelled", async () => {
    // The ordinary sequence that gets here: a worker fails, and Claude spawns
    // the follow-up that depended on it without reading the result first.
    // Returning an id for a worker the queue is about to cancel would read as a
    // worker that started and then died.
    const { manager, store } = await harness(
      { scenario: "hang", workMs: 20 },
      { maxConcurrent: 2, budget: { idleMs: 150, wallClockMs: 60_000, tokens: 1_000_000, blockedMs: 60_000 } },
    );
    const a = (await manager.spawn(spec({ task: "will time out" }))).workerID;
    await waitFor(() => stateOf(manager, a) === "timed_out", 10_000, "the dependency to time out");

    let error: unknown;
    try {
      await manager.spawn(spec({ task: "too late", dependsOn: [a] }));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(DependencyError);
    expect((error as Error).message).toMatch(/timed_out/);
    expect(store.listWorkers().map((r) => r.workerID)).toEqual([a]);
  }, 30_000);

  test("a blocked dependency is neither satisfied nor failed — its dependent waits", async () => {
    // `blocked` is settled, but it is settled *asking a question*. Failing its
    // dependents the moment it asks would turn every escalation into a cascade.
    const { manager } = await harness({ scenario: "blocked", workMs: 20 }, { maxConcurrent: 4 });

    const a = (await manager.spawn(spec({ task: "asks something" }))).workerID;
    const b = (await manager.spawn(spec({ task: "waits", dependsOn: [a] }))).workerID;

    await waitFor(() => stateOf(manager, a) === "blocked", 8_000, "the dependency to block");
    await sleep(120);
    expect(stateOf(manager, b)).toBe("spawned");
    expect(manager.queueHint(b)!.waitingFor).toEqual([a]);
  }, 30_000);
});

// ---------------------------------------------------------------------------

describe("cancelling and disposing with a full queue", () => {
  test("dispose() returns with workers queued, and leaves no worktree behind them", async () => {
    // The shutdown hazard the queue introduced: `dispose()` awaits every
    // worker's `done`, and a queued worker's `done` is parked on the admission
    // promise. If cancelling it does not settle that promise, this test hangs.
    const { manager, store } = await harness({ workMs: 200 }, { maxConcurrent: 1 });
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) ids.push((await manager.spawn(spec({ task: `t${i}` }))).workerID);
    expect(ids.slice(1).every((id) => manager.queueHint(id) !== undefined)).toBe(true);

    await manager.dispose();

    const rows = ids.map((id) => store.getWorker(id)!);
    expect(rows.every((r) => ["cancelled", "completed"].includes(r.state))).toBe(true);
    // The three that never started allocated nothing at all.
    expect(rows.slice(1).every((r) => r.worktree === "")).toBe(true);
  }, 30_000);

  test("cancelling a queued worker settles it as cancelled, without touching the ones running", async () => {
    const { manager } = await harness({ workMsFor: { "w-001": 400 }, workMs: 30 }, { maxConcurrent: 1 });
    const a = (await manager.spawn(spec({ task: "running" }))).workerID;
    const b = (await manager.spawn(spec({ task: "queued" }))).workerID;
    const c = (await manager.spawn(spec({ task: "also queued" }))).workerID;
    await waitFor(() => stateOf(manager, a) === "running", 8_000, "the admitted worker to be prompted");

    const cancelled = await manager.cancel(b, "changed_my_mind");
    expect(cancelled.state).toBe("cancelled");
    expect(cancelled.reason).toBe("changed_my_mind");
    expect(stateOf(manager, a)).toBe("running");

    // …and the queue closed over the hole rather than stalling on it.
    await waitFor(() => stateOf(manager, c) === "completed", 10_000, "the worker behind it to run");
  }, 30_000);

  test("a worker cancelled between admission and its session never opens one", async () => {
    // The window the queue widened: between `spawn()` returning and the session
    // existing there is nothing for an abort to act on. It used to be recorded
    // and then ignored, and the worker ran to completion anyway. Cancelling in
    // the same tick as the spawn lands squarely in it.
    const { manager, store } = await harness({ workMs: 200 }, { maxConcurrent: 3 });
    const id = (await manager.spawn(spec({ task: "cancelled before it could start" }))).workerID;
    const cancelled = await manager.cancel(id, "changed_my_mind");

    expect(cancelled.state).toBe("cancelled");
    expect(cancelled.reason).toBe("changed_my_mind");
    expect(cancelled.sessionID).toBeUndefined();
    expect(cancelled.result!.reportSource).toBe("not_started");
    // And no prompt was ever sent, which is the fact the state is claiming.
    expect(store.listEvents(id).some((e) => e.kind === "state:running")).toBe(false);
  }, 20_000);

  test("halt() settles parked admissions rather than leaving promises nobody resolves", async () => {
    const { manager } = await harness({ workMs: 400 }, { maxConcurrent: 1 });
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) ids.push((await manager.spawn(spec({ task: `t${i}` }))).workerID);

    manager.halt();
    // A halted manager writes nothing — that is what makes it a simulated crash
    // rather than a shutdown — so the rows stay where they were.
    await sleep(50);
    expect(manager.get(ids[2]!)!.state).toBe("spawned");
  }, 20_000);
});

// ---------------------------------------------------------------------------

describe("the scheduler on its own", () => {
  test("a cycle is found and named, over a graph built by hand", () => {
    // `validate`'s existence rule means no cycle can reach it through the
    // ordinary spawn path — every edge points backwards in spawn order. This is
    // the check the day that rule is relaxed, and a check that cannot be
    // exercised is a check nobody can trust, so it is exercised here directly.
    const edges: Record<string, string[]> = { "w-002": ["w-003"], "w-003": ["w-001"] };
    const cycle = findCycle("w-001", ["w-002"], (id) => edges[id] ?? []);
    expect(cycle).toEqual(["w-001", "w-002", "w-003", "w-001"]);

    expect(findCycle("w-001", ["w-001"], () => [])).toEqual(["w-001", "w-001"]);
    expect(findCycle("w-001", ["w-002"], () => [])).toBeUndefined();
  });

  test("a cycle reaching the scheduler is rejected rather than queued", () => {
    const states = new Map<string, WorkerState>([
      ["w-001", "spawned"],
      ["w-002", "spawned"],
    ]);
    const s = new Scheduler({ maxConcurrent: 1, stateOf: (id) => states.get(id) });
    void s.enqueue("w-001", ["w-002"]);
    expect(() => s.validate("w-002", ["w-001"])).toThrow(DependencyError);
    expect(() => s.validate("w-002", ["w-001"])).toThrow(/w-002 -> w-001 -> w-002/);
  });

  test("the cap is clamped rather than trusted", () => {
    expect(clampConcurrency(undefined)).toBe(3);
    expect(clampConcurrency(0)).toBe(1);
    expect(clampConcurrency(-4)).toBe(1);
    expect(clampConcurrency(2.9)).toBe(2);
    expect(clampConcurrency(1_000)).toBe(32);
    expect(clampConcurrency(Number.NaN)).toBe(3);
  });

  test("a dependency's outcome is decided by its state, and `blocked` is not a verdict", () => {
    const states = new Map<string, WorkerState>();
    const s = new Scheduler({ maxConcurrent: 1, stateOf: (id) => states.get(id) });
    const check = (state: WorkerState): string => {
      states.set("d", state);
      return s.outcomeOf("d");
    };
    expect(check("completed")).toBe("satisfied");
    expect(check("merged")).toBe("satisfied");
    expect(check("blocked")).toBe("waiting");
    expect(check("running")).toBe("waiting");
    expect(check("spawned")).toBe("waiting");
    expect(check("failed")).toBe("failed");
    expect(check("timed_out")).toBe("failed");
    expect(check("over_budget")).toBe("failed");
    expect(check("cancelled")).toBe("failed");
    expect(check("interrupted")).toBe("failed");
    // A dependency the index has never heard of cannot ever be satisfied.
    expect(s.outcomeOf("nobody")).toBe("failed");
  });

  test("two workers finishing in the same tick admit exactly the free slots, not more", () => {
    // Single-threaded, so this is not a data race — but a `release` that pumped
    // the whole queue rather than up to the cap would over-admit here.
    const states = new Map<string, WorkerState>();
    const admitted: string[] = [];
    const s = new Scheduler({ maxConcurrent: 2, stateOf: (id) => states.get(id) });
    for (const id of ["a", "b", "c", "d", "e"]) {
      states.set(id, "spawned");
      void s.enqueue(id, []).then((v) => {
        if (v.kind === "start") admitted.push(id);
      });
    }
    expect(s.running).toBe(2);
    expect(s.queued).toBe(3);
    s.release("a");
    s.release("b");
    expect(s.running).toBe(2);
    expect(s.queued).toBe(1);
  });
});

// ---------------------------------------------------------------------------

describe("restart semantics (ADR-0004)", () => {
  test("a queued worker comes back as interrupted with a reason that says it never started", async () => {
    // The queue is in-process. `recover()` already turns mid-flight rows into
    // `interrupted`; what Phase 5 adds is telling a row that was *queued* apart
    // from one that was working, because the answer to the first is "spawn it
    // again, nothing was spent".
    const repo = makeGoldenRepo("sched-restart");
    cleanup.push(repo.cleanup);
    const mock = await OCMock.start({ heartbeatMs: 20, workMs: 2_000, report: TRUTHFUL });
    cleanup.push(() => mock.stop());
    const backend = new ServeBackend({ baseUrl: mock.baseUrl });
    cleanup.push(() => backend.dispose());
    await backend.start();
    const dbPath = join(repo.path, "orchestrator.db");

    const first = new Store(dbPath);
    const managerA = new WorkerManager({ backend, store: first, repoRoot: repo.path, tickMs: 10, maxConcurrent: 1, verifyTests: false });
    const running = (await managerA.spawn(spec({ task: "runs" }))).workerID;
    const queued = (await managerA.spawn(spec({ task: "queues" }))).workerID;
    await waitFor(() => managerA.get(running)!.state === "running", 8_000, "the first worker to start");
    managerA.halt();
    first.close();

    const second = new Store(dbPath);
    cleanup.push(() => second.close());
    const managerB = new WorkerManager({ backend, store: second, repoRoot: repo.path, tickMs: 10, verifyTests: false });
    cleanup.push(() => managerB.dispose());
    const recovered: WorkerRecord[] = await managerB.recover();

    expect(recovered.map((r) => r.workerID).sort()).toEqual([running, queued].sort());
    expect(second.getWorker(queued)!.reason).toBe("manager_restart_while_queued");
    expect(second.getWorker(running)!.reason).toBe("manager_restart");
  }, 30_000);
});
