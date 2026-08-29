/**
 * The admission gate: the concurrency cap, the queue, and `dependsOn`
 * (`projectplan.md` §11 Phase 5, §10's "manager/ … queue").
 *
 * Everything here exists between `spawn()` returning an id and `prepareAndRun()`
 * creating a worktree. That position is the whole design:
 *
 * - **`spawn()` still returns in under a second (DD-1).** A queued worker is
 *   *accepted*, not rejected. The gate lives inside the detached run loop, so
 *   `worker_spawn` never blocks on a slot; a tool that waited for one would
 *   convert this system's async contract into a synchronous one and the symptom
 *   would be a host giving up at sixty seconds.
 * - **Queue time is not work time.** `runningSince` — the wall-clock budget's
 *   origin — is set in `prepareAndRun()` after the subscription is live, which
 *   is strictly after admission. A worker that waits ten minutes for a slot
 *   still gets its full fifteen minutes of work. Nothing in this file may start
 *   that clock.
 * - **A worker waiting on a dependency holds no slot.** That is the single
 *   property that keeps `dependsOn` plus a cap from generating deadlocks: the
 *   queue is scanned for the first *runnable* entry rather than blocked at its
 *   head, so a dependency can never sit behind its own dependent.
 *
 * The queue is in-process and does not survive a restart. See
 * `docs/adr/0004-queue-and-dependencies.md` for why, and for the
 * failed-dependency rule this file implements.
 */

import { isFinal, type WorkerState } from "./state.js";

/**
 * §3, trap 3 of the Phase 5 handoff, as a number.
 *
 * Phase 1 measured **four** concurrent sessions on one server completing with no
 * cross-talk at ~1.4–1.9× single-session latency (`docs/phase0-facts.md`
 * "Unresolved" 2). That is one run, four sessions, one free-tier model: it is
 * the ceiling that worked once, not the number to ship. Three leaves headroom
 * inside a measurement nobody has repeated, and `ORCHESTRATOR_MAX_CONCURRENT`
 * moves it for anyone who has measured their own.
 */
export const DEFAULT_MAX_CONCURRENT = 3;

/** A sanity ceiling, not a measurement. Past this, see the fact sheet first. */
export const MAX_CONCURRENT_LIMIT = 32;

/** What the run loop is told when it stops waiting for a slot. */
export type Admission =
  /** Take a slot and run. Exactly one {@link Scheduler.release} must follow. */
  | { readonly kind: "start" }
  /** It will never start. The reason is machine-readable and names the cause. */
  | { readonly kind: "refused"; readonly reason: string };

/** Why a worker is sitting in `spawned` rather than preparing. */
export type QueueReason = "queued" | "waiting_on_dependencies";

/** What `worker_status` and `worker_list` need to tell the two apart. */
export interface QueueHint {
  readonly reason: QueueReason;
  /** 1-based position among *all* queued workers, in spawn order. */
  readonly position: number;
  readonly queueLength: number;
  /** The dependencies that have not completed yet. Empty when `queued`. */
  readonly waitingFor: readonly string[];
  readonly running: number;
  readonly maxConcurrent: number;
}

export interface SchedulerOptions {
  readonly maxConcurrent?: number;
  /**
   * The authority on a dependency's state.
   *
   * Read live rather than cached: a dependency's satisfaction is decided at the
   * moment the queue is pumped, and a copy taken at spawn would be stale by
   * definition.
   */
  readonly stateOf: (workerID: string) => WorkerState | undefined;
  /** The audit trail. Every admission decision is worth a row. */
  readonly onEvent?: (workerID: string, kind: string, detail: Record<string, unknown>) => void;
}

/** A `dependsOn` that cannot be honoured. Rejected at spawn, never queued. */
export class DependencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DependencyError";
  }
}

/**
 * Whether a dependency has been met, will never be met, or is still working.
 *
 * `blocked` is deliberately `waiting` and not `failed`: a blocked worker has
 * stopped, but it stopped to ask a question, and answering it is the ordinary
 * path back to `completed`. Failing its dependents the moment it asks would turn
 * every escalation into a cascade.
 */
export type DependencyOutcome = "satisfied" | "failed" | "waiting";

interface QueueEntry {
  readonly workerID: string;
  readonly dependsOn: readonly string[];
  readonly settle: (admission: Admission) => void;
}

export class Scheduler {
  readonly maxConcurrent: number;
  private readonly stateOf: (workerID: string) => WorkerState | undefined;
  private readonly onEvent: (workerID: string, kind: string, detail: Record<string, unknown>) => void;
  /** FIFO by spawn time. Order is spawn order; admission order is not. */
  private readonly queue: QueueEntry[] = [];
  /** Admitted and not yet released — `preparing`, `running` or `blocked`. */
  private readonly occupied = new Set<string>();
  /** Every worker's declared dependencies, kept for cycle checks and reporting. */
  private readonly edges = new Map<string, readonly string[]>();
  /**
   * Workers this scheduler refused.
   *
   * Needed because a refusal is delivered asynchronously: the run loop settles
   * the worker as `cancelled` a tick later, and until it does, `stateOf` still
   * says `spawned`. A dependent scanned in the same pump would therefore see its
   * dependency as merely *waiting* and the cascade would stall for a pump.
   */
  private readonly refused = new Set<string>();
  private halted = false;

  constructor(opts: SchedulerOptions) {
    this.maxConcurrent = clampConcurrency(opts.maxConcurrent);
    this.stateOf = opts.stateOf;
    this.onEvent = opts.onEvent ?? (() => {});
  }

  // --- spawn-time validation ----------------------------------------------

  /**
   * Reject a `dependsOn` that would deadlock, before any row is written.
   *
   * Three rejections, all loud, because a rejected spawn is legible and a wedged
   * run is not — nothing in the system reports a wave that is waiting forever.
   *
   * 1. **A dependency that does not exist.** Worker ids are minted by the
   *    manager, so Claude cannot name one before it has been handed back. An
   *    unknown id is a typo, and a typo that is honoured is a worker that never
   *    starts and never says why.
   * 2. **A dependency that has already failed.** Exactly as unsatisfiable as one
   *    that does not exist, and known here rather than a tick later. Accepting
   *    it would mean returning an id for a worker the queue is about to cancel,
   *    which reads to the caller as a worker that started and then died.
   * 3. **A cycle.** Rules 1 and 2 make the graph acyclic by construction — every
   *    edge points backwards in spawn order — so today this check cannot fire
   *    through {@link Scheduler.enqueue}. It is here because that argument is a
   *    property of rule 1, not of the queue, and the day rule 1 is relaxed the
   *    deadlock it prevents is silent. It is tested directly, against a graph
   *    built by hand.
   */
  validate(workerID: string, dependsOn: readonly string[]): void {
    const deps = [...new Set(dependsOn)];
    const unknown = deps.filter((id) => id !== workerID && this.stateOf(id) === undefined && !this.edges.has(id));
    if (unknown.length > 0) {
      throw new DependencyError(
        `dependsOn names ${unknown.length === 1 ? "a worker" : "workers"} that do not exist: ${unknown.join(", ")}. ` +
          "Worker ids are assigned by worker_spawn, so a dependency must already have been spawned — " +
          "spawn it first and pass the id it returns.",
      );
    }
    const dead = deps.filter((id) => id !== workerID && this.outcomeOf(id) === "failed");
    if (dead.length > 0) {
      throw new DependencyError(
        `dependsOn names ${dead.length === 1 ? "a worker" : "workers"} that will never complete: ` +
          `${dead.map((id) => `${id} (${this.stateOf(id) ?? "unknown"})`).join(", ")}. ` +
          "Read its worker_result first: either it needs respawning, or this worker does not depend on it after all.",
      );
    }
    const cycle = findCycle(workerID, deps, (id) => this.edges.get(id) ?? []);
    if (cycle) {
      throw new DependencyError(
        `dependsOn would create a dependency cycle: ${cycle.join(" -> ")}. ` +
          "Nothing in that loop could ever start, so the spawn is rejected rather than queued forever.",
      );
    }
  }

  // --- the queue ----------------------------------------------------------

  /**
   * Register a worker and hand back the promise its run loop waits on.
   *
   * Resolves with `start` when a slot is free and every dependency has
   * completed, or with `refused` when the worker is cancelled while queued or a
   * dependency ends in a state it can never come back from.
   */
  enqueue(workerID: string, dependsOn: readonly string[]): Promise<Admission> {
    const deps = [...new Set(dependsOn)].filter((id) => id !== workerID);
    this.edges.set(workerID, deps);
    return new Promise<Admission>((resolve) => {
      this.queue.push({ workerID, dependsOn: deps, settle: resolve });
      this.pump();
    });
  }

  /**
   * Why this worker has not started, or `undefined` if it has been admitted.
   *
   * The record carries the {@link QueueHint.reason} as its `reason` so a stored
   * row says why it is idle; the position and the outstanding dependencies are
   * in-process only, because a queue position is not durable state and writing
   * it to the index would be a number that lies after a restart.
   */
  hint(workerID: string): QueueHint | undefined {
    const index = this.queue.findIndex((e) => e.workerID === workerID);
    if (index < 0) return undefined;
    const entry = this.queue[index]!;
    const waitingFor = entry.dependsOn.filter((id) => this.outcomeOf(id) !== "satisfied");
    return {
      reason: waitingFor.length > 0 ? "waiting_on_dependencies" : "queued",
      position: index + 1,
      queueLength: this.queue.length,
      waitingFor,
      running: this.occupied.size,
      maxConcurrent: this.maxConcurrent,
    };
  }

  isQueued(workerID: string): boolean {
    return this.queue.some((e) => e.workerID === workerID);
  }

  /** Admitted workers, for the "never more than the cap" assertion. */
  get running(): number {
    return this.occupied.size;
  }

  get queued(): number {
    return this.queue.length;
  }

  /**
   * Give the slot back and let the queue move.
   *
   * Called after the worker has genuinely settled, not when its stream closes:
   * a dependent may only start once its dependency is `completed`, and
   * `completed` is a fact only after the snapshot, the independent test re-run
   * and the reconciliation have all happened. One release point for the slot and
   * for dependency satisfaction keeps the two from disagreeing.
   */
  release(workerID: string): void {
    this.occupied.delete(workerID);
    this.pump();
  }

  /** Refuse a queued worker. A no-op once it has been admitted or settled. */
  reject(workerID: string, reason: string): boolean {
    const removed = this.remove(workerID, reason);
    if (removed) this.pump();
    return removed;
  }

  /** The removal half of {@link reject}, without the re-entrant pump. */
  private remove(workerID: string, reason: string): boolean {
    const index = this.queue.findIndex((e) => e.workerID === workerID);
    if (index < 0) return false;
    const [entry] = this.queue.splice(index, 1);
    this.refused.add(workerID);
    entry!.settle({ kind: "refused", reason });
    return true;
  }

  /**
   * Stop dead, the way {@link WorkerManager.halt} does.
   *
   * Every parked promise is settled so nothing is left awaiting a slot that will
   * never come — `dispose()` awaits every worker's `done`, and a `done` parked
   * on this queue forever is a shutdown that never returns.
   */
  halt(): void {
    this.halted = true;
    for (const entry of this.queue.splice(0)) entry.settle({ kind: "refused", reason: "manager_halted" });
    this.occupied.clear();
  }

  // --- dependencies -------------------------------------------------------

  /**
   * ADR-0004's rule, in one function.
   *
   * `completed` and `merged` satisfy. Every final state and `interrupted` fail —
   * a dependent waiting on one of those would wait forever, and a run that hangs
   * because a dependency failed is the worst outcome available, because nothing
   * in the system reports it. Everything else is still in flight.
   */
  outcomeOf(workerID: string): DependencyOutcome {
    if (this.refused.has(workerID)) return "failed";
    const state = this.stateOf(workerID);
    if (state === undefined) return "failed";
    if (state === "completed" || state === "merged") return "satisfied";
    if (isFinal(state) || state === "interrupted") return "failed";
    return "waiting";
  }

  // --- the pump -----------------------------------------------------------

  /**
   * Fail what can never run, then start what can — in that order.
   *
   * The failure sweep comes first and loops, because refusing one entry can doom
   * the next: cancel `a`, and `b` which depends on `a` is doomed, and `c` which
   * depends on `b` with it. Resolving the whole cascade in one pump is what
   * makes a failed dependency produce a legible chain of cancellations rather
   * than one cancellation per subsequent event.
   *
   * The admission loop then scans the queue for the first entry whose
   * dependencies are *all* satisfied, rather than stopping at the head. That
   * single word — first *runnable*, not first — is what guarantees a dependency
   * is never queued behind its own dependent.
   */
  private pump(): void {
    if (this.halted) return;

    for (;;) {
      const doomed = this.queue.find((e) => e.dependsOn.some((id) => this.outcomeOf(id) === "failed"));
      if (!doomed) break;
      const cause = doomed.dependsOn.find((id) => this.outcomeOf(id) === "failed")!;
      this.onEvent(doomed.workerID, "dependency_failed", { dependency: cause, state: this.stateOf(cause) ?? "unknown" });
      this.remove(doomed.workerID, `dependency_failed:${cause}`);
    }

    while (this.occupied.size < this.maxConcurrent) {
      const index = this.queue.findIndex((e) => e.dependsOn.every((id) => this.outcomeOf(id) === "satisfied"));
      if (index < 0) return;
      const [entry] = this.queue.splice(index, 1);
      this.occupied.add(entry!.workerID);
      this.onEvent(entry!.workerID, "admitted", {
        running: this.occupied.size,
        maxConcurrent: this.maxConcurrent,
        queued: this.queue.length,
      });
      entry!.settle({ kind: "start" });
    }
  }
}

// ---------------------------------------------------------------------------

/**
 * The cycle `dependsOn` would close, named, or `undefined`.
 *
 * Returns the path rather than a boolean because "there is a cycle" is not an
 * actionable error message and `a -> b -> c -> a` is. Exported so it can be
 * tested against a graph built by hand: {@link Scheduler.validate}'s
 * existence rule means no cycle can reach it through the ordinary spawn path,
 * and a check that cannot be exercised is a check nobody can trust.
 */
export function findCycle(
  workerID: string,
  dependsOn: readonly string[],
  edgesOf: (id: string) => readonly string[],
): string[] | undefined {
  const stack = dependsOn.map((dep) => ({ node: dep, path: [workerID, dep] }));
  const seen = new Set<string>();
  while (stack.length > 0) {
    const { node, path } = stack.pop()!;
    if (node === workerID) return path;
    if (seen.has(node)) continue;
    seen.add(node);
    for (const next of edgesOf(node)) stack.push({ node: next, path: [...path, next] });
  }
  return undefined;
}

export function clampConcurrency(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_CONCURRENT;
  return Math.max(1, Math.min(MAX_CONCURRENT_LIMIT, Math.floor(value)));
}
