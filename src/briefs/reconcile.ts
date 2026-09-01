/**
 * DD-4: trust, but verify.
 *
 * "The manager reconciles `changes[]` against the actual `git diff --name-only`
 * and flags discrepancies in the result it returns to Claude. Workers will
 * sometimes misreport." (`projectplan.md` §4.2.)
 *
 * This is the one place in the system that decides whether to believe a worker,
 * so it is written to be boring: set arithmetic over normalized paths, no
 * heuristics, no benefit of the doubt. Every disagreement becomes a
 * {@link Discrepancy} that travels all the way to Claude. Discrepancies are not
 * failures — a worker that edits one extra file may have been right to — but
 * they are never invisible, because the alternative is a system that
 * launders a model's claims into facts.
 *
 * Note what is *not* here: nothing runs, resolves, or fetches anything named in
 * a report. The report is data (DD-8). The only executable string in the whole
 * flow is the test command, and that comes from the brief, not from the worker.
 */

import type { Discrepancy, WorkerReport } from "../manager/types.js";

export interface TestVerification {
  /** The command the *brief* specified. Never one the worker suggested. */
  readonly command: string;
  /** Did the manager actually run it? */
  readonly ran: boolean;
  /** Exit status when it ran. */
  readonly passed?: boolean;
  readonly detail?: string;
}

export interface ReconcileInput {
  /** `null` when the worker never produced a readable report. */
  readonly report: WorkerReport | null;
  /** Issues raised while parsing, folded in as discrepancies. */
  readonly parseIssues?: readonly string[];
  /** Ground truth: `git diff --name-only`, repo-relative. */
  readonly actualFiles: readonly string[];
  /** The paths the brief assigned this worker. Empty means "no restriction". */
  readonly ownedPaths?: readonly string[];
  /** Absolute worktree path, so absolute claims can be made relative. */
  readonly worktree?: string;
  readonly tests?: TestVerification;
  /**
   * True for a worker that cannot write at all — `research` and `review` (DD-10).
   *
   * It turns off exactly one rule: `claimed_not_changed`. A read-only worker's
   * `changes` list is not a claim about what it wrote, because it wrote nothing
   * and could not have; in practice it is the model naming the files it *read*,
   * however plainly the brief says otherwise. Measured on 2026-08-30 across four
   * free models: telling reviewers to leave `changes` empty fixed one of them and
   * not the others, which is ADR-0002's lesson again — the contract cannot depend
   * on instruction-following the models do not reliably have.
   *
   * The rule in the other direction is **kept, and matters more**: a read-only
   * worker whose diff is not empty has done something it could not do, and that
   * is a finding about the sandbox rather than about the report.
   */
  readonly readOnly?: boolean;
}

/**
 * Compare what the worker said against what the repository shows.
 *
 * Returns discrepancies in a stable order — unreadable report first, then
 * claims, then reality, then scope — so a diff of two runs is readable.
 */
export function reconcile(input: ReconcileInput): Discrepancy[] {
  const out: Discrepancy[] = [];
  const actual = new Set(input.actualFiles.map((f) => normalizePath(f, input.worktree)));

  for (const issue of input.parseIssues ?? []) {
    out.push({ kind: "unparseable_report", detail: issue });
  }

  if (input.report === null) {
    out.push({
      kind: "unparseable_report",
      detail:
        actual.size > 0
          ? `no usable report, but the worktree has ${actual.size} changed file(s): ${[...actual].sort().join(", ")}`
          : "no usable report and no changes in the worktree",
    });
    return dedupe(out);
  }

  const claimed = new Map<string, string>();
  for (const c of input.report.changes) {
    const p = normalizePath(c.file, input.worktree);
    if (p) claimed.set(p, c.action);
  }

  // The claim the report cannot make good on. This is the lying-report case —
  // and only for a worker that could have written something. For a read-only
  // one the same list means "files I looked at", and flagging it manufactures a
  // discrepancy that dilutes the very signal DD-4 exists to provide.
  if (!input.readOnly) {
    for (const [file, action] of [...claimed].sort()) {
      if (!actual.has(file)) {
        out.push({
          kind: "claimed_not_changed",
          file,
          detail: `report claims ${action} but the diff does not show it`,
        });
      }
    }
  }

  // The change the report forgot to mention. Less alarming, still material:
  // an unmentioned edit is an unreviewed edit.
  for (const file of [...actual].sort()) {
    if (!claimed.has(file)) {
      out.push({ kind: "changed_not_claimed", file, detail: "changed in the worktree but absent from the report" });
    }
  }

  // §8's jail check, done against reality rather than against the claim: a
  // worker that writes outside its lane and then omits it from the report would
  // otherwise be invisible.
  const owned = input.ownedPaths ?? [];
  if (owned.length > 0) {
    for (const file of [...actual].sort()) {
      if (!owned.some((pattern) => matchesPath(pattern, file))) {
        out.push({
          kind: "out_of_scope",
          file,
          detail: `changed but not in this worker's paths (${owned.join(", ")})`,
        });
      }
    }
  }

  const tests = input.tests;
  if (tests?.ran && tests.passed === false && (input.report.tests?.failed ?? 0) === 0) {
    out.push({
      kind: "test_claim_unverified",
      detail:
        `report claims no failing tests, but the manager re-ran \`${tests.command}\` and it failed` +
        (tests.detail ? `: ${tests.detail}` : ""),
    });
  }
  if (input.report.tests?.command && tests && input.report.tests.command !== tests.command) {
    out.push({
      kind: "test_claim_unverified",
      detail: `report's test command \`${input.report.tests.command}\` is not the one the brief required (\`${tests.command}\`)`,
    });
  }

  return dedupe(out);
}

/**
 * Normalize a path claim into a repo-relative, forward-slashed path.
 *
 * Workers produce all of `src/a.ts`, `./src/a.ts`, `/abs/worktree/src/a.ts` and
 * `src\\a.ts` for the same file. Comparing those raw manufactures discrepancies
 * that are really just formatting, which trains the reader to ignore the field.
 */
export function normalizePath(file: string, worktree?: string): string {
  let p = file.trim().replace(/\\/g, "/");
  if (worktree) {
    const root = worktree.replace(/\\/g, "/").replace(/\/+$/, "");
    if (p === root) return "";
    if (p.startsWith(`${root}/`)) p = p.slice(root.length + 1);
  }
  p = p.replace(/^\.\//, "").replace(/^\/+/, "").replace(/\/+$/, "");
  return p;
}

/**
 * Does `file` fall under `pattern`?
 *
 * Supports the three forms a brief actually uses: an exact path, a directory
 * prefix (`src/settings` or `src/settings/`), and globs with `*` (within a
 * segment) and `**` (across segments).
 */
export function matchesPath(pattern: string, file: string): boolean {
  const pat = normalizePath(pattern);
  if (!pat) return false;
  if (pat === file) return true;
  if (!pat.includes("*") && file.startsWith(`${pat}/`)) return true;
  if (!pat.includes("*")) return false;

  const segments = pat.split("/");
  let source = "^";
  segments.forEach((seg, i) => {
    const last = i === segments.length - 1;
    if (seg === "**") {
      // A trailing `**` swallows the rest; an interior one swallows whole segments.
      source += last ? ".*" : "(?:[^/]+/)*";
      return;
    }
    source += seg.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, "[^/]*");
    if (!last) source += "/";
  });
  return new RegExp(`${source}$`).test(file);
}

function dedupe(items: Discrepancy[]): Discrepancy[] {
  const seen = new Set<string>();
  return items.filter((d) => {
    const key = [d.kind, d.file ?? "", d.detail].join("|");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
