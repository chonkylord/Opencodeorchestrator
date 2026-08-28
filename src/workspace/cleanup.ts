/**
 * Pruning worktrees and branches, and the orphan scan (§6.3 step 4, §9).
 *
 * The one rule this module exists to enforce: **cleanup must not be able to
 * destroy unmerged work.** DD-7 says the worktrees are the durable state and the
 * database is an index — so a `workspace_cleanup` that deletes an unmerged
 * `worker/*` branch is not tidying up, it is deleting the only copy of what a
 * worker produced. Every decision below follows from that:
 *
 * - A branch is pruned **only** if its tip is already contained in something
 *   that survives the prune (the repository's HEAD, or an integration branch).
 *   Anything else is kept, with the reason said out loud, unless the caller
 *   passes `force`.
 * - `force` is not a flag that means "try harder". It means *delete commits that
 *   exist nowhere else*, and the tool description says so in those words.
 * - The orphan scan **reports** by default. §9 says "report or prune"; the safe
 *   half is the default, and the unsafe half needs the same `force`.
 * - Nothing outside the orchestrator's own directories is ever removed. The
 *   main worktree — the user's checkout — is filtered out by path before any
 *   removal is considered, not merely absent from the list by luck.
 *
 * Removing a *worktree* is much cheaper than removing a *branch*: the branch
 * keeps every commit, so a pruned worktree loses nothing but disk. The two are
 * therefore decided separately, and a worker whose branch must be kept still has
 * its worktree reclaimed.
 */

import { existsSync, rmSync } from "node:fs";
import { resolve, sep } from "node:path";

import { git, gitLine } from "./git.js";
import { ORCHESTRATOR_DIR, defaultWorktreeRoot, resolveRepoRoot } from "./worktree.js";

/** What the index knows about one worker, as far as cleanup cares. */
export interface CleanupCandidate {
  readonly workerID: string;
  readonly worktree: string;
  readonly branch: string;
  /** Used only to explain a decision; the ancestry check is what decides it. */
  readonly state?: string;
}

export interface PrunedWorker {
  readonly workerID: string;
  readonly branch: string;
  readonly worktreeRemoved: boolean;
  readonly branchDeleted: boolean;
  /** Where the branch's tip was found, when it was. */
  readonly containedIn?: string;
  /** Why something was left alone. Present whenever anything was. */
  readonly kept?: string;
  readonly error?: string;
}

export interface Orphan {
  readonly kind: "worktree" | "branch";
  /** Path for a worktree, ref name for a branch. */
  readonly name: string;
  /** The worker id implied by the path or branch name, when one is. */
  readonly workerID?: string;
  /** True when the tip is already contained in HEAD or an integration branch. */
  readonly merged: boolean;
}

export interface CleanupReport {
  readonly pruned: readonly PrunedWorker[];
  readonly orphans: readonly Orphan[];
  /** Refs that were treated as "somewhere safe to already be". */
  readonly containers: readonly string[];
  readonly forced: boolean;
}

export interface CleanupOptions {
  readonly repoRoot: string;
  /** The workers to consider. Cleanup never goes looking for more. */
  readonly candidates: readonly CleanupCandidate[];
  /** Every worker id the index knows, for the orphan scan. */
  readonly knownIDs?: readonly string[];
  readonly worktreeRoot?: string;
  /**
   * Delete branches whose commits exist nowhere else.
   *
   * This destroys work. It is the caller's decision and it is never implied.
   */
  readonly force?: boolean;
  /** Include the orphan scan. On by default: it is read-only without `force`. */
  readonly scan?: boolean;
  /** Prune the orphans the scan finds, rather than reporting them (§9). */
  readonly pruneOrphans?: boolean;
}

// ---------------------------------------------------------------------------

/**
 * Prune the named workers, and scan for what the index has lost track of.
 *
 * Total: a worker whose removal fails is reported with its error rather than
 * aborting the rest, because a cleanup that stops halfway through leaves a
 * caller with no idea which half happened.
 */
export async function cleanupWorkspace(opts: CleanupOptions): Promise<CleanupReport> {
  const repoRoot = await resolveRepoRoot(opts.repoRoot);
  const worktreeRoot = opts.worktreeRoot ? resolve(opts.worktreeRoot) : defaultWorktreeRoot(repoRoot);
  const containers = await containerRefs(repoRoot);
  const force = opts.force === true;

  const pruned: PrunedWorker[] = [];
  for (const candidate of opts.candidates) {
    pruned.push(await pruneWorker(repoRoot, candidate, { containers, force, worktreeRoot }));
  }

  const orphans =
    opts.scan === false
      ? []
      : await scanOrphans({
          repoRoot,
          worktreeRoot,
          knownIDs: opts.knownIDs ?? opts.candidates.map((c) => c.workerID),
          containers,
        });

  if (opts.pruneOrphans === true) {
    // Worktrees before branches, always: git refuses to delete a branch that is
    // checked out in a worktree, so the other order silently leaves every branch
    // behind while reporting that it pruned.
    const prunable = orphans.filter((o) => o.merged || force);
    for (const orphan of prunable.filter((o) => o.kind === "worktree")) {
      await removeWorktree(repoRoot, orphan.name, worktreeRoot);
    }
    for (const orphan of prunable.filter((o) => o.kind === "branch")) {
      await git(repoRoot, ["branch", "-D", orphan.name], { allowFailure: true });
    }
  }

  return { pruned, orphans, containers, forced: force };
}

/**
 * One worker's worktree and branch.
 *
 * The order matters: the worktree goes first, because git refuses to delete a
 * branch that is checked out in one, and because the worktree is the part whose
 * removal costs nothing.
 */
export async function pruneWorker(
  repoRoot: string,
  candidate: CleanupCandidate,
  ctx: { containers: readonly string[]; force: boolean; worktreeRoot: string },
): Promise<PrunedWorker> {
  const base = { workerID: candidate.workerID, branch: candidate.branch };
  try {
    const worktreeRemoved = candidate.worktree
      ? await removeWorktree(repoRoot, candidate.worktree, ctx.worktreeRoot)
      : false;

    const tip = await gitLine(repoRoot, ["rev-parse", "--verify", "--quiet", `refs/heads/${candidate.branch}`], {
      allowFailure: true,
    });
    if (!tip) {
      return { ...base, worktreeRemoved, branchDeleted: false, kept: "the branch does not exist" };
    }

    const containedIn = await containedWhere(repoRoot, tip, ctx.containers);
    if (containedIn === undefined && !ctx.force) {
      return {
        ...base,
        worktreeRemoved,
        branchDeleted: false,
        kept:
          `unmerged — ${candidate.branch} holds commits that exist nowhere else` +
          `${candidate.state ? ` (worker is ${candidate.state})` : ""}. Merge it, or pass force to delete the work.`,
      };
    }
    // `-D` rather than `-d` deliberately: the ancestry check above is the safety
    // property, and git's own `-d` heuristic asks a different question (is it
    // merged into the *current* branch, which in a bare-ish repoRoot is whatever
    // the user happens to have checked out).
    const del = await git(repoRoot, ["branch", "-D", candidate.branch], { allowFailure: true });
    return {
      ...base,
      worktreeRemoved,
      branchDeleted: del.code === 0,
      ...(containedIn === undefined ? {} : { containedIn }),
      ...(del.code === 0 ? {} : { error: del.stderr.trim().slice(0, 300) }),
    };
  } catch (e) {
    return { ...base, worktreeRemoved: false, branchDeleted: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * §9's orphan scan: worktrees and `worker/*` branches with no index row.
 *
 * Read-only. It answers "what is on disk that the database does not know about",
 * which is the question a rebuilt or lost index leaves behind — and the answer
 * is a report precisely because an orphan is more likely to be work worth
 * keeping than garbage worth deleting.
 */
export async function scanOrphans(opts: {
  repoRoot: string;
  worktreeRoot: string;
  knownIDs: readonly string[];
  containers?: readonly string[];
}): Promise<Orphan[]> {
  const known = new Set(opts.knownIDs);
  const containers = opts.containers ?? (await containerRefs(opts.repoRoot));
  const orphans: Orphan[] = [];

  for (const wt of await listWorktrees(opts.repoRoot)) {
    if (!isUnder(wt.path, opts.worktreeRoot)) continue; // never the user's checkout
    const id = wt.path.split(sep).pop() ?? wt.path;
    if (known.has(id)) continue;
    orphans.push({
      kind: "worktree",
      name: wt.path,
      workerID: id,
      merged: wt.head ? (await containedWhere(opts.repoRoot, wt.head, containers)) !== undefined : false,
    });
  }

  const branches = await gitLine(opts.repoRoot, ["for-each-ref", "--format=%(refname:short) %(objectname)", "refs/heads/worker"]);
  for (const line of branches.split("\n").filter((l) => l.trim() !== "")) {
    const [name, sha] = line.trim().split(" ");
    if (!name || !sha) continue;
    const id = name.slice("worker/".length);
    if (known.has(id)) continue;
    orphans.push({
      kind: "branch",
      name,
      workerID: id,
      merged: (await containedWhere(opts.repoRoot, sha, containers)) !== undefined,
    });
  }

  return orphans.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
}

// ---------------------------------------------------------------------------

export interface WorktreeEntry {
  readonly path: string;
  readonly head?: string;
  readonly branch?: string;
}

/** Every worktree git knows about, the main one included (and then filtered out). */
export async function listWorktrees(repoRoot: string): Promise<WorktreeEntry[]> {
  const out = await git(repoRoot, ["worktree", "list", "--porcelain"]);
  const entries: WorktreeEntry[] = [];
  let current: { path?: string; head?: string; branch?: string } = {};
  const flush = (): void => {
    if (current.path) {
      entries.push({
        path: current.path,
        ...(current.head === undefined ? {} : { head: current.head }),
        ...(current.branch === undefined ? {} : { branch: current.branch }),
      });
    }
    current = {};
  };
  for (const line of out.stdout.split("\n")) {
    if (line.startsWith("worktree ")) {
      flush();
      current.path = line.slice("worktree ".length).trim();
    } else if (line.startsWith("HEAD ")) current.head = line.slice("HEAD ".length).trim();
    else if (line.startsWith("branch ")) current.branch = line.slice("branch refs/heads/".length).trim();
  }
  flush();
  return entries;
}

/**
 * The refs a branch is allowed to already be inside of.
 *
 * The repository's HEAD, plus every integration branch a merge has produced.
 * "Merged" has to mean *merged into something that outlives this cleanup*, and
 * an integration branch is exactly that — the deliverable of §6.3.
 */
export async function containerRefs(repoRoot: string): Promise<string[]> {
  const refs: string[] = [];
  const head = await gitLine(repoRoot, ["rev-parse", "--verify", "--quiet", "HEAD"], { allowFailure: true });
  if (head) refs.push("HEAD");
  const integration = await gitLine(repoRoot, ["for-each-ref", "--format=%(refname:short)", "refs/heads/integration"]);
  refs.push(...integration.split("\n").map((l) => l.trim()).filter(Boolean));
  return refs;
}

/** The first container `sha` is an ancestor of, or `undefined` if it is in none. */
async function containedWhere(repoRoot: string, sha: string, containers: readonly string[]): Promise<string | undefined> {
  for (const ref of containers) {
    const r = await git(repoRoot, ["merge-base", "--is-ancestor", sha, ref], { allowFailure: true });
    if (r.code === 0) return ref;
  }
  return undefined;
}

/**
 * Remove a worktree, refusing anything that is not ours.
 *
 * The path check is the whole safety property and it is done here rather than at
 * a call site, because there is exactly one function that can delete a directory
 * and it should be the one that knows which directories are deletable. A path
 * outside the orchestrator's worktree root — the user's checkout above all — is
 * left alone and reported as not removed.
 */
async function removeWorktree(repoRoot: string, path: string, worktreeRoot: string): Promise<boolean> {
  const target = resolve(path);
  if (!isUnder(target, worktreeRoot) && !target.includes(`${sep}${ORCHESTRATOR_DIR}${sep}`)) return false;
  await git(repoRoot, ["worktree", "remove", "--force", target], { allowFailure: true });
  if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  await git(repoRoot, ["worktree", "prune"], { allowFailure: true });
  return !existsSync(target);
}

function isUnder(path: string, root: string): boolean {
  const p = resolve(path);
  const r = resolve(root);
  return p === r || p.startsWith(r.endsWith(sep) ? r : `${r}${sep}`);
}
