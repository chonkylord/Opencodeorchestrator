/**
 * Workspace: the git side of a worker's life.
 *
 * Phase 2 scope only — create a worktree, snapshot what the worker left, and
 * measure it. Overlap detection, the gated merge and cleanup are Phase 4's and
 * are deliberately absent.
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
