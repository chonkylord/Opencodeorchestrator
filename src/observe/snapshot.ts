/**
 * The dashboard's view model (§11 Phase 9).
 *
 * One shape, built from the index and the manager, serialised as JSON. It is
 * the deliberate opposite of everything in `src/mcp/render.ts`: that module
 * exists to make Claude's context grow by under 2k tokens per interaction, and
 * this one exists to give a human every number Dispatched Code has. The
 * constraint that shaped the tool surface — §8's context budget — does not
 * apply to a socket on 127.0.0.1, and pretending it does would be the one way to
 * build a dashboard that tells you less than the tools do.
 *
 * Two rules still carry over unchanged:
 *
 * - **DD-8.** Worker-authored text (summaries, questions, risks, follow-ups, the
 *   activity stream) is data. It is passed through as strings, and the UI renders
 *   it with `textContent`, never as markup.
 * - **DD-4.** A claim and a measurement are never merged into one field. The
 *   worker's `summary` sits beside Dispatched Code's `changes` and
 *   `discrepancies`, and the UI labels which is which.
 */

import type { MergeRecord, QueueHint, WorkerRecord, WorkerResult } from "../manager/index.js";
import type { ModelCapability, RunRow, Store } from "../store/index.js";
import type { ActivityEntry, ActivityLog } from "./activity.js";

/** What Dispatched Code itself is configured to do. The graph's root node. */
export interface ServerView {
  readonly name: string;
  readonly version: string;
  readonly repoRoot: string;
  readonly defaultModel: string;
  readonly workspace: string;
  readonly maxConcurrent: number;
  readonly maxRevisions: number;
  readonly runBudgetTokens: number;
  readonly waitMaxMs: number;
  readonly verifyTests: boolean;
  readonly startedAt: number;
  /** Models observed to refuse something, keyed by `provider/model`. */
  readonly modelCapabilities: Record<string, ModelCapability>;
}

export interface WorkerView {
  readonly id: string;
  readonly runID: string;
  readonly state: string;
  readonly reason?: string;
  readonly mode: string;
  readonly model: string;
  readonly task: string;
  readonly createdAt: number;
  readonly startedAt?: number;
  readonly endedAt?: number;
  readonly updatedAt: number;
  readonly totalTokens: number;
  readonly cost: number;
  readonly resumes: number;
  readonly revisions: number;
  readonly worktree: string;
  readonly branch: string;
  readonly workspace: "shared" | "isolated";
  readonly ownedPaths: readonly string[];
  readonly dependsOn: readonly string[];
  readonly reviewOf?: string;
  readonly priority: number;
  /** Worker-authored (DD-8). Present only while blocked. */
  readonly questions: readonly string[];
  /** Why nothing is happening yet, when the answer is "the queue". */
  readonly queue?: QueueHint;
  /** True when no session in this process can reach it. Drives the recover prompt. */
  readonly orphaned: boolean;
  /** Whether this worker's turns carry the report schema. */
  readonly structuredOutput: boolean;
  readonly result?: WorkerResult;
  readonly activity: { readonly count: number; readonly chars: number; readonly last?: ActivityEntry };
}

export interface DashboardSnapshot {
  readonly at: number;
  readonly server: ServerView;
  readonly runs: readonly RunRow[];
  readonly workers: readonly WorkerView[];
  readonly merges: readonly MergeRecord[];
  readonly totals: {
    readonly workers: number;
    readonly running: number;
    readonly queued: number;
    readonly blocked: number;
    readonly settled: number;
    readonly failed: number;
    readonly tokens: number;
    readonly cost: number;
  };
}

/** The slice of `WorkerManager` a snapshot needs. Structural, so tests can fake it. */
export interface SnapshotManager {
  list(filter?: { runID?: string }): WorkerRecord[];
  queueHint(workerID: string): QueueHint | undefined;
  isOrphaned(workerID: string): boolean;
  supportsStructuredOutput(model: string): boolean;
  isShared(spec: { workspace?: "shared" | "isolated" }): boolean;
  briefOf(workerID: string): { system: string; text: string } | undefined;
}

export interface SnapshotSources {
  readonly manager: SnapshotManager;
  readonly store: Store;
  readonly activity: ActivityLog;
  readonly server: Omit<ServerView, "modelCapabilities">;
  readonly now?: () => number;
}

/** States that mean "this worker is doing nothing more of its own accord". */
const SETTLED = new Set(["completed", "merged", "failed", "timed_out", "over_budget", "cancelled"]);
const FAILED = new Set(["failed", "timed_out", "over_budget"]);

export function buildWorkerView(sources: SnapshotSources, r: WorkerRecord): WorkerView {
  const queue = r.state === "spawned" ? sources.manager.queueHint(r.workerID) : undefined;
  const activity = sources.activity.summary(r.workerID);
  return {
    id: r.workerID,
    runID: r.runID,
    state: r.state,
    ...(r.reason === undefined ? {} : { reason: r.reason }),
    mode: r.mode,
    model: r.model,
    task: r.task,
    createdAt: r.createdAt,
    ...(r.startedAt === undefined ? {} : { startedAt: r.startedAt }),
    ...(r.endedAt === undefined ? {} : { endedAt: r.endedAt }),
    updatedAt: r.updatedAt,
    totalTokens: r.totalTokens,
    cost: r.cost,
    resumes: r.resumes,
    revisions: r.revisions,
    worktree: r.worktree,
    branch: r.branch,
    // A shared worker has no branch of its own — that is the structural fact the
    // merge tools key off, and it is a more reliable signal here than the spec,
    // which may name a mode the server default overrode.
    workspace: r.branch === "" ? "shared" : "isolated",
    ownedPaths: r.spec.ownedPaths ?? [],
    dependsOn: r.spec.dependsOn ?? [],
    ...(r.spec.reviewOf === undefined ? {} : { reviewOf: r.spec.reviewOf }),
    priority: r.spec.priority ?? 0,
    questions: r.questions,
    ...(queue === undefined ? {} : { queue }),
    orphaned: sources.manager.isOrphaned(r.workerID),
    structuredOutput: sources.manager.supportsStructuredOutput(r.model),
    ...(r.result === undefined ? {} : { result: r.result }),
    activity,
  };
}

export function buildSnapshot(sources: SnapshotSources): DashboardSnapshot {
  const now = sources.now ?? Date.now;
  const records = sources.manager.list();
  const workers = records.map((r) => buildWorkerView(sources, r));

  let tokens = 0;
  let cost = 0;
  let running = 0;
  let queued = 0;
  let blocked = 0;
  let settled = 0;
  let failed = 0;
  for (const w of workers) {
    tokens += w.totalTokens;
    cost += w.cost;
    if (w.state === "blocked") blocked += 1;
    else if (w.state === "spawned" && w.queue) queued += 1;
    else if (w.state === "spawned" || w.state === "preparing" || w.state === "running") running += 1;
    if (SETTLED.has(w.state)) settled += 1;
    if (FAILED.has(w.state)) failed += 1;
  }

  return {
    at: now(),
    server: { ...sources.server, modelCapabilities: sources.store.listModelCapabilities() },
    runs: sources.store.listRuns(),
    workers,
    merges: sources.store.listMerges(),
    totals: { workers: workers.length, running, queued, blocked, settled, failed, tokens, cost },
  };
}
