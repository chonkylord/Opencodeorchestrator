/**
 * The worker manager: registry, run loop, watchdogs (`projectplan.md` §3.2, §5).
 *
 * One worker's life, start to finish, lives in {@link WorkerManager.drive}. It is
 * written as a single linear function on purpose — the lifecycle in §5 is one
 * story, and splitting it across callbacks is how the "which state am I in"
 * questions start.
 *
 * Three facts from Phase 0 shape it more than anything else:
 *
 * 1. **An abort emits two terminal events, in order: an error carrying the
 *    abort, and then idle.** A loop that settles on the first one marks every
 *    timed-out and over-budget worker `failed`, and Claude loses the distinction
 *    that tells it whether a retry is worth anything. So an abort this manager
 *    *asked for* is recorded as an intent before the request goes out, and the
 *    intent — not the error — decides the final state. See {@link AbortIntent}.
 *
 * 2. **Breaking out of a `for await` does not close the subscription.** That is
 *    what makes §5's blocked→answer→resume path one stream instead of three: the
 *    loop stops reading while it waits for Claude, prompts the same session
 *    again, and carries on reading the same stream. The stream is closed exactly
 *    once, in the `finally`.
 *
 * 3. **The idle watchdog keys off worker events, not stream silence.** Liveness
 *    ticks arrive every ten seconds whether or not anything is running, so a
 *    watchdog that resets on any frame never fires. Ticks arriving with no
 *    worker events means the *worker* is wedged; no ticks at all means the
 *    *server* is gone, which `health()` confirms. Different failures, different
 *    responses — a wedged worker is aborted, a dead server is not the worker's
 *    fault and is not reported as its timeout.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  HEADLESS_PERMISSIONS,
  type PermissionReply,
  type OCEvent,
  type OpenCodeBackend,
  OpenCodeError,
  type PermissionRule,
  type EventStream,
  type SessionHandle,
  isAnswerable,
  isBlocking,
  isWorkerEvent,
} from "../opencode/index.js";
import {
  type Brief,
  REPORT_RETRY_COUNT,
  REPORT_SCHEMA,
  REVIEW_DIFF_LINES,
  type ReviewTarget,
  buildAnswerPrompt,
  buildBrief,
  buildReviewPrompt,
  buildRevisionPrompt,
  matchesPath,
  parseReport,
  reconcile,
} from "../briefs/index.js";
import type { Store } from "../store/index.js";
import {
  changedFiles,
  createWorktree,
  dirtyFiles,
  readCommitDiff,
  readDiff,
  defaultWorktreeRoot,
  diffStat,
  listManifests,
  readReportFile,
  declaredOverlap,
  resolveRepoRoot,
  resolveSha,
  runTestCommand,
  snapshotCommit,
  writeManifest,
} from "../workspace/index.js";
import { type Admission, DEFAULT_MAX_CONCURRENT, DependencyError, type QueueHint, Scheduler } from "./scheduler.js";
import { type Metric, type MetricsSink, NULL_METRICS } from "./metrics.js";
import { type RevisionRound, revisionRounds } from "./revisions.js";
import { type Route, route } from "./routing.js";
import { WorkerMachine, type WorkerState, isSettled } from "./state.js";
import type {
  Discrepancy,
  DiffStat,
  WorkerBudget,
  WorkerManifest,
  WorkerMode,
  WorkerRecord,
  WorkerReport,
  WorkerResult,
  WorkerSpec,
  WorkspaceMode,
} from "./types.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * §8's per-worker budget, in the units that actually work.
 *
 * Tokens, not dollars: Phase 0 found `cost` is `0` on free-tier providers even
 * after real work, so a dollar cap silently never fires. 15 minutes of wall
 * clock and 3 minutes of silence are §5's defaults.
 */
export const DEFAULT_BUDGET: WorkerBudget = Object.freeze({
  tokens: 250_000,
  wallClockMs: 15 * 60_000,
  idleMs: 3 * 60_000,
  blockedMs: 30 * 60_000,
});

/** DD-9: task type routes to model. One default until Phase 8 measures better. */
export const DEFAULT_MODEL = "opencode/muse-spark-1.2-contributor-free";

/**
 * §5's revision cap, and §13's mitigation for infinite fix loops.
 *
 * Three is the number §5 has carried since before Phase 0, and nothing measured
 * since argues with it: a defect a worker cannot fix in three rounds of specific
 * feedback is usually one where the instruction, not the worker, is wrong. The
 * cap is a backstop and not a licence — nothing in this system revises a worker
 * on its own, and §11 Phase 6 is explicit that Claude decides and the tools
 * report. `ORCHESTRATOR_MAX_REVISIONS` moves it.
 */
export const DEFAULT_MAX_REVISIONS = 3;

/**
 * How many times a turn is re-sent after a retryable provider error.
 *
 * Two, so a rate limit or a dropped upstream costs seconds rather than a worker,
 * and a provider that is genuinely down costs three attempts rather than
 * fifteen. §5 is explicit that a retry is not a revision: a retry re-runs the
 * same instruction, so it has no cap of its own to interact with and no round
 * to report.
 */
export const DEFAULT_MAX_RETRIES = 2;

/**
 * How long a recovered worker waits for its old turn to speak up (§11 Phase 7).
 *
 * Eight seconds: long enough that a busy provider mid-response is not mistaken
 * for a finished one, short enough that the salvage is a pause rather than an
 * outage. A turn that is genuinely running emits *something* — a text delta, a
 * tool part — well inside it.
 */
export const DEFAULT_RECOVER_GRACE_MS = 8_000;

/** Base of the exponential backoff: 1s, then 2s, then 4s, capped. */
export const DEFAULT_RETRY_BACKOFF_MS = 1_000;

/** Nothing waits longer than this between attempts, whatever the exponent says. */
export const MAX_RETRY_BACKOFF_MS = 30_000;

/**
 * §8's global run cap, in tokens.
 *
 * Two million is roughly eight workers at the default per-worker ceiling: high
 * enough that an ordinary wave never meets it, low enough that a runaway costs
 * a bounded amount. It is a backstop, not a quota — the number to change if your
 * waves are bigger, and the number that means a `worker_spawn` can be refused
 * for a reason that is about the *run* rather than about the worker.
 */
export const DEFAULT_RUN_BUDGET_TOKENS = 2_000_000;

/**
 * What an `implement` worker is allowed, on top of the adapter's headless set.
 *
 * `doom_loop` is an interactive anti-loop guard, and interactive is the one
 * thing a headless worker cannot be: left at `ask` it does not stop a runaway,
 * it stops the *run*, waiting for an answer from nobody. The manager already
 * bounds loops three ways — idle watchdog, wall clock, token budget — so the
 * guard is redundant here and the prompt is pure deadlock.
 *
 * `external_directory` is deliberately *not* widened. Phase 0 called it "a
 * useful jail signal for §8", and it is: a worker reaching outside its worktree
 * raises a question the orchestrator can surface, rather than silently writing
 * where it should not.
 */
const IMPLEMENT_PERMISSIONS: readonly PermissionRule[] = Object.freeze([
  ...HEADLESS_PERMISSIONS,
  { permission: "doom_loop", pattern: "**", action: "allow" },
]);

/** Read-only modes (DD-10), enforced twice: at the session and at the prompt. */
const READ_ONLY_PERMISSIONS: readonly PermissionRule[] = Object.freeze([
  { permission: "edit", pattern: "**", action: "deny" },
  { permission: "bash", pattern: "**", action: "deny" },
]);

const READ_ONLY_TOOLS: Readonly<Record<string, boolean>> = Object.freeze({
  bash: false,
  edit: false,
  write: false,
  patch: false,
});

export interface WorkerManagerOptions {
  readonly backend: OpenCodeBackend;
  readonly store: Store;
  /** Any path inside the repository the workers branch from. */
  readonly repoRoot: string;
  /** Defaults to `<repoRoot>/.orchestrator/worktrees` (§6.1). */
  readonly worktreeRoot?: string;
  readonly defaultModel?: string;
  /** DD-9 presets, per mode. */
  readonly models?: Partial<Record<WorkerMode, string>>;
  /**
   * Models a `review` worker may be routed to, in preference order (§11 Phase 8).
   *
   * The point is that a reviewer should not be the same model as the author it
   * is reviewing — a critique from a model that shares the author's blind spots
   * is the weakest kind of check this system can produce. Empty is fine and
   * means "use the presets"; a same-model review still happens when nothing else
   * is available, and says so in the result rather than passing silently.
   */
  readonly reviewPool?: readonly string[];
  /**
   * Where workers work unless they say otherwise (§11 Phase 8).
   *
   * Defaults to `shared` — the repository itself, every worker in it together,
   * the way Claude's own subagents behave. `isolated` is the pre-Phase-8
   * behaviour and is still what you want when workers would collide or when the
   * merge gate should stand between their work and your tree.
   */
  readonly defaultWorkspace?: WorkspaceMode;
  readonly budget?: Partial<WorkerBudget>;
  /**
   * How many workers may be past `spawned` at once (§11 Phase 5).
   *
   * Counts `preparing`, `running` and `blocked` — every state in which a worker
   * holds a session on the shared backend. Defaults to
   * {@link DEFAULT_MAX_CONCURRENT}; the server reads it from
   * `ORCHESTRATOR_MAX_CONCURRENT`.
   */
  readonly maxConcurrent?: number;
  /**
   * How many revision rounds one worker may take (§5, §13).
   *
   * Defaults to {@link DEFAULT_MAX_REVISIONS}; the server reads it from
   * `ORCHESTRATOR_MAX_REVISIONS`. At the cap {@link WorkerManager.revise}
   * refuses, and the refusal carries the terminal report §13 calls actionable.
   */
  readonly maxRevisions?: number;
  /**
   * How many times one turn may be re-sent after a **retryable** provider error
   * (§11 Phase 7).
   *
   * Defaults to {@link DEFAULT_MAX_RETRIES}. Only errors the provider itself
   * marks retryable are retried; a content filter or a bad request reproduces
   * and is failed on the first try. `0` turns retries off.
   */
  readonly maxRetries?: number;
  /** Base for the exponential backoff between retries. Small in tests. */
  readonly retryBackoffMs?: number;
  /**
   * How long a recovered worker waits for its old turn to show signs of life
   * before it is salvaged from its worktree instead (§9, §11 Phase 7).
   *
   * Not the idle watchdog: that one asks "has this worker wedged" and answers in
   * minutes, which is the right question for a turn we know started and the
   * wrong one for a turn that may have ended before we were listening.
   */
  readonly recoverGraceMs?: number;
  /**
   * §8's **global run cap**, in tokens across every worker sharing a `runID`.
   *
   * The per-worker budget stops one worker running away; this stops a *wave*
   * doing it — six workers each dutifully inside their own ceiling still spend
   * six ceilings. Defaults to {@link DEFAULT_RUN_BUDGET_TOKENS}; `0` disables it.
   * Enforced at spawn, where a refusal is legible, and again before a queued
   * worker opens a session, because the spend that matters accrues while it
   * waits.
   */
  readonly runBudgetTokens?: number;
  /**
   * Where §11 Phase 7's metrics go. Defaults to {@link NULL_METRICS}.
   *
   * The manager records; it does not decide where. The server hands it a file
   * sink rooted at the repository, and every test that does not care gets the
   * one that writes nothing.
   */
  readonly metrics?: MetricsSink;
  /** Watchdog resolution. Small in tests, ~1s in production. */
  readonly tickMs?: number;
  /** How often to poll the backend for token usage. */
  readonly budgetPollMs?: number;
  /** How long to wait for the terminal event after an abort before giving up. */
  readonly abortGraceMs?: number;
  /**
   * Minimum quiet period between a session's terminal event and the next prompt
   * to it. See {@link WorkerManager.promptTurn} for why this is not zero.
   */
  readonly retrySettleMs?: number;
  /**
   * Re-run the brief's test command after a worker completes (§4.3's
   * "manager re-ran independently"). On when a spec supplies a command.
   */
  readonly verifyTests?: boolean;
  /** Constrain the reply to the report schema. Off only to debug a provider. */
  readonly structuredOutput?: boolean;
  readonly now?: () => number;
  readonly newWorkerID?: () => string;
}

// ---------------------------------------------------------------------------
// Internal per-worker state
// ---------------------------------------------------------------------------

/**
 * Why *we* aborted, recorded before the request goes out.
 *
 * The backend reports every abort the same way; only the caller knows whether
 * it was a deadline, a budget, a cancellation, or an escalation. Losing that is
 * fact (1) at the top of this file.
 */
interface AbortIntent {
  readonly disposition: "timed_out" | "over_budget" | "cancelled" | "blocked";
  readonly reason: string;
  readonly questions?: readonly string[];
  readonly at: number;
}

type Disposition =
  | { kind: "complete" }
  | { kind: "failed"; reason: string; error?: OpenCodeError }
  | { kind: "timed_out"; reason: string }
  | { kind: "over_budget"; reason: string }
  | { kind: "cancelled"; reason: string };

type AnswerOutcome =
  | {
      kind: "answer";
      text: string;
      /**
       * What to say to an outstanding *permission* request, when there is one.
       *
       * Free text cannot be turned into `once`/`reject` reliably, and guessing
       * wrong in the permissive direction is exactly the failure §8's jail signal
       * exists to prevent. So the decision is carried explicitly and defaults to
       * allowing — because Claude choosing to answer a permission ask at all is
       * already the decision to let the worker proceed, and `worker_stop` is how
       * it says no to the whole worker.
       */
      decision?: "allow" | "deny";
    }
  | { kind: "cancel" }
  | { kind: "timeout" };

/**
 * §8's global run cap, refused at spawn.
 *
 * Its own class rather than a bare `Error` for the same reason
 * {@link DependencyError} is: the tool layer turns it into a refusal Claude can
 * act on, and a refusal that arrives as a stack trace is one nobody acts on.
 */
export class RunBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunBudgetError";
  }
}

/** Another shared worker laying claim to paths this one declared. */
export interface SharedCollision {
  readonly workerID: string;
  /** The declared patterns that could match the same files. */
  readonly paths: readonly string[];
}

/** §9's three decisions about a worker a dead process left behind. */
export type RecoverAction = "resume" | "fail" | "discard";

/** What {@link WorkerManager.recoverWorker} answers with. */
export type RecoverOutcome =
  | {
      /** `fail` and `discard` are synchronous: there is nothing to run. */
      readonly kind: "settled";
      readonly action: RecoverAction;
      readonly record: WorkerRecord;
    }
  | {
      /** `resume` runs in the background, like every other unit of work here. */
      readonly kind: "resuming";
      readonly action: RecoverAction;
      readonly record: WorkerRecord;
      readonly hint?: QueueHint;
    };

/** Why {@link WorkerManager.revise} declined. Both are reports, not errors. */
export type RevisionRefusal = "revision_cap" | "token_budget";

/** What {@link WorkerManager.revise} answers with. */
export type ReviseOutcome =
  | {
      readonly kind: "started";
      /** 1-based round number this feedback begins. */
      readonly round: number;
      readonly record: WorkerRecord;
      /** Present when the round is waiting for a concurrency slot. */
      readonly hint?: QueueHint;
    }
  | {
      readonly kind: "refused";
      readonly reason: RevisionRefusal;
      /** §13's *terminal actionable report*. Rendered by `renderRevisionCap`. */
      readonly report: RevisionCapReport;
    };

/**
 * Everything §13's terminal report needs, gathered rather than formatted.
 *
 * The manager produces the facts and `src/mcp/render.ts` turns them into prose,
 * which is the same split every other surface here uses — and it is what lets
 * the cap be tested on its content rather than on its wording.
 */
export interface RevisionCapReport {
  readonly workerID: string;
  readonly reason: RevisionRefusal;
  readonly revisions: number;
  readonly maxRevisions: number;
  readonly totalTokens: number;
  readonly tokenBudget: number;
  readonly state: WorkerState;
  readonly branch: string;
  readonly rounds: readonly RevisionRound[];
  readonly result?: WorkerResult;
}


/** Everything about one in-flight worker that is not in the database. */
class ManagedWorker {
  readonly machine: WorkerMachine;
  session: SessionHandle | undefined;
  stream: EventStream | undefined;
  brief: Brief | undefined;
  /** The current turn's accumulated reply — the report channel. Bounded. */
  replyText = "";
  replyTruncated = false;
  lastWorkerEventAt = 0;
  runningSince = 0;
  blockedTotalMs = 0;
  blockedAt = 0;
  lastBudgetPollAt = 0;
  totalTokens = 0;
  cost = 0;
  resumes = 0;
  /** Revision rounds actually prompted. §13's cap counts this, not `resumes`. */
  revisions = 0;
  /**
   * A revision that has been asked for and has not finished.
   *
   * One worker takes one round at a time. Without this, two `worker_revise`
   * calls in the same tick both find a settled worker, both pass the cap check,
   * and both start a run loop over one session — two subscriptions, two prompts,
   * and a `done` that only tracks the second of them.
   */
  reviseInFlight = false;
  questions: readonly string[] = [];
  abortIntent: AbortIntent | undefined;
  /** An abort we did not ask for still has to be distinguished from a clean end. */
  sawAbort = false;
  /**
   * The permission request the worker is waiting on, if it is waiting on one.
   *
   * Set when the adapter reports an answerable block (`isAnswerable`) and
   * cleared once it is answered. Its presence is what lets §11 Phase 7 answer
   * **in band** — leaving the turn running and the tool call to proceed —
   * instead of Phase 2's escalation, which had to abort the turn because there
   * was no way to reply at all.
   */
  pendingPermission: { requestID: string; permission: string } | undefined;
  /** This turn's instruction, kept so a turn can be re-sent unchanged. */
  lastPromptText = "";
  /** Was this turn's reply schema-constrained? */
  usedFormat = false;
  /** One retry without the constraint, at most, per worker. */
  formatRetried = false;
  /** Set when a re-send is pending; cleared when it goes out. */
  retryAt: number | undefined;
  /**
   * While recovering: when to stop waiting for the old turn to say something.
   *
   * A session that outlived the manager may have finished its turn while nobody
   * was listening, and a terminal event that arrived then is simply gone —
   * subscriptions are not replayed. Without a deadline the recovered worker
   * would sit through the full idle watchdog before anything happened, which
   * turns a three-second salvage into a three-minute timeout that also throws
   * the work away. Cleared the moment a real worker event arrives.
   */
  recoverDeadline: number | undefined;
  /** When the recovery watch began, so "has anything arrived since" is answerable. */
  recoverStartedAt = 0;
  /**
   * Which kind of re-send is pending, and how long to wait before it.
   *
   * Two paths re-send the *same* turn and they are not the same thing.
   * `format` is Phase 2's one-shot drop of the schema constraint and waits for
   * nothing. `transient` is Phase 7's retry of a provider error the provider
   * itself called retryable, and waits out a backoff — which is the whole
   * difference between a retry and a hot loop against a rate limiter.
   */
  resendKind: "format" | "transient" = "format";
  resendDelayMs = 0;
  /** Transient-error retries this worker has spent. Capped; never reset. */
  retries = 0;
  /**
   * Files already modified when this shared worker started (§11 Phase 8).
   *
   * Empty for an isolated worker, whose worktree starts clean by construction.
   */
  preexisting: readonly string[] = [];
  /**
   * A cancellation that arrived before there was anything to abort.
   *
   * The queue widened a window that always existed: between `spawn()` returning
   * and the session existing there is nothing for `abort()` to act on, so a
   * cancel in that window used to be recorded and then ignored, and the worker
   * ran to completion anyway. `prepareAndRun()` checks this flag at every step
   * boundary instead.
   */
  cancelRequested: string | undefined;
  /**
   * Has the turn we most recently prompted actually begun?
   *
   * Terminal events are session-scoped, not prompt-scoped, so an idle carries no
   * evidence about *which* turn it ends. A turn that fails emits two of them
   * (measured ~30ms apart on OpenCode 1.18.25), and a run loop that re-prompts
   * on the first one reads the second as its new turn finishing instantly — with
   * an empty reply, which then looks like a worker that did nothing. So a turn
   * is only allowed to end once something proved it started.
   */
  turnStarted = false;
  /** When this session last went terminal. Gates how soon it can be re-prompted. */
  lastTerminalAt: number | undefined;
  lastError: OpenCodeError | undefined;
  answer: ((outcome: AnswerOutcome) => void) | undefined;
  /** Settled by {@link WorkerManager.answer} once the follow-up prompt is away. */
  resumeSignal: { resolve: () => void; reject: (e: unknown) => void } | undefined;
  readonly waiters = new Set<() => void>();
  done: Promise<void> | undefined;

  constructor(
    readonly record: { current: WorkerRecord },
    now: () => number,
    onChange: (change: { from: WorkerState; to: WorkerState; trigger: string; reason?: string; detail?: Readonly<Record<string, unknown>> }) => void,
    /**
     * Where the machine starts.
     *
     * `spawned` for a worker this process is spawning; the stored state for one
     * it is *adopting* from a previous process (§9). A machine seeded at the
     * beginning would happily accept `prepare` on a worker that already has a
     * worktree and a session, which is the class of bug the machine exists to
     * make impossible.
     */
    initial?: WorkerState,
  ) {
    this.machine = new WorkerMachine({
      workerID: record.current.workerID,
      now,
      onChange,
      ...(initial === undefined ? {} : { initial }),
    });
  }
}

const MAX_REPLY_CHARS = 512 * 1024;

/** How much of Claude's feedback the audit trail keeps, per round. */
const FEEDBACK_TRAIL_CHARS = 2_000;

/** How much of a worker's own summary each round's trail entry keeps. */
const SUMMARY_TRAIL_CHARS = 400;

/**
 * How far back {@link WorkerManager.revisionHistory} reads.
 *
 * A worker capped at three rounds has a few dozen events; this is a ceiling that
 * stops a pathological trail from being loaded whole, not a page size.
 */
const REVISION_TRAIL_LIMIT = 2_000;

/** Reconciliation findings handed to a reviewer before it starts. */
const MAX_REVIEW_DISCREPANCIES = 10;

// ---------------------------------------------------------------------------
// The manager
// ---------------------------------------------------------------------------

export class WorkerManager {
  private readonly opts: Required<Omit<WorkerManagerOptions, "worktreeRoot" | "models" | "budget">> & {
    worktreeRoot?: string;
    models: Partial<Record<WorkerMode, string>>;
    budget: WorkerBudget;
  };
  private readonly workers = new Map<string, ManagedWorker>();
  /** How each worker's model was chosen (§11 Phase 8). Reporting only. */
  private readonly routes = new Map<string, Route>();
  /** Shared-workspace path collisions found at spawn. Reporting only. */
  private readonly collisions = new Map<string, readonly SharedCollision[]>();
  /** §11 Phase 5's cap, queue and `dependsOn`. See {@link Scheduler}. */
  private readonly scheduler: Scheduler;
  /**
   * Does this backend's provider actually support schema-constrained replies?
   *
   * Starts optimistic and latches off the first time a provider rejects the
   * request, so exactly one worker pays for the discovery rather than all of
   * them. See ADR-0002 and `docs/phase0-facts.md` §3.
   */
  private structuredOutputOK: boolean;
  private repoRootResolved: string | undefined;
  private worktreeRootResolved: string | undefined;
  private halted = false;
  private seq = 0;

  constructor(options: WorkerManagerOptions) {
    this.opts = {
      backend: options.backend,
      store: options.store,
      repoRoot: options.repoRoot,
      ...(options.worktreeRoot === undefined ? {} : { worktreeRoot: options.worktreeRoot }),
      defaultModel: options.defaultModel ?? DEFAULT_MODEL,
      models: options.models ?? {},
      reviewPool: options.reviewPool ?? [],
      defaultWorkspace: options.defaultWorkspace ?? "shared",
      budget: { ...DEFAULT_BUDGET, ...options.budget },
      maxConcurrent: options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
      maxRevisions: Math.max(0, Math.floor(options.maxRevisions ?? DEFAULT_MAX_REVISIONS)),
      maxRetries: Math.max(0, Math.floor(options.maxRetries ?? DEFAULT_MAX_RETRIES)),
      retryBackoffMs: Math.max(0, Math.floor(options.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS)),
      recoverGraceMs: options.recoverGraceMs ?? DEFAULT_RECOVER_GRACE_MS,
      runBudgetTokens: Math.max(0, Math.floor(options.runBudgetTokens ?? DEFAULT_RUN_BUDGET_TOKENS)),
      metrics: options.metrics ?? NULL_METRICS,
      tickMs: options.tickMs ?? 1_000,
      budgetPollMs: options.budgetPollMs ?? 15_000,
      abortGraceMs: options.abortGraceMs ?? 10_000,
      retrySettleMs: options.retrySettleMs ?? 2_000,
      verifyTests: options.verifyTests ?? true,
      structuredOutput: options.structuredOutput ?? true,
      now: options.now ?? Date.now,
      newWorkerID: options.newWorkerID ?? (() => `w-${(++this.seq).toString().padStart(3, "0")}`),
    };
    this.structuredOutputOK = this.opts.structuredOutput;
    this.scheduler = new Scheduler({
      maxConcurrent: this.opts.maxConcurrent,
      // Live, never cached: a dependency's satisfaction is decided when the
      // queue is pumped, and the index lags the record by a write.
      stateOf: (id) => this.workers.get(id)?.record.current.state ?? this.opts.store.getWorker(id)?.state,
      onEvent: (id, kind, detail) => this.opts.store.appendEvent(id, kind, detail),
    });
  }

  /** The cap this manager is enforcing. Configuration, exposed for reporting. */
  get maxConcurrent(): number {
    return this.scheduler.maxConcurrent;
  }

  /**
   * Workers already claiming paths this one declared, found at spawn.
   *
   * Empty for an isolated worker, for one that declared no `ownedPaths`, and —
   * the ordinary case — for one whose claim nobody else shares.
   */
  collisionsFor(workerID: string): readonly SharedCollision[] {
    return this.collisions.get(workerID) ?? [];
  }

  /** Whether this worker will work in the user's own checkout. */
  isShared(spec: WorkerSpec): boolean {
    return this.workspaceOf(spec) === "shared";
  }

  /** §5's revision cap. Configuration, exposed so the tools can quote it. */
  get maxRevisions(): number {
    return this.opts.maxRevisions;
  }

  /** §8's global run cap, in tokens. `0` when disabled. */
  get runBudgetTokens(): number {
    return this.opts.runBudgetTokens;
  }

  /**
   * What a run has spent so far, across every worker that shares its id.
   *
   * Summed from the index rather than tracked in a counter, because the index is
   * where a restarted process finds the spend that already happened — a counter
   * in memory would reset to zero and hand a runaway run a fresh budget on every
   * crash, which is the opposite of what a backstop is for.
   */
  runSpend(runID: string): number {
    let total = 0;
    for (const row of this.opts.store.listWorkers({ runID })) total += row.totalTokens;
    return total;
  }

  /** `undefined` when the run may proceed; the refusal text when it may not. */
  private runBudgetRefusal(runID: string): string | undefined {
    const cap = this.opts.runBudgetTokens;
    if (cap <= 0) return undefined;
    const spent = this.runSpend(runID);
    if (spent < cap) return undefined;
    return (
      `run ${runID} has spent ${spent.toLocaleString("en-US")} tokens against a run cap of ${cap.toLocaleString("en-US")} ` +
      "(§8's global cap, ORCHESTRATOR_RUN_BUDGET_TOKENS). Per-worker budgets stop one worker running away; this stops a wave doing it. " +
      "Read run_report to see where the tokens went, then start a new run with a fresh runID if the work is worth continuing, or raise the cap deliberately."
    );
  }

  /**
   * Why a worker has not started yet, or `undefined` if it has.
   *
   * `worker_status` needs this because a worker that is `spawned` because three
   * others are running looks identical, on the record alone, to one that is
   * about to start — and "next: worker_wait" is the wrong advice for the first.
   */
  queueHint(workerID: string): QueueHint | undefined {
    return this.scheduler.hint(workerID);
  }

  // --- public surface -----------------------------------------------------

  /**
   * Spawn a worker and return as soon as it is registered (DD-1).
   *
   * Never blocks on the work: MCP hosts time out long tool calls, so everything
   * above this is spawn-and-poll. The returned record is in `spawned` or
   * `preparing`; use {@link wait} to find out how it ended.
   *
   * Phase 5 put a queue behind this and deliberately did not put it in front:
   * a worker over the concurrency cap is *accepted* and sits in `spawned` — the
   * state already documented as "accepted, nothing allocated yet" — while the
   * gate waits inside the detached run loop. Only an unsatisfiable `dependsOn`
   * is rejected here, because a rejected spawn is legible and a wedged run is
   * not.
   */
  async spawn(spec: WorkerSpec): Promise<WorkerRecord> {
    const now = this.opts.now();
    const workerID = this.opts.newWorkerID();
    // Before any row is written: a spawn that cannot ever run leaves nothing
    // behind to explain later.
    this.scheduler.validate(workerID, spec.dependsOn ?? []);
    // Before a row is written, for the same reason an unsatisfiable `dependsOn`
    // is: a spawn that cannot be honoured should be a refusal Claude can read,
    // not a worker that appears and then dies.
    const overRun = this.runBudgetRefusal(spec.runID ?? "run-default");
    if (overRun) throw new RunBudgetError(overRun);
    // Same rule as `dependsOn`, and for the same reason: ids are minted by
    // `spawn()`, so one nobody has been handed is a typo, and a typo honoured
    // here becomes a reviewer that starts, finds nothing to review and reports
    // an opinion about an empty diff.
    if (spec.reviewOf !== undefined) {
      if (spec.reviewOf === workerID) throw new DependencyError(`reviewOf cannot name the reviewer itself (${workerID}).`);
      if (!this.get(spec.reviewOf)) {
        throw new DependencyError(
          `reviewOf names a worker that does not exist: ${spec.reviewOf}. ` +
            "Worker ids are assigned by worker_spawn, so the worker being reviewed must already have been spawned.",
        );
      }
      if ((spec.mode ?? "implement") !== "review") {
        throw new DependencyError(
          `reviewOf was given with mode "${spec.mode ?? "implement"}". It points a review worker at another worker's diff, so it only means anything with mode: "review".`,
        );
      }
    }
    const runID = spec.runID ?? "run-default";
    const mode: WorkerMode = spec.mode ?? "implement";
    // §11 Phase 8. A `review` worker is routed *away* from the model that wrote
    // the code it is reading, which is what turns ADR-0005's caveat — "Muse Spark
    // reviewing Muse Spark, sharing the author's blind spots by construction" —
    // from a permanent property into a configuration choice.
    const reviewTarget = mode === "review" && spec.reviewOf ? this.get(spec.reviewOf) : undefined;
    const chosen = route(
      {
        defaultModel: this.opts.defaultModel,
        perMode: this.opts.models,
        reviewPool: this.opts.reviewPool,
      },
      {
        mode,
        ...(spec.model === undefined ? {} : { explicit: spec.model }),
        ...(reviewTarget === undefined ? {} : { avoid: reviewTarget.model }),
      },
    );
    const model = chosen.model;
    const repoRoot = await this.resolveRepo();

    this.opts.store.createRun({ id: runID, repoRoot });

    const record: WorkerRecord = {
      workerID,
      runID,
      state: "spawned",
      mode,
      model,
      task: spec.task,
      spec,
      worktree: "",
      branch: `worker/${workerID}`,
      baseSha: "",
      createdAt: now,
      updatedAt: now,
      totalTokens: 0,
      cost: 0,
      resumes: 0,
      revisions: 0,
      questions: [],
    };

    const box = { current: record };
    // Kept in memory only: it is derivable from the trail and from the two
    // models, and DD-7 says the index holds nothing whose loss breaks a run.
    this.routes.set(workerID, chosen);
    const w = new ManagedWorker(box, this.opts.now, (change) => {
      // The machine's own hook is the *only* writer of `state:*`. A second,
      // richer append beside a transition writes the same event twice, which
      // the run report renders as two identical timeline rows — so a caller
      // with extra context passes it as `detail` and it lands here.
      this.opts.store.appendEvent(workerID, `state:${change.to}`, {
        from: change.from,
        trigger: change.trigger,
        ...(change.reason === undefined ? {} : { reason: change.reason }),
        ...(change.detail ?? {}),
      });
    });
    this.workers.set(workerID, w);
    this.opts.store.putWorker(record);
    this.opts.store.appendEvent(workerID, "spawned", {
      task: spec.task,
      mode,
      model,
      // Why this model, so "which model reviewed this?" is answerable from the
      // trail rather than from re-deriving the configuration that was live then.
      routedBy: chosen.reason,
      ...(chosen.diverse === undefined ? {} : { crossModel: chosen.diverse }),
      ...(chosen.avoided === undefined ? {} : { authorModel: chosen.avoided }),
      ...(spec.dependsOn && spec.dependsOn.length > 0 ? { dependsOn: [...spec.dependsOn] } : {}),
    });

    // Computed before the worker is admitted, so the warning reaches the caller
    // in the same reply that hands back the id — while the plan can still change.
    const collisions = this.sharedCollisions(workerID, spec);
    if (collisions.length > 0) {
      this.opts.store.appendEvent(workerID, "shared_path_collision", {
        with: collisions.map((c) => c.workerID),
        paths: [...new Set(collisions.flatMap((c) => c.paths))],
      });
    }
    this.collisions.set(workerID, collisions);

    const admission = this.scheduler.enqueue(workerID, spec.dependsOn ?? [], spec.priority ?? 0);
    // Written to the record straight away, so a status line taken one
    // millisecond after `worker_spawn` returns already says why nothing is
    // happening. The position and the outstanding dependencies are in-process
    // (`queueHint`) — a queue position is not durable state.
    const hint = this.scheduler.hint(workerID);
    if (hint) {
      this.opts.store.appendEvent(workerID, "queued", {
        reason: hint.reason,
        position: hint.position,
        running: hint.running,
        maxConcurrent: hint.maxConcurrent,
        ...(hint.waitingFor.length > 0 ? { waitingFor: [...hint.waitingFor] } : {}),
      });
      this.update(w, { reason: hint.reason });
    }

    w.done = this.drive(w, admission).catch(() => {
      /* drive() is total: every failure is already a state. */
    });
    return w.record.current;
  }

  get(workerID: string): WorkerRecord | undefined {
    return this.workers.get(workerID)?.record.current ?? this.opts.store.getWorker(workerID);
  }

  list(filter: { runID?: string; states?: readonly WorkerState[] } = {}): WorkerRecord[] {
    return this.opts.store.listWorkers(filter);
  }

  /**
   * Wait for a worker to stop needing the manager's attention.
   *
   * Resolves on any settled state, `blocked` included — a blocked worker is
   * finished as far as the orchestrator is concerned until somebody answers it.
   * Resolves (rather than throwing) on timeout: "still running" is an answer,
   * and Phase 3's `worker_wait` has a hard cap it must respect.
   */
  async wait(workerID: string, timeoutMs = 30_000): Promise<WorkerRecord> {
    const w = this.workers.get(workerID);
    if (!w) {
      const stored = this.opts.store.getWorker(workerID);
      if (!stored) throw new Error(`unknown worker ${workerID}`);
      return stored;
    }
    if (isSettled(w.machine.state)) return w.record.current;

    const waiters = w.waiters;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(finish, timeoutMs);
      function finish(): void {
        clearTimeout(timer);
        waiters.delete(finish);
        resolve();
      }
      waiters.add(finish);
    });
    return w.record.current;
  }

  /**
   * Wait for a *set* of workers (§11 Phase 5's batched wait).
   *
   * Two modes, and both are needed. `any` returns the moment one of them stops
   * needing the manager's attention, which is what a caller supervising a wave
   * wants: a worker that blocked on a question is the event worth waking for,
   * and waiting for the whole wave would leave it unanswered until the slowest
   * worker finished. `all` returns when none of them is still working, which is
   * what a caller wants before it merges.
   *
   * Resolves rather than throwing on timeout, like {@link wait}: "still running"
   * is an answer, and `worker_wait`'s cap is measured against a host ceiling it
   * must not race. The returned records are every id asked about, in the order
   * they were asked about, whichever mode ended the wait.
   */
  async waitMany(
    ids: readonly string[],
    opts: { mode?: "any" | "all"; timeoutMs?: number } = {},
  ): Promise<{ records: WorkerRecord[]; settled: string[] }> {
    const mode = opts.mode ?? "any";
    const timeoutMs = opts.timeoutMs ?? 30_000;
    if (ids.length === 0) throw new Error("waitMany needs at least one worker id");

    const unique = [...new Set(ids)];
    const live: ManagedWorker[] = [];
    // A worker this process does not hold is one a previous process spawned. It
    // is not going to move under us, so it counts as settled rather than as
    // something to wait for — which is what `wait` does for the same case.
    let inertSettled = 0;
    for (const id of unique) {
      const w = this.workers.get(id);
      if (w) {
        live.push(w);
        continue;
      }
      if (!this.opts.store.getWorker(id)) throw new Error(`unknown worker ${id}`);
      inertSettled += 1;
    }

    const satisfied = (): boolean => {
      const settled = live.filter((w) => isSettled(w.machine.state)).length + inertSettled;
      return mode === "any" ? settled > 0 : settled === live.length + inertSettled;
    };

    if (!satisfied()) {
      await new Promise<void>((resolve) => {
        let done = false;
        const finish = (): void => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          for (const w of live) w.waiters.delete(check);
          resolve();
        };
        const check = (): void => {
          if (satisfied()) finish();
        };
        const timer = setTimeout(finish, timeoutMs);
        for (const w of live) w.waiters.add(check);
        // One more look: a worker can settle between the guard above and the
        // registration above, and a waiter that missed its own event waits out
        // the full timeout for something that already happened.
        check();
      });
    }

    const records = unique.map((id) => this.get(id)).filter((r): r is WorkerRecord => r !== undefined);
    return { records, settled: records.filter((r) => isSettled(r.state)).map((r) => r.workerID) };
  }

  /**
   * Answer a blocked worker (§5's escalation channel).
   *
   * The same session is prompted again, so the worker still has every bit of its
   * own context — Phase 0 verified that reuse retains it. This is the only way a
   * worker gets help, and the only way `blocked` is left.
   */
  async answer(workerID: string, text: string, decision?: "allow" | "deny"): Promise<WorkerRecord> {
    const w = this.workers.get(workerID);
    if (!w) throw new Error(`unknown worker ${workerID}`);
    if (w.machine.state !== "blocked" || !w.answer) {
      throw new Error(`worker ${workerID} is ${w.machine.state}, not blocked; nothing is waiting for an answer`);
    }
    this.opts.store.appendEvent(workerID, "answered", { chars: text.length });
    // Resolve only once the worker is running again. A caller that got the
    // record back while it still said `blocked` would poll, see a settled state
    // and conclude the answer had been ignored.
    const resumed = new Promise<void>((resolve, reject) => {
      w.resumeSignal = { resolve, reject };
    });
    w.answer({ kind: "answer", text, ...(decision === undefined ? {} : { decision }) });
    w.answer = undefined;
    await resumed;
    return w.record.current;
  }

  /**
   * Send Claude's feedback to a settled worker and let it take another turn
   * (§5's revision path, §11 Phase 6).
   *
   * The session is reused, which is the entire point: the worker keeps every
   * file it read and every conclusion it drew, so feedback costs one turn rather
   * than a whole respawn. Phase 0 verified the reuse retains context and the
   * spike still asserts it.
   *
   * Returns as soon as the revision is *registered*, not when it has run
   * (DD-1) — but it moves the worker out of its settled state **before it
   * returns**, so a `worker_wait` on the next line has something to wait for
   * rather than coming straight back with the pre-revision record.
   *
   * Four things about this are load-bearing and none of them are obvious:
   *
   * - **It re-enters the concurrency queue.** A settled worker holds no slot —
   *   `drive()` releases it after `settle()` — so a revision that skipped the
   *   gate would put a session on the shared backend that nothing is counting.
   *   Revise three completed workers while three others run and a cap of three
   *   is silently six. So a revision acquires, runs, settles and releases, the
   *   way a spawn does, and while it waits its record says `queued`.
   * - **The new `done` is installed synchronously**, in the same tick as the
   *   state change. `dispose()` awaits `w.done`, and a settled worker's `done`
   *   resolved long ago; a gap here is a shutdown that returns while a revision
   *   is still prompting a session.
   * - **The cap counts rounds actually taken**, not rounds asked for. A revision
   *   that sits in the queue and is cancelled there took no round.
   * - **At the cap it refuses with a report rather than an error.** §13's
   *   mitigation for infinite fix loops is a cap *with a terminal actionable
   *   report*; a cap that stops the loop and produces nothing Claude can act on
   *   has converted a runaway into a dead end.
   */
  revise(workerID: string, feedback: string): ReviseOutcome {
    const w = this.workers.get(workerID);
    if (!w) {
      const stored = this.opts.store.getWorker(workerID);
      throw new Error(
        stored
          ? `worker ${workerID} belongs to a previous manager process; its session is gone, so there is nothing to revise. Spawn a new worker.`
          : `unknown worker ${workerID}`,
      );
    }
    if (this.halted) throw new Error(`the manager is shutting down; ${workerID} cannot be revised`);
    if (w.reviseInFlight) {
      throw new Error(`worker ${workerID} is already revising; wait for that round to settle before sending more feedback`);
    }

    const rec = w.record.current;
    if (!w.machine.can("revise")) throw new Error(notRevisable(rec, w.machine.state));
    // Every revisable state is one this worker reached *after* being prompted,
    // so a missing session here means the session died with the manager that
    // owned it — there is nothing to reuse and a respawn is the honest answer.
    if (!w.session) {
      throw new Error(
        `worker ${workerID} has no live session to revise — it never opened one, or it belongs to a previous process. Spawn a new worker instead.`,
      );
    }

    const round = w.revisions + 1;
    const budget = this.budgetFor(rec.spec);
    if (w.revisions >= this.opts.maxRevisions) {
      return { kind: "refused", reason: "revision_cap", report: this.capReport(w, "revision_cap") };
    }
    // The wall clock is per turn but the tokens are not: they accumulate in the
    // session, because every round re-sends the whole context. A worker already
    // at its token ceiling would be admitted, prompted and killed by the first
    // budget poll, which reads as a revision that silently did nothing.
    if (rec.totalTokens >= budget.tokens) {
      // Refused, not blocked: `worker_budget` raises the ceiling and the report
      // says so. Before Phase 7 this was a dead end, which is exactly what §8's
      // "pause and surface" was supposed not to be.
      return { kind: "refused", reason: "token_budget", report: this.capReport(w, "token_budget") };
    }

    // --- from here down, nothing awaits until `done` is installed ---
    w.reviseInFlight = true;
    // Sticky, and Phase 5 made it load-bearing: `prepareAndRun()` bails at four
    // step boundaries when it is set, so a worker that was stopped and is now
    // being deliberately redirected would abandon its round with a reason from
    // its previous life.
    w.cancelRequested = undefined;
    w.machine.apply("revise", { reason: "revision_requested", detail: { round } });
    this.opts.store.appendEvent(workerID, "revision_requested", {
      round,
      maxRevisions: this.opts.maxRevisions,
      // Claude's own words, capped the way every other quoted string here is.
      feedback: feedback.slice(0, FEEDBACK_TRAIL_CHARS),
      feedbackChars: feedback.length,
    });

    // The same priority as the spawn: a revision is more of this worker's work,
    // and a wave that put its critical path first should not lose that ordering
    // the moment one of them needs a second round.
    const admission = this.scheduler.enqueue(workerID, [], rec.spec.priority ?? 0);
    const hint = this.scheduler.hint(workerID);
    this.update(w, {
      state: w.machine.state,
      reason: hint?.reason ?? "revising",
      // It has not ended; a stale `endedAt` freezes every elapsed figure at the
      // moment the previous round finished.
      endedAt: undefined,
      questions: [],
    });
    if (hint) {
      this.opts.store.appendEvent(workerID, "queued", {
        reason: hint.reason,
        position: hint.position,
        running: hint.running,
        maxConcurrent: hint.maxConcurrent,
        revision: round,
      });
    }
    w.done = this.driveRevision(w, admission, feedback, round).catch(() => {
      /* driveRevision is total, exactly as drive() is: every failure is a state. */
    });
    return { kind: "started", round, record: w.record.current, ...(hint ? { hint } : {}) };
  }

  /**
   * Every round this worker has taken, oldest first, rebuilt from the trail.
   *
   * Read from the event log rather than kept in a column: the rounds are only
   * ever needed whole, at the cap or in the run report, and DD-7's rule is that
   * the index holds nothing whose loss breaks a run. The trail is already the
   * durable record of what happened and this is a view over it.
   */
  revisionHistory(workerID: string): RevisionRound[] {
    return revisionRounds(this.opts.store.listEvents(workerID, { limit: REVISION_TRAIL_LIMIT }));
  }

  /** The refusal, as data. {@link renderRevisionCap} turns it into the report. */
  private capReport(w: ManagedWorker, reason: RevisionRefusal): RevisionCapReport {
    const rec = w.record.current;
    return {
      workerID: rec.workerID,
      reason,
      revisions: w.revisions,
      maxRevisions: this.opts.maxRevisions,
      totalTokens: rec.totalTokens,
      tokenBudget: this.budgetFor(rec.spec).tokens,
      state: rec.state,
      branch: rec.branch,
      rounds: this.revisionHistory(rec.workerID),
      ...(rec.result === undefined ? {} : { result: rec.result }),
    };
  }

  /**
   * Stop a worker. Safe at any point; a settled worker is left alone.
   *
   * Four places a worker can be, and only one of them has a session to abort.
   * A *queued* worker is the Phase 5 addition and the one that matters for
   * shutdown: its `done` is parked on the admission promise, so refusing it is
   * the only thing that lets `dispose()` return at all.
   */
  async cancel(workerID: string, reason = "cancelled_by_request"): Promise<WorkerRecord> {
    const w = this.workers.get(workerID);
    if (!w) throw new Error(`unknown worker ${workerID}`);
    if (w.machine.final) return w.record.current;
    w.cancelRequested = reason;
    if (this.scheduler.reject(workerID, reason)) {
      // Queued: nothing was allocated, so there is nothing to abort and the
      // run loop settles it as `spawned → cancel → cancelled`.
    } else if (w.answer) {
      w.answer({ kind: "cancel" });
      w.answer = undefined;
    } else if (w.session) {
      await this.requestAbort(w, { disposition: "cancelled", reason, at: this.opts.now() });
    }
    // Admitted but still preparing: no session exists yet, so there is nothing
    // to abort and `prepareAndRun` picks the flag up at its next step boundary.
    // Return when it has genuinely stopped, not when the request was sent.
    await w.done;
    return w.record.current;
  }

  /**
   * Fire the one edge Phase 2 enumerated and never used: `completed → merged`.
   *
   * The state machine is what makes this safe. Attempting to merge a `failed`,
   * `timed_out` or already-`merged` worker throws {@link IllegalTransitionError}
   * here, loudly, before any git command runs — rather than quietly at a `git
   * merge` whose error message would be about refs. That is exactly why §5's
   * table enumerates edges instead of documenting them.
   *
   * Called by the merge coordinator once a worker's commits are genuinely in the
   * integration branch. A worker whose branch had nothing to merge stays
   * `completed`: it was never merged, and saying it was would put a false row in
   * the run report.
   */
  markMerged(workerID: string, detail: { mergeID: string; integrationBranch: string; sha?: string }): WorkerRecord {
    const live = this.workers.get(workerID);
    const record = live?.record.current ?? this.opts.store.getWorker(workerID);
    if (!record) throw new Error(`unknown worker ${workerID}`);

    // A worker the manager still holds in memory has the authoritative machine;
    // one that only exists in the index (a previous process's, rebuilt at
    // startup) gets a machine seeded from its stored state. Both reject an
    // illegal move identically, which is the property that matters.
    const trail = {
      mergeID: detail.mergeID,
      branch: detail.integrationBranch,
      ...(detail.sha === undefined ? {} : { sha: detail.sha }),
    };
    // A live worker's machine writes the `state:merged` row itself, through the
    // hook installed in `spawn()`; one rebuilt from the index has no hook, so
    // this is the only path that writes it twice if both do.
    if (live) live.machine.apply("merge", { reason: "gated_merge", detail: trail });
    else new WorkerMachine({ workerID, initial: record.state }).apply("merge", { reason: "gated_merge", detail: trail });

    const updated: WorkerRecord = { ...record, state: "merged", updatedAt: this.opts.now() };
    if (live) live.record.current = updated;
    this.opts.store.putWorker(updated);
    if (!live) {
      this.opts.store.appendEvent(workerID, "state:merged", { from: record.state, trigger: "merge", reason: "gated_merge", ...trail });
    }
    if (live) this.notify(live);
    return updated;
  }

  /**
   * Raise a worker's budget ceiling (§8's cost controls, §11 Phase 7).
   *
   * §8 says a worker that exceeds its cap should **pause and surface to Claude**,
   * and until Phase 7 only half of that was true: the worker stopped and said so,
   * and there was no way to say "carry on, you may have more". The grant is that
   * way, and it is deliberately *not* a resume — raising a ceiling and deciding
   * to continue are two different decisions, and a tool that did both would take
   * the second one on Claude's behalf. Grant, then `worker_revise` to continue;
   * the refusal `worker_revise` gives an over-budget worker names this tool.
   *
   * The grant is additive and is written to the worker's own spec, so it
   * survives a restart in the row like everything else that matters. It applies
   * to a running worker immediately — the watchdogs read the budget fresh on
   * every tick — which means a worker about to be killed for its tokens can be
   * rescued mid-turn rather than only after it dies.
   */
  grantBudget(workerID: string, grant: { tokens?: number; wallClockMs?: number }): { record: WorkerRecord; budget: WorkerBudget } {
    const w = this.workers.get(workerID);
    const stored = w?.record.current ?? this.opts.store.getWorker(workerID);
    if (!stored) throw new Error(`unknown worker ${workerID}`);
    if (stored.state === "merged") {
      throw new Error(`worker ${workerID} is merged; its work is already on an integration branch and more budget would buy nothing`);
    }
    const addTokens = Math.max(0, Math.floor(grant.tokens ?? 0));
    const addWallClockMs = Math.max(0, Math.floor(grant.wallClockMs ?? 0));
    if (addTokens === 0 && addWallClockMs === 0) {
      throw new Error("a budget grant needs tokens, wallClockMs, or both — nothing was asked for");
    }

    const before = this.budgetFor(stored.spec);
    const after: WorkerBudget = {
      ...before,
      tokens: before.tokens + addTokens,
      wallClockMs: before.wallClockMs + addWallClockMs,
    };
    // Onto the spec, because the spec is what `budgetFor()` reads and what the
    // row persists. A grant kept only in memory would be forgotten by the next
    // process, which is the one place a worker most needs it remembered.
    const spec: WorkerSpec = { ...stored.spec, budget: { ...(stored.spec.budget ?? {}), tokens: after.tokens, wallClockMs: after.wallClockMs } };
    const updated: WorkerRecord = { ...stored, spec, updatedAt: this.opts.now() };
    if (w) w.record.current = updated;
    this.opts.store.putWorker(updated);
    this.opts.store.appendEvent(workerID, "budget_granted", {
      addTokens,
      addWallClockMs,
      tokens: after.tokens,
      wallClockMs: after.wallClockMs,
      spent: stored.totalTokens,
      state: stored.state,
    });
    return { record: updated, budget: after };
  }

  /**
   * Act on a worker a previous process left mid-flight (§9, §11 Phase 7).
   *
   * `recover()` turns a dead process's `running` rows into `interrupted`, which
   * §9 calls *a decision point, not a verdict* — and until Phase 7 nothing could
   * take the decision. The state machine has enumerated the three edges out of
   * `interrupted` since Phase 2 and fired none of them; these are them.
   *
   * - **`resume`** — carry on with this worker. What that means depends on a
   *   fact only the backend knows: whether its session still exists. If it does
   *   (a shared server, `ORCHESTRATOR_BASE_URL`), the turn may still be running
   *   and this re-subscribes and monitors it. If it does not — the ordinary case,
   *   because a restarted manager spawns a fresh server — the turn is gone but
   *   **the worktree is not**, so the worker is settled from what is on disk:
   *   snapshot, measured diff, the test command re-run, reconciliation, a real
   *   result. That salvage is what makes a `kill -9` cost a turn rather than the
   *   work, and it is the honest reading of §9's "resume monitoring".
   * - **`fail`** — settle it as `failed`, keeping the worktree. For a worker
   *   whose work is not worth having but whose row should stop being a question.
   * - **`discard`** — settle it as `cancelled`, keeping the worktree. DD-7: the
   *   commits are the only copy of what the worker produced, so nothing here
   *   deletes anything. `workspace_cleanup` is the tool that deletes.
   *
   * Like {@link revise} this returns as soon as the decision is registered, and
   * for the same three reasons: the state leaves `interrupted` before it
   * returns, the new `done` is installed in the same tick, and the work itself
   * re-enters the concurrency queue rather than running unaccounted.
   */
  recoverWorker(workerID: string, action: RecoverAction): RecoverOutcome {
    const stored = this.opts.store.getWorker(workerID);
    if (!stored) throw new Error(`unknown worker ${workerID}`);
    if (this.halted) throw new Error(`the manager is shutting down; ${workerID} cannot be recovered`);
    if (stored.state !== "interrupted") {
      throw new Error(
        `worker ${workerID} is ${stored.state}, not interrupted — worker_recover is for workers a previous manager process left mid-flight. ` +
          (isSettled(stored.state)
            ? "This one has settled; read worker_result."
            : "This one is live in this process; wait for it, or stop it with worker_stop."),
      );
    }

    // A worker this process has never held has no `ManagedWorker` — `recover()`
    // wrote the row and nothing else. Rebuild one around the stored record so
    // the run loop, the waiters and `dispose()` all see it like any other.
    const w = this.workers.get(workerID) ?? this.adopt(stored);

    if (action === "fail" || action === "discard") {
      const trigger = action === "fail" ? "fail" : "cancel";
      const reason = action === "fail" ? "recovered_failed" : "recovered_discarded";
      w.machine.apply(trigger, { reason });
      this.update(w, { state: w.machine.state, reason, endedAt: this.opts.now() });
      this.opts.store.appendEvent(workerID, "recovered", { action, reason });
      this.metric({ kind: "recovery", at: this.opts.now(), runID: stored.runID, workerID, action, resumed: false });
      this.notify(w);
      return { kind: "settled", action, record: w.record.current };
    }

    // --- resume: nothing awaits until `done` is installed ---
    w.cancelRequested = undefined;
    w.machine.apply("recover", { reason: "recovering" });
    this.opts.store.appendEvent(workerID, "recovered", { action, sessionID: stored.sessionID ?? null });
    this.metric({ kind: "recovery", at: this.opts.now(), runID: stored.runID, workerID, action, resumed: true });
    const admission = this.scheduler.enqueue(workerID, [], stored.spec.priority ?? 0);
    const hint = this.scheduler.hint(workerID);
    this.update(w, { state: w.machine.state, reason: hint?.reason ?? "recovering", endedAt: undefined });
    w.done = this.driveRecovery(w, admission).catch(() => {
      /* total, exactly as drive() and driveRevision() are */
    });
    return { kind: "resuming", action, record: w.record.current, ...(hint ? { hint } : {}) };
  }

  /**
   * Rebuild the in-memory half of a worker this process never ran.
   *
   * Everything durable is already in the row (DD-7); what is missing is the
   * machine, the waiter set and the session handle. The machine is seeded at the
   * stored state so an illegal move still throws, and the hook that writes
   * `state:*` is installed exactly as `spawn()` installs it — one writer per
   * transition, which is the defect Phase 5's run report found.
   */
  private adopt(stored: WorkerRecord): ManagedWorker {
    const workerID = stored.workerID;
    const box = { current: stored };
    const w = new ManagedWorker(
      box,
      this.opts.now,
      (change) => {
        this.opts.store.appendEvent(workerID, `state:${change.to}`, {
          from: change.from,
          trigger: change.trigger,
          ...(change.reason === undefined ? {} : { reason: change.reason }),
          ...(change.detail ?? {}),
        });
      },
      // Seeded from the row, not from `spawned`.
      stored.state,
    );
    // Rebuilt rather than restored: the handle the previous process held is
    // gone, and everything this one needs of it is in the row. Whether the
    // *backend* still knows this session is a different question, and
    // `driveRecovery` asks it rather than assuming.
    if (stored.sessionID) {
      w.session = { sessionID: stored.sessionID, directory: stored.worktree, createdAt: stored.createdAt };
    }
    w.revisions = stored.revisions;
    w.resumes = stored.resumes;
    w.totalTokens = stored.totalTokens;
    w.cost = stored.cost;
    this.workers.set(workerID, w);
    return w;
  }

  /**
   * §9's restart recovery.
   *
   * Call it before spawning anything. Rows left `running`, `blocked`, `preparing`
   * or `spawned` by a process that no longer exists are lies; they become
   * `interrupted`, which is a decision point, not a verdict. Worktrees are left
   * exactly as they are — they are the durable state, and destroying a worker's
   * work because the manager fell over would be the opposite of recovery.
   */
  async recover(): Promise<WorkerRecord[]> {
    const stale = this.opts.store.listUnfinished();
    const recovered: WorkerRecord[] = [];
    for (const row of stale) {
      const machine = new WorkerMachine({ workerID: row.workerID, initial: row.state, now: this.opts.now });
      const change = machine.tryApply("interrupt", { reason: "manager_restart" });
      if (!change) continue;
      const worktreeIntact = row.worktree !== "" && existsSync(row.worktree);
      // The queue is in-process and does not survive a restart (ADR-0004). A row
      // that never got as far as a worktree was queued, not mid-flight, and
      // saying so is the difference between "inspect the worktree" and "just
      // spawn it again, nothing was spent".
      const neverStarted = row.state === "spawned" && row.worktree === "";
      const updated: WorkerRecord = {
        ...row,
        state: "interrupted",
        reason: neverStarted
          ? "manager_restart_while_queued"
          : worktreeIntact
            ? "manager_restart"
            : "manager_restart_worktree_missing",
        updatedAt: this.opts.now(),
      };
      this.opts.store.putWorker(updated);
      this.opts.store.appendEvent(row.workerID, "state:interrupted", {
        from: row.state,
        trigger: "interrupt",
        reason: updated.reason,
        worktreeIntact,
      });
      recovered.push(updated);
    }
    return recovered;
  }

  /**
   * Rebuild index rows from the worktrees on disk (DD-7).
   *
   * The database is an index; this is what makes losing it survivable rather
   * than catastrophic. Rows that already exist are left alone.
   */
  async rebuildIndex(): Promise<WorkerRecord[]> {
    const root = await this.resolveWorktreeRoot();
    const manifests = listManifests(root);
    return this.opts.store.rebuildFromWorktrees(manifests, (m: WorkerManifest) => join(root, m.workerID));
  }

  /** Cancel everything and wait for the loops to settle. */
  async dispose(): Promise<void> {
    const active = [...this.workers.values()].filter((w) => !w.machine.final);
    await Promise.all(active.map((w) => this.cancel(w.record.current.workerID, "manager_disposed").catch(() => {})));
    await Promise.all([...this.workers.values()].map((w) => w.done ?? Promise.resolve()));
  }

  /**
   * Stop dead, writing nothing — a simulated crash, for testing §9.
   *
   * Deliberately not `dispose()`: the difference between a manager that shuts
   * down and a manager that is killed is exactly what recovery has to handle,
   * and a test that cannot produce the second one is not testing recovery.
   */
  halt(): void {
    this.halted = true;
    // Settle every parked admission too: a `done` still waiting for a slot is a
    // promise nothing will ever resolve, and every test awaiting one hangs.
    this.scheduler.halt();
    for (const w of this.workers.values()) {
      w.stream?.close();
      w.answer?.({ kind: "cancel" });
      for (const notify of [...w.waiters]) notify();
    }
    this.workers.clear();
  }

  // --- the run loop -------------------------------------------------------

  /**
   * The whole of one worker's life, from the queue to a settled row.
   *
   * The first `await` is the concurrency gate. Nothing before it costs anything
   * — no worktree, no session, no clock — which is what makes a queued worker
   * genuinely free and its wall-clock budget genuinely untouched by the wait.
   */
  private async drive(w: ManagedWorker, admission: Promise<Admission>): Promise<void> {
    const workerID = w.record.current.workerID;
    const verdict = await admission;
    // A halted manager writes nothing, by definition — that is the difference
    // between a shutdown and the crash §9's recovery has to survive.
    if (this.halted) return;
    if (verdict.kind === "refused") {
      await this.settle(w, { kind: "cancelled", reason: verdict.reason });
      return;
    }
    // Admitted: the `queued` / `waiting_on_dependencies` reason has stopped
    // being true, and a stale one would render as the reason it is preparing.
    if (w.record.current.reason !== undefined) this.update(w, { reason: undefined });

    let disposition: Disposition;
    try {
      disposition = await this.prepareAndRun(w);
    } catch (e) {
      const err = e instanceof OpenCodeError ? e : undefined;
      disposition = {
        kind: "failed",
        reason: err ? `backend_${err.code}` : "manager_error",
        ...(err ? { error: err } : {}),
      };
      if (!err) this.opts.store.appendEvent(w.record.current.workerID, "manager_error", { message: String(e) });
    } finally {
      // Fact (2): the subscription outlives every loop over it, so this is the
      // one place it is closed — after the worker is genuinely finished, not
      // when some `for await` stopped reading.
      w.stream?.close();
    }
    if (this.halted) return;
    try {
      await this.settle(w, disposition);
    } finally {
      // After settling, never before. A dependent may only start once its
      // dependency is genuinely `completed`, and `completed` is a fact only
      // once the snapshot, the independent test re-run and the reconciliation
      // have happened. One release point keeps the slot and the dependency
      // edge from disagreeing about when this worker finished.
      this.scheduler.release(workerID);
    }
  }

  /**
   * One revision round, from the queue to a settled row.
   *
   * The shape mirrors {@link WorkerManager.drive} deliberately — admission,
   * turn, settle, release — because a revision *is* a spawn-shaped thing and the
   * two must not drift apart. What differs is only what happens in the middle:
   * no worktree is created and no session is opened, because reusing both is the
   * whole point.
   */
  private async driveRevision(w: ManagedWorker, admission: Promise<Admission>, feedback: string, round: number): Promise<void> {
    const workerID = w.record.current.workerID;
    const verdict = await admission;
    if (this.halted) return;

    if (verdict.kind === "refused") {
      // The round never ran: no prompt went out, no tokens were spent, and the
      // worktree is exactly as the previous round left it. So this settles the
      // worker **without rebuilding its result** — re-running the reconciliation
      // here would overwrite a real result describing real work with one
      // describing a round that did not happen.
      w.reviseInFlight = false;
      w.machine.tryApply("cancel", { reason: verdict.reason, detail: { revision: round, prompted: false } });
      this.opts.store.appendEvent(workerID, "revision_abandoned", { round, reason: verdict.reason });
      this.update(w, { state: w.machine.state, reason: verdict.reason, endedAt: this.opts.now() });
      this.notify(w);
      return;
    }

    if (w.record.current.reason !== undefined) this.update(w, { reason: undefined });

    let disposition: Disposition;
    try {
      disposition = await this.reviseTurn(w, feedback, round);
    } catch (e) {
      const err = e instanceof OpenCodeError ? e : undefined;
      disposition = {
        kind: "failed",
        reason: err ? `backend_${err.code}` : "manager_error",
        ...(err ? { error: err } : {}),
      };
      if (!err) this.opts.store.appendEvent(workerID, "manager_error", { message: String(e) });
    } finally {
      // The revision opened its own subscription; it closes here for the same
      // reason `drive()` closes the first one, and in the same one place.
      w.stream?.close();
    }
    if (this.halted) return;
    // Cleared *before* settling, not after. The round is over — a disposition
    // exists — and settling is the manager's own bookkeeping. Clearing it
    // afterwards would leave the flag set at the moment `settle()` wakes every
    // waiter, so a caller that did `worker_wait` then `worker_revise` could be
    // told a revision was in flight when the one it waited for had just ended.
    w.reviseInFlight = false;
    try {
      await this.settle(w, disposition);
    } finally {
      this.scheduler.release(workerID);
    }
  }

  /**
   * Carry on with a worker a previous process left mid-flight.
   *
   * The whole function turns on one question the backend answers and nothing
   * else can: **does this session still exist?**
   *
   * - **It does** — a shared server outlived the manager. The turn may still be
   *   running, so this re-subscribes and pumps it exactly as the original loop
   *   would have. What cannot be recovered is the *reply so far*: it lived in
   *   the dead process's memory, so `readReport()` will fall back to the
   *   worktree's `report.json` (§5's secondary channel) or to no report at all,
   *   and the measured diff carries the result either way.
   * - **It does not** — the ordinary case, because a restarted manager spawns a
   *   fresh server. There is nothing to monitor and nothing to abort, but the
   *   worktree is intact and is the durable half (DD-7). So the worker is
   *   settled *from disk*: snapshot, diff, the brief's test command re-run
   *   independently, reconciliation. The worker's own claims are mostly gone;
   *   the measurements are all still there, and they are the half §4.3 calls the
   *   finding.
   *
   * Either way this ends in a settled row with a real result and a branch worth
   * merging, which is what "clean recovery" has to mean.
   */
  private async driveRecovery(w: ManagedWorker, admission: Promise<Admission>): Promise<void> {
    const workerID = w.record.current.workerID;
    const verdict = await admission;
    if (this.halted) return;

    if (verdict.kind === "refused") {
      w.machine.tryApply("cancel", { reason: verdict.reason });
      this.update(w, { state: w.machine.state, reason: verdict.reason, endedAt: this.opts.now() });
      this.notify(w);
      return;
    }
    if (w.record.current.reason !== undefined) this.update(w, { reason: undefined });

    let disposition: Disposition;
    try {
      disposition = await this.recoverTurn(w);
    } catch (e) {
      const err = e instanceof OpenCodeError ? e : undefined;
      disposition = {
        kind: "failed",
        reason: err ? `backend_${err.code}` : "manager_error",
        ...(err ? { error: err } : {}),
      };
      if (!err) this.opts.store.appendEvent(workerID, "manager_error", { message: String(e) });
    } finally {
      w.stream?.close();
    }
    if (this.halted) return;
    try {
      await this.settle(w, disposition);
    } finally {
      this.scheduler.release(workerID);
    }
  }

  /** The live-session half of {@link WorkerManager.driveRecovery}, or the salvage. */
  private async recoverTurn(w: ManagedWorker): Promise<Disposition> {
    const rec = w.record.current;
    if (this.halted) return { kind: "cancelled", reason: "manager_halted" };
    if (w.cancelRequested) return { kind: "cancelled", reason: w.cancelRequested };

    // `usage()` answers `null` for a session the backend does not know, which is
    // the liveness probe this needs and costs one request. Deliberately not a
    // new backend method: DD-2's surface is small on purpose, and a question the
    // existing one already answers does not earn a new one.
    const alive = w.session ? await this.opts.backend.usage(w.session).catch(() => null) : null;
    if (!alive) {
      this.opts.store.appendEvent(rec.workerID, "recovery_salvaged", {
        sessionID: rec.sessionID ?? null,
        worktree: rec.worktree,
        reason: rec.sessionID ? "session_gone" : "no_session",
      });
      // No prompt, no stream, no watchdogs — there is nothing running to watch.
      // `settle()` does the rest: it snapshots, measures, re-runs the tests and
      // reconciles, all from the worktree, which is exactly what is left.
      w.runningSince = this.opts.now();
      return { kind: "complete" };
    }

    this.opts.store.appendEvent(rec.workerID, "recovery_resumed", {
      sessionID: rec.sessionID ?? null,
      totalTokens: alive.totalTokens,
    });
    w.totalTokens = alive.totalTokens;
    w.cost = alive.cost;
    // A fresh subscription and a fresh clock, for the same reasons a revision
    // gets them: the previous stream died with the process, and the deadline
    // exists to bound *this* watch rather than to charge the worker for the time
    // the manager spent not running.
    w.stream = await this.opts.backend.events(w.session!, { deltas: true });
    const now = this.opts.now();
    w.runningSince = now;
    w.blockedTotalMs = 0;
    w.lastWorkerEventAt = now;
    w.lastBudgetPollAt = now;
    w.replyText = "";
    w.replyTruncated = false;
    w.sawAbort = false;
    w.abortIntent = undefined;
    w.retryAt = undefined;
    // The turn was already under way when the manager died, so nothing is going
    // to prove it started a second time. Treating it as started is what lets the
    // terminal event that ends it actually end it, rather than being discarded
    // as stale — the one place the Phase 2 discrimination has to be told the
    // answer instead of observing it.
    w.turnStarted = true;
    // The turn may have ended while nobody was listening. Give it a short window
    // to prove otherwise, then salvage rather than wait out the idle watchdog.
    w.recoverStartedAt = now;
    w.recoverDeadline = now + this.opts.recoverGraceMs;
    return this.pump(w);
  }

  /**
   * Prompt the existing session with Claude's feedback and read the turn out.
   *
   * Everything before the prompt is the answer to one question: which of
   * `ManagedWorker`'s fields survived the previous `settle()` and are now
   * *wrong*? The run loop was written once, for one turn, and a second turn
   * inherits all of it.
   */
  private async reviseTurn(w: ManagedWorker, feedback: string, round: number): Promise<Disposition> {
    const rec = w.record.current;
    if (this.halted) return { kind: "cancelled", reason: "manager_halted" };
    if (w.cancelRequested) return { kind: "cancelled", reason: w.cancelRequested };
    w.machine.apply("prepare", { reason: "revising", detail: { round } });
    this.update(w, { state: "preparing" });

    // The report channel. `parseReport` takes the *first* usable object out of
    // the reply, so an uncleared buffer makes the new report the old one with
    // the new one stuck to the end of it — and the old one wins.
    w.replyText = "";
    w.replyTruncated = false;
    // Terminal-event discrimination, from Phase 2's facts (1) and (3). A stale
    // `sawAbort` turns this round's clean finish into `aborted_externally`, and
    // a stale `abortIntent` settles it on the *previous* round's reason.
    w.sawAbort = false;
    w.abortIntent = undefined;
    w.turnStarted = false;
    w.retryAt = undefined;
    w.lastError = undefined;
    w.questions = [];
    // `lastTerminalAt` is deliberately KEPT. It is what makes `promptTurn()`
    // wait out the settle guard, and a revision prompts a session that has just
    // gone terminal — which on OpenCode 1.18.25 is precisely the prompt that is
    // accepted with 204 and then silently dropped. Clearing it here would
    // produce a revision that does nothing at all, for 57 seconds, with no error.
    // `formatRetried` and `structuredOutputOK` are kept latched too: the
    // provider has not changed its mind about schema-constrained output.

    // `drive()` closed the previous subscription in its `finally`, so this round
    // needs a new one — awaited before the prompt goes out, for the reason
    // `prepareAndRun()` subscribes first: a trivial turn can finish in ~11s and
    // a late subscriber misses the completion entirely.
    w.stream = await this.opts.backend.events(w.session!, { deltas: true });

    if (this.halted) return { kind: "cancelled", reason: "manager_halted" };
    if (w.cancelRequested) return { kind: "cancelled", reason: w.cancelRequested };

    const now = this.opts.now();
    // A fresh wall clock, set at the prompt rather than at the revise call, for
    // the same reason queue time is free for a spawn: this is a new turn with a
    // new instruction, and the deadline exists to stop *this* turn hanging.
    // Tokens are not reset — they accumulate in the session, because each round
    // re-sends the whole context, and that cumulative figure is the honest one.
    w.runningSince = now;
    w.blockedTotalMs = 0;
    w.lastWorkerEventAt = now;
    w.lastBudgetPollAt = now;
    await this.promptTurn(w, buildRevisionPrompt(feedback, round, this.opts.maxRevisions));

    w.revisions = round;
    w.machine.apply("start", { reason: "revising", detail: { round } });
    this.update(w, {
      state: "running",
      revisions: round,
      reason: undefined,
      endedAt: undefined,
      questions: [],
      // Kept at the *first* round's value, so elapsed time in the run report is
      // the whole of this worker's life rather than only its last turn. The
      // budget clock is `runningSince` and is a different number on purpose.
      // The one exception is a worker that was stopped before it was ever
      // prompted: it has a session but no start, and leaving it unset would make
      // `buildResult` report this round as `not_started`.
      ...(rec.startedAt === undefined ? { startedAt: now } : {}),
    });
    this.metric({
      kind: "revision_round",
      at: now,
      runID: rec.runID,
      workerID: rec.workerID,
      round,
      feedbackChars: feedback.length,
    });
    this.opts.store.appendEvent(rec.workerID, "revision_started", {
      round,
      ...(rec.sessionID === undefined ? {} : { sessionID: rec.sessionID }),
    });

    return this.pump(w);
  }

  private async prepareAndRun(w: ManagedWorker): Promise<Disposition> {
    const rec = w.record.current;
    if (this.halted) return { kind: "cancelled", reason: "manager_halted" };
    if (w.cancelRequested) return { kind: "cancelled", reason: w.cancelRequested };
    w.machine.apply("prepare");
    this.update(w, { state: "preparing" });

    const repoRoot = await this.resolveRepo();
    const worktreeRoot = await this.resolveWorktreeRoot();
    // Resolved before the worktree exists, because it decides where the worktree
    // branches from: a reviewer reading a diff against one base while its own
    // checkout sits on another is reviewing two different repositories at once.
    const review = rec.mode === "review" && rec.spec.reviewOf ? await this.reviewTargetOf(rec.spec.reviewOf) : undefined;
    const baseRef = rec.spec.baseRef ?? review?.baseSha;

    let wt: { path: string; branch: string; baseSha: string };
    if (this.workspaceOf(rec.spec) === "shared") {
      // §11 Phase 8: the worker works in the repository itself, alongside every
      // other shared worker — which is what Claude's own subagents do, and what
      // this was asked for. No worktree, no branch, and nothing to merge
      // afterwards because the work is simply *there*.
      //
      // Two things this must get right, and they are the whole reason shared
      // mode is not one line. The baseline is HEAD **plus whatever was already
      // dirty**, because attributing the user's half-finished feature to the
      // first worker that settles would be a lie in the one channel this system
      // keeps honest. And nothing is ever committed here — see `settle()`.
      w.preexisting = await dirtyFiles(repoRoot);
      wt = { path: repoRoot, branch: "", baseSha: await resolveSha(repoRoot, baseRef ?? "HEAD") };
      this.opts.store.appendEvent(rec.workerID, "shared_workspace", {
        repoRoot,
        baseSha: wt.baseSha,
        alreadyDirty: w.preexisting.length,
      });
    } else {
      wt = await createWorktree({
        repoRoot,
        workerID: rec.workerID,
        root: worktreeRoot,
        ...(baseRef === undefined ? {} : { baseRef }),
      });
    }
    this.update(w, { worktree: wt.path, branch: wt.branch, baseSha: wt.baseSha });
    // Skipped in shared mode: `writeManifest` writes one file per *worktree*, and
    // in a shared tree every worker would overwrite the last one's — turning
    // DD-7's rebuild-from-disk into a rebuild of whichever worker finished most
    // recently. There is no per-worker directory to rebuild from either.
    if (wt.branch !== "") this.writeManifest(w);
    if (w.cancelRequested) return { kind: "cancelled", reason: w.cancelRequested };

    const base = buildBrief({
      workerID: rec.workerID,
      spec: rec.spec,
      mode: rec.mode,
      budget: this.budgetFor(rec.spec),
      baseSha: wt.baseSha,
      worktree: wt.path,
      ...(wt.branch === "" ? { shared: true } : {}),
    });
    // A reviewer's standing contract is the same as anyone's; only the turn's
    // instruction differs, because the thing it is being pointed at is not in
    // its own worktree. The system half is untouched so the read-only rules and
    // the report format still arrive with every prompt (ADR-0002).
    const brief: Brief = review ? { ...base, text: buildReviewPrompt(review.target) } : base;
    w.brief = brief;
    if (review) {
      this.opts.store.appendEvent(rec.workerID, "review_target", {
        target: review.target.workerID,
        baseSha: review.baseSha,
        diffLines: review.target.diff.length,
        truncated: review.target.diffTruncated,
        source: review.source,
      });
    }

    // Checked again here, and not only at spawn: a worker admitted from the queue
    // may have waited while its siblings spent the run's whole budget, and the
    // point of a cap is that it binds at the moment the money would be spent.
    const overRun = this.runBudgetRefusal(rec.runID);
    if (overRun) {
      this.opts.store.appendEvent(rec.workerID, "run_budget_exceeded", { runID: rec.runID, spent: this.runSpend(rec.runID) });
      return { kind: "over_budget", reason: "run_budget" };
    }

    const session = await this.opts.backend.createSession({
      cwd: wt.path,
      title: rec.workerID,
      model: rec.model,
      permissions: rec.mode === "implement" ? IMPLEMENT_PERMISSIONS : READ_ONLY_PERMISSIONS,
    });
    w.session = session;
    this.update(w, { sessionID: session.sessionID });
    this.writeManifest(w);

    if (this.halted) return { kind: "cancelled", reason: "manager_halted" };
    if (w.cancelRequested) return { kind: "cancelled", reason: w.cancelRequested };

    // Subscribe *before* prompting: a trivial task can finish in ~11s and a late
    // subscriber misses the completion entirely. `events()` resolves only once
    // the subscription is live, so awaiting it is the whole guarantee.
    // Deltas are on because the reply *is* the report (see ADR-0002).
    w.stream = await this.opts.backend.events(session, { deltas: true });

    const now = this.opts.now();
    w.runningSince = now;
    w.lastWorkerEventAt = now;
    w.lastBudgetPollAt = now;
    await this.promptTurn(w, brief.text);
    w.machine.apply("start");
    this.update(w, { state: "running", startedAt: now });

    return this.pump(w);
  }

  /**
   * Send one turn to the worker's session.
   *
   * The wait at the top is not caution, it is a measured requirement. On
   * OpenCode 1.18.25 a prompt sent within a few tens of milliseconds of the
   * session's previous terminal event is **accepted with HTTP 204 and then
   * silently dropped** — no busy status, no work, no error. The run loop sees a
   * worker that was asked to continue and did nothing, and waits until the idle
   * watchdog calls it wedged. Measured directly: re-prompting 26ms after a
   * terminal produced nothing in the following 57 seconds; the same prompt sent
   * later on the same session ran normally.
   *
   * Both paths that re-prompt an existing session go through here — the
   * structured-output retry and §5's blocked→resume — so the rule is stated once.
   */
  private async promptTurn(w: ManagedWorker, text: string): Promise<void> {
    const rec = w.record.current;
    if (w.lastTerminalAt !== undefined) {
      const quiet = this.opts.now() - w.lastTerminalAt;
      if (quiet < this.opts.retrySettleMs) await sleepMs(this.opts.retrySettleMs - quiet);
    }
    w.lastPromptText = text;
    w.usedFormat = this.structuredOutputOK;
    w.turnStarted = false;
    await this.opts.backend.prompt(w.session!, {
      text,
      ...(w.brief?.system === undefined ? {} : { system: w.brief.system }),
      ...(rec.mode === "implement" ? {} : { tools: READ_ONLY_TOOLS }),
      ...(w.usedFormat
        ? { format: { type: "json_schema" as const, schema: REPORT_SCHEMA, retryCount: REPORT_RETRY_COUNT } }
        : {}),
    });
  }

  /**
   * Re-send the current turn with the schema constraint dropped.
   *
   * Verified on OpenCode 1.18.25: `format: {type: "json_schema"}` is implemented
   * by forcing a tool call, and a provider that only accepts `tool_choice: auto`
   * rejects the whole request — the free-tier model this project defaults to is
   * one of them. The schema was never the contract, only its enforcement; the
   * brief already states the contract in words and the parser was written to be
   * lied to. So the constraint is a bonus where it works, not a dependency.
   */
  private async retryWithoutFormat(w: ManagedWorker): Promise<void> {
    await this.resendTurn(w);
  }

  /**
   * Re-send the turn that is already in {@link ManagedWorker.lastPromptText}.
   *
   * Both re-send paths land here so the reset is written once: the partial reply
   * from the failed attempt has to go (`parseReport` takes the first usable
   * object, so a kept prefix wins over the real answer), and `sawAbort` has to
   * go with it or the retry's clean finish reads as `aborted_externally`.
   *
   * The backoff is *before* the prompt and after the reset, and it is a real
   * wait rather than a token one: a provider that rate-limited us will do it
   * again if we come straight back, and the retry that arrives 30 ms later is
   * indistinguishable from the request that caused the problem.
   */
  private async resendTurn(w: ManagedWorker): Promise<void> {
    w.retryAt = undefined;
    w.replyText = "";
    w.replyTruncated = false;
    w.sawAbort = false;
    const delay = w.resendDelayMs;
    w.resendDelayMs = 0;
    if (delay > 0) {
      this.opts.store.appendEvent(w.record.current.workerID, "retry_backoff", { delayMs: delay, attempt: w.retries });
      await sleepMs(delay);
      if (this.halted || w.cancelRequested) return;
    }
    w.lastWorkerEventAt = this.opts.now();
    await this.promptTurn(w, w.lastPromptText);
  }

  /**
   * Consume the stream until the worker is finished with the manager.
   *
   * The loop races the next event against a watchdog tick rather than awaiting
   * events alone, because the failures that matter most here — a wedged worker,
   * a dead server, a runaway budget — all look like *nothing arriving*.
   */
  private async pump(w: ManagedWorker): Promise<Disposition> {
    const stream = w.stream!;
    const it = stream[Symbol.asyncIterator]();
    let pending: Promise<IteratorResult<OCEvent>> | undefined;
    /**
     * When the watchdogs last ran.
     *
     * The tick below is a race, not a schedule: a stream that produces an event
     * every few milliseconds — a worker streaming text deltas, or a server whose
     * heartbeat is faster than `tickMs` — wins that race every time, and the
     * watchdogs then never run at all. Which is precisely backwards: the runaway
     * worker the token budget exists to stop is the *chattiest* one there is.
     * So the tick decides how often they run, and the race only decides what
     * else the loop does while it waits.
     */
    let lastCheckAt = this.opts.now();

    for (;;) {
      if (this.halted) return { kind: "cancelled", reason: "manager_halted" };
      pending ??= it.next();
      const tick = delay(this.opts.tickMs);
      let winner: { t: "event"; r: IteratorResult<OCEvent> } | { t: "tick" };
      try {
        winner = await Promise.race([pending.then((r) => ({ t: "event" as const, r })), tick.promise]);
      } catch (e) {
        // The subscription broke rather than ending. Same question as below: is
        // the worker gone, or the server? Only one of those is the worker's.
        tick.cancel();
        const health = await this.opts.backend.health();
        return {
          kind: "failed",
          reason: health.alive ? "stream_error" : "server_gone",
          ...(e instanceof OpenCodeError ? { error: e } : {}),
        };
      }
      tick.cancel();

      if (winner.t === "tick") {
        lastCheckAt = this.opts.now();
        const d = await this.checkWatchdogs(w);
        if (d) return d;
        continue;
      }

      pending = undefined;
      if (winner.r.done) {
        // The subscription ended under us. That is the server, not the worker.
        const health = await this.opts.backend.health();
        return {
          kind: "failed",
          reason: health.alive ? "stream_ended" : "server_gone",
          ...(w.lastError ? { error: w.lastError } : {}),
        };
      }

      const outcome = await this.onEvent(w, winner.r.value);
      if (outcome) return outcome;

      if (this.opts.now() - lastCheckAt >= this.opts.tickMs) {
        lastCheckAt = this.opts.now();
        const d = await this.checkWatchdogs(w);
        if (d) return d;
      }
    }
  }

  /** Returns a disposition only when the worker is genuinely finished. */
  private async onEvent(w: ManagedWorker, e: OCEvent): Promise<Disposition | undefined> {
    // Fact (3): liveness ticks are not progress. Only worker events reset the
    // idle timer, or a hung worker on a healthy server looks busy forever.
    if (isWorkerEvent(e)) w.lastWorkerEventAt = this.opts.now();

    // Evidence that the turn we prompted is under way. `busy` is the explicit
    // signal; real work arriving is the implicit one.
    if ((e.kind === "status" && e.busy) || e.kind === "tool" || e.kind === "text" || e.kind === "file.edited" || e.kind === "diff") {
      w.turnStarted = true;
    }

    if (e.kind === "text") {
      if (w.replyText.length < MAX_REPLY_CHARS) w.replyText += e.delta;
      else w.replyTruncated = true;
      return undefined;
    }

    if (isBlocking(e)) {
      const questions = "questions" in e ? [...e.questions] : "permission" in e ? [permissionQuestion(e)] : ["the worker is blocked"];
      this.opts.store.appendEvent(w.record.current.workerID, "escalation", { questions });

      // §11 Phase 7: a *permission* request can now be answered in band, so the
      // turn is left running and the worker simply waits at its tool call. Phase
      // 2 had to abort here — the adapter could surface an ask and not reply to
      // one — and the cost was a partial turn on every escalation, which Phase
      // 6's demo measured rather than estimated: three asks in one four-worker
      // run, and the worker that escalated twice ended on 47,531 tokens against
      // 7,715 for the one that never did.
      //
      // A *question* still escalates the old way. Its reply shape is a selection
      // from offered labels rather than free text (verified on the wire), so
      // forcing Claude's prose into it would answer something nobody asked.
      if (isAnswerable(e)) {
        w.pendingPermission = { requestID: e.requestID, permission: e.permission };
        return this.enterBlocked(w, questions, "permission_required");
      }

      await this.requestAbort(w, {
        disposition: "blocked",
        reason: "questions" in e ? "worker_asked" : "permission_required",
        questions,
        at: this.opts.now(),
      });
      return undefined;
    }

    if (e.kind === "error") {
      if (e.error.code === "aborted") {
        // Fact (1): this is the *first* of two terminal events. The idle that
        // follows is what actually ends the run; deciding here would throw away
        // the reason we aborted.
        w.sawAbort = true;
        return undefined;
      }
      // §11 Phase 7's retry, and the one place `OpenCodeError.retryable` earns
      // its keep: it is the provider's own judgement (`APIError.data.isRetryable`
      // per the fact sheet), not a guess from the message text. A retry re-runs
      // the *same* instruction — which is exactly what makes it not a revision,
      // and why it has its own counter and no revision cap.
      //
      // **Ahead of the structured-output branch below, deliberately.** A schema
      // rejection arrives as an `api` error too, so a format check that ran
      // first would swallow every transient failure and silently re-send the
      // turn with the constraint dropped — losing the constraint for the rest of
      // the backend's life over a hiccup that had nothing to do with it. The
      // real rejection is measured as `isRetryable: false`, so retryability is
      // exactly the field that tells the two apart.
      if (e.error.retryable && w.retries < this.opts.maxRetries) {
        w.retries += 1;
        w.retryAt = this.opts.now();
        w.resendKind = "transient";
        w.resendDelayMs = backoffMs(w.retries, this.opts.retryBackoffMs);
        this.metric({
          kind: "retry",
          at: this.opts.now(),
          runID: w.record.current.runID,
          workerID: w.record.current.workerID,
          attempt: w.retries,
          code: e.error.code,
          backoffMs: w.resendDelayMs,
        });
        this.opts.store.appendEvent(w.record.current.workerID, "turn_retried", {
          attempt: w.retries,
          maxRetries: this.opts.maxRetries,
          code: e.error.code,
          backoffMs: w.resendDelayMs,
          message: e.error.message.slice(0, 300),
        });
        return undefined;
      }
      // `!e.error.retryable` matters as much as the rest of this condition. A
      // schema rejection is measured as `isRetryable: false`, and a transient
      // `api` error is not a schema problem — without this the provider hiccup
      // that happens to arrive first spends the one-shot format retry and
      // latches structured output off for the whole backend's life.
      if (w.usedFormat && !w.formatRetried && !e.error.retryable && (e.error.code === "api" || e.error.code === "structured_output")) {
        // The provider refused the constrained request. Latch it off for every
        // later worker and re-send this turn plainly, once. Settling here would
        // fail a worker for a capability it never needed.
        w.formatRetried = true;
        this.structuredOutputOK = false;
        w.retryAt = this.opts.now();
        this.opts.store.appendEvent(w.record.current.workerID, "structured_output_unsupported", {
          code: e.error.code,
          message: e.error.message.slice(0, 300),
        });
        return undefined;
      }
      w.lastError = e.error;
      return {
        kind: "failed",
        reason: w.retries > 0 ? `worker_error_${e.error.code}_after_${w.retries}_retries` : `worker_error_${e.error.code}`,
        error: e.error,
      };
    }

    if (e.kind === "idle") {
      w.lastTerminalAt = this.opts.now();
      if (!w.turnStarted && !w.abortIntent) {
        // A terminal event for a turn that is already over. Ignoring it is the
        // difference between resuming a worker and silently completing it empty.
        this.opts.store.appendEvent(w.record.current.workerID, "stale_terminal_ignored", {});
        return undefined;
      }
      w.turnStarted = false;
      const intent = w.abortIntent;
      if (intent) {
        w.abortIntent = undefined;
        return this.applyIntent(w, intent);
      }
      if (w.retryAt !== undefined) {
        // The failed turn's terminal event. Now the session is free to take the
        // turn again — without the constraint that broke it, or after the
        // backoff a transient failure earned.
        await this.resendTurn(w);
        return undefined;
      }
      if (w.sawAbort) {
        w.sawAbort = false;
        return { kind: "failed", reason: "aborted_externally" };
      }
      return this.onTurnFinished(w);
    }

    return undefined;
  }

  /**
   * The run reached a clean terminal event. Read what the worker said.
   *
   * A report of `blocked` is §5's escalation channel taken deliberately by the
   * worker, and is the *expected* way a worker asks for help — no abort, no lost
   * turn, just a stop and a question.
   */
  private async onTurnFinished(w: ManagedWorker): Promise<Disposition | undefined> {
    const parsed = this.readReport(w);
    if (parsed.report?.status === "blocked") {
      const questions = parsed.report.questions.length > 0 ? parsed.report.questions : [parsed.report.summary || "the worker stopped and asked for guidance"];
      return this.enterBlocked(w, questions, "reported_blocked");
    }
    if (parsed.report?.status === "failed") {
      return { kind: "failed", reason: "reported_failed" };
    }
    return { kind: "complete" };
  }

  /**
   * Park in `blocked` until somebody answers, then resume the same session.
   *
   * The stream is *not* closed and *not* reopened. Everything the worker learned
   * in its first turn is still in the session, so the answer is a prompt, not a
   * respawn.
   */
  private async enterBlocked(w: ManagedWorker, questions: readonly string[], reason: string): Promise<Disposition | undefined> {
    w.questions = questions;
    w.blockedAt = this.opts.now();
    w.machine.apply("block", { reason });
    this.update(w, { state: "blocked", reason, questions: [...questions] });
    this.notify(w);

    const budget = this.budgetFor(w.record.current.spec);
    const outcome = await new Promise<AnswerOutcome>((resolve) => {
      const timer = setTimeout(() => {
        w.answer = undefined;
        resolve({ kind: "timeout" });
      }, budget.blockedMs);
      w.answer = (o) => {
        clearTimeout(timer);
        resolve(o);
      };
    });

    if (outcome.kind === "cancel") return { kind: "cancelled", reason: "cancelled_while_blocked" };
    if (outcome.kind === "timeout") return { kind: "timed_out", reason: "blocked_unanswered" };

    // Time spent waiting on Claude is not time the worker spent working, so it
    // does not count against the worker's wall-clock budget.
    w.blockedTotalMs += this.opts.now() - w.blockedAt;
    w.resumes += 1;
    w.lastWorkerEventAt = this.opts.now();

    // §11 Phase 7's in-band reply. The turn was never aborted, so there is
    // nothing to re-prompt: answering the request lets the tool call it was
    // waiting on proceed, and the worker carries on mid-thought. Everything the
    // turn has produced so far — `replyText` included — is still the *current*
    // turn's, so unlike the re-prompt path below, none of it is cleared.
    const pending = w.pendingPermission;
    if (pending) {
      w.pendingPermission = undefined;
      const decision: PermissionReply = outcome.decision === "deny" ? "reject" : "once";
      try {
        const answered = await this.opts.backend.respond(w.session!, pending.requestID, decision);
        this.opts.store.appendEvent(w.record.current.workerID, "permission_answered", {
          requestID: pending.requestID,
          permission: pending.permission,
          reply: decision,
          accepted: answered,
        });
        if (answered) {
          w.machine.apply("resume", { reason: "permission_answered" });
          this.update(w, { state: "running", resumes: w.resumes, questions: [] });
          w.resumeSignal?.resolve();
          w.resumeSignal = undefined;
          return undefined;
        }
        // The backend does not know the request any more — the turn moved on, or
        // it was answered twice. Fall through to the escalation path, which
        // works from a session rather than from a live request.
        this.opts.store.appendEvent(w.record.current.workerID, "permission_stale", { requestID: pending.requestID });
      } catch (e) {
        // An adapter that cannot answer is not a worker that has to die: the
        // pre-Phase-7 path still works and is one prompt away.
        this.opts.store.appendEvent(w.record.current.workerID, "permission_reply_failed", { message: String(e) });
      }
      // Deliberately **no abort** before falling through, and the reason is
      // worth stating because the instinct is wrong. `respond()` answering
      // `false` means the backend does not know the request — which is what it
      // says when the turn that raised it is already over. There is nothing left
      // to abort, and aborting anyway is actively harmful: the pump is paused
      // here, so the abort's own error and idle arrive *after* the re-prompt has
      // reset `sawAbort`, and the run loop reads them as an abort nobody asked
      // for and fails the worker `aborted_externally`. (Measured, not reasoned:
      // the first version of this did exactly that.)
      //
      // If a turn somehow *is* still live with a request the backend has lost,
      // the idle watchdog is the backstop, which is what it is for.
    }

    w.replyText = "";
    w.replyTruncated = false;
    w.sawAbort = false;
    try {
      await this.promptTurn(w, buildAnswerPrompt(questions, outcome.text));
    } catch (e) {
      w.resumeSignal?.reject(e);
      w.resumeSignal = undefined;
      throw e;
    }
    w.machine.apply("resume");
    this.update(w, { state: "running", resumes: w.resumes, questions: [] });
    w.resumeSignal?.resolve();
    w.resumeSignal = undefined;
    return undefined;
  }

  // --- watchdogs ----------------------------------------------------------

  private async checkWatchdogs(w: ManagedWorker): Promise<Disposition | undefined> {
    const now = this.opts.now();
    const budget = this.budgetFor(w.record.current.spec);

    // The recovery window, and it has to be first: a recovered worker whose old
    // turn is genuinely over produces no events at all, and every other watchdog
    // below reads that as a wedged worker rather than as a finished one.
    if (w.recoverDeadline !== undefined) {
      if (w.lastWorkerEventAt > w.recoverStartedAt) {
        // Something is alive on the other end. Ordinary rules from here on.
        w.recoverDeadline = undefined;
        this.opts.store.appendEvent(w.record.current.workerID, "recovery_live", {});
      } else if (now > w.recoverDeadline) {
        w.recoverDeadline = undefined;
        this.opts.store.appendEvent(w.record.current.workerID, "recovery_salvaged", {
          reason: "session_alive_but_turn_over",
          waitedMs: now - w.recoverStartedAt,
        });
        // Settle from the worktree, exactly as the no-session path does.
        return { kind: "complete" };
      }
    }

    if (w.abortIntent) {
      // We asked it to stop and the terminal events have not come. Do not wait
      // forever for a server that may already be gone: take the intent.
      if (now - w.abortIntent.at > this.opts.abortGraceMs) {
        const intent = w.abortIntent;
        w.abortIntent = undefined;
        this.opts.store.appendEvent(w.record.current.workerID, "abort_grace_expired", { reason: intent.reason });
        return this.applyIntent(w, intent);
      }
      return undefined;
    }

    if (w.retryAt !== undefined && now - w.retryAt > this.opts.abortGraceMs + w.resendDelayMs) {
      // No terminal event followed the failure. Re-send anyway rather than
      // sitting here until the idle watchdog calls it a wedged worker. The
      // backoff is added to the grace so a long one is not mistaken for silence.
      await this.resendTurn(w);
      return undefined;
    }

    if (w.machine.state !== "running") return undefined;

    if (now - w.runningSince - w.blockedTotalMs > budget.wallClockMs) {
      await this.requestAbort(w, { disposition: "timed_out", reason: "hard_timeout", at: now });
      return undefined;
    }

    if (now - w.lastWorkerEventAt > budget.idleMs) {
      // The discrimination the fact sheet insists on: silence from the worker is
      // not the same failure as silence from the server, and only one of them is
      // the worker's fault.
      const health = await this.opts.backend.health();
      if (!health.alive) {
        this.opts.store.appendEvent(w.record.current.workerID, "server_gone", {
          detail: health.detail ?? "health check reported not alive",
        });
        return { kind: "failed", reason: "server_gone" };
      }
      await this.requestAbort(w, { disposition: "timed_out", reason: "idle_watchdog", at: now });
      return undefined;
    }

    if (now - w.lastBudgetPollAt >= this.opts.budgetPollMs) {
      w.lastBudgetPollAt = now;
      const usage = await this.opts.backend.usage(w.session!).catch(() => null);
      if (usage) {
        w.totalTokens = usage.totalTokens;
        w.cost = usage.cost;
        this.update(w, { totalTokens: usage.totalTokens, cost: usage.cost });
        if (usage.totalTokens > budget.tokens) {
          this.opts.store.appendEvent(w.record.current.workerID, "budget_exceeded", {
            totalTokens: usage.totalTokens,
            limit: budget.tokens,
          });
          await this.requestAbort(w, { disposition: "over_budget", reason: "token_budget", at: now });
        }
      }
    }
    return undefined;
  }

  /**
   * Ask the backend to stop, recording *why* first.
   *
   * The order matters: the intent has to be in place before the abort lands,
   * because the abort's error event can arrive before this function returns.
   */
  private async requestAbort(w: ManagedWorker, intent: AbortIntent): Promise<void> {
    w.abortIntent = intent;
    this.opts.store.appendEvent(w.record.current.workerID, "abort_requested", {
      disposition: intent.disposition,
      reason: intent.reason,
    });
    try {
      await this.opts.backend.abort(w.session!);
    } catch (e) {
      // The server is unreachable, so no terminal event is coming. Settle on the
      // intent immediately rather than burning the grace period.
      w.abortIntent = { ...intent, at: intent.at - this.opts.abortGraceMs - 1 };
      this.opts.store.appendEvent(w.record.current.workerID, "abort_failed", { message: String(e) });
    }
  }

  private async applyIntent(w: ManagedWorker, intent: AbortIntent): Promise<Disposition | undefined> {
    switch (intent.disposition) {
      case "blocked":
        return this.enterBlocked(w, intent.questions ?? ["the worker is blocked"], intent.reason);
      case "timed_out":
        return { kind: "timed_out", reason: intent.reason };
      case "over_budget":
        return { kind: "over_budget", reason: intent.reason };
      case "cancelled":
        return { kind: "cancelled", reason: intent.reason };
    }
  }

  // --- settling -----------------------------------------------------------

  /**
   * Snapshot, reconcile, record — for every ending, not just the happy one.
   *
   * A timed-out worker often leaves real work behind, and throwing it away
   * because the run ended badly loses the most useful thing about the failure.
   */
  private async settle(w: ManagedWorker, disposition: Disposition): Promise<void> {
    const rec = w.record.current;
    const extra: Discrepancy[] = [];

    // A worker refused at the queue has no worktree, and "the manager could not
    // snapshot the worktree" would be a discrepancy about a directory that was
    // never meant to exist.
    let snapshot: WorkerResult["snapshot"];
    // **Never in shared mode.** DD-5 has the manager commit so the worker does
    // not have to, which is right in a worktree the orchestrator owns. The user's
    // checkout is not that: `git add -A` there would sweep up whatever else they
    // had in progress, onto whatever branch they happen to be on, and call it
    // this worker's snapshot. The work is left as uncommitted changes for them to
    // read and commit — which is also exactly what a native subagent leaves.
    const isShared = this.workspaceOf(rec.spec) === "shared";
    if (rec.worktree && !isShared) {
      try {
        const snap = await snapshotCommit(rec.worktree, snapshotMessage(rec));
        snapshot = { committed: snap.committed, ...(snap.sha === undefined ? {} : { sha: snap.sha }) };
      } catch (e) {
        extra.push({ kind: "unparseable_report", detail: `the manager could not snapshot the worktree: ${String(e)}` });
        if (disposition.kind === "complete") disposition = { kind: "failed", reason: "snapshot_failed" };
      }
    }

    const trigger =
      disposition.kind === "complete"
        ? "complete"
        : disposition.kind === "timed_out"
          ? "timeout"
          : disposition.kind === "over_budget"
            ? "exhaust_budget"
            : disposition.kind === "cancelled"
              ? "cancel"
              : "fail";
    const reason = disposition.kind === "complete" ? undefined : disposition.reason;
    w.machine.tryApply(trigger, reason === undefined ? {} : { reason });

    const result = await this.buildResult(w, disposition, snapshot, extra);
    this.update(w, {
      state: w.machine.state,
      endedAt: this.opts.now(),
      // Written unconditionally, `undefined` included: a clean completion has to
      // *clear* whatever reason an earlier state left on the record. A worker
      // that blocked, was answered and then finished used to carry
      // `reported_blocked` into its final row, where every status line rendered
      // it as `completed: reported_blocked` — which reads as though blocking
      // were the reason it completed. `WorkerResult.reason` was always right;
      // it was the record that lied.
      reason,
      totalTokens: result.usage.totalTokens,
      cost: result.usage.cost,
      result,
      questions: [...result.questions],
    });
    // The trail is where {@link WorkerManager.revisionHistory} reads a round's
    // outcome from, so it carries what "what changed this round" needs — and the
    // round number, without which two settles are indistinguishable.
    // Every worker passes through here exactly once per round, which is what
    // makes it the right place for the metric and the wrong place for anything
    // that could throw — hence `metric()` rather than the sink directly.
    this.metric({
      kind: "worker_settled",
      at: this.opts.now(),
      runID: rec.runID,
      workerID: rec.workerID,
      state: w.machine.state,
      mode: rec.mode,
      model: rec.model,
      durationMs: result.durationMs,
      totalTokens: result.usage.totalTokens,
      files: result.changes.files,
      discrepancies: result.discrepancies.length,
      revisions: w.revisions,
      resumes: w.resumes,
      retries: w.retries,
      reportSource: result.reportSource,
      ...(reason === undefined ? {} : { reason }),
      ...(result.tests?.failed === undefined ? {} : { testsFailed: result.tests.failed }),
    });
    this.opts.store.appendEvent(rec.workerID, "settled", {
      state: w.machine.state,
      discrepancies: result.discrepancies.length,
      files: result.changes.files,
      additions: result.changes.additions,
      deletions: result.changes.deletions,
      ...(w.revisions > 0 ? { revision: w.revisions } : {}),
      ...(result.tests?.failed === undefined ? {} : { testsFailed: result.tests.failed }),
      ...(result.summary === "" ? {} : { summary: result.summary.slice(0, SUMMARY_TRAIL_CHARS) }),
    });
    this.notify(w);
  }

  private async buildResult(
    w: ManagedWorker,
    disposition: Disposition,
    snapshot: WorkerResult["snapshot"],
    extra: readonly Discrepancy[],
  ): Promise<WorkerResult> {
    const rec = w.record.current;

    if (rec.startedAt === undefined) {
      // Never prompted — refused at the queue, or cancelled before the session
      // existed. There is no report to parse, no diff to measure and no usage to
      // read; running the machinery anyway would manufacture a report-parse
      // discrepancy about a report nobody was ever asked for, and render as a
      // worker that ran and achieved nothing. `not_started` is the honest word.
      return {
        workerID: rec.workerID,
        runID: rec.runID,
        state: w.machine.state,
        mode: rec.mode,
        model: rec.model,
        task: rec.task,
        durationMs: 0,
        usage: { totalTokens: 0, cost: 0 },
        summary: "",
        changes: { files: 0, additions: 0, deletions: 0, paths: [] },
        tests: null,
        discrepancies: [...extra],
        risks: [],
        questions: [],
        followUps: [],
        ...(disposition.kind === "complete" ? {} : { reason: disposition.reason }),
        reportSource: "not_started",
      };
    }

    const parsed = this.readReport(w);

    let actual: string[] = [];
    let stat: DiffStat = { files: 0, additions: 0, deletions: 0, paths: [] };
    const discrepancies: Discrepancy[] = [...extra];
    try {
      actual = await changedFiles(rec.worktree, rec.baseSha);
      stat = await diffStat(rec.worktree, rec.baseSha);
    } catch (e) {
      discrepancies.push({ kind: "unparseable_report", detail: `the manager could not read the diff: ${String(e)}` });
    }

    // §4.3's "[manager re-ran independently]". The command comes from the brief,
    // never from the report — DD-8 draws that line and this is where it matters.
    let tests: WorkerReport["tests"] | null = parsed.report?.tests ?? null;
    let verification: Parameters<typeof reconcile>[0]["tests"];
    const command = rec.spec.testCommand;
    if (command && this.opts.verifyTests && disposition.kind === "complete") {
      const run = await runTestCommand(rec.worktree, command);
      verification = { command, ran: true, passed: run.passed, ...(run.error ? { detail: run.error } : {}) };
      this.opts.store.appendEvent(rec.workerID, "tests_verified", { command, passed: run.passed, exitCode: run.exitCode });
      tests = { ...(tests ?? {}), command, ...(run.passed ? {} : { failed: Math.max(1, tests?.failed ?? 1) }) };
    } else if (command) {
      verification = { command, ran: false };
    }

    discrepancies.push(
      ...reconcile({
        report: parsed.report,
        parseIssues: parsed.issues,
        actualFiles: actual,
        ...(rec.spec.ownedPaths === undefined ? {} : { ownedPaths: rec.spec.ownedPaths }),
        // DD-10: `research` and `review` cannot write, so their `changes` list is
        // not a claim about what they wrote. See `ReconcileInput.readOnly`.
        ...(rec.mode === "implement" ? {} : { readOnly: true }),
        worktree: rec.worktree,
        ...(verification === undefined ? {} : { tests: verification }),
      }),
    );

    const usage = await this.opts.backend
      .usage(w.session!)
      .catch(() => null)
      .then((u) => u ?? { totalTokens: w.totalTokens, cost: w.cost });

    const error = disposition.kind === "failed" ? (disposition.error ?? w.lastError) : undefined;
    const startedAt = rec.startedAt ?? rec.createdAt;
    // §11 Phase 8: whether this review was cross-model. Derived from the route
    // taken at spawn rather than re-computed, so the result records what
    // actually happened and not what the configuration says now.
    const chosen = this.routes.get(rec.workerID);
    const reviewOf =
      rec.mode === "review" && rec.spec.reviewOf && chosen?.avoided !== undefined
        ? { of: rec.spec.reviewOf, authorModel: chosen.avoided, crossModel: chosen.diverse === true }
        : undefined;

    return {
      workerID: rec.workerID,
      runID: rec.runID,
      state: w.machine.state,
      mode: rec.mode,
      model: rec.model,
      task: rec.task,
      durationMs: Math.max(0, this.opts.now() - startedAt),
      usage: { totalTokens: usage.totalTokens, cost: usage.cost },
      summary: parsed.report?.summary ?? "",
      changes: stat,
      tests,
      discrepancies,
      risks: parsed.report?.risks ?? [],
      questions: w.machine.state === "blocked" ? [...w.questions] : (parsed.report?.questions ?? []),
      followUps: parsed.report?.followUps ?? [],
      ...(disposition.kind === "complete" ? {} : { reason: disposition.reason }),
      ...(error ? { error: { code: error.code, message: error.message } } : {}),
      ...(snapshot === undefined ? {} : { snapshot }),
      ...(reviewOf === undefined ? {} : { review: reviewOf }),
      ...(this.workspaceOf(rec.spec) === "shared" ? { attribution: this.attribute(w, actual) } : {}),
      reportSource: parsed.source,
    };
  }

  /**
   * Read the report from whichever channel produced one.
   *
   * Primary is the reply itself, schema-constrained and retried by the provider
   * (ADR-0002). The worktree's `report.json` is §5's "belt and suspenders"
   * secondary — used only when the reply yields nothing usable, because a model
   * that wrote a file and then said something else in its reply has told us two
   * things, and the file is the one it had to think about.
   */
  private readReport(w: ManagedWorker): {
    report: WorkerReport | null;
    issues: string[];
    source: WorkerResult["reportSource"];
  } {
    const issues: string[] = [];
    if (w.replyTruncated) issues.push("the worker's reply was truncated by the manager before parsing");

    const fromReply = parseReport(w.replyText);
    if (fromReply.report) return { report: fromReply.report, issues: [...issues, ...fromReply.issues], source: "reply" };

    const file = w.record.current.worktree ? readReportFile(w.record.current.worktree) : null;
    if (file) {
      const fromFile = parseReport(file);
      if (fromFile.report) {
        return {
          report: fromFile.report,
          issues: [...issues, "the reply carried no usable report; recovered it from the worktree", ...fromFile.issues],
          source: "report_file",
        };
      }
      return { report: null, issues: [...issues, ...fromReply.issues, ...fromFile.issues], source: "none" };
    }
    return { report: null, issues: [...issues, ...fromReply.issues], source: "none" };
  }

  // --- plumbing -----------------------------------------------------------

  /**
   * Assemble what a `review` worker is pointed at (§6.1, §11 Phase 6).
   *
   * §6.1 offered two shapes — "no worktree, or a read-only mount of the target
   * worktree" — and this is the third, which is the one that keeps the
   * measurements honest: the reviewer gets **its own** worktree at the target's
   * base, and the target's diff arrives quoted in its brief.
   *
   * Mounting the target's worktree would have made every file the *author*
   * changed show up as a change by the *reviewer*, because `buildResult()`
   * measures a worker's own directory against its own base — a read-only worker
   * would have settled with a discrepancy for each of them. With its own
   * worktree the reviewer's measured diff is genuinely empty, which means a
   * reviewer that somehow writes something is visible rather than camouflaged.
   *
   * The diff is read from the target's worktree while it exists and from its
   * snapshot commit once it does not, exactly as `worker_diff` does — a review
   * spawned after a cleanup is still a review.
   */
  private async reviewTargetOf(targetID: string): Promise<{ target: ReviewTarget; baseSha: string; source: string }> {
    const t = this.get(targetID);
    if (!t) throw new Error(`reviewOf names a worker that does not exist: ${targetID}`);
    // **Phase 8 correction.** Phase 6 branched the reviewer from the target's
    // *base* commit, on the reasoning that this is how a human reads a pull
    // request. It is not, and the first live cross-model review found out how
    // badly: the reviewer read `src/stats.js` in its own worktree, did not find
    // the function the diff said had been added, and reported — confidently, and
    // as a finding — that the author's change "was not applied". It was; the
    // reviewer was reading the version from before it.
    //
    // So the reviewer now branches from the target's **snapshot commit**: the
    // files it can read are the code as that worker left it, and the diff shows
    // what changed to get there. That is what a human actually reviews.
    //
    // The measurement property that made this checkout worth having is
    // untouched — the reviewer's own diff is taken against its own base, so a
    // read-only worker still measures as having changed nothing, and one that
    // writes is still visible rather than camouflaged.
    const reviewBase = t.result?.snapshot?.committed && t.result.snapshot.sha ? t.result.snapshot.sha : t.baseSha;
    const atSnapshot = reviewBase !== t.baseSha;

    let page: Awaited<ReturnType<typeof readDiff>> | undefined;
    let source = "none";
    if (t.worktree && existsSync(t.worktree)) {
      page = await readDiff(t.worktree, { baseSha: t.baseSha, maxLines: REVIEW_DIFF_LINES });
      source = "worktree";
    } else if (t.result?.snapshot?.sha) {
      page = await readCommitDiff(await this.resolveRepo(), t.baseSha, t.result.snapshot.sha, { maxLines: REVIEW_DIFF_LINES });
      source = "snapshot";
    }

    const target: Omit<ReviewTarget, "atSnapshot"> = {
      workerID: t.workerID,
      task: t.task,
      summary: t.result?.summary ?? "",
      changedPaths: t.result?.changes.paths ?? [],
      diff: page?.lines ?? ["(the orchestrator could not read a diff for this worker)"],
      diffTruncated: page?.hasMore ?? false,
      // The orchestrator's own reconciliation, handed over so the reviewer does
      // not spend its one round re-deriving findings that are already measured.
      discrepancies: (t.result?.discrepancies ?? []).slice(0, MAX_REVIEW_DISCREPANCIES).map((d) => `${d.kind}: ${d.detail}`),
    };
    return { target: { ...target, atSnapshot }, baseSha: reviewBase, source };
  }

  /**
   * Who else is already claiming the files this shared worker is about to edit
   * (§11 Phase 8, §6.2 asked one step earlier).
   *
   * §6.2's overlap check runs in the merge pipeline, from *measured* diffs, and
   * a shared worker never gets there — it has no branch and nothing to merge. So
   * the question has to be asked at spawn instead, from what has been *declared*,
   * and it matters more here than it ever did before a merge: two isolated
   * workers touching one file produce a conflict the gate catches, while two
   * shared workers produce a last-write-wins race in the user's tree with nobody
   * watching.
   *
   * Only shared workers are compared with shared workers. An isolated worker has
   * its own copy of every file and can overlap freely.
   */
  private sharedCollisions(workerID: string, spec: WorkerSpec): SharedCollision[] {
    if (this.workspaceOf(spec) !== "shared") return [];
    const mine = spec.ownedPaths ?? [];
    if (mine.length === 0) return [];
    const out: SharedCollision[] = [];
    for (const [id, other] of this.workers) {
      if (id === workerID) continue;
      const o = other.record.current;
      if (isSettled(o.state) && o.state !== "blocked") continue;
      if (this.workspaceOf(o.spec) !== "shared") continue;
      const paths = declaredOverlap(mine, o.spec.ownedPaths ?? []);
      if (paths.length > 0) out.push({ workerID: id, paths });
    }
    return out.sort((a, b) => a.workerID.localeCompare(b.workerID));
  }

  /** Where a worker works: its own choice, else the manager's default. */
  private workspaceOf(spec: WorkerSpec): WorkspaceMode {
    return spec.workspace ?? this.opts.defaultWorkspace;
  }

  /**
   * Who did what, in a tree where several workers were writing at once.
   *
   * There is no clever trick here and this function does not pretend otherwise.
   * Git records which worker changed a file exactly as well as a shared folder
   * does — which is not at all — so the honest answer has three parts:
   *
   * - **`preexisting`** is subtracted outright. It was dirty before this worker
   *   drew breath, so whatever it is, it is not this worker's.
   * - **`owned`** is what the worker's declared `ownedPaths` cover. This is the
   *   only positive evidence available, and it is a *claim the brief made*
   *   rather than a measurement — a worker that ignored its own path list is
   *   attributed work it did not do, which is why `ownedPaths` matters far more
   *   in shared mode than in an isolated one.
   * - **`unattributed`** is the rest: files that changed while this worker ran,
   *   that nobody owns, and that could belong to any concurrent worker. Named,
   *   not hidden, and not quietly credited to whoever settled first.
   *
   * `concurrent` lists who else was in the tree, because a result with an empty
   * `concurrent` list is exact — a shared worker that happened to run alone is
   * measured as precisely as an isolated one, and should not be discounted.
   */
  private attribute(w: ManagedWorker, changed: readonly string[]): NonNullable<WorkerResult["attribution"]> {
    const rec = w.record.current;
    const preexisting = new Set(w.preexisting);
    const mine = changed.filter((f) => !preexisting.has(f));
    const owned = rec.spec.ownedPaths ?? [];
    // `matchesPath(pattern, file)` — in that order. Reversed, an exact path still
    // matched (both sides equal) and every *glob* silently matched nothing, so a
    // worker owning `src/**` was credited with none of its own work and all of it
    // landed in `unattributed`. Wrong in the one direction that looks like
    // caution, which is why it survived a live run.
    const isMine = (f: string): boolean => owned.some((pattern) => matchesPath(pattern, f));

    // Everyone else who shared the tree at any point while this worker ran.
    const concurrent: string[] = [];
    for (const [id, other] of this.workers) {
      if (id === rec.workerID) continue;
      const o = other.record.current;
      if (this.workspaceOf(o.spec) !== "shared") continue;
      if (o.startedAt === undefined) continue;
      // Overlapping intervals, with an open end meaning "still going".
      const otherEnded = o.endedAt ?? Number.POSITIVE_INFINITY;
      const mineStarted = rec.startedAt ?? 0;
      if (otherEnded >= mineStarted) concurrent.push(id);
    }

    return {
      mode: "shared",
      owned: owned.length > 0 ? mine.filter(isMine) : [],
      unattributed: owned.length > 0 ? mine.filter((f) => !isMine(f)) : mine,
      preexisting: changed.filter((f) => preexisting.has(f)),
      concurrent: concurrent.sort(),
    };
  }

  private budgetFor(spec: WorkerSpec): WorkerBudget {
    return { ...this.opts.budget, ...spec.budget };
  }

  private update(w: ManagedWorker, patch: Partial<WorkerRecord>): void {
    const updated: WorkerRecord = { ...w.record.current, ...patch, updatedAt: this.opts.now() };
    w.record.current = updated;
    this.opts.store.putWorker(updated);
  }

  /**
   * Record a metric, and never let it matter.
   *
   * `fileMetrics` already swallows its own IO failures, but the sink is an
   * injected interface and the manager cannot assume every implementation is as
   * careful. Telemetry that can throw is telemetry that can fail a worker at
   * `settle()` — the one place every worker passes through — which would turn a
   * full disk into a run that never finishes. Wrapped here so the promise in
   * `metrics.ts`'s header is true of every call site rather than of most.
   */
  private metric(metric: Metric): void {
    try {
      this.opts.metrics.record(metric);
    } catch {
      /* never worth a run */
    }
  }

  private notify(w: ManagedWorker): void {
    for (const waiter of [...w.waiters]) waiter();
  }

  private writeManifest(w: ManagedWorker): void {
    const rec = w.record.current;
    if (!rec.worktree) return;
    writeManifest(rec.worktree, {
      version: 1,
      workerID: rec.workerID,
      runID: rec.runID,
      task: rec.task,
      mode: rec.mode,
      model: rec.model,
      branch: rec.branch,
      baseSha: rec.baseSha,
      createdAt: rec.createdAt,
      spec: rec.spec,
      ...(rec.sessionID === undefined ? {} : { sessionID: rec.sessionID }),
    });
  }

  private async resolveRepo(): Promise<string> {
    this.repoRootResolved ??= await resolveRepoRoot(this.opts.repoRoot);
    return this.repoRootResolved;
  }

  private async resolveWorktreeRoot(): Promise<string> {
    this.worktreeRootResolved ??= this.opts.worktreeRoot ?? defaultWorktreeRoot(await this.resolveRepo());
    return this.worktreeRootResolved;
  }
}

// ---------------------------------------------------------------------------

const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Exponential, capped: 1s, 2s, 4s, … and never more than half a minute. */
export function backoffMs(attempt: number, base: number): number {
  if (base <= 0) return 0;
  return Math.min(MAX_RETRY_BACKOFF_MS, base * 2 ** Math.max(0, attempt - 1));
}

/** A cancellable tick, so a racing watchdog does not leave a timer per event. */
function delay(ms: number): { promise: Promise<{ t: "tick" }>; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout>;
  const promise = new Promise<{ t: "tick" }>((resolve) => {
    timer = setTimeout(() => resolve({ t: "tick" }), ms);
  });
  return { promise, cancel: () => clearTimeout(timer) };
}

function permissionQuestion(e: { permission: string; patterns: readonly string[] }): string {
  return `the worker needs permission "${e.permission}" for ${e.patterns.join(", ") || "an unspecified target"}`;
}

/** The refusal a non-revisable state earns, with the way forward named. */
function notRevisable(rec: WorkerRecord, state: WorkerState): string {
  const head = `worker ${rec.workerID} is ${state} and cannot be revised`;
  switch (state) {
    case "blocked":
      return `${head}: it is waiting for an answer, not for feedback. Read its questions with worker_result and reply with worker_message — that is the same session too.`;
    case "merged":
      return (
        `${head}: its commits are already on an integration branch. A revision would produce a commit that branch does not have, ` +
        "so the run report would name a merged worker whose branch tip is not what was merged. Spawn a new worker for the follow-up change."
      );
    case "interrupted":
      return `${head}: the manager restarted while it was mid-flight, so its session did not survive. Its worktree is intact — read it, then spawn a new worker.`;
    case "spawned":
    case "preparing":
    case "running":
      return `${head}: it is still working. Wait for it to settle (worker_wait), read what it produced, and revise it then.`;
    default:
      return head;
  }
}

function snapshotMessage(rec: WorkerRecord): string {
  const task = rec.task.split("\n")[0]?.slice(0, 60) ?? rec.task.slice(0, 60);
  return `${rec.workerID}: ${task}\n\nSnapshot taken by the orchestrator (DD-5); the worker does not commit its own work.`;
}
