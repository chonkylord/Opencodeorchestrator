/**
 * The §5 lifecycle, checked edge by edge.
 *
 * These tests are the reason `state.ts` is data rather than a switch statement:
 * a table can be walked exhaustively, and "every state that is not final has a
 * way out" is a property, not thirty separate assertions.
 */

import { describe, expect, test } from "bun:test";

import {
  FAILURE_STATES,
  IllegalTransitionError,
  TRANSITIONS,
  WORKER_STATES,
  WorkerMachine,
  can,
  isActive,
  isFinal,
  isSettled,
  next,
  peek,
  triggersFrom,
  type Trigger,
  type WorkerState,
} from "../../src/manager/state.js";

describe("the transition table", () => {
  test("covers exactly the states it declares", () => {
    const used = new Set<WorkerState>();
    for (const t of TRANSITIONS) {
      used.add(t.from);
      used.add(t.to);
    }
    expect([...used].sort()).toEqual([...WORKER_STATES].sort());
  });

  test("has no duplicate edges", () => {
    const keys = TRANSITIONS.map((t) => `${t.from} ${t.trigger}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  test("every non-final state has a way out", () => {
    // A state with no exits that is not marked final is a worker that hangs
    // forever with no error — the worst possible failure mode for a system like this one.
    for (const s of WORKER_STATES) {
      if (!isFinal(s)) expect(triggersFrom(s).length).toBeGreaterThan(0);
    }
  });

  test("a final state is left only by an act from outside, never by the run loop", () => {
    // Phase 6 loosened what `final` means and this is the load-bearing half of
    // the new definition. A final worker has no loop turning and no watchdog
    // armed, so nothing *it* does can move it — but `revise` is Claude's
    // instruction, not the worker's, exactly as `merge` is. The rule that has to
    // hold is that `revise` is the ONLY way out: a `timeout` or `complete` edge
    // out of a final state would mean a settled worker could be re-settled by an
    // event arriving late, which is the corruption the machine exists to stop.
    for (const s of WORKER_STATES) {
      if (!isFinal(s)) continue;
      for (const trigger of triggersFrom(s)) expect(trigger).toBe("revise");
    }
  });

  test("`merged` is the one state nothing can leave", () => {
    // Deliberate, and recorded in ADR-0005 rather than left as an omission: a
    // revision of a merged worker would put a commit on its branch that the
    // integration branch does not have, so the run report would name a merged
    // worker whose branch tip is not what was merged.
    expect(triggersFrom("merged")).toEqual([]);
  });

  test("every settled state that can be revised lands back in the queue", () => {
    // Not in `running`. A revision has to re-acquire a concurrency slot, and the
    // gate sits between `spawned` and `preparing` (ADR-0004), so a revision
    // admitted straight to `running` would hold no slot and would put a session
    // on the shared backend that nothing counts.
    const revisable = WORKER_STATES.filter((s) => can(s, "revise"));
    expect(revisable.sort()).toEqual(["cancelled", "completed", "failed", "over_budget", "timed_out"]);
    for (const s of revisable) expect(peek(s, "revise")).toBe("spawned");
  });

  test("every state is reachable from `spawned`", () => {
    const seen = new Set<WorkerState>(["spawned"]);
    for (let changed = true; changed; ) {
      changed = false;
      for (const t of TRANSITIONS) {
        if (seen.has(t.from) && !seen.has(t.to)) {
          seen.add(t.to);
          changed = true;
        }
      }
    }
    expect([...seen].sort()).toEqual([...WORKER_STATES].sort());
  });

  test("the §5 happy path is walkable end to end", () => {
    let s: WorkerState = "spawned";
    for (const trigger of ["prepare", "start", "complete", "merge"] as Trigger[]) s = next(s, trigger);
    expect(s).toBe("merged");
  });

  test("the blocked loop returns to running without leaving the machine", () => {
    let s: WorkerState = "running";
    s = next(s, "block");
    expect(s).toBe("blocked");
    s = next(s, "resume");
    expect(s).toBe("running");
    // …and can go round again: an answer is not a one-shot.
    expect(peek(next(s, "block"), "resume")).toBe("running");
  });

  test("the four unhappy endings are distinct and all reachable from running", () => {
    expect(peek("running", "fail")).toBe("failed");
    expect(peek("running", "timeout")).toBe("timed_out");
    expect(peek("running", "exhaust_budget")).toBe("over_budget");
    expect(peek("running", "cancel")).toBe("cancelled");
    expect(new Set(FAILURE_STATES).size).toBe(FAILURE_STATES.length);
  });

  test("§9's recovery edges exist in all three directions", () => {
    expect(peek("running", "interrupt")).toBe("interrupted");
    expect(peek("interrupted", "recover")).toBe("running");
    expect(peek("interrupted", "fail")).toBe("failed");
    expect(peek("interrupted", "cancel")).toBe("cancelled");
  });
});

describe("illegal transitions are rejected, not tolerated", () => {
  test("a completed worker cannot go back to running", () => {
    expect(can("completed", "resume")).toBe(false);
    expect(() => next("completed", "resume", "w-001")).toThrow(IllegalTransitionError);
  });

  test("a terminal worker accepts nothing the run loop could fire", () => {
    // `revise` is deliberately not in this list — it is Claude's instruction,
    // not the run loop's, and the test above pins it as the only exception.
    for (const s of WORKER_STATES.filter(isFinal)) {
      for (const trigger of ["prepare", "start", "resume", "complete", "fail", "cancel"] as Trigger[]) {
        expect(can(s, trigger)).toBe(false);
      }
    }
  });

  test("the error names the worker and the legal moves", () => {
    const err = (() => {
      try {
        next("spawned", "complete", "w-042");
        return null;
      } catch (e) {
        return e as IllegalTransitionError;
      }
    })();
    expect(err).toBeInstanceOf(IllegalTransitionError);
    expect(err!.message).toContain("w-042");
    expect(err!.message).toContain("cannot complete from spawned");
    expect(err!.message).toContain("prepare");
  });

  test("a worker cannot start without being prepared", () => {
    expect(can("spawned", "start")).toBe(false);
  });
});

describe("state categories", () => {
  test("active, settled and final partition the way callers assume", () => {
    // `wait()` resolves on settled; the run loop only runs while active; nothing
    // touches a final worker. Overlap between the first two would make a poller
    // return a worker that is still moving.
    for (const s of WORKER_STATES) {
      if (isActive(s)) expect(isSettled(s)).toBe(false);
      if (isFinal(s)) expect(isSettled(s)).toBe(true);
    }
    expect(isSettled("blocked")).toBe(true);
    expect(isFinal("blocked")).toBe(false);
    expect(isSettled("completed")).toBe(true);
    expect(isFinal("completed")).toBe(false); // Phase 4 may still merge it
  });
});

describe("WorkerMachine", () => {
  test("records why, not just what", () => {
    const seen: string[] = [];
    const m = new WorkerMachine({ workerID: "w-001", now: () => 1000, onChange: (c) => seen.push(`${c.from}->${c.to}`) });
    m.apply("prepare");
    m.apply("start");
    const change = m.apply("timeout", { reason: "idle_watchdog", detail: { silentMs: 180_000 } });

    expect(m.state).toBe("timed_out");
    expect(change.reason).toBe("idle_watchdog");
    expect(change.detail).toEqual({ silentMs: 180_000 });
    expect(change.at).toBe(1000);
    expect(seen).toEqual(["spawned->preparing", "preparing->running", "running->timed_out"]);
    expect(m.history).toHaveLength(3);
    expect(m.final).toBe(true);
  });

  test("tryApply absorbs the watchdog/terminal race and nothing else", () => {
    const m = new WorkerMachine({ initial: "running" });
    expect(m.apply("complete").to).toBe("completed");
    // The watchdog that fired a millisecond too late must not crash the loop…
    expect(m.tryApply("timeout")).toBeUndefined();
    expect(m.state).toBe("completed");
    // …but it must not have moved anything either.
    expect(m.history).toHaveLength(1);
  });

  test("history survives the blocked loop with both round trips visible", () => {
    const m = new WorkerMachine({ initial: "running" });
    m.apply("block", { reason: "worker_asked" });
    m.apply("resume");
    m.apply("block", { reason: "worker_asked_again" });
    m.apply("resume");
    m.apply("complete");
    expect(m.history.map((h) => h.trigger)).toEqual(["block", "resume", "block", "resume", "complete"]);
    expect(m.state).toBe("completed");
  });
});
