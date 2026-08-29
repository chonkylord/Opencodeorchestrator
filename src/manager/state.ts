/**
 * The worker lifecycle (`projectplan.md` §5), as data.
 *
 * The diagram in §5 is drawn with arrows; this file is those arrows, enumerated.
 * Everything else in the manager asks *this* module whether a move is legal
 * rather than deciding for itself, because a state machine that is only
 * documented is a state machine that drifts. Illegal moves throw — a worker that
 * silently slides from `completed` back to `running` is a bug that surfaces
 * three phases later as a corrupt run report.
 *
 * Two states are not in the §5 drawing and are here on purpose:
 *
 * - `interrupted` — §9's restart semantics. A manager that dies mid-run leaves
 *   `running` rows behind; on restart they become `interrupted`, which is a
 *   *decision point* (resume / fail / cancel), not a terminal state.
 * - `merged` — §5 draws it and Phase 4 owns it. The edge is enumerated here so
 *   the machine is complete; nothing in Phase 2 fires it.
 */

// ---------------------------------------------------------------------------
// States
// ---------------------------------------------------------------------------

export type WorkerState =
  /** Accepted, nothing allocated yet. */
  | "spawned"
  /** Worktree being created, brief being built, session being opened. */
  | "preparing"
  /** A prompt is in flight and the event stream is being consumed. */
  | "running"
  /** The worker asked for something. Only the orchestrator can move it on. */
  | "blocked"
  /** Work finished and was snapshotted. Phase 4 may still merge it. */
  | "completed"
  /** Phase 4. Enumerated for completeness; never fired in Phase 2. */
  | "merged"
  /** Something went wrong that is not a deadline and not a budget. */
  | "failed"
  /** A watchdog fired: hard deadline or idle deadline. */
  | "timed_out"
  /** Token budget exceeded (§8 budgets on tokens, not dollars). */
  | "over_budget"
  /** Stopped on request. */
  | "cancelled"
  /** The manager restarted while this worker was mid-flight (§9). */
  | "interrupted";

export const WORKER_STATES: readonly WorkerState[] = Object.freeze([
  "spawned",
  "preparing",
  "running",
  "blocked",
  "completed",
  "merged",
  "failed",
  "timed_out",
  "over_budget",
  "cancelled",
  "interrupted",
] as const);

/** States in which the worker may still be doing work of its own. */
const ACTIVE: ReadonlySet<WorkerState> = new Set<WorkerState>(["spawned", "preparing", "running"]);

/**
 * States in which the worker will do nothing further *of its own accord*.
 *
 * Not "nothing can ever happen again": `completed --merge--> merged` was always
 * an act from outside, and **Phase 6 adds `revise`, which is another** — four of
 * the five states below accept it. What `final` means, precisely, is that no
 * watchdog will fire, no event will arrive and no run loop is turning; only an
 * explicit instruction from Claude moves the worker on. Callers rely on exactly
 * that: `cancel()` returns early on a final worker because there is nothing to
 * abort, and `dispose()` skips one because there is nothing to wind down.
 *
 * `merged` is the one that accepts nothing further at all — see the `revise`
 * rows below for why.
 */
const FINAL: ReadonlySet<WorkerState> = new Set<WorkerState>([
  "merged",
  "failed",
  "timed_out",
  "over_budget",
  "cancelled",
]);

/**
 * Outcomes that mean "this worker will not produce more work without a new
 * instruction" — what a caller polling for an answer is waiting on. `blocked`
 * counts: the worker has stopped and the orchestrator has to act.
 */
const SETTLED: ReadonlySet<WorkerState> = new Set<WorkerState>([
  "blocked",
  "completed",
  "merged",
  "failed",
  "timed_out",
  "over_budget",
  "cancelled",
  "interrupted",
]);

export const isActive = (s: WorkerState): boolean => ACTIVE.has(s);
export const isFinal = (s: WorkerState): boolean => FINAL.has(s);
export const isSettled = (s: WorkerState): boolean => SETTLED.has(s);

/**
 * The four unhappy endings, kept distinct on purpose.
 *
 * `timed_out` and `over_budget` both arrive as a deliberate abort, which the
 * backend reports as an error. Collapsing them into `failed` throws away the one
 * signal that tells Claude whether retrying is worth anything — a timeout may
 * be, a content filter is not.
 */
export const FAILURE_STATES: readonly WorkerState[] = Object.freeze([
  "failed",
  "timed_out",
  "over_budget",
  "cancelled",
] as const);

// ---------------------------------------------------------------------------
// Triggers
// ---------------------------------------------------------------------------

export type Trigger =
  /** Worktree, brief, session. */
  | "prepare"
  /** Prompt accepted, stream live. */
  | "start"
  /** The worker asked a question or hit a permission wall. */
  | "block"
  /** The orchestrator answered; same session, new prompt. */
  | "resume"
  /** Terminal event arrived and the report says the work is done. */
  | "complete"
  /** Anything that is not a deadline, a budget, or a cancellation. */
  | "fail"
  /** Hard deadline or idle deadline. */
  | "timeout"
  /** Token budget exceeded. */
  | "exhaust_budget"
  /** Stop requested. */
  | "cancel"
  /** Manager restart found this row mid-flight (§9). */
  | "interrupt"
  /** Claude chose "resume monitoring" for an interrupted worker (§9). */
  | "recover"
  /** Phase 4. */
  | "merge"
  /** §11 Phase 6: Claude sent feedback; the same session takes another turn. */
  | "revise";

export interface Transition {
  readonly from: WorkerState;
  readonly trigger: Trigger;
  readonly to: WorkerState;
  /** Why this edge exists — for the reader, and for the run report. */
  readonly note: string;
}

/**
 * Every legal edge. If a move is not in this table it does not exist.
 *
 * Read it against the §5 diagram: the happy path down the middle, the four
 * unhappy endings off `running`, the `blocked` loop, and the §9 recovery edges.
 */
export const TRANSITIONS: readonly Transition[] = Object.freeze([
  { from: "spawned", trigger: "prepare", to: "preparing", note: "allocate worktree, build brief, open session" },
  { from: "spawned", trigger: "fail", to: "failed", note: "rejected before anything was allocated" },
  { from: "spawned", trigger: "cancel", to: "cancelled", note: "stopped before it started" },
  { from: "spawned", trigger: "interrupt", to: "interrupted", note: "manager died before this one was picked up" },

  { from: "preparing", trigger: "start", to: "running", note: "prompt accepted, subscription live" },
  { from: "preparing", trigger: "fail", to: "failed", note: "worktree or session setup failed (§5 preparing to failed)" },
  { from: "preparing", trigger: "cancel", to: "cancelled", note: "stopped while setting up" },
  // §11 Phase 7's global run cap is checked *before* the session is opened, so
  // the one worker it stops is one that never reached `running`. Without this
  // edge `settle()`'s `tryApply` silently declined the move and the worker sat
  // in `preparing` forever — a hang rather than an error, which is the failure
  // mode the machine exists to prevent.
  { from: "preparing", trigger: "exhaust_budget", to: "over_budget", note: "§8's run cap stopped it before it opened a session" },
  { from: "preparing", trigger: "interrupt", to: "interrupted", note: "manager died mid-setup" },

  { from: "running", trigger: "block", to: "blocked", note: "worker asked; only the orchestrator can unblock it" },
  { from: "running", trigger: "complete", to: "completed", note: "terminal event, report parsed, snapshot taken" },
  { from: "running", trigger: "fail", to: "failed", note: "typed error, dead server, or an unusable report" },
  { from: "running", trigger: "timeout", to: "timed_out", note: "hard deadline or idle watchdog" },
  { from: "running", trigger: "exhaust_budget", to: "over_budget", note: "token budget exceeded (§8)" },
  { from: "running", trigger: "cancel", to: "cancelled", note: "stop requested" },
  { from: "running", trigger: "interrupt", to: "interrupted", note: "manager died mid-run (§9)" },

  { from: "blocked", trigger: "resume", to: "running", note: "answer sent to the same session (§5 blocked to running)" },
  { from: "blocked", trigger: "fail", to: "failed", note: "resuming the session failed" },
  { from: "blocked", trigger: "timeout", to: "timed_out", note: "nobody answered within the blocked deadline" },
  { from: "blocked", trigger: "cancel", to: "cancelled", note: "abandoned rather than answered" },
  { from: "blocked", trigger: "interrupt", to: "interrupted", note: "manager died with the question outstanding" },

  { from: "completed", trigger: "merge", to: "merged", note: "Phase 4's gated merge" },

  // §11 Phase 6's review loop. Every one of these lands in `spawned` rather than
  // in `running`, and that is the phase's largest structural decision: a
  // revision is a spawn-shaped thing that has to re-acquire a concurrency slot
  // (ADR-0004's gate sits between `spawned` and `preparing`), so it re-enters
  // the lifecycle where a spawn does and reuses `prepare` and `start` from
  // there. A revision admitted straight to `running` would hold no slot and
  // would put a session on the shared backend that nothing is counting.
  // See `docs/adr/0005-the-review-loop.md`.
  { from: "completed", trigger: "revise", to: "spawned", note: "Claude sent feedback; the same session takes another turn" },
  { from: "failed", trigger: "revise", to: "spawned", note: "revising a failure: worth it for a dead server, not for a content filter" },
  { from: "timed_out", trigger: "revise", to: "spawned", note: "the session outlived the deadline; a narrower instruction may not" },
  { from: "over_budget", trigger: "revise", to: "spawned", note: "a fresh wall clock, but the session's tokens keep accumulating" },
  { from: "cancelled", trigger: "revise", to: "spawned", note: "redirect a worker that was stopped for going the wrong way" },
  // `merged` deliberately has no `revise` row. Its commits are already on an
  // integration branch; a revision would produce a commit that branch does not
  // have, and the run report would show a merged worker whose branch tip is not
  // what was merged. Respawn instead.

  { from: "interrupted", trigger: "recover", to: "running", note: "§9: resume monitoring a session that is still alive" },
  { from: "interrupted", trigger: "fail", to: "failed", note: "§9: fail-and-cleanup" },
  { from: "interrupted", trigger: "cancel", to: "cancelled", note: "§9: abandon it" },
] as const);

const INDEX: ReadonlyMap<string, Transition> = new Map(TRANSITIONS.map((t) => [`${t.from} ${t.trigger}`, t]));

export class IllegalTransitionError extends Error {
  constructor(
    readonly from: WorkerState,
    readonly trigger: Trigger,
    readonly workerID?: string,
  ) {
    super(
      `illegal transition: ${workerID ? `${workerID}: ` : ""}cannot ${trigger} from ${from}` +
        ` (legal from ${from}: ${triggersFrom(from).join(", ") || "none, terminal"})`,
    );
    this.name = "IllegalTransitionError";
  }
}

/** The triggers `from` accepts, in table order. */
export function triggersFrom(from: WorkerState): Trigger[] {
  return TRANSITIONS.filter((t) => t.from === from).map((t) => t.trigger);
}

export function can(from: WorkerState, trigger: Trigger): boolean {
  return INDEX.has(`${from} ${trigger}`);
}

/** The state `trigger` leads to, or `undefined` if the edge does not exist. */
export function peek(from: WorkerState, trigger: Trigger): WorkerState | undefined {
  return INDEX.get(`${from} ${trigger}`)?.to;
}

/** As {@link peek}, but an illegal move is an error rather than a shrug. */
export function next(from: WorkerState, trigger: Trigger, workerID?: string): WorkerState {
  const to = peek(from, trigger);
  if (to === undefined) throw new IllegalTransitionError(from, trigger, workerID);
  return to;
}

// ---------------------------------------------------------------------------
// The machine
// ---------------------------------------------------------------------------

export interface StateChange {
  readonly from: WorkerState;
  readonly to: WorkerState;
  readonly trigger: Trigger;
  /** Short machine-readable cause: `idle_watchdog`, `token_budget`, … */
  readonly reason?: string;
  /** Structured context. Data, never instructions (DD-8). */
  readonly detail?: Readonly<Record<string, unknown>>;
  readonly at: number;
}

export interface WorkerMachineOptions {
  readonly workerID?: string;
  readonly initial?: WorkerState;
  readonly now?: () => number;
  /** Called after every accepted change — the store's hook into the lifecycle. */
  readonly onChange?: (change: StateChange) => void;
}

/**
 * One worker's position in the lifecycle, plus the trail of how it got there.
 *
 * The history is not decoration: §9's recovery and the run report both need to
 * know *why* a worker is where it is, and "why it timed out" is not recoverable
 * from its final state alone.
 */
export class WorkerMachine {
  readonly workerID: string | undefined;
  private current: WorkerState;
  private readonly log: StateChange[] = [];
  private readonly now: () => number;
  private readonly onChange: ((change: StateChange) => void) | undefined;

  constructor(opts: WorkerMachineOptions = {}) {
    this.workerID = opts.workerID;
    this.current = opts.initial ?? "spawned";
    this.now = opts.now ?? Date.now;
    this.onChange = opts.onChange;
  }

  get state(): WorkerState {
    return this.current;
  }

  get history(): readonly StateChange[] {
    return this.log;
  }

  get settled(): boolean {
    return isSettled(this.current);
  }

  get final(): boolean {
    return isFinal(this.current);
  }

  can(trigger: Trigger): boolean {
    return can(this.current, trigger);
  }

  /** Apply a trigger. Throws {@link IllegalTransitionError} on an illegal move. */
  apply(trigger: Trigger, opts: { reason?: string; detail?: Record<string, unknown> } = {}): StateChange {
    const from = this.current;
    const to = next(from, trigger, this.workerID);
    const change: StateChange = {
      from,
      to,
      trigger,
      ...(opts.reason === undefined ? {} : { reason: opts.reason }),
      ...(opts.detail === undefined ? {} : { detail: Object.freeze({ ...opts.detail }) }),
      at: this.now(),
    };
    this.current = to;
    this.log.push(change);
    this.onChange?.(change);
    return change;
  }

  /**
   * Apply if legal, otherwise report `undefined`.
   *
   * For the races the manager genuinely cannot prevent — a watchdog firing at
   * the same moment a terminal event lands — where "already settled" is the
   * right answer rather than a crash. Use it deliberately, not as a way to avoid
   * knowing which state you are in.
   */
  tryApply(trigger: Trigger, opts: { reason?: string; detail?: Record<string, unknown> } = {}): StateChange | undefined {
    return this.can(trigger) ? this.apply(trigger, opts) : undefined;
  }
}
