/**
 * Observability (§11 Phase 9): the other side of the context firewall.
 *
 * Everything under `src/mcp/` is built to keep worker transcripts *out* of a
 * model's context window. Everything here is built to put the same information
 * in front of a human, live, at no token cost — a socket on 127.0.0.1 has no
 * context budget to blow.
 */

export {
  type ActivityEntry,
  type ActivityOptions,
  ActivityLog,
  DEFAULT_MAX_BURST_CHARS,
  DEFAULT_MAX_CHARS,
  DEFAULT_MAX_ENTRIES,
} from "./activity.js";
export {
  type DashboardSnapshot,
  type ServerView,
  type SnapshotManager,
  type SnapshotSources,
  type WorkerView,
  buildSnapshot,
  buildWorkerView,
} from "./snapshot.js";
export {
  DASHBOARD_HOST,
  DEFAULT_DASHBOARD_PORT,
  type Dashboard,
  type DashboardOptions,
  startDashboard,
} from "./server.js";
