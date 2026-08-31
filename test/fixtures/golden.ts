/**
 * The golden repo (`projectplan.md` §12), materialized.
 *
 * The fixture lives in `golden/` as ordinary files; this module copies it into a
 * temp directory and makes it a git repository with one commit. Copying rather
 * than using it in place is not fussiness — the lifecycle tests create
 * worktrees, commit into them and leave branches behind, and doing that inside
 * the orchestrator's own checkout would be indistinguishable from a bug.
 *
 * `breakGoldenRepo` is the "make them fail on demand" half of §12: the
 * reconciliation tests need a suite that fails for a real reason, not a stubbed
 * exit code.
 */

import { cpSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const FIXTURE = new URL("./golden/", import.meta.url).pathname;

export interface GoldenRepo {
  /** Absolute path to the repository root. */
  readonly path: string;
  /** The sha of the single initial commit. */
  readonly baseSha: string;
  /** Remove the whole temp tree, worktrees included. */
  readonly cleanup: () => void;
}

/** The command the fixture's own `package.json` exposes. */
export const GOLDEN_TEST_COMMAND = "npm test";

/**
 * A temp directory under its *canonical* path.
 *
 * `tmpdir()` on macOS is `/var/folders/...`, and `/var` is a symlink to
 * `/private/var`; on Linux it is already canonical and this is a no-op. It
 * matters because the code under test does not invent repository paths, it asks
 * git for them — `rev-parse --show-toplevel` and `worktree list --porcelain`
 * both answer with the resolved path. A fixture that hands out the unresolved
 * one makes every comparison against git's output fail on macOS and pass on
 * Linux, which is a property of the fixture rather than of the orchestrator.
 *
 * Resolved once here rather than at each comparison, because the alternative is
 * remembering to do it at every assertion for as long as the suite exists.
 */
function mkdtempReal(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), `${prefix}-`)));
}

export function makeGoldenRepo(prefix = "golden"): GoldenRepo {
  const path = mkdtempReal(prefix);
  cpSync(FIXTURE, path, { recursive: true });
  return { path, baseSha: initRepo(path), cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

/**
 * An empty git repository, for the tests that only need somewhere to branch.
 *
 * One commit, because `git worktree add <sha>` needs a commit to point at and a
 * repository with no HEAD fails in a way that has nothing to teach anyone.
 */
export function makeEmptyRepo(prefix = "repo"): GoldenRepo {
  const path = mkdtempReal(prefix);
  writeFileSync(join(path, "README.md"), "# scratch\n");
  return { path, baseSha: initRepo(path), cleanup: () => rmSync(path, { recursive: true, force: true }) };
}

/**
 * Make `npm test` fail, for real.
 *
 * `sum` starts returning one too many, so two of the three test cases fail on
 * their assertions — the same shape of failure a bad worker produces, rather
 * than a syntax error that would fail before the suite ran.
 */
export function breakGoldenRepo(repo: string): void {
  writeFileSync(
    join(repo, "src", "stats.js"),
    `export function sum(values) {
  let total = 1; // deliberately wrong: the fixture's break switch
  for (const v of values) total += v;
  return total;
}

export function mean(values) {
  if (values.length === 0) throw new RangeError("mean of an empty list is undefined");
  return sum(values) / values.length;
}

export function median(values) {
  if (values.length === 0) throw new RangeError("median of an empty list is undefined");
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
`,
  );
}

function initRepo(path: string): string {
  const run = (...args: string[]): string =>
    execFileSync("git", ["-c", "user.name=fixture", "-c", "user.email=fixture@localhost", "-c", "commit.gpgsign=false", ...args], {
      cwd: path,
      encoding: "utf8",
    }).trim();
  run("init", "-q", "-b", "main");
  run("add", "-A");
  run("commit", "-q", "-m", "initial");
  return run("rev-parse", "HEAD");
}
