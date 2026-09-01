/**
 * The merge coordinator: what turns §6.3's pipeline into something Claude can
 * actually call.
 *
 * **Why this exists at all is DD-1.** The gate runs the repository's own test
 * suite after every merge — minutes, plausibly tens of minutes — and Phase 3
 * *measured* the ceiling: the host abandons a tool call at sixty seconds and
 * says so in the error (`docs/phase0-facts.md` §7). §7's table says
 * `workspace_merge` returns a "merge + test-gate result", which reads
 * synchronous and cannot be. So a merge is **spawn-and-poll like everything
 * else**: `start()` validates, computes the overlap warning, kicks the pipeline
 * off and returns a handle in milliseconds; `get()` is what Claude polls.
 *
 * The handle is a first-class {@link MergeRecord} in its own table rather than a
 * field on a worker row, because a merge is not a property of a worker: it has
 * its own lifecycle, it can fail without any worker failing, and it is about a
 * *set* — "which worker broke it" is only answerable when the others are named
 * alongside. See `docs/adr/0003-integration-worktree.md`.
 *
 * Two things are deliberately done *before* returning, in the caller's own two
 * seconds, because getting them wrong later is expensive:
 *
 * 1. **The state-machine check.** `merge` is legal only from `completed`. A
 *    `failed` or `timed_out` worker is rejected here, by name, rather than
 *    discovered when git cannot find a useful commit.
 * 2. **Overlap detection (§6.2).** It is a set intersection over measurements
 *    the manager already has, it costs nothing, and §6.2's whole value is that
 *    it *warns up front* — a warning delivered after the merge has already gone
 *    red is a post-mortem.
 */

import { detectOverlap, type OverlapReport } from "../workspace/overlap.js";
import { type MergeCandidate, type MergeOutcome, runMerge } from "../workspace/merge.js";
import type { Store } from "../store/index.js";
import type { MergeRecord, WorkerRecord } from "./types.js";
import type { WorkerManager } from "./worker.js";

export interface MergeCoordinatorOptions {
  readonly manager: WorkerManager;
  readonly store: Store;
  readonly repoRoot: string;
  readonly now?: () => number;
  readonly newMergeID?: () => string;
  /** How long the gate's test command may run. Generous; the poll is cheap. */
  readonly testTimeoutMs?: number;
  /** Where integration worktrees go. Defaults under the state directory. */
  readonly integrationRoot?: string;
  /** Diagnostics. Never stdout — that is the JSON-RPC channel. */
  readonly log?: (line: string) => void;
}

export interface StartMergeRequest {
  readonly workerIDs: readonly string[];
  readonly runID?: string;
  /**
   * Overrides the command taken from the workers' briefs.
   *
   * Claude's to set, never a worker's (DD-8): the fallback below reads
   * `WorkerSpec.testCommand`, which is what Claude wrote at spawn, and never
   * `report.tests.command`, which is what the worker said afterwards.
   */
  readonly testCommand?: string;
  /** Off means every clean merge is accepted. Deliberate, and reported. */
  readonly runTests?: boolean;
  readonly integrationBranch?: string;
  readonly continueOnFailure?: boolean;
}

/** What `start()` hands back: the row, plus the §6.2 warning that came free. */
export interface StartedMerge {
  readonly record: MergeRecord;
  readonly overlap: OverlapReport;
  /** Workers whose branch holds no commit — merging them is already a no-op. */
  readonly empty: readonly string[];
  /**
   * Why this merge is running without a gate, when it is.
   *
   * An ungated merge has to say so out loud. Silence here would let "merged
   * green" mean "merged, and nobody checked", which is the one thing DD-6 exists
   * to prevent.
   */
  readonly gateNote?: string;
}

export class MergeStartError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MergeStartError";
  }
}

export class MergeCoordinator {
  private readonly opts: Required<Omit<MergeCoordinatorOptions, "integrationRoot">> & { integrationRoot?: string };
  /** In-flight pipelines, so `wait` has something to await and dispose can drain. */
  private readonly running = new Map<string, Promise<void>>();
  private readonly waiters = new Map<string, Set<() => void>>();
  private seq = 0;

  constructor(options: MergeCoordinatorOptions) {
    this.opts = {
      manager: options.manager,
      store: options.store,
      repoRoot: options.repoRoot,
      now: options.now ?? Date.now,
      newMergeID: options.newMergeID ?? (() => `m-${(++this.seq).toString().padStart(3, "0")}`),
      testTimeoutMs: options.testTimeoutMs ?? 10 * 60_000,
      log: options.log ?? (() => {}),
      ...(options.integrationRoot === undefined ? {} : { integrationRoot: options.integrationRoot }),
    };
  }

  /**
   * Validate, warn, start, return. Everything here is synchronous or trivially
   * fast; the pipeline itself runs detached.
   */
  start(req: StartMergeRequest): StartedMerge {
    if (req.workerIDs.length === 0) throw new MergeStartError("no workers to merge");

    const records = req.workerIDs.map((id) => this.requireMergeable(id));
    const bases = [...new Set(records.map((r) => r.baseSha).filter(Boolean))];

    const candidates: MergeCandidate[] = records.map((r) => ({
      workerID: r.workerID,
      branch: r.branch,
      baseSha: r.baseSha,
      // A `completed` worker may have no commit at all — `snapshotCommit`
      // reports `{committed: false}` when it changed nothing. Reaching for
      // `.snapshot.sha` unguarded null-dereferences on exactly the workers most
      // worth being suspicious of, so it is optional the whole way down.
      ...(r.result?.snapshot?.committed && r.result.snapshot.sha ? { sha: r.result.snapshot.sha } : {}),
    }));

    const overlap = detectOverlap(
      records.map((r) => ({
        workerID: r.workerID,
        // Dispatched Code's own measurement (git), not the worker's claim.
        files: r.result?.changes.paths ?? [],
        baseSha: r.baseSha,
      })),
    );

    const brief = briefTestCommand(records);
    const testCommand = req.runTests === false ? undefined : (req.testCommand ?? brief.command);
    const gateNote =
      req.runTests === false
        ? "runTests was false — merges are accepted on a clean apply alone, with no suite run."
        : testCommand === undefined
          ? brief.why
          : undefined;
    const mergeID = this.opts.newMergeID();
    const runID = req.runID ?? records[0]?.runID;
    const startedAt = this.opts.now();
    const baseSha = bases.length === 1 ? bases[0]! : "";

    const record: MergeRecord = {
      mergeID,
      ...(runID === undefined ? {} : { runID }),
      state: "running",
      integrationBranch: req.integrationBranch ?? `integration/${mergeID}`,
      baseSha,
      headSha: baseSha,
      workers: records.map((r) => r.workerID),
      ...(testCommand === undefined ? {} : { testCommand }),
      startedAt,
    };
    this.opts.store.putMerge(record);
    for (const r of records) {
      this.opts.store.appendEvent(r.workerID, "merge_started", { mergeID, branch: record.integrationBranch });
    }

    // Detached, and its rejection caught here rather than anywhere else: an
    // unhandled rejection in a background pipeline takes the whole MCP server
    // down, and the server going away is indistinguishable to the host from
    // Dispatched Code never having worked.
    this.running.set(
      mergeID,
      this.drive(mergeID, record, candidates, req, testCommand).catch((e: unknown) => {
        this.fail(mergeID, record, e instanceof Error ? e.message : String(e));
      }),
    );

    return {
      record,
      overlap,
      empty: candidates.filter((c) => c.sha === undefined).map((c) => c.workerID),
      ...(gateNote === undefined ? {} : { gateNote }),
    };
  }

  get(mergeID: string): MergeRecord | undefined {
    return this.opts.store.getMerge(mergeID);
  }

  list(filter: { runID?: string } = {}): MergeRecord[] {
    return this.opts.store.listMerges(filter);
  }

  /**
   * Block until a merge settles, or the budget runs out.
   *
   * Not exposed as a tool — `workspace_merge_status` is the poll, and a wait
   * whose subject can legitimately take twenty minutes would be a trap in a
   * host that gives up at sixty seconds. It exists for tests, and for any caller
   * inside this process that genuinely wants to await the result.
   */
  async wait(mergeID: string, timeoutMs = 30_000): Promise<MergeRecord | undefined> {
    const settled = (): MergeRecord | undefined => {
      const r = this.opts.store.getMerge(mergeID);
      return r && r.state !== "running" ? r : undefined;
    };
    const already = settled();
    if (already) return already;
    if (!this.running.has(mergeID)) return this.opts.store.getMerge(mergeID);

    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, timeoutMs);
      const set = this.waiters.get(mergeID) ?? new Set<() => void>();
      set.add(done);
      this.waiters.set(mergeID, set);
      function done(): void {
        clearTimeout(timer);
        set.delete(done);
        resolve();
      }
    });
    return this.opts.store.getMerge(mergeID);
  }

  /** Let in-flight pipelines finish before the process tears its store down. */
  async drain(): Promise<void> {
    await Promise.all([...this.running.values()]);
  }

  // -------------------------------------------------------------------------

  private async drive(
    mergeID: string,
    initial: MergeRecord,
    candidates: readonly MergeCandidate[],
    req: StartMergeRequest,
    testCommand: string | undefined,
  ): Promise<void> {
    try {
      const outcome = await runMerge({
        mergeID,
        repoRoot: this.opts.repoRoot,
        candidates,
        integrationBranch: initial.integrationBranch,
        ...(this.opts.integrationRoot === undefined ? {} : { integrationRoot: this.opts.integrationRoot }),
        ...(initial.baseSha === "" ? {} : { baseSha: initial.baseSha }),
        ...(testCommand === undefined ? {} : { testCommand }),
        testTimeoutMs: this.opts.testTimeoutMs,
        ...(req.continueOnFailure === undefined ? {} : { continueOnFailure: req.continueOnFailure }),
        now: this.opts.now,
        log: this.opts.log,
        // Persist as it goes: a merge that takes ten minutes should be legible
        // from the index while it is still running, not only afterwards.
        onStep: (step) => {
          this.opts.store.appendEvent(step.workerID, `merge_${step.outcome}`, {
            mergeID,
            shaBefore: step.shaBefore.slice(0, 12),
            shaAfter: step.shaAfter.slice(0, 12),
            ...(step.detail === undefined ? {} : { detail: step.detail }),
          });
        },
      });
      this.finish(mergeID, initial, outcome);
    } finally {
      this.running.delete(mergeID);
      this.notify(mergeID);
    }
  }

  /**
   * Record the outcome and fire `completed → merged` for the workers that
   * genuinely landed.
   *
   * The transition comes *after* the pipeline, never before: a worker is
   * `merged` when its commits are in the integration branch, and a worker moved
   * to `merged` optimistically would keep that state through the rollback that
   * took its commits back out.
   */
  private finish(mergeID: string, initial: MergeRecord, outcome: MergeOutcome): void {
    for (const workerID of outcome.merged) {
      try {
        this.opts.manager.markMerged(workerID, {
          mergeID,
          integrationBranch: outcome.integrationBranch,
          sha: outcome.headSha,
        });
      } catch (e) {
        // A worker that cannot make the transition (already merged by an earlier
        // pipeline, say) does not invalidate the merge that just happened. The
        // branch is the truth; the row is the index.
        this.opts.log(`merge ${mergeID}: could not mark ${workerID} merged: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    this.opts.store.putMerge({
      ...initial,
      state: outcome.state === "running" ? "failed" : outcome.state,
      baseSha: outcome.baseSha,
      headSha: outcome.headSha,
      endedAt: outcome.endedAt ?? this.opts.now(),
      outcome,
    });
  }

  private fail(mergeID: string, initial: MergeRecord, error: string): void {
    this.opts.log(`merge ${mergeID} failed to run: ${error}`);
    this.opts.store.putMerge({ ...initial, state: "failed", endedAt: this.opts.now(), error });
    this.notify(mergeID);
  }

  private notify(mergeID: string): void {
    for (const fn of [...(this.waiters.get(mergeID) ?? [])]) fn();
    this.waiters.delete(mergeID);
  }

  /**
   * The state-machine gate, phrased as an error a model can act on.
   *
   * §5 gives `merge` exactly one legal source state. Saying which state the
   * worker is actually in, and what to do about it, is the difference between a
   * tool Claude retries pointlessly and one it routes around.
   */
  private requireMergeable(workerID: string): WorkerRecord {
    const record = this.opts.manager.get(workerID);
    if (!record) throw new MergeStartError(`no worker ${JSON.stringify(workerID)} — use worker_list to see what exists`);
    if (record.state === "merged") {
      throw new MergeStartError(`${workerID} is already merged (into a previous integration branch); nothing to do`);
    }
    // §11 Phase 8: a shared worker has no branch, because its work went straight
    // into the repository. There is nothing to merge and — far more importantly —
    // nothing here may try: the pipeline's rollback is `git reset --hard`, and
    // pointed at the user's own checkout that destroys work nobody asked it to
    // touch. ADR-0003 drew that line and shared mode does not move it.
    if (record.branch === "") {
      throw new MergeStartError(
        `${workerID} worked in your repository directly (workspace: shared), so its changes are already in your tree — ` +
          "there is no branch to merge and nothing for the test gate to stand between. Review them with " +
          `worker_diff({id: "${workerID}"}) and commit what you want. Spawn with workspace: "isolated" if you want ` +
          "the gate.",
      );
    }
    if (record.state !== "completed") {
      throw new MergeStartError(
        `${workerID} is ${record.state}, and only a \`completed\` worker can be merged. ` +
          (record.state === "blocked"
            ? "Answer it with worker_message and let it finish first."
            : record.state === "failed" || record.state === "timed_out" || record.state === "over_budget"
              ? "Its work is still on its branch, but it never finished; read worker_result and decide whether to respawn."
              : "Wait for it with worker_wait, then merge."),
      );
    }
    return record;
  }
}

/**
 * The gate command, from the briefs (DD-8).
 *
 * Takes the first command the workers were *given*, and requires the rest to
 * agree with it — two workers briefed with different suites have no single
 * command that gates their merge, and silently picking one would run half a
 * check while reporting a whole one.
 */
function briefTestCommand(records: readonly WorkerRecord[]): { command?: string; why?: string } {
  const commands = [...new Set(records.map((r) => r.spec.testCommand).filter((c): c is string => !!c && c.trim() !== ""))];
  if (commands.length === 1) return { command: commands[0]! };
  if (commands.length === 0) {
    return { why: "no worker was briefed with a testCommand, so there is no suite to gate on. Pass testCommand to add one." };
  }
  return {
    why:
      `the workers were briefed with different test commands (${commands.map((c) => JSON.stringify(c)).join(", ")}), ` +
      "so none of them gates the whole merge. Pass testCommand to choose one.",
  };
}
