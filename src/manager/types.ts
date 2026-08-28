/**
 * The manager's own vocabulary — the data contracts from `projectplan.md` §4.
 *
 * Nothing here names an OpenCode shape (DD-2). A `WorkerRecord` is what the
 * orchestrator knows about a worker; a `WorkerResult` is what Claude is shown.
 */

import type { MergeOutcome, MergeState } from "../workspace/merge.js";
import type { WorkerState } from "./state.js";

/** DD-10. `research` and `review` are read-only; only `implement` may edit. */
export type WorkerMode = "implement" | "research" | "review";

export const WORKER_MODES: readonly WorkerMode[] = Object.freeze(["implement", "research", "review"] as const);

/**
 * §8's budgets, per worker.
 *
 * Tokens rather than dollars: Phase 0 verified `cost` is `0` on free-tier
 * providers even after real work, so a dollar budget silently never fires.
 */
export interface WorkerBudget {
  /** Hard cap on `input + output + reasoning`. */
  readonly tokens: number;
  /** Hard deadline from first prompt to terminal event. Excludes blocked time. */
  readonly wallClockMs: number;
  /** No worker-generated events for this long means the worker is stuck (§5). */
  readonly idleMs: number;
  /** How long a `blocked` worker waits for an answer before it is timed out. */
  readonly blockedMs: number;
}

/** What Claude asks for when it spawns a worker. */
export interface WorkerSpec {
  /** Groups workers into one run (§3.4 `runs`). */
  readonly runID?: string;
  /** One-line objective. Becomes the `Task:` line of the brief. */
  readonly task: string;
  /** Expanded description. Becomes `## Scope`. */
  readonly scope?: string;
  readonly mode?: WorkerMode;
  /** Repo-relative paths this worker owns. Anything else it touches is flagged. */
  readonly ownedPaths?: readonly string[];
  readonly acceptance?: readonly string[];
  /** The command the worker must run before reporting, e.g. `npm test`. */
  readonly testCommand?: string;
  /** `provider/model`. Falls back to the manager's default for the mode (DD-9). */
  readonly model?: string;
  /** Git ref the worktree branches from. Defaults to the repo's HEAD. */
  readonly baseRef?: string;
  readonly budget?: Partial<WorkerBudget>;
  /** Extra constraints appended to the brief verbatim. */
  readonly notes?: readonly string[];
}

/** One claimed file change, straight from the worker's report (§4.2). */
export interface ReportedChange {
  readonly file: string;
  readonly action: "added" | "modified" | "deleted" | string;
  readonly rationale?: string;
}

/** §4.2, as parsed. Every field optional: this is untrusted worker output. */
export interface WorkerReport {
  readonly workerId?: string;
  readonly status: "completed" | "blocked" | "failed";
  readonly summary: string;
  readonly changes: readonly ReportedChange[];
  readonly tests?: {
    readonly command?: string;
    readonly passed?: number;
    readonly failed?: number;
    readonly skipped?: number;
  };
  readonly risks: readonly string[];
  readonly questions: readonly string[];
  readonly followUps: readonly string[];
}

/**
 * A disagreement between what the worker said and what the repository shows.
 *
 * DD-4's whole point. These are surfaced in the result, never swallowed —
 * "the model said it wrote the tests" is a claim until `git` agrees.
 */
export interface Discrepancy {
  readonly kind:
    /** Report claims a file changed; the diff does not show it. */
    | "claimed_not_changed"
    /** The diff shows a file the report never mentions. */
    | "changed_not_claimed"
    /** A real change outside the paths the brief assigned this worker. */
    | "out_of_scope"
    /** The report itself could not be read. */
    | "unparseable_report"
    /** The report says one thing about tests and the numbers disagree. */
    | "test_claim_unverified";
  readonly file?: string;
  readonly detail: string;
}

/** What the worker actually changed, according to git. */
export interface DiffStat {
  readonly files: number;
  readonly additions: number;
  readonly deletions: number;
  /** Repo-relative paths, sorted. */
  readonly paths: readonly string[];
}

/** §4.3 — the whole of what Claude sees about a worker. */
export interface WorkerResult {
  readonly workerID: string;
  readonly runID: string;
  readonly state: WorkerState;
  readonly mode: WorkerMode;
  readonly model: string;
  readonly task: string;
  readonly durationMs: number;
  readonly usage: { readonly totalTokens: number; readonly cost: number };
  readonly summary: string;
  readonly changes: DiffStat;
  readonly tests: WorkerReport["tests"] | null;
  readonly discrepancies: readonly Discrepancy[];
  readonly risks: readonly string[];
  readonly questions: readonly string[];
  readonly followUps: readonly string[];
  /** Machine-readable cause for a non-`completed` state. */
  readonly reason?: string;
  readonly error?: { readonly code: string; readonly message: string };
  /** DD-5's snapshot commit. */
  readonly snapshot?: { readonly committed: boolean; readonly sha?: string };
  /**
   * Which channel the report came from. `reply` is the worker's own final
   * message (schema-constrained where the provider allows it); `report_file` is
   * §5's secondary signal; `none` means the worker never reported at all.
   */
  readonly reportSource: "reply" | "report_file" | "none";
}

/** The manager's row for one worker. The SQLite `workers` table mirrors it. */
export interface WorkerRecord {
  readonly workerID: string;
  readonly runID: string;
  readonly state: WorkerState;
  readonly mode: WorkerMode;
  readonly model: string;
  readonly task: string;
  readonly spec: WorkerSpec;
  readonly worktree: string;
  readonly branch: string;
  readonly baseSha: string;
  /** Set once the backend session exists. */
  readonly sessionID?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly totalTokens: number;
  readonly cost: number;
  /** How many times this worker has been unblocked and resumed. */
  readonly resumes: number;
  readonly reason?: string;
  /** Outstanding questions while `blocked`. Untrusted text (DD-8). */
  readonly questions: readonly string[];
  readonly result?: WorkerResult;
}

/**
 * The self-describing file written next to the worker's work (DD-7).
 *
 * SQLite is the index; the worktrees are the durable state. A manifest in each
 * worktree is what makes that true rather than aspirational — lose the database
 * and the run is still reconstructible from the filesystem.
 */
export interface WorkerManifest {
  readonly version: 1;
  readonly workerID: string;
  readonly runID: string;
  readonly task: string;
  readonly mode: WorkerMode;
  readonly model: string;
  readonly branch: string;
  readonly baseSha: string;
  readonly createdAt: number;
  readonly spec: WorkerSpec;
  readonly sessionID?: string;
}

/**
 * One gated merge (§6.3), as the index stores it.
 *
 * A merge is a first-class entity rather than a field on a worker, and the
 * reason is DD-1: the gate runs a test suite, which takes minutes, and the host
 * abandons a tool call at sixty seconds. So `workspace_merge` starts a merge and
 * returns this handle, exactly as `worker_spawn` returns a worker — and a thing
 * with its own identity, its own state and its own poll needs its own row.
 *
 * It carries a set of workers rather than one, because merging is inherently
 * about a wave: "which worker broke it" is only a meaningful question when the
 * others are named alongside.
 */
export interface MergeRecord {
  readonly mergeID: string;
  readonly runID?: string;
  readonly state: MergeState;
  readonly integrationBranch: string;
  /** Where the integration branch started. The floor every rollback lands on. */
  readonly baseSha: string;
  /** Where it is now. Equal to `baseSha` while nothing has merged. */
  readonly headSha: string;
  /** The workers offered, in merge order. */
  readonly workers: readonly string[];
  /** The gate, from the brief (DD-8). Absent means the merge ran ungated. */
  readonly testCommand?: string;
  readonly startedAt: number;
  readonly endedAt?: number;
  /** The full per-step detail, once the pipeline has produced it. */
  readonly outcome?: MergeOutcome;
  /** Set when the merge could not run at all. */
  readonly error?: string;
}
