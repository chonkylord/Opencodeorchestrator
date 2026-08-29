/**
 * Workspace: the git side of a worker's life.
 *
 * Phase 2 built the worker's own life here — create a worktree, snapshot what
 * the worker left, and measure it. **Phase 4 added the other half**: a paginated
 * diff reader (§8's 400-line cap), overlap detection (§6.2), the gated merge
 * with auto-rollback (§6.3, DD-6) and the pruning that follows it (§9).
 *
 * Every merge operation runs in a dedicated integration worktree, never in the
 * user's checkout. See `merge.ts` and `docs/adr/0003-integration-worktree.md`.
 */

export { COMMIT_IDENTITY, type GitOptions, type GitOutcome, WorkspaceError, git, gitLine } from "./git.js";
export {
  type CreateWorktreeOptions,
  MANIFEST_FILE,
  ORCHESTRATOR_DIR,
  REPORT_FILE,
  type Snapshot,
  type Worktree,
  changedFiles,
  createWorktree,
  ensureExcluded,
  defaultWorktreeRoot,
  diffStat,
  listManifests,
  manifestPath,
  readManifest,
  readReportFile,
  resolveRepoRoot,
  resolveSha,
  snapshotCommit,
  writeManifest,
} from "./worktree.js";
export { type TestRun, runTestCommand } from "./verify.js";
export {
  DIFF_BYTES_MAX,
  DIFF_LINES_DEFAULT,
  DIFF_LINES_MAX,
  DIFF_LINE_CHARS,
  type DiffOptions,
  type DiffPage,
  readCommitDiff,
  readDiff,
} from "./diff.js";
export {
  type OverlapClass,
  type OverlapInput,
  type OverlapPair,
  type OverlapReport,
  type SharedFile,
  detectOverlap,
  isIntegrationFile,
  suggestMergeOrder,
} from "./overlap.js";
export {
  type MergeCandidate,
  type MergeOptions,
  type MergeOutcome,
  type MergeState,
  type MergeStep,
  type StepOutcome,
  defaultIntegrationRoot,
  runMerge,
} from "./merge.js";
export {
  type CleanupCandidate,
  type CleanupOptions,
  type CleanupReport,
  type Orphan,
  type PrunedWorker,
  type WorktreeEntry,
  cleanupWorkspace,
  containerRefs,
  listWorktrees,
  pruneWorker,
  scanOrphans,
} from "./cleanup.js";
