/**
 * §11 Phase 8's model routing and worker priorities.
 *
 * The routing half is a pure function and is tested as one: it is the only part
 * of this system where "which model" is decided, and a wrong answer is invisible
 * — the worker runs, produces something, and nothing looks broken. So the table
 * below is exhaustive about precedence rather than illustrative.
 *
 * The priority half is tested against the real scheduler, by observation, the
 * way Phase 5's cap is: a queue that reorders correctly in a unit test and
 * starves something in production has not been tested.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { OCMock } from "../ocmock/server.js";
import { ServeBackend } from "../../src/opencode/index.js";
import { Scheduler, WorkerManager, parseModelPool, route } from "../../src/manager/index.js";
import { Store } from "../../src/store/index.js";
import { makeGoldenRepo } from "../fixtures/golden.js";
import { sleep } from "../helpers.js";
import type { WorkerSpec } from "../../src/manager/types.js";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await Promise.resolve(fn()).catch(() => {});
});

const CONFIG = {
  defaultModel: "opencode/default-model",
  perMode: { review: "opencode/reviewer", research: "opencode/researcher" },
  reviewPool: ["opencode/pool-a", "opencode/pool-b"],
};

// ---------------------------------------------------------------------------

describe("model routing (§11 Phase 8, DD-9)", () => {
  test("an explicit model always wins, even over review diversity", () => {
    // Claude naming a model is not a hint. Reviewing with the author's own model
    // is a legitimate experiment — two runs of one model is a real comparison —
    // and silently overriding the parameter would make it a suggestion.
    const r = route(CONFIG, { mode: "review", explicit: "opencode/asked-for", avoid: "opencode/asked-for" });
    expect(r.model).toBe("opencode/asked-for");
    expect(r.reason).toBe("explicit");
    // …and it still records that this one is not an independent read.
    expect(r.diverse).toBe(false);
  });

  test("a reviewer is routed away from the model that wrote the code", () => {
    const r = route(CONFIG, { mode: "review", avoid: "opencode/pool-a" });
    expect(r.model).toBe("opencode/pool-b");
    expect(r.reason).toBe("review_diversity");
    expect(r.diverse).toBe(true);
    expect(r.avoided).toBe("opencode/pool-a");
  });

  test("the pool is preferred, then the mode preset, then the default", () => {
    expect(route(CONFIG, { mode: "review", avoid: "opencode/other" }).model).toBe("opencode/pool-a");
    const noPool = { ...CONFIG, reviewPool: [] };
    expect(route(noPool, { mode: "review", avoid: "opencode/other" }).model).toBe("opencode/reviewer");
    const bare = { defaultModel: "opencode/default-model" };
    expect(route(bare, { mode: "review", avoid: "opencode/other" }).model).toBe("opencode/default-model");
  });

  test("when every candidate IS the author's model, it says so rather than pretending", () => {
    // The honest case, and the one ADR-0005 had to state as permanent. A
    // same-model review is weaker evidence; `diverse: false` is what carries that
    // into the result instead of leaving Claude to assume the stronger kind.
    const oneModel = { defaultModel: "opencode/only" };
    const r = route(oneModel, { mode: "review", avoid: "opencode/only" });
    expect(r.model).toBe("opencode/only");
    expect(r.diverse).toBe(false);
    expect(r.avoided).toBe("opencode/only");
  });

  test("a review with no known author is routed by preset, not by diversity", () => {
    // `reviewOf` is optional: a review worker can be pointed at a task rather
    // than at another worker, and there is then nothing to differ from.
    const r = route(CONFIG, { mode: "review" });
    expect(r.model).toBe("opencode/reviewer");
    expect(r.reason).toBe("mode_preset");
    expect(r.diverse).toBeUndefined();
  });

  test("non-review modes take their preset, then the default", () => {
    expect(route(CONFIG, { mode: "research" })).toMatchObject({ model: "opencode/researcher", reason: "mode_preset" });
    expect(route(CONFIG, { mode: "implement" })).toMatchObject({ model: "opencode/default-model", reason: "default" });
  });

  test("routing is deterministic — the same inputs give the same model twice", () => {
    // A system whose whole value is evidence should answer "which model reviewed
    // this?" the same way whenever it is asked.
    const a = route(CONFIG, { mode: "review", avoid: "opencode/pool-a" });
    const b = route(CONFIG, { mode: "review", avoid: "opencode/pool-a" });
    expect(a).toEqual(b);
  });

  test("the pool parser is tolerant of the ways an env var goes wrong", () => {
    expect(parseModelPool("a, b ,, c,a")).toEqual(["a", "b", "c"]);
    expect(parseModelPool("")).toEqual([]);
    expect(parseModelPool(undefined)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------

describe("worker priorities (§11 Phase 8, deferred here by ADR-0004)", () => {
  const admitted = (): { scheduler: Scheduler; order: string[]; states: Map<string, string> } => {
    const order: string[] = [];
    const states = new Map<string, string>();
    const scheduler = new Scheduler({
      maxConcurrent: 1,
      stateOf: (id) => states.get(id) as never,
      onEvent: (id, kind) => {
        if (kind === "admitted") order.push(id);
      },
    });
    return { scheduler, order, states };
  };

  test("the highest priority among runnable entries goes first; ties keep spawn order", async () => {
    const { scheduler, order } = admitted();
    const done: Array<Promise<unknown>> = [];
    done.push(scheduler.enqueue("low", [], 0));
    done.push(scheduler.enqueue("high", [], 10));
    done.push(scheduler.enqueue("mid", [], 5));
    done.push(scheduler.enqueue("low2", [], 0));

    // One slot, so admission order is fully observable.
    expect(order).toEqual(["low"]); // already running before the others arrived
    scheduler.release("low");
    expect(order).toEqual(["low", "high"]);
    scheduler.release("high");
    expect(order).toEqual(["low", "high", "mid"]);
    scheduler.release("mid");
    // Equal priority falls back to spawn order, which is what makes the whole
    // thing deterministic rather than merely ordered.
    expect(order).toEqual(["low", "high", "mid", "low2"]);
    scheduler.release("low2");
    await Promise.all(done);
  });

  test("priority never lets a worker skip a dependency", () => {
    // The property ADR-0004 was careful about, and the one a priority scheme is
    // most likely to break: the scan covers entries that are *runnable*, and
    // priority only reorders among those.
    const { scheduler, order, states } = admitted();
    states.set("dep", "running");
    void scheduler.enqueue("dep", [], 0);
    void scheduler.enqueue("urgent", ["dep"], 100);
    void scheduler.enqueue("filler", [], 1);

    // `urgent` outranks everything and still waits, because its dependency has
    // not completed. `filler` runs instead — the queue is not blocked at its head.
    expect(order).toEqual(["dep"]);
    scheduler.release("dep");
    expect(order).toEqual(["dep", "filler"]);
    states.set("dep", "completed");
    scheduler.release("filler");
    expect(order).toEqual(["dep", "filler", "urgent"]);
  });

  test("the queue position a worker is told is its admission position, not its array index", () => {
    // "3rd of 5" is a promise about when this worker runs. Taken from the array
    // it would quietly mean something else as soon as anything jumped the queue.
    const { scheduler, states } = admitted();
    states.set("blocker", "running");
    void scheduler.enqueue("blocker", [], 0);
    void scheduler.enqueue("first", [], 0);
    void scheduler.enqueue("jumper", [], 50);

    expect(scheduler.hint("jumper")?.position).toBe(1);
    expect(scheduler.hint("first")?.position).toBe(2);
  });
});

// ---------------------------------------------------------------------------

describe("routing and priorities through the manager", () => {
  async function harness(
    managerOpts: Partial<ConstructorParameters<typeof WorkerManager>[0]> = {},
  ): Promise<{ manager: WorkerManager; store: Store; mock: OCMock }> {
    const repo = makeGoldenRepo("routing");
    cleanup.push(repo.cleanup);
    const mock = await OCMock.start({
      heartbeatMs: 20,
      writeFiles: true,
      report: { status: "completed", summary: "done", changes: [], risks: [], questions: [], followUps: [] },
    });
    cleanup.push(() => mock.stop());
    const backend = new ServeBackend({ baseUrl: mock.baseUrl });
    cleanup.push(() => backend.dispose());
    await backend.start();
    const store = new Store(join(repo.path, "db.sqlite"));
    cleanup.push(() => store.close());
    const manager = new WorkerManager({
      backend,
      store,
      repoRoot: repo.path,
      tickMs: 10,
      verifyTests: false,
      ...managerOpts,
    });
    cleanup.push(() => manager.dispose());
    mocks.set(manager, mock);
    return { manager, store, mock };
  }

  /** The mock behind a manager, so a test can script a session mid-run. */
  const mocks = new WeakMap<WorkerManager, OCMock>();
  const mockOf = (m: WorkerManager): OCMock => mocks.get(m)!;

  const spec = (over: Partial<WorkerSpec> = {}): WorkerSpec => ({ runID: "run-1", task: "t", mode: "implement", ...over });

  test("a reviewer really is spawned on a different model, and the result says so", async () => {
    const { manager, store } = await harness({
      defaultModel: "opencode/author-model",
      reviewPool: ["opencode/author-model", "opencode/reviewer-model"],
    });
    const author = await manager.spawn(spec());
    await manager.wait(author.workerID, 6_000);
    expect(manager.get(author.workerID)!.model).toBe("opencode/author-model");

    const reviewer = await manager.spawn(spec({ mode: "review", reviewOf: author.workerID }));
    // The pool's first entry is the author's model, so routing skipped it.
    expect(manager.get(reviewer.workerID)!.model).toBe("opencode/reviewer-model");

    const done = await manager.wait(reviewer.workerID, 8_000);
    expect(done.state).toBe("completed");
    expect(done.result!.review).toEqual({
      of: author.workerID,
      authorModel: "opencode/author-model",
      crossModel: true,
    });

    const spawned = store.listEvents(reviewer.workerID, { limit: 50 }).find((e) => e.kind === "spawned")!;
    expect(spawned.detail["routedBy"]).toBe("review_diversity");
    expect(spawned.detail["crossModel"]).toBe(true);
  }, 30_000);

  test("with only one model available, the review happens and is marked as NOT independent", async () => {
    // The pre-Phase-8 world, which is still the world for anyone with one model
    // configured. It must keep working, and it must stop being silent.
    const { manager } = await harness({ defaultModel: "opencode/only-model" });
    const author = await manager.spawn(spec());
    await manager.wait(author.workerID, 6_000);

    const reviewer = await manager.spawn(spec({ mode: "review", reviewOf: author.workerID }));
    expect(manager.get(reviewer.workerID)!.model).toBe("opencode/only-model");
    const done = await manager.wait(reviewer.workerID, 8_000);
    expect(done.result!.review?.crossModel).toBe(false);
  }, 30_000);

  test("a read-only worker is not accused of failing to change what it never claimed to write", async () => {
    // Found live, across four models: a reviewer told plainly to leave `changes`
    // empty puts the file it reviewed there anyway, and reconciliation reported
    // `claimed_not_changed` — a false finding, in the one channel this system
    // relies on for true ones. Instruction-following is not a contract
    // (ADR-0002), so the rule is off for workers that cannot write at all.
    const { manager } = await harness({ defaultModel: "opencode/only" });
    const author = await manager.spawn(spec());
    await manager.wait(author.workerID, 6_000);

    const reviewer = await manager.spawn(spec({ mode: "review", reviewOf: author.workerID }));
    const sessionID = await (async () => {
      const deadline = Date.now() + 8_000;
      while (Date.now() < deadline) {
        const id = manager.get(reviewer.workerID)?.sessionID;
        if (id) return id;
        await sleep(10);
      }
      throw new Error("no session");
    })();
    // The reviewer names the file it read, exactly as the real models do.
    mockOf(manager).setReport(sessionID, {
      status: "completed",
      summary: "The clamp implementation is correct.",
      changes: [{ file: "hello.txt", action: "modified", rationale: "reviewed" }],
      risks: [],
      questions: [],
      followUps: [],
    });
    const done = await manager.wait(reviewer.workerID, 8_000);
    expect(done.state).toBe("completed");
    expect(done.result!.changes.files).toBe(0);
    expect(done.result!.discrepancies).toEqual([]);
  }, 30_000);

  test("a read-only worker that DOES change something is still caught", async () => {
    // The half that matters more, and that stays on: a worker which cannot write
    // and wrote anyway is a finding about the sandbox, not about the report.
    const { manager } = await harness({ defaultModel: "opencode/only" });
    const author = await manager.spawn(spec());
    await manager.wait(author.workerID, 6_000);

    const reviewer = await manager.spawn(spec({ mode: "review", reviewOf: author.workerID }));
    const deadline = Date.now() + 8_000;
    let sessionID: string | undefined;
    while (Date.now() < deadline && !sessionID) {
      sessionID = manager.get(reviewer.workerID)?.sessionID;
      if (!sessionID) await sleep(10);
    }
    // A reviewer that escapes its read-only sandbox and writes something.
    mockOf(manager).setWrite(sessionID!, [{ path: "sneaky.txt", content: "a reviewer should not be able to write this\n" }]);

    const done = await manager.wait(reviewer.workerID, 8_000);
    expect(done.result!.changes.paths).toContain("sneaky.txt");
    expect(done.result!.discrepancies.some((d) => d.kind === "changed_not_claimed")).toBe(true);
  }, 30_000);

  test("a high-priority worker jumps the queue, and its record says where it is", async () => {
    const { manager } = await harness({ maxConcurrent: 1 });
    const blocker = await manager.spawn(spec({ task: "occupies the slot" }));
    await manager.wait(blocker.workerID, 6_000).catch(() => {});

    // Spawned while nothing is free, so ordering is decided by the queue.
    const { manager: m2 } = await harness({ maxConcurrent: 1 });
    const hold = await m2.spawn(spec({ task: "holds the slot" }));
    const ordinary = await m2.spawn(spec({ task: "ordinary" }));
    const urgent = await m2.spawn(spec({ task: "urgent", priority: 10 }));
    expect(m2.queueHint(urgent.workerID)?.position).toBe(1);
    expect(m2.queueHint(ordinary.workerID)?.position).toBe(2);

    for (const id of [hold.workerID, ordinary.workerID, urgent.workerID]) await m2.wait(id, 10_000);
  }, 30_000);
});
