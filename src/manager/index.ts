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

export { DEFAULT_BUDGET, DEFAULT_MODEL, WorkerManager, type WorkerManagerOptions } from "./worker.js";

export type {
  DiffStat,
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
} from "./types.js";
