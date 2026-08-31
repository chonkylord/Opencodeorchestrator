/**
 * The worktree operations the Phase 2 lifecycle needs, and deliberately no more.
 *
 * §6.1 draws a larger workspace manager — overlap detection, the gated merge,
 * orphan pruning. Those are Phase 4's. What a worker's *life* needs is three
 * things: somewhere isolated to work (`createWorktree`), a commit of whatever it
 * left behind (`snapshotCommit`, DD-5), and the truth about what it changed
 * (`changedFiles` / `diffStat`, which DD-4's reconciliation runs on).
 *
 * On not using OpenCode's own worktree API: `docs/phase0-facts.md` §6 notes that
 * `POST /experimental/worktree` and `GET /session/{id}/diff` exist. They are the
 * wrong tools here for a reason worth stating — the diff is the evidence we
 * check the worker's claims against, and asking the worker's own server for it
 * makes the witness and the accused the same process. Local git is an
 * independent source, and DD-5 means the manager needs git in the loop anyway.
 * See `docs/adr/0002-worker-contract-channel.md`.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

import type { DiffStat, WorkerManifest } from "../manager/types.js";
import { WorkspaceError, git, gitLine } from "./git.js";

/** Per-worktree orchestrator scratch. Never committed, never reconciled. */
export const ORCHESTRATOR_DIR = ".orchestrator";
export const MANIFEST_FILE = "worker.json";
/** §5's secondary completion signal, if the worker chooses to write one. */
export const REPORT_FILE = "report.json";

/**
 * Paths the manager owns inside a worker's tree.
 *
 * Excluded from the snapshot commit and filtered out of every changed-file list:
 * they are orchestration artifacts, and counting them as the worker's work would
 * put a false entry in every single reconciliation.
 */
const EXCLUDED = [ORCHESTRATOR_DIR, REPORT_FILE];
const EXCLUDE_PATHSPECS = EXCLUDED.map((p) => `:(exclude)${p}`);

export interface CreateWorktreeOptions {
  readonly repoRoot: string;
  readonly workerID: string;
  /** Branch point. Defaults to the repo's current HEAD. */
  readonly baseRef?: string;
  /** Where worktrees live. Defaults to `<repoRoot>/.orchestrator/worktrees` (§6.1). */
  readonly root?: string;
  /** Branch name. Defaults to `worker/<workerID>`. */
  readonly branch?: string;
}

export interface Worktree {
  readonly path: string;
  readonly branch: string;
  readonly baseSha: string;
}

export async function resolveRepoRoot(dir: string): Promise<string> {
  const root = await gitLine(dir, ["rev-parse", "--show-toplevel"]);
  if (!root) throw new WorkspaceError("config", `not a git repository: ${dir}`);
  return root;
}

export async function resolveSha(repoRoot: string, ref = "HEAD"): Promise<string> {
  const sha = await gitLine(repoRoot, ["rev-parse", ref]);
  if (!/^[0-9a-f]{40}$/.test(sha)) {
    throw new WorkspaceError("config", `cannot resolve ${ref} in ${repoRoot} (got ${JSON.stringify(sha)})`);
  }
  return sha;
}

export function defaultWorktreeRoot(repoRoot: string): string {
  return join(repoRoot, ORCHESTRATOR_DIR, "worktrees");
}

/**
 * `git worktree add <path> -b worker/<id> <base-sha>` (§6.1).
 *
 * Branches from a resolved sha rather than a ref: a run that takes twenty
 * minutes must not have its workers silently based on different commits because
 * something moved `main` underneath them.
 */
export async function createWorktree(opts: CreateWorktreeOptions): Promise<Worktree> {
  const repoRoot = await resolveRepoRoot(opts.repoRoot);
  const baseSha = await resolveSha(repoRoot, opts.baseRef ?? "HEAD");
  const root = opts.root ? resolve(opts.root) : defaultWorktreeRoot(repoRoot);
  const branch = opts.branch ?? `worker/${opts.workerID}`;
  const path = join(root, opts.workerID);

  if (existsSync(path)) {
    throw new WorkspaceError("config", `worktree path already exists: ${path}`, { workerID: opts.workerID });
  }
  mkdirSync(dirname(path), { recursive: true });
  await ensureExcluded(repoRoot);
  await git(repoRoot, ["worktree", "add", path, "-b", branch, baseSha]);
  return { path, branch, baseSha };
}

/**
 * Keep the orchestrator's scratch out of everyone's `git status`.
 *
 * Written to `info/exclude`, which is local and uncommitted — the user's own
 * `.gitignore` is theirs, and a tool that edits it has overstepped. The common
 * git dir is shared by every worktree, so one entry covers them all, which is
 * also what keeps a worker's manifest out of `git add -A`.
 *
 * **Exported since Phase 7, and called at server start as well as here.** It
 * used to run only when a worker prepared a worktree, but the server writes
 * `.orchestrator/` the moment it opens its database — and a run in which no
 * worker ever reached `preparing` therefore left the directory sitting visible
 * in the user's `git status`. Idempotent, and safe on a read-only `.git`.
 */
export async function ensureExcluded(repoRoot: string): Promise<void> {
  const commonDir = await gitLine(repoRoot, ["rev-parse", "--git-common-dir"]);
  const excludeFile = join(isAbsolute(commonDir) ? commonDir : join(repoRoot, commonDir), "info", "exclude");
  const entry = `/${ORCHESTRATOR_DIR}/`;
  try {
    const existing = existsSync(excludeFile) ? readFileSync(excludeFile, "utf8") : "";
    if (existing.split("\n").some((l) => l.trim() === entry)) return;
    mkdirSync(dirname(excludeFile), { recursive: true });
    writeFileSync(excludeFile, `${existing}${existing.endsWith("\n") || existing === "" ? "" : "\n"}${entry}\n`);
  } catch {
    // A read-only .git is unusual but survivable: the pathspec exclusions below
    // are the load-bearing half of this, and they need no filesystem write.
  }
}

// ---------------------------------------------------------------------------
// The manifest (DD-7)
// ---------------------------------------------------------------------------

export function manifestPath(worktree: string): string {
  return join(worktree, ORCHESTRATOR_DIR, MANIFEST_FILE);
}

// ---------------------------------------------------------------------------
// Scratch space (§11 Phase 9)
// ---------------------------------------------------------------------------

/** Where per-worker scratch lives, under {@link ORCHESTRATOR_DIR}. */
export const SCRATCH_DIR = "scratch";

/**
 * A worker's own scratch directory, inside its jail.
 *
 * The problem this solves is small and cost a whole worker: a worker told to
 * write a throwaway verification script has nowhere to put it. `/tmp` is outside
 * its tree and trips the `external_directory` permission wall — deliberately, and
 * `IMPLEMENT_PERMISSIONS` explains why that wall is not widened — while the
 * worktree itself is the thing being reconciled, so a scratch file dropped there
 * shows up in the diff as unclaimed work and reads as a discrepancy. Both
 * available answers were wrong, so the worker blocked on a permission request
 * doing exactly what it was asked to do.
 *
 * This is the third answer: inside the jail, so no permission is needed; under
 * `.orchestrator/`, which is already git-excluded and already filtered out of
 * every changed-file list by {@link EXCLUDED}, so nothing written here can reach
 * a diff, a snapshot or a reconciliation.
 *
 * Per worker rather than per tree, because in `shared` mode the tree is the
 * user's whole checkout and several workers are in it at once.
 */
export function scratchPath(worktree: string, workerID: string): string {
  return join(worktree, ORCHESTRATOR_DIR, SCRATCH_DIR, workerID);
}

/**
 * Create {@link scratchPath} and return it.
 *
 * Best-effort by contract: a worker that cannot be given scratch space is a
 * worker that works the way it did before this existed, not one that fails to
 * start. The caller passes `undefined` to the brief in that case, and the brief
 * simply says nothing about scratch.
 */
export function ensureScratch(worktree: string, workerID: string): string | undefined {
  const path = scratchPath(worktree, workerID);
  try {
    mkdirSync(path, { recursive: true });
    return path;
  } catch {
    return undefined;
  }
}

/**
 * Write the worker's identity next to its work.
 *
 * DD-7 says the worktrees are the durable state and the database is the index.
 * That is only true if a worktree can say who it belongs to — otherwise a lost
 * database leaves a directory of anonymous branches, which is exactly the
 * catastrophic case DD-7 claims not to have.
 */
export function writeManifest(worktree: string, manifest: WorkerManifest): void {
  const path = manifestPath(worktree);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

export function readManifest(worktree: string): WorkerManifest | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(manifestPath(worktree), "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const m = parsed as WorkerManifest;
    return typeof m.workerID === "string" && m.version === 1 ? m : null;
  } catch {
    return null;
  }
}

/** Every manifest under a worktree root — the input to rebuilding a lost index. */
export function listManifests(root: string): WorkerManifest[] {
  if (!existsSync(root)) return [];
  const out: WorkerManifest[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const m = readManifest(join(root, entry.name));
    if (m) out.push(m);
  }
  return out.sort((a, b) => a.workerID.localeCompare(b.workerID));
}

// ---------------------------------------------------------------------------
// Snapshot, diff
// ---------------------------------------------------------------------------

export interface Snapshot {
  readonly committed: boolean;
  readonly sha?: string;
  readonly files: readonly string[];
}

/**
 * DD-5: `git add -A && git commit` after the worker finishes.
 *
 * Workers cannot be trusted to commit — Phase 0 watched one leave its work
 * untracked — and an uncommitted worktree makes every later diff and merge a
 * guess. Hooks are disabled (see `git.ts`): a snapshot must never be a path for
 * repository content to execute in the manager's process.
 */
export async function snapshotCommit(worktree: string, message: string): Promise<Snapshot> {
  // Stage everything, then unstage the orchestrator's own files. Naming them in
  // an `add` pathspec looks tidier and is not equivalent: git rejects a pathspec
  // that explicitly matches an ignored path, and `.orchestrator/` is ignored
  // precisely so the worker never sees it. Unstaging afterwards holds whether or
  // not the ignore entry was written.
  await git(worktree, ["add", "-A", "--", "."]);
  let files = splitLines((await git(worktree, ["diff", "--cached", "--name-only"])).stdout);
  const ours = files.filter(isExcluded);
  if (ours.length > 0) {
    await git(worktree, ["reset", "-q", "--", ...ours]);
    files = files.filter((f) => !isExcluded(f));
  }
  if (files.length === 0) return { committed: false, files: [] };
  await git(worktree, ["commit", "--no-verify", "--no-gpg-sign", "-m", message]);
  return { committed: true, sha: await resolveSha(worktree, "HEAD"), files };
}

/**
 * What actually changed, relative to the base commit.
 *
 * The ground truth DD-4 reconciles against. Works before or after the snapshot:
 * tracked changes come from the diff, anything the worker left untracked comes
 * from `ls-files --others`, so a worker that never got committed is still
 * measured honestly.
 */
/**
 * Files that differ from HEAD right now — modified, staged or untracked.
 *
 * The baseline a **shared** worker needs (§11 Phase 8). In its own worktree a
 * worker starts from a clean tree, so everything that differs from its base is
 * its doing. In the user's checkout that is false before it even begins: the
 * user may have half a feature in progress, and attributing that to the first
 * worker to finish would be a lie in the one channel this system keeps honest.
 *
 * So the manager records this at the moment a shared worker starts, and
 * subtracts it at the end.
 */
export async function dirtyFiles(repoRoot: string): Promise<string[]> {
  const out = await git(repoRoot, ["status", "--porcelain=1", "--untracked-files=all", "--", ".", ...EXCLUDE_PATHSPECS]);
  const files = splitLines(out.stdout)
    // `XY path` — and `R  old -> new` for a rename, whose *new* name is the one
    // that exists on disk and the one every other path in this file speaks of.
    .map((line) => {
      const path = line.slice(3).trim();
      const arrow = path.indexOf(" -> ");
      return arrow >= 0 ? path.slice(arrow + 4) : path;
    })
    .map((p) => (p.startsWith('"') && p.endsWith('"') ? p.slice(1, -1) : p))
    .filter((p) => p !== "" && !isExcluded(p));
  return [...new Set(files)].sort();
}

export async function changedFiles(worktree: string, baseSha: string): Promise<string[]> {
  const tracked = await git(worktree, ["diff", "--name-only", baseSha, "--", ".", ...EXCLUDE_PATHSPECS]);
  const untracked = await git(worktree, ["ls-files", "--others", "--exclude-standard", "--", ".", ...EXCLUDE_PATHSPECS]);
  const all = new Set([...splitLines(tracked.stdout), ...splitLines(untracked.stdout)]);
  return [...all].filter((f) => !isExcluded(f)).sort();
}

export async function diffStat(worktree: string, baseSha: string): Promise<DiffStat> {
  const numstat = await git(worktree, ["diff", "--numstat", baseSha, "--", ".", ...EXCLUDE_PATHSPECS]);
  let additions = 0;
  let deletions = 0;
  const paths = new Set<string>();
  for (const line of splitLines(numstat.stdout)) {
    const [add, del, ...rest] = line.split("\t");
    const file = rest.join("\t");
    if (!file || isExcluded(file)) continue;
    paths.add(file);
    // Binary files report "-": counted as a changed file with no line delta.
    additions += Number.parseInt(add ?? "0", 10) || 0;
    deletions += Number.parseInt(del ?? "0", 10) || 0;
  }

  // Anything the worker left untracked has no diff yet; count its lines so a
  // result taken before the snapshot is not silently empty.
  const untracked = await git(worktree, ["ls-files", "--others", "--exclude-standard", "--", ".", ...EXCLUDE_PATHSPECS]);
  for (const file of splitLines(untracked.stdout)) {
    if (isExcluded(file)) continue;
    paths.add(file);
    additions += countLines(join(worktree, file));
  }

  return { files: paths.size, additions, deletions, paths: [...paths].sort() };
}

/** §5's secondary completion signal: whatever the worker wrote to `report.json`. */
export function readReportFile(worktree: string): string | null {
  try {
    const text = readFileSync(join(worktree, REPORT_FILE), "utf8");
    return text.trim() === "" ? null : text;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------

function isExcluded(file: string): boolean {
  return EXCLUDED.some((p) => file === p || file.startsWith(`${p}/`));
}

function splitLines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
}

function countLines(path: string): number {
  try {
    const buf = readFileSync(path);
    // Bound it: a worker that drops a 200MB artifact should not be able to make
    // the manager read it into memory just to produce a line count.
    if (buf.length > 4 * 1024 * 1024) return 0;
    if (buf.includes(0)) return 0; // binary
    const text = buf.toString("utf8");
    return text.length === 0 ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
  } catch {
    return 0;
  }
}
