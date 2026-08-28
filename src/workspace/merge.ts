/**
 * The gated merge pipeline (§6.3, DD-6).
 *
 * One idea runs through this whole file, and it is the reason the phase exists:
 * **a merge pipeline that half-fails is worse than no merge pipeline**, because
 * the thing it half-fails in is somebody's repository. So:
 *
 * **The merge never happens in the user's checkout.** `config.repoRoot` is a
 * real repository a human may have open, on a branch of their choosing, with
 * uncommitted work in it. `git merge` there is rude; `git reset --hard` there —
 * which is the rollback — destroys work the orchestrator never created and
 * cannot restore. So every operation below runs in a **dedicated integration
 * worktree** created for this merge under `.orchestrator/`, which is already in
 * `.git/info/exclude`. The user's branch, index and working tree are never
 * written to. Nothing in §6.3 says this, because §6.3 was drawn before there was
 * a repository to be careful about; see `docs/adr/0003-integration-worktree.md`.
 *
 * **A `completed` worker may have nothing to merge.** `snapshotCommit` returns
 * `{committed: false}` when the worker changed nothing, and a worker can finish,
 * report enthusiastically, and leave an empty branch. That is an *outcome*
 * (`nothing_to_merge`), reported like any other — not an error, and not a null
 * dereference on `result.snapshot.sha`.
 *
 * **Rollback is to a sha, and it is checked.** Every step records the integration
 * branch's sha before it runs. On a conflict or a red gate the worktree is reset
 * hard to that sha and cleaned of anything the failed merge left untracked, and
 * the resulting sha is recorded so a caller can assert on it rather than on "it
 * did not throw".
 *
 * **The test command comes from the brief, never from a worker's report (DD-8).**
 * `runTestCommand` is the one place in this system that runs a shell string;
 * where that string comes from is load-bearing. The caller passes it, having
 * taken it from `WorkerSpec.testCommand` — which is what Claude wrote when it
 * spawned the worker. `report.tests.command` is the worker talking and is only
 * ever compared, never executed.
 *
 * Sequential, one worker at a time, gate after each (DD-6). Not because parallel
 * merging is hard, but because a red gate has to name the worker that caused it,
 * and a batch merge cannot.
 */

import { existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { WorkspaceError, git, gitLine } from "./git.js";
import { type TestRun, runTestCommand } from "./verify.js";
import { ORCHESTRATOR_DIR, resolveRepoRoot, resolveSha } from "./worktree.js";

/** Where integration worktrees live, beside the workers' own. */
export function defaultIntegrationRoot(repoRoot: string): string {
  return join(repoRoot, ORCHESTRATOR_DIR, "integration");
}

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** One worker offered to the pipeline. Everything here is the manager's, not the worker's. */
export interface MergeCandidate {
  readonly workerID: string;
  /** `worker/<id>`, as `createWorktree` made it. */
  readonly branch: string;
  /** The sha this worker branched from. Compared against the others. */
  readonly baseSha: string;
  /** DD-5's snapshot commit, when there was one. Absent means "nothing committed". */
  readonly sha?: string;
}

export type StepOutcome =
  /** Merged cleanly and, if the gate ran, green. */
  | "merged"
  /** The branch adds nothing the integration branch does not already have. */
  | "nothing_to_merge"
  /** `git merge` could not do it. Rolled back. */
  | "conflict"
  /** Merged, then the test gate went red. Rolled back. */
  | "test_failed"
  /** An earlier step failed and the pipeline stopped before reaching this one. */
  | "skipped"
  /** Something went wrong that is not a conflict and not a red gate. Rolled back. */
  | "error";

export interface MergeStep {
  readonly workerID: string;
  readonly branch: string;
  readonly outcome: StepOutcome;
  /** The integration branch's sha before this step. The rollback target. */
  readonly shaBefore: string;
  /** Its sha after — equal to `shaBefore` for every non-`merged` outcome. */
  readonly shaAfter: string;
  /** Files git reported as conflicted, when it did. */
  readonly conflicts?: readonly string[];
  /** The gate's run. `reran` marks the §13 second attempt at a red suite. */
  readonly tests?: TestRun & { readonly reran: boolean };
  /** One line of human-readable why, safe to render. */
  readonly detail?: string;
}

export type MergeState = "running" | "succeeded" | "failed";

export interface MergeOutcome {
  readonly mergeID: string;
  readonly state: MergeState;
  readonly integrationBranch: string;
  /** The sha the integration branch started at. */
  readonly baseSha: string;
  /** Where it ended up. Equal to `baseSha` if nothing merged. */
  readonly headSha: string;
  readonly steps: readonly MergeStep[];
  /** Workers whose commits are in `headSha`. */
  readonly merged: readonly string[];
  /** True if any step had to reset the integration branch. */
  readonly rolledBack: boolean;
  readonly testCommand?: string;
  readonly startedAt: number;
  readonly endedAt?: number;
  /** Set when the candidates did not all branch from the same commit. */
  readonly baseMismatch?: readonly string[];
  /** A failure that stopped the pipeline before it could run at all. */
  readonly error?: string;
}

export interface MergeOptions {
  readonly mergeID: string;
  readonly repoRoot: string;
  readonly candidates: readonly MergeCandidate[];
  /** Defaults to `integration/<mergeID>`. */
  readonly integrationBranch?: string;
  /** Where the integration worktree goes. Defaults under `.orchestrator/`. */
  readonly integrationRoot?: string;
  /** Branch point. Defaults to the candidates' shared base sha. */
  readonly baseSha?: string;
  /**
   * The gate. From the brief (`WorkerSpec.testCommand`), never from a report.
   * Absent means no gate — every clean merge is accepted, which is a choice the
   * caller has to make deliberately.
   */
  readonly testCommand?: string;
  readonly testTimeoutMs?: number;
  /**
   * Keep merging after a step fails.
   *
   * Off by default. §6.3 step 2 says a red gate is surfaced to Claude with
   * options, and continuing past it turns one legible failure into a pile of
   * them — plus the workers after a conflicted one are the most likely to
   * conflict too.
   */
  readonly continueOnFailure?: boolean;
  /** Keep the integration worktree on disk afterwards. Off by default. */
  readonly keepWorktree?: boolean;
  readonly now?: () => number;
  /** Progress, for a caller persisting the merge as it runs. */
  readonly onStep?: (step: MergeStep) => void;
  /** Diagnostics. Never stdout — that is the JSON-RPC channel. */
  readonly log?: (line: string) => void;
}

// ---------------------------------------------------------------------------
// The pipeline
// ---------------------------------------------------------------------------

/**
 * Merge every candidate into a fresh integration branch, gating after each.
 *
 * Returns rather than throws for every outcome the pipeline is *for* — a
 * conflict, a red gate, a worker with nothing to merge. It throws only when it
 * could not establish an integration worktree at all, because at that point
 * there is nothing to report about and nothing has been touched.
 */
export async function runMerge(opts: MergeOptions): Promise<MergeOutcome> {
  const now = opts.now ?? Date.now;
  const startedAt = now();
  const log = opts.log ?? (() => {});
  const repoRoot = await resolveRepoRoot(opts.repoRoot);
  const branch = opts.integrationBranch ?? `integration/${opts.mergeID}`;

  const bases = [...new Set(opts.candidates.map((c) => c.baseSha).filter((s) => s !== ""))];
  const baseSha = opts.baseSha
    ? await resolveSha(repoRoot, opts.baseSha)
    : bases.length === 1
      ? bases[0]!
      : await resolveSha(repoRoot, "HEAD");

  const root = opts.integrationRoot ? resolve(opts.integrationRoot) : defaultIntegrationRoot(repoRoot);
  const path = join(root, opts.mergeID);
  if (existsSync(path)) {
    throw new WorkspaceError("config", `integration worktree path already exists: ${path}`, { mergeID: opts.mergeID });
  }
  mkdirSync(dirname(path), { recursive: true });
  await git(repoRoot, ["worktree", "add", "--quiet", path, "-b", branch, baseSha]);
  log(`merge ${opts.mergeID}: integration worktree ${path} on ${branch} at ${baseSha.slice(0, 8)}`);

  const steps: MergeStep[] = [];
  const merged: string[] = [];
  let rolledBack = false;
  let stopped = false;

  try {
    for (const candidate of opts.candidates) {
      if (stopped) {
        steps.push(record(opts, skipped(candidate, await head(path))));
        continue;
      }
      // A git failure that is neither a conflict nor a red gate — a corrupt
      // ref, a full disk — still has to leave the branch where it was and still
      // has to leave the steps already recorded intact. Losing the fact that
      // w-001 merged because w-002 hit an I/O error would make the outcome
      // unreadable, and the rollback below is the same one every other failure
      // path takes.
      // Read before, not in the catch: by the time something throws, HEAD may
      // already be past the merge, and rolling back to *that* is a no-op with
      // the shape of a rollback.
      const before = await head(path);
      let step: MergeStep;
      try {
        step = await mergeOne(path, candidate, opts);
      } catch (e) {
        await rollback(path, before).catch(() => undefined);
        step = {
          workerID: candidate.workerID,
          branch: candidate.branch,
          outcome: "error",
          shaBefore: before,
          shaAfter: await head(path).catch(() => before),
          detail: `git failed unexpectedly: ${e instanceof Error ? e.message : String(e)}`.slice(0, 400),
        };
      }
      steps.push(record(opts, step));
      if (step.outcome === "merged") merged.push(candidate.workerID);
      if (step.outcome === "conflict" || step.outcome === "test_failed" || step.outcome === "error") {
        rolledBack = true;
        if (!opts.continueOnFailure) stopped = true;
      }
    }

    const headSha = await head(path);
    const failed = steps.some((s) => s.outcome === "conflict" || s.outcome === "test_failed" || s.outcome === "error");
    return {
      mergeID: opts.mergeID,
      state: failed ? "failed" : "succeeded",
      integrationBranch: branch,
      baseSha,
      headSha,
      steps,
      merged,
      rolledBack,
      ...(opts.testCommand === undefined ? {} : { testCommand: opts.testCommand }),
      startedAt,
      endedAt: now(),
      ...(bases.length > 1 ? { baseMismatch: bases.sort() } : {}),
    };
  } finally {
    // The branch is the deliverable and it survives this; the worktree is
    // scaffolding. Removing it is what keeps a repository from accumulating one
    // checkout per merge, and `--force` is safe here precisely because nothing
    // in this directory was ever the user's.
    if (!opts.keepWorktree) {
      await git(repoRoot, ["worktree", "remove", "--force", path], { allowFailure: true }).catch(() => undefined);
      rmSync(path, { recursive: true, force: true });
      await git(repoRoot, ["worktree", "prune"], { allowFailure: true }).catch(() => undefined);
    }
  }
}

/**
 * One candidate: merge, gate, and roll back if either fails.
 *
 * The whole function is written so that every early return has already restored
 * `shaBefore`. There is no path out of here that leaves the integration branch
 * on a commit nobody asked for.
 */
async function mergeOne(path: string, candidate: MergeCandidate, opts: MergeOptions): Promise<MergeStep> {
  const shaBefore = await head(path);
  const base = { workerID: candidate.workerID, branch: candidate.branch, shaBefore };

  // What are we actually merging? The branch, resolved now — a worker's snapshot
  // sha is what it committed, but the branch is what its work lives on, and the
  // two differ if anything moved the branch since.
  const ref = candidate.branch;
  const tip = await gitLine(path, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { allowFailure: true });
  if (!tip) {
    return { ...base, outcome: "nothing_to_merge", shaAfter: shaBefore, detail: `branch ${ref} does not exist` };
  }

  // "Already contained" covers both the worker that committed nothing (its
  // branch is still at the base) and the one whose work another merge brought
  // in. Neither is an error and both must be said out loud, because a worker
  // that produced nothing while reporting success is exactly the case DD-4
  // exists for.
  const contained = await git(path, ["merge-base", "--is-ancestor", tip, "HEAD"], { allowFailure: true });
  if (contained.code === 0) {
    return {
      ...base,
      outcome: "nothing_to_merge",
      shaAfter: shaBefore,
      detail: candidate.sha ? "already contained in the integration branch" : "the worker committed nothing",
    };
  }

  const merge = await git(
    path,
    ["merge", "--no-ff", "--no-verify", "--no-gpg-sign", "-m", `merge ${candidate.workerID} (${ref})`, tip],
    { allowFailure: true },
  );
  if (merge.code !== 0) {
    const conflicts = await conflictedFiles(path);
    await rollback(path, shaBefore);
    return {
      ...base,
      outcome: "conflict",
      shaAfter: await head(path),
      conflicts,
      detail:
        conflicts.length > 0
          ? `git could not merge ${conflicts.length} file(s)`
          : `git merge failed: ${firstLine(merge.stderr || merge.stdout)}`,
    };
  }

  const shaAfter = await head(path);
  if (!opts.testCommand) {
    return { ...base, outcome: "merged", shaAfter, detail: "no test command; merged without a gate" };
  }

  const gate = await gateTests(path, opts.testCommand, opts.testTimeoutMs);
  if (gate.passed) return { ...base, outcome: "merged", shaAfter, tests: gate };

  await rollback(path, shaBefore);
  const rolledTo = await head(path);
  return {
    ...base,
    outcome: "test_failed",
    shaAfter: rolledTo,
    tests: gate,
    detail:
      `the test gate went red after merging ${candidate.workerID}` +
      `${gate.reran ? " (re-run once, red both times)" : ""}; rolled back to ${rolledTo.slice(0, 8)}`,
  };
}

/**
 * The gate, with §13's flaky-test mitigation.
 *
 * A suite that fails once is re-run exactly once before the merge is declared
 * red. Once, not "until it passes": a gate that retries indefinitely is not a
 * gate, and a test that only passes on the third try is a finding, not a pass.
 * The re-run is skipped when the command could not be run at all — a missing
 * binary is not flaky.
 */
async function gateTests(cwd: string, command: string, timeoutMs?: number): Promise<TestRun & { reran: boolean }> {
  const first = await runTestCommand(cwd, command, timeoutMs);
  if (first.passed || first.error?.startsWith("timed out")) return { ...first, reran: false };
  const second = await runTestCommand(cwd, command, timeoutMs);
  return { ...second, reran: true };
}

/**
 * Put the integration worktree back exactly as it was.
 *
 * Three steps, all of which are needed: abort any merge still in progress (a
 * conflicted merge leaves `MERGE_HEAD` behind and a reset alone would leave the
 * worktree mid-merge), reset hard to the recorded sha, and clean the untracked
 * files a failed merge or a test run left. `git clean -fdq` is only ever safe
 * because this directory belongs to this merge and to nothing else.
 */
async function rollback(path: string, sha: string): Promise<void> {
  await git(path, ["merge", "--abort"], { allowFailure: true });
  await git(path, ["reset", "--hard", "--quiet", sha]);
  await git(path, ["clean", "-fdq"], { allowFailure: true });
}

async function conflictedFiles(path: string): Promise<string[]> {
  const out = await git(path, ["diff", "--name-only", "--diff-filter=U"], { allowFailure: true });
  return out.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .sort();
}

async function head(path: string): Promise<string> {
  return gitLine(path, ["rev-parse", "HEAD"]);
}

function skipped(candidate: MergeCandidate, sha: string): MergeStep {
  return {
    workerID: candidate.workerID,
    branch: candidate.branch,
    outcome: "skipped",
    shaBefore: sha,
    shaAfter: sha,
    detail: "an earlier step failed; the pipeline stopped before this one",
  };
}

/** Hand the step to a caller persisting progress, then keep it. */
function record(opts: MergeOptions, step: MergeStep): MergeStep {
  opts.onStep?.(step);
  return step;
}

function firstLine(text: string): string {
  return (text.split("\n").find((l) => l.trim() !== "") ?? "").trim().slice(0, 300);
}
