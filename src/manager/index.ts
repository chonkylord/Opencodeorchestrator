/**
 * The worker manager (§3.2): the lifecycle, the registry, and what Claude sees.
 */

export {
  FAILURE_STATES,
  IllegalTransitionError,
  type StateChange,
  TRANSITIONS,
  type Transition,
  type Trigger,
  WORKER_STATES,
  WorkerMachine,
  type WorkerMachineOptions,
  type WorkerState,
  can,
  isActive,
  isFinal,
  isSettled,
  next,
  peek,
  triggersFrom,
} from "./state.js";

export { type RenderOptions, renderResult } from "./result.js";

export {
  type Answerability,
  DEFAULT_BUDGET,
  DEFAULT_MAX_RETRIES,
  DEFAULT_MAX_REVISIONS,
  DEFAULT_RETRY_BACKOFF_MS,
  DEFAULT_RUN_BUDGET_TOKENS,
  backoffMs,
  DEFAULT_MODEL,
  DEFAULT_PERMISSION_MODE,
  type PermissionMode,
  type RecoverAction,
  type SharedCollision,
  type RecoverOutcome,
  type ReviseOutcome,
  RunBudgetError,
  type RevisionCapReport,
  type RevisionRefusal,
  WorkerManager,
  type WorkerManagerOptions,
} from "./worker.js";

export {
  type Admission,
  DEFAULT_MAX_CONCURRENT,
  DependencyError,
  type DependencyOutcome,
  MAX_CONCURRENT_LIMIT,
  type QueueHint,
  type QueueReason,
  Scheduler,
  type SchedulerOptions,
  clampConcurrency,
  findCycle,
} from "./scheduler.js";

export { METRICS_DIR, type Metric, type MetricKind, type MetricsSink, NULL_METRICS, fileMetrics } from "./metrics.js";

export { type Route, type RouteRequest, type RoutingConfig, parseModelPool, route } from "./routing.js";

export { type RevisionRound, revisionRounds } from "./revisions.js";

export { RUN_REPORT_DIR, type RunReport, buildRunReport, writeRunReport } from "./runreport.js";

export {
  MergeCoordinator,
  type MergeCoordinatorOptions,
  MergeStartError,
  type StartMergeRequest,
  type StartedMerge,
} from "./merges.js";

export type {
  ActivityInput,
  WorkerObserver,
  DiffStat,
  MergeRecord,
  Discrepancy,
  ReportedChange,
  WORKER_MODES,
  WorkerBudget,
  WorkerManifest,
  WorkerMode,
  WorkerRecord,
  WorkerReport,
  WorkerResult,
  WorkerSpec,
  WorkspaceMode,
} from "./types.js";
