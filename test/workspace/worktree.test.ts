/**
 * Worktree plumbing against real git repositories.
 *
 * Everything here runs on a temp clone of the golden repo, because the failures
 * worth catching — a snapshot that commits the orchestrator's own scratch, a
 * diff that misses an untracked file — only appear against real git.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  changedFiles,
  createWorktree,
  diffStat,
  listManifests,
  readManifest,
  readReportFile,
  resolveRepoRoot,
  resolveSha,
  runTestCommand,
  snapshotCommit,
  writeManifest,
} from "../../src/workspace/index.js";
import { GOLDEN_TEST_COMMAND, breakGoldenRepo, makeGoldenRepo } from "../fixtures/golden.js";
import type { WorkerManifest } from "../../src/manager/types.js";

const repos: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of repos.splice(0)) cleanup();
});

function golden() {
  const repo = makeGoldenRepo("wt");
  repos.push(repo.cleanup);
  return repo;
}

const manifest = (over: Partial<WorkerManifest> = {}): WorkerManifest => ({
  version: 1,
  workerID: "w-001",
  runID: "run-1",
  task: "do a thing",
  mode: "implement",
  model: "opencode/muse-spark-1.2-contributor-free",
  branch: "worker/w-001",
  baseSha: "0".repeat(40),
  createdAt: 1,
  spec: { task: "do a thing" },
  ...over,
});

describe("the golden repo fixture", () => {
  test("is a real npm project whose tests really pass", async () => {
    // §12's requirement, asserted rather than assumed: an integration test that
    // runs against a fixture with no working suite proves nothing.
    const repo = golden();
    const run = await runTestCommand(repo.path, GOLDEN_TEST_COMMAND);
    expect(run.passed).toBe(true);
    expect(run.output).toContain("pass 3");
  });

  test("fails on demand, on an assertion rather than a crash", async () => {
    const repo = golden();
    breakGoldenRepo(repo.path);
    const run = await runTestCommand(repo.path, GOLDEN_TEST_COMMAND);
    expect(run.passed).toBe(false);
    expect(run.exitCode).not.toBe(0);
    expect(run.output).toContain("fail 2");
  });
});

describe("createWorktree", () => {
  test("branches from a resolved sha and lands where §6.1 says", async () => {
    const repo = golden();
    const root = join(repo.path, ".orchestrator", "worktrees");
    const wt = await createWorktree({ repoRoot: repo.path, workerID: "w-001", root });

    expect(wt.path).toBe(join(root, "w-001"));
    expect(wt.branch).toBe("worker/w-001");
    expect(wt.baseSha).toBe(repo.baseSha);
    expect(existsSync(join(wt.path, "package.json"))).toBe(true);
    // A sha, not a ref: workers in one run must not drift onto different bases
    // because something moved the branch mid-run.
    expect(await resolveSha(wt.path, "HEAD")).toBe(repo.baseSha);
  });

  test("refuses to reuse an occupied path rather than clobbering work", async () => {
    const repo = golden();
    const root = join(repo.path, ".orchestrator", "worktrees");
    await createWorktree({ repoRoot: repo.path, workerID: "w-001", root });
    await expect(createWorktree({ repoRoot: repo.path, workerID: "w-001", root })).rejects.toThrow(/already exists/);
  });

  test("two workers get genuinely independent trees", async () => {
    const repo = golden();
    const root = join(repo.path, ".orchestrator", "worktrees");
    const a = await createWorktree({ repoRoot: repo.path, workerID: "w-001", root });
    const b = await createWorktree({ repoRoot: repo.path, workerID: "w-002", root });
    writeFileSync(join(a.path, "only-a.txt"), "a\n");
    expect(existsSync(join(b.path, "only-a.txt"))).toBe(false);
    expect(await changedFiles(b.path, b.baseSha)).toEqual([]);
  });

  test("resolveRepoRoot finds the root from inside a worktree", async () => {
    const repo = golden();
    const wt = await createWorktree({ repoRoot: repo.path, workerID: "w-001" });
    expect(await resolveRepoRoot(join(wt.path, "src"))).toBe(wt.path);
  });
});

describe("snapshotCommit (DD-5)", () => {
  test("commits whatever the worker left, tracked and untracked alike", async () => {
    const repo = golden();
    const wt = await createWorktree({ repoRoot: repo.path, workerID: "w-001" });
    writeFileSync(join(wt.path, "src", "stats.js"), `${readFileSync(join(wt.path, "src", "stats.js"), "utf8")}\n// edited\n`);
    writeFileSync(join(wt.path, "src", "new.js"), "export const x = 1;\n");

    const snap = await snapshotCommit(wt.path, "w-001: snapshot");
    expect(snap.committed).toBe(true);
    expect(snap.sha).toMatch(/^[0-9a-f]{40}$/);
    expect([...snap.files].sort()).toEqual(["src/new.js", "src/stats.js"]);
    // Post-snapshot the tree is clean: that is what makes the later diff and any
    // Phase 4 merge deterministic.
    expect(await changedFiles(wt.path, wt.baseSha)).toEqual(["src/new.js", "src/stats.js"]);
  });

  test("an untouched worktree produces no commit and says so", async () => {
    const repo = golden();
    const wt = await createWorktree({ repoRoot: repo.path, workerID: "w-001" });
    const snap = await snapshotCommit(wt.path, "nothing to see");
    expect(snap).toEqual({ committed: false, files: [] });
  });

  test("never commits the orchestrator's own scratch", async () => {
    // The manifest lives in the worktree so the worktree can say who it belongs
    // to (DD-7). If it landed in the commit it would be in every worker's diff,
    // in every reconciliation, forever.
    const repo = golden();
    const wt = await createWorktree({ repoRoot: repo.path, workerID: "w-001" });
    writeManifest(wt.path, manifest());
    writeFileSync(join(wt.path, "report.json"), '{"status":"completed","summary":"x","changes":[]}');
    writeFileSync(join(wt.path, "src", "new.js"), "export const x = 1;\n");

    const snap = await snapshotCommit(wt.path, "w-001: snapshot");
    expect(snap.files).toEqual(["src/new.js"]);
    expect(await changedFiles(wt.path, wt.baseSha)).toEqual(["src/new.js"]);
    // …and the manifest is still on disk, which is the whole point of it.
    expect(readManifest(wt.path)?.workerID).toBe("w-001");
    expect(readReportFile(wt.path)).toContain("completed");
  });
});

describe("changedFiles and diffStat", () => {
  test("see uncommitted work, so a killed worker is still measured", async () => {
    const repo = golden();
    const wt = await createWorktree({ repoRoot: repo.path, workerID: "w-001" });
    writeFileSync(join(wt.path, "src", "new.js"), "a\nb\nc\n");

    expect(await changedFiles(wt.path, wt.baseSha)).toEqual(["src/new.js"]);
    const stat = await diffStat(wt.path, wt.baseSha);
    expect(stat).toMatchObject({ files: 1, additions: 3, deletions: 0, paths: ["src/new.js"] });
  });

  test("count deletions and edits after a snapshot", async () => {
    const repo = golden();
    const wt = await createWorktree({ repoRoot: repo.path, workerID: "w-001" });
    rmSync(join(wt.path, "README.md"));
    writeFileSync(join(wt.path, "src", "stats.js"), "export const sum = () => 0;\n");
    await snapshotCommit(wt.path, "w-001: snapshot");

    const stat = await diffStat(wt.path, wt.baseSha);
    expect(stat.paths).toEqual(["README.md", "src/stats.js"]);
    expect(stat.deletions).toBeGreaterThan(0);
    expect(stat.additions).toBe(1);
  });

  test("an unmodified worktree is empty, not noisy", async () => {
    const repo = golden();
    const wt = await createWorktree({ repoRoot: repo.path, workerID: "w-001" });
    writeManifest(wt.path, manifest());
    expect(await changedFiles(wt.path, wt.baseSha)).toEqual([]);
    expect(await diffStat(wt.path, wt.baseSha)).toMatchObject({ files: 0, additions: 0, deletions: 0 });
  });
});

describe("manifests (DD-7)", () => {
  test("round-trip, and survive a snapshot", async () => {
    const repo = golden();
    const wt = await createWorktree({ repoRoot: repo.path, workerID: "w-001" });
    writeManifest(wt.path, manifest({ sessionID: "ses_123" }));
    expect(readManifest(wt.path)).toMatchObject({ workerID: "w-001", sessionID: "ses_123", branch: "worker/w-001" });
  });

  test("listManifests enumerates the worktrees a lost database would need", async () => {
    const repo = golden();
    const root = join(repo.path, ".orchestrator", "worktrees");
    for (const id of ["w-001", "w-002"]) {
      const wt = await createWorktree({ repoRoot: repo.path, workerID: id, root });
      writeManifest(wt.path, manifest({ workerID: id, branch: `worker/${id}` }));
    }
    mkdirSync(join(root, "not-a-worker"), { recursive: true });
    expect(listManifests(root).map((m) => m.workerID)).toEqual(["w-001", "w-002"]);
  });

  test("a corrupt manifest is ignored rather than crashing the scan", async () => {
    const repo = golden();
    const root = join(repo.path, ".orchestrator", "worktrees");
    const wt = await createWorktree({ repoRoot: repo.path, workerID: "w-001", root });
    mkdirSync(join(wt.path, ".orchestrator"), { recursive: true });
    writeFileSync(join(wt.path, ".orchestrator", "worker.json"), "{ not json");
    expect(readManifest(wt.path)).toBeNull();
    expect(listManifests(root)).toEqual([]);
  });
});
