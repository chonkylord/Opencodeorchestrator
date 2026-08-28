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

import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

import {
  HEADLESS_PERMISSIONS,
  type OCEvent,
  type OpenCodeBackend,
  OpenCodeError,
  type PermissionRule,
  type EventStream,
  type SessionHandle,
  isBlocking,
  isWorkerEvent,
} from "../opencode/index.js";
import { type Brief, REPORT_RETRY_COUNT, REPORT_SCHEMA, buildAnswerPrompt, buildBrief, parseReport, reconcile } from "../briefs/index.js";
import type { Store } from "../store/index.js";
import {
  changedFiles,
  createWorktree,
  defaultWorktreeRoot,
  diffStat,
  listManifests,
  readReportFile,
  resolveRepoRoot,
  runTestCommand,
  snapshotCommit,
  writeManifest,
} from "../workspace/index.js";
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
  readonly budget?: Partial<WorkerBudget>;
  /** Watchdog resolution. Small in tests, ~1s in production. */
  readonly tickMs?: number;
  /** How often to poll the backend for token usage. */
  readonly budgetPollMs?: number;
  /** How long to wait for the terminal event after an abort before giving up. */
  readonly abortGraceMs?: number;
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

type AnswerOutcome = { kind: "answer"; text: string } | { kind: "cancel" } | { kind: "timeout" };

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
  questions: readonly string[] = [];
  abortIntent: AbortIntent | undefined;
  /** An abort we did not ask for still has to be distinguished from a clean end. */
  sawAbort = false;
  lastError: OpenCodeError | undefined;
  answer: ((outcome: AnswerOutcome) => void) | undefined;
  /** Settled by {@link WorkerManager.answer} once the follow-up prompt is away. */
  resumeSignal: { resolve: () => void; reject: (e: unknown) => void } | undefined;
  readonly waiters = new Set<() => void>();
  done: Promise<void> | undefined;

  constructor(
    readonly record: { current: WorkerRecord },
    now: () => number,
    onChange: (change: { from: WorkerState; to: WorkerState; trigger: string; reason?: string }) => void,
  ) {
    this.machine = new WorkerMachine({ workerID: record.current.workerID, now, onChange });
  }
}

const MAX_REPLY_CHARS = 512 * 1024;

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
      budget: { ...DEFAULT_BUDGET, ...options.budget },
      tickMs: options.tickMs ?? 1_000,
      budgetPollMs: options.budgetPollMs ?? 15_000,
      abortGraceMs: options.abortGraceMs ?? 10_000,
      verifyTests: options.verifyTests ?? true,
      structuredOutput: options.structuredOutput ?? true,
      now: options.now ?? Date.now,
      newWorkerID: options.newWorkerID ?? (() => `w-${(++this.seq).toString().padStart(3, "0")}`),
    };
  }

  // --- public surface -----------------------------------------------------

  /**
   * Spawn a worker and return as soon as it is registered (DD-1).
   *
   * Never blocks on the work: MCP hosts time out long tool calls, so everything
   * above this is spawn-and-poll. The returned record is in `spawned` or
   * `preparing`; use {@link wait} to find out how it ended.
   */
  async spawn(spec: WorkerSpec): Promise<WorkerRecord> {
    const now = this.opts.now();
    const workerID = this.opts.newWorkerID();
    const runID = spec.runID ?? "run-default";
    const mode: WorkerMode = spec.mode ?? "implement";
    const model = spec.model ?? this.opts.models[mode] ?? this.opts.defaultModel;
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
      questions: [],
    };

    const box = { current: record };
    const w = new ManagedWorker(box, this.opts.now, (change) => {
      this.opts.store.appendEvent(workerID, `state:${change.to}`, {
        from: change.from,
        trigger: change.trigger,
        ...(change.reason === undefined ? {} : { reason: change.reason }),
      });
    });
    this.workers.set(workerID, w);
    this.opts.store.putWorker(record);
    this.opts.store.appendEvent(workerID, "spawned", { task: spec.task, mode, model });

    w.done = this.drive(w).catch(() => {
      /* drive() is total: every failure is already a state. */
    });
    return record;
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
   * Answer a blocked worker (§5's escalation channel).
   *
   * The same session is prompted again, so the worker still has every bit of its
   * own context — Phase 0 verified that reuse retains it. This is the only way a
   * worker gets help, and the only way `blocked` is left.
   */
  async answer(workerID: string, text: string): Promise<WorkerRecord> {
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
    w.answer({ kind: "answer", text });
    w.answer = undefined;
    await resumed;
    return w.record.current;
  }

  /** Stop a worker. Safe at any point; a settled worker is left alone. */
  async cancel(workerID: string, reason = "cancelled_by_request"): Promise<WorkerRecord> {
    const w = this.workers.get(workerID);
    if (!w) throw new Error(`unknown worker ${workerID}`);
    if (w.machine.final) return w.record.current;
    if (w.answer) {
      w.answer({ kind: "cancel" });
      w.answer = undefined;
    } else {
      await this.requestAbort(w, { disposition: "cancelled", reason, at: this.opts.now() });
    }
    // Return when it has genuinely stopped, not when the request was sent.
    await w.done;
    return w.record.current;
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
      const updated: WorkerRecord = {
        ...row,
        state: "interrupted",
        reason: worktreeIntact ? "manager_restart" : "manager_restart_worktree_missing",
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
    for (const w of this.workers.values()) {
      w.stream?.close();
      w.answer?.({ kind: "cancel" });
      for (const notify of [...w.waiters]) notify();
    }
    this.workers.clear();
  }

  // --- the run loop -------------------------------------------------------

  private async drive(w: ManagedWorker): Promise<void> {
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
    await this.settle(w, disposition);
  }

  private async prepareAndRun(w: ManagedWorker): Promise<Disposition> {
    const rec = w.record.current;
    w.machine.apply("prepare");
    this.update(w, { state: "preparing" });

    const repoRoot = await this.resolveRepo();
    const worktreeRoot = await this.resolveWorktreeRoot();
    const wt = await createWorktree({
      repoRoot,
      workerID: rec.workerID,
      root: worktreeRoot,
      ...(rec.spec.baseRef === undefined ? {} : { baseRef: rec.spec.baseRef }),
    });
    this.update(w, { worktree: wt.path, branch: wt.branch, baseSha: wt.baseSha });
    this.writeManifest(w);

    const brief = buildBrief({
      workerID: rec.workerID,
      spec: rec.spec,
      mode: rec.mode,
      budget: this.budgetFor(rec.spec),
      baseSha: wt.baseSha,
      worktree: wt.path,
    });
    w.brief = brief;

    const session = await this.opts.backend.createSession({
      cwd: wt.path,
      title: rec.workerID,
      model: rec.model,
      permissions: rec.mode === "implement" ? HEADLESS_PERMISSIONS : READ_ONLY_PERMISSIONS,
    });
    w.session = session;
    this.update(w, { sessionID: session.sessionID });
    this.writeManifest(w);

    if (this.halted) return { kind: "cancelled", reason: "manager_halted" };

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

  private async promptTurn(w: ManagedWorker, text: string): Promise<void> {
    const rec = w.record.current;
    await this.opts.backend.prompt(w.session!, {
      text,
      ...(w.brief?.system === undefined ? {} : { system: w.brief.system }),
      ...(rec.mode === "implement" ? {} : { tools: READ_ONLY_TOOLS }),
      ...(this.opts.structuredOutput
        ? { format: { type: "json_schema" as const, schema: REPORT_SCHEMA, retryCount: REPORT_RETRY_COUNT } }
        : {}),
    });
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
    }
  }

  /** Returns a disposition only when the worker is genuinely finished. */
  private async onEvent(w: ManagedWorker, e: OCEvent): Promise<Disposition | undefined> {
    // Fact (3): liveness ticks are not progress. Only worker events reset the
    // idle timer, or a hung worker on a healthy server looks busy forever.
    if (isWorkerEvent(e)) w.lastWorkerEventAt = this.opts.now();

    if (e.kind === "text") {
      if (w.replyText.length < MAX_REPLY_CHARS) w.replyText += e.delta;
      else w.replyTruncated = true;
      return undefined;
    }

    if (isBlocking(e)) {
      // The worker asked mid-run. The adapter has no way to answer it in band,
      // so the turn is stopped and the question becomes an escalation: the
      // session survives, and the answer arrives as its next prompt. That is
      // also the §8 jail signal — a worker reaching outside its worktree raises
      // one of these rather than silently writing.
      const questions = "questions" in e ? [...e.questions] : "permission" in e ? [permissionQuestion(e)] : ["the worker is blocked"];
      this.opts.store.appendEvent(w.record.current.workerID, "escalation", { questions });
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
      w.lastError = e.error;
      return { kind: "failed", reason: `worker_error_${e.error.code}`, error: e.error };
    }

    if (e.kind === "idle") {
      const intent = w.abortIntent;
      if (intent) {
        w.abortIntent = undefined;
        return this.applyIntent(w, intent);
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
    w.replyText = "";
    w.replyTruncated = false;
    w.sawAbort = false;
    w.resumes += 1;
    w.lastWorkerEventAt = this.opts.now();
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
        return { kind: "failed", reason: "server_gone", ...(health.detail ? {} : {}) };
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

    let snapshot: WorkerResult["snapshot"];
    try {
      const snap = await snapshotCommit(rec.worktree, snapshotMessage(rec));
      snapshot = { committed: snap.committed, ...(snap.sha === undefined ? {} : { sha: snap.sha }) };
    } catch (e) {
      extra.push({ kind: "unparseable_report", detail: `the manager could not snapshot the worktree: ${String(e)}` });
      if (disposition.kind === "complete") disposition = { kind: "failed", reason: "snapshot_failed" };
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
      ...(reason === undefined ? {} : { reason }),
      totalTokens: result.usage.totalTokens,
      cost: result.usage.cost,
      result,
      questions: [...result.questions],
    });
    this.opts.store.appendEvent(rec.workerID, "settled", {
      state: w.machine.state,
      discrepancies: result.discrepancies.length,
      files: result.changes.files,
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
    if (fromReply.report) return { report: fromReply.report, issues: [...issues, ...fromReply.issues], source: "structured_output" };

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

  private budgetFor(spec: WorkerSpec): WorkerBudget {
    return { ...this.opts.budget, ...spec.budget };
  }

  private update(w: ManagedWorker, patch: Partial<WorkerRecord>): void {
    const updated: WorkerRecord = { ...w.record.current, ...patch, updatedAt: this.opts.now() };
    w.record.current = updated;
    this.opts.store.putWorker(updated);
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

function snapshotMessage(rec: WorkerRecord): string {
  const task = rec.task.split("\n")[0]?.slice(0, 60) ?? rec.task.slice(0, 60);
  return `${rec.workerID}: ${task}\n\nSnapshot taken by the orchestrator (DD-5); the worker does not commit its own work.`;
}
