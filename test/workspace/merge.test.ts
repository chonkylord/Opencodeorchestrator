/**
 * The gated merge (§6.3, DD-6) and §11 Phase 4's acceptance criteria.
 *
 * Every test here runs against a **real git repository** — `makeGoldenRepo()`
 * materializes the §12 fixture into a temp directory with a real commit, real
 * worktrees and a real `npm test` that really fails when `breakGoldenRepo()`
 * breaks it. A merge suite against stubs would pass while the merge was wrong,
 * because everything interesting in this pipeline is a git behaviour: what
 * conflicts, what `reset --hard` restores, what a worktree shares with its
 * parent.
 *
 * The assertions are on **shas**, never on "it did not throw". A rollback that
 * throws nothing and restores nothing is the exact failure this phase exists to
 * prevent, and it is invisible to a test that only checks for an exception.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { GOLDEN_TEST_COMMAND, breakGoldenRepo, makeGoldenRepo } from "../fixtures/golden.js";
import { git, gitLine } from "../../src/workspace/git.js";
import { createWorktree, snapshotCommit } from "../../src/workspace/worktree.js";
import { type MergeCandidate, runMerge } from "../../src/workspace/merge.js";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) {
    try {
      fn();
    } catch {
      /* a temp dir that will not delete is not a test failure */
    }
  }
});

function repo(): string {
  const r = makeGoldenRepo("merge");
  cleanup.push(r.cleanup);
  return r.path;
}

/**
 * A worker, without a worker: a worktree, some edits, and DD-5's snapshot.
 *
 * The manager is not involved on purpose. What is under test is the git
 * pipeline, and driving it through a whole worker lifecycle would make every
 * failure here ambiguous between a merge bug and a lifecycle bug.
 */
async function worker(repoRoot: string, id: string, edits: Record<string, string>): Promise<MergeCandidate> {
  const wt = await createWorktree({ repoRoot, workerID: id });
  for (const [file, content] of Object.entries(edits)) writeFileSync(join(wt.path, file), content);
  const snap = await snapshotCommit(wt.path, `worker ${id}`);
  return {
    workerID: id,
    branch: wt.branch,
    baseSha: wt.baseSha,
    ...(snap.committed && snap.sha ? { sha: snap.sha } : {}),
  };
}

const shaOf = (repoRoot: string, ref: string): Promise<string> => gitLine(repoRoot, ["rev-parse", ref]);

// ---------------------------------------------------------------------------

describe("the gated merge (§6.3)", () => {
  test("two workers on disjoint files merge green — §11 Phase 4 AC", async () => {
    const root = repo();
    const a = await worker(root, "w-001", { "alpha.txt": "alpha\n" });
    const b = await worker(root, "w-002", { "beta.txt": "beta\n" });

    const outcome = await runMerge({
      mergeID: "m-001",
      repoRoot: root,
      candidates: [a, b],
      testCommand: GOLDEN_TEST_COMMAND,
    });

    expect(outcome.state).toBe("succeeded");
    expect(outcome.merged).toEqual(["w-001", "w-002"]);
    expect(outcome.rolledBack).toBe(false);
    expect(outcome.steps.map((s) => s.outcome)).toEqual(["merged", "merged"]);
    // The gate ran after *each* merge, not once at the end (DD-6).
    expect(outcome.steps.every((s) => s.tests?.passed === true)).toBe(true);

    // Both workers' files are genuinely on the branch, and the branch moved.
    expect(outcome.headSha).not.toBe(outcome.baseSha);
    const tree = await gitLine(root, ["ls-tree", "-r", "--name-only", outcome.integrationBranch]);
    expect(tree.split("\n")).toContain("alpha.txt");
    expect(tree.split("\n")).toContain("beta.txt");
  });

  test("a seeded conflicting merge is detected and rolled back, bit-identical — AC", async () => {
    const root = repo();
    // Both workers rewrite the same region of the same file. Git cannot pick.
    const a = await worker(root, "w-001", { "src/stats.js": "export const sum = () => 1;\n" });
    const b = await worker(root, "w-002", { "src/stats.js": "export const sum = () => 2;\n" });

    const outcome = await runMerge({ mergeID: "m-002", repoRoot: root, candidates: [a, b] });

    expect(outcome.state).toBe("failed");
    expect(outcome.rolledBack).toBe(true);
    expect(outcome.merged).toEqual(["w-001"]);
    const [first, second] = outcome.steps;
    expect(first?.outcome).toBe("merged");
    expect(second?.outcome).toBe("conflict");
    expect(second?.conflicts).toEqual(["src/stats.js"]);

    // The assertion that matters: the branch is *exactly* where it was before
    // the failing step, not merely "not broken".
    expect(second?.shaAfter).toBe(second!.shaBefore);
    expect(await shaOf(root, outcome.integrationBranch)).toBe(first!.shaAfter);
    // And the first worker's content survived the second's rollback intact.
    const kept = await gitLine(root, ["show", `${outcome.integrationBranch}:src/stats.js`]);
    expect(kept).toBe("export const sum = () => 1;");
  });

  test("a failed test gate restores the pre-merge state — AC", async () => {
    const root = repo();
    const good = await worker(root, "w-001", { "alpha.txt": "alpha\n" });
    // Not a stubbed exit code: `breakGoldenRepo` makes `sum` return one too
    // many, so two of the fixture's three cases fail on their assertions.
    const wt = await createWorktree({ repoRoot: root, workerID: "w-002" });
    breakGoldenRepo(wt.path);
    const snap = await snapshotCommit(wt.path, "worker w-002");
    const bad: MergeCandidate = { workerID: "w-002", branch: wt.branch, baseSha: wt.baseSha, sha: snap.sha! };

    const outcome = await runMerge({
      mergeID: "m-003",
      repoRoot: root,
      candidates: [good, bad],
      testCommand: GOLDEN_TEST_COMMAND,
    });

    expect(outcome.state).toBe("failed");
    const [first, second] = outcome.steps;
    expect(second?.outcome).toBe("test_failed");
    expect(second?.tests?.passed).toBe(false);
    // §13's flaky mitigation: a red suite is re-run once before it is believed.
    expect(second?.tests?.reran).toBe(true);
    expect(second?.shaAfter).toBe(second!.shaBefore);
    expect(await shaOf(root, outcome.integrationBranch)).toBe(first!.shaAfter);

    // The broken file is not on the branch — the merge was undone, not just
    // marked failed.
    const stats = await gitLine(root, ["show", `${outcome.integrationBranch}:src/stats.js`]);
    expect(stats).not.toContain("let total = 1;");
  }, 30_000);

  test("the user's checkout is untouched by a whole merge cycle", async () => {
    const root = repo();
    // A human's working tree: a dirty tracked file and an untracked scratch file.
    writeFileSync(join(root, "src", "stats.js"), `${readFileSync(join(root, "src", "stats.js"), "utf8")}// mine\n`);
    writeFileSync(join(root, "scratch.txt"), "do not touch\n");
    const beforeStatus = await gitLine(root, ["status", "--porcelain"]);
    const beforeHead = await shaOf(root, "HEAD");
    const beforeBranch = await gitLine(root, ["rev-parse", "--abbrev-ref", "HEAD"]);

    const a = await worker(root, "w-001", { "alpha.txt": "alpha\n" });
    const b = await worker(root, "w-002", { "src/stats.js": "export const sum = () => 1;\n" });
    // This one conflicts, so the rollback path runs too — `git reset --hard` is
    // the operation that would destroy the dirt above if it ran in the wrong cwd.
    const outcome = await runMerge({ mergeID: "m-004", repoRoot: root, candidates: [b, a] });
    expect(outcome.steps.some((s) => s.outcome === "merged")).toBe(true);

    expect(await gitLine(root, ["status", "--porcelain"])).toBe(beforeStatus);
    expect(await shaOf(root, "HEAD")).toBe(beforeHead);
    expect(await gitLine(root, ["rev-parse", "--abbrev-ref", "HEAD"])).toBe(beforeBranch);
    expect(readFileSync(join(root, "src", "stats.js"), "utf8")).toContain("// mine");
    expect(readFileSync(join(root, "scratch.txt"), "utf8")).toBe("do not touch\n");
  });

  test("a completed worker that committed nothing is an outcome, not a crash", async () => {
    const root = repo();
    // No edits at all: `snapshotCommit` returns {committed: false} and the
    // candidate carries no sha. This is the null-dereference trap.
    const empty = await worker(root, "w-001", {});
    expect(empty.sha).toBeUndefined();
    const real = await worker(root, "w-002", { "beta.txt": "beta\n" });

    const outcome = await runMerge({ mergeID: "m-005", repoRoot: root, candidates: [empty, real] });

    expect(outcome.state).toBe("succeeded");
    expect(outcome.steps[0]?.outcome).toBe("nothing_to_merge");
    expect(outcome.steps[0]?.detail).toContain("committed nothing");
    expect(outcome.merged).toEqual(["w-002"]);
  });

  test("an ungated merge says so, and still merges", async () => {
    const root = repo();
    const a = await worker(root, "w-001", { "alpha.txt": "alpha\n" });
    const outcome = await runMerge({ mergeID: "m-006", repoRoot: root, candidates: [a] });
    expect(outcome.state).toBe("succeeded");
    expect(outcome.testCommand).toBeUndefined();
    expect(outcome.steps[0]?.detail).toContain("without a gate");
  });

  test("the pipeline stops at the first failure and says the rest were skipped", async () => {
    const root = repo();
    const a = await worker(root, "w-001", { "src/stats.js": "export const sum = () => 1;\n" });
    const b = await worker(root, "w-002", { "src/stats.js": "export const sum = () => 2;\n" });
    const c = await worker(root, "w-003", { "gamma.txt": "gamma\n" });

    const outcome = await runMerge({ mergeID: "m-007", repoRoot: root, candidates: [a, b, c] });
    expect(outcome.steps.map((s) => s.outcome)).toEqual(["merged", "conflict", "skipped"]);
    // continueOnFailure gets past it, and the last worker still merges.
    const again = await runMerge({ mergeID: "m-008", repoRoot: root, candidates: [a, b, c], continueOnFailure: true });
    expect(again.steps.map((s) => s.outcome)).toEqual(["merged", "conflict", "merged"]);
    expect(again.merged).toEqual(["w-001", "w-003"]);
  });

  test("the integration worktree is cleaned up; the branch it made is not", async () => {
    const root = repo();
    const a = await worker(root, "w-001", { "alpha.txt": "alpha\n" });
    const outcome = await runMerge({ mergeID: "m-009", repoRoot: root, candidates: [a] });

    expect(existsSync(join(root, ".dispatched-code", "integration", "m-009"))).toBe(false);
    // The branch is the deliverable and it survives the scaffolding.
    expect(await shaOf(root, outcome.integrationBranch)).toBe(outcome.headSha);
    // And git agrees the worktree is gone, rather than merely the directory.
    const worktrees = await gitLine(root, ["worktree", "list", "--porcelain"]);
    expect(worktrees).not.toContain("m-009");
  });

  test("`.dispatched-code/` never enters a merge commit", async () => {
    const root = repo();
    const a = await worker(root, "w-001", { "alpha.txt": "alpha\n" });
    const outcome = await runMerge({ mergeID: "m-010", repoRoot: root, candidates: [a] });
    const tree = await gitLine(root, ["ls-tree", "-r", "--name-only", outcome.integrationBranch]);
    expect(tree).not.toContain(".dispatched-code");
  });

  test("candidates from different bases are reported rather than silently merged", async () => {
    const root = repo();
    const a = await worker(root, "w-001", { "alpha.txt": "alpha\n" });
    // Move the repo on, then branch a second worker from the new HEAD.
    writeFileSync(join(root, "moved.txt"), "moved\n");
    await git(root, ["add", "-A"]);
    await git(root, ["commit", "-q", "-m", "somebody else's commit"]);
    const b = await worker(root, "w-002", { "beta.txt": "beta\n" });
    expect(a.baseSha).not.toBe(b.baseSha);

    const outcome = await runMerge({ mergeID: "m-011", repoRoot: root, candidates: [a, b] });
    expect(outcome.baseMismatch).toHaveLength(2);
    expect(outcome.state).toBe("succeeded");
  });
});
