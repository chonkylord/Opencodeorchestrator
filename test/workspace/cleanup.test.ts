/**
 * Cleanup (§6.3 step 4, §9's orphan scan).
 *
 * One property is worth more than all the others put together and most of this
 * file is about it: **cleanup must not be able to destroy unmerged work.** DD-7
 * says the worktrees are the durable state and the database is an index, so a
 * prune that deletes an unmerged `worker/*` branch has deleted the only copy of
 * what a worker produced — and it will do it silently, because a branch delete
 * succeeds whether or not anyone wanted the commits.
 *
 * So: a merged branch is pruned, an unmerged one is kept with a reason, `force`
 * is what it takes to override that, and the user's own checkout is never a
 * candidate for removal at all.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { makeGoldenRepo } from "../fixtures/golden.js";
import { git, gitLine } from "../../src/workspace/git.js";
import { createWorktree, defaultWorktreeRoot, snapshotCommit } from "../../src/workspace/worktree.js";
import { cleanupWorkspace, listWorktrees, scanOrphans } from "../../src/workspace/cleanup.js";
import { runMerge } from "../../src/workspace/merge.js";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) {
    try {
      fn();
    } catch {
      /* ignore */
    }
  }
});

function repo(): string {
  const r = makeGoldenRepo("cleanup");
  cleanup.push(r.cleanup);
  return r.path;
}

async function worker(repoRoot: string, id: string, file: string) {
  const wt = await createWorktree({ repoRoot, workerID: id });
  writeFileSync(join(wt.path, file), `${file}\n`);
  const snap = await snapshotCommit(wt.path, `worker ${id}`);
  return { workerID: id, worktree: wt.path, branch: wt.branch, baseSha: wt.baseSha, sha: snap.sha };
}

const branchExists = async (root: string, branch: string): Promise<boolean> =>
  (await gitLine(root, ["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], { allowFailure: true })) !== "";

// ---------------------------------------------------------------------------

describe("pruning", () => {
  test("a merged worker's worktree and branch both go", async () => {
    const root = repo();
    const w = await worker(root, "w-001", "alpha.txt");
    await runMerge({
      mergeID: "m-001",
      repoRoot: root,
      candidates: [{ workerID: w.workerID, branch: w.branch, baseSha: w.baseSha, sha: w.sha! }],
    });

    const report = await cleanupWorkspace({
      repoRoot: root,
      candidates: [{ workerID: w.workerID, worktree: w.worktree, branch: w.branch, state: "merged" }],
    });

    expect(report.pruned[0]?.worktreeRemoved).toBe(true);
    expect(report.pruned[0]?.branchDeleted).toBe(true);
    expect(report.pruned[0]?.containedIn).toBe("integration/m-001");
    expect(existsSync(w.worktree)).toBe(false);
    expect(await branchExists(root, w.branch)).toBe(false);
  });

  test("an UNMERGED branch is kept, and its worktree is still reclaimed", async () => {
    const root = repo();
    const w = await worker(root, "w-001", "alpha.txt");

    const report = await cleanupWorkspace({
      repoRoot: root,
      candidates: [{ workerID: w.workerID, worktree: w.worktree, branch: w.branch, state: "completed" }],
    });

    expect(report.pruned[0]?.branchDeleted).toBe(false);
    expect(report.pruned[0]?.kept).toContain("unmerged");
    // The branch is the only copy of the work; the directory is not.
    expect(await branchExists(root, w.branch)).toBe(true);
    expect(report.pruned[0]?.worktreeRemoved).toBe(true);
    // And the commit is still reachable from the branch that survived.
    expect(await gitLine(root, ["rev-parse", w.branch])).toBe(w.sha!);
  });

  test("`force` deletes unmerged work, which is what it is for", async () => {
    const root = repo();
    const w = await worker(root, "w-001", "alpha.txt");
    const report = await cleanupWorkspace({
      repoRoot: root,
      candidates: [{ workerID: w.workerID, worktree: w.worktree, branch: w.branch, state: "completed" }],
      force: true,
    });
    expect(report.forced).toBe(true);
    expect(report.pruned[0]?.branchDeleted).toBe(true);
    expect(await branchExists(root, w.branch)).toBe(false);
  });

  test("the user's checkout is never removable, whatever it is handed", async () => {
    const root = repo();
    // A candidate pointing at the repository itself — the worst thing a caller
    // could ask for, and the one the path guard exists to refuse.
    const report = await cleanupWorkspace({
      repoRoot: root,
      candidates: [{ workerID: "w-bogus", worktree: root, branch: "main", state: "completed" }],
      force: true,
      scan: false,
    });
    expect(report.pruned[0]?.worktreeRemoved).toBe(false);
    expect(existsSync(join(root, "package.json"))).toBe(true);
  });

  test("a worker whose branch is already gone is reported, not an error", async () => {
    const root = repo();
    const report = await cleanupWorkspace({
      repoRoot: root,
      candidates: [{ workerID: "w-404", worktree: "", branch: "worker/w-404" }],
      scan: false,
    });
    expect(report.pruned[0]?.kept).toContain("does not exist");
    expect(report.pruned[0]?.error).toBeUndefined();
  });
});

describe("the orphan scan (§9)", () => {
  test("finds worktrees and worker branches with no index row", async () => {
    const root = repo();
    await worker(root, "w-001", "alpha.txt");
    const orphans = await scanOrphans({
      repoRoot: root,
      worktreeRoot: defaultWorktreeRoot(root),
      knownIDs: [], // the index lost everything, as after a database loss
    });
    expect(orphans.filter((o) => o.kind === "worktree").map((o) => o.workerID)).toEqual(["w-001"]);
    expect(orphans.filter((o) => o.kind === "branch").map((o) => o.name)).toEqual(["worker/w-001"]);
    // Unmerged, so the report says so — which is what stops a caller pruning it.
    expect(orphans.every((o) => o.merged === false)).toBe(true);
  });

  test("a known worker is not an orphan", async () => {
    const root = repo();
    await worker(root, "w-001", "alpha.txt");
    const orphans = await scanOrphans({
      repoRoot: root,
      worktreeRoot: defaultWorktreeRoot(root),
      knownIDs: ["w-001"],
    });
    expect(orphans).toEqual([]);
  });

  test("the scan reports; it never prunes on its own", async () => {
    const root = repo();
    const w = await worker(root, "w-001", "alpha.txt");
    const report = await cleanupWorkspace({ repoRoot: root, candidates: [], knownIDs: [] });
    expect(report.orphans.length).toBe(2);
    // Nothing was touched: the safe half of "report or prune" is the default.
    expect(existsSync(w.worktree)).toBe(true);
    expect(await branchExists(root, w.branch)).toBe(true);
  });

  test("pruneOrphans still refuses unmerged ones without force", async () => {
    const root = repo();
    const w = await worker(root, "w-001", "alpha.txt");
    await cleanupWorkspace({ repoRoot: root, candidates: [], knownIDs: [], pruneOrphans: true });
    expect(await branchExists(root, w.branch)).toBe(true);

    await cleanupWorkspace({ repoRoot: root, candidates: [], knownIDs: [], pruneOrphans: true, force: true });
    expect(await branchExists(root, w.branch)).toBe(false);
  });

  test("the main worktree is not in the orphan list", async () => {
    const root = repo();
    const all = await listWorktrees(root);
    expect(all.map((w) => w.path)).toContain(await gitLine(root, ["rev-parse", "--show-toplevel"]));
    const orphans = await scanOrphans({ repoRoot: root, worktreeRoot: defaultWorktreeRoot(root), knownIDs: [] });
    expect(orphans.filter((o) => o.kind === "worktree")).toEqual([]);
  });

  test("a branch merged into HEAD counts as contained", async () => {
    const root = repo();
    const w = await worker(root, "w-001", "alpha.txt");
    // Land it the way a human would, on the checked-out branch.
    await git(root, ["merge", "--no-ff", "--no-edit", "-m", "land w-001", w.sha!]);
    const orphans = await scanOrphans({ repoRoot: root, worktreeRoot: defaultWorktreeRoot(root), knownIDs: [] });
    expect(orphans.find((o) => o.kind === "branch")?.merged).toBe(true);
  });
});
