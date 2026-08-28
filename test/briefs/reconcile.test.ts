/**
 * DD-4, the assertion Phase 1 left for Phase 2.
 *
 * `test/opencode/serve.test.ts` proves both halves are observable — the claim
 * arrives on the stream, the diff says zero files — and stops there, because the
 * adapter has no business judging a worker. This is where the judging happens.
 */

import { describe, expect, test } from "bun:test";

import { matchesPath, normalizePath, reconcile } from "../../src/briefs/index.js";
import type { WorkerReport } from "../../src/manager/types.js";

function report(over: Partial<WorkerReport> = {}): WorkerReport {
  return {
    status: "completed",
    summary: "did the thing",
    changes: [],
    risks: [],
    questions: [],
    followUps: [],
    ...over,
  };
}

describe("claims against reality", () => {
  test("agreement produces no discrepancies at all", () => {
    const d = reconcile({
      report: report({ changes: [{ file: "src/a.ts", action: "modified" }, { file: "src/b.ts", action: "added" }] }),
      actualFiles: ["src/a.ts", "src/b.ts"],
    });
    expect(d).toEqual([]);
  });

  test("a lying report is caught: claimed files that were never touched", () => {
    // The `lying_report` scenario, in miniature — the shape ocmock produces.
    const d = reconcile({
      report: report({
        summary: "Updated src/index.ts and added tests.",
        changes: [
          { file: "src/index.ts", action: "modified" },
          { file: "test/index.test.ts", action: "added" },
        ],
      }),
      actualFiles: [],
    });
    expect(d).toHaveLength(2);
    expect(d.every((x) => x.kind === "claimed_not_changed")).toBe(true);
    expect(d.map((x) => x.file).sort()).toEqual(["src/index.ts", "test/index.test.ts"]);
    expect(d[0]!.detail).toContain("the diff does not show it");
  });

  test("an unmentioned edit is surfaced too", () => {
    // Less alarming than a false claim and just as important: an edit nobody
    // mentioned is an edit nobody reviewed.
    const d = reconcile({
      report: report({ changes: [{ file: "src/a.ts", action: "modified" }] }),
      actualFiles: ["src/a.ts", "src/secret.ts"],
    });
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ kind: "changed_not_claimed", file: "src/secret.ts" });
  });

  test("out-of-scope writes are judged against the diff, not the report", () => {
    // A worker that edits outside its lane *and* omits it would otherwise be
    // invisible: both checks have to run off the real file list.
    const d = reconcile({
      report: report({ changes: [{ file: "src/settings/api.ts", action: "modified" }] }),
      actualFiles: ["src/settings/api.ts", "src/router.ts"],
      ownedPaths: ["src/settings/"],
    });
    expect(d.filter((x) => x.kind === "out_of_scope").map((x) => x.file)).toEqual(["src/router.ts"]);
    expect(d.some((x) => x.kind === "changed_not_claimed" && x.file === "src/router.ts")).toBe(true);
  });

  test("no report at all is a discrepancy that names what is on disk", () => {
    const d = reconcile({ report: null, actualFiles: ["src/a.ts", "src/b.ts"] });
    expect(d).toHaveLength(1);
    expect(d[0]!.kind).toBe("unparseable_report");
    expect(d[0]!.detail).toContain("2 changed file");
    expect(d[0]!.detail).toContain("src/a.ts");
  });

  test("parse issues travel through rather than being swallowed", () => {
    const d = reconcile({ report: report(), parseIssues: ["report has no summary"], actualFiles: [] });
    expect(d.map((x) => x.detail)).toContain("report has no summary");
  });

  test("formatting differences are not discrepancies", () => {
    // `./src/a.ts`, `/abs/wt/src/a.ts` and `src/a.ts` are the same file. Treating
    // them as three teaches the reader to skip the field.
    const d = reconcile({
      report: report({
        changes: [
          { file: "./src/a.ts", action: "modified" },
          { file: "/tmp/wt/w-1/src/b.ts", action: "added" },
        ],
      }),
      actualFiles: ["src/a.ts", "src/b.ts"],
      worktree: "/tmp/wt/w-1",
    });
    expect(d).toEqual([]);
  });

  test("a test claim contradicted by a real run is flagged", () => {
    const d = reconcile({
      report: report({ tests: { command: "npm test", passed: 24, failed: 0 } }),
      actualFiles: [],
      tests: { command: "npm test", ran: true, passed: false, detail: "exit 1" },
    });
    expect(d.some((x) => x.kind === "test_claim_unverified" && x.detail.includes("re-ran"))).toBe(true);
  });

  test("a worker that reports a different test command than it was given is flagged", () => {
    const d = reconcile({
      report: report({ tests: { command: "npm test -- --only-mine", passed: 1, failed: 0 } }),
      actualFiles: [],
      tests: { command: "npm test", ran: true, passed: true },
    });
    expect(d.some((x) => x.kind === "test_claim_unverified" && x.detail.includes("not the one the brief required"))).toBe(true);
  });

  test("a passing verification of a truthful claim says nothing", () => {
    const d = reconcile({
      report: report({ tests: { command: "npm test", passed: 3, failed: 0 } }),
      actualFiles: [],
      tests: { command: "npm test", ran: true, passed: true },
    });
    expect(d).toEqual([]);
  });
});

describe("path handling", () => {
  test("normalizePath strips the shapes workers actually emit", () => {
    expect(normalizePath("./src/a.ts")).toBe("src/a.ts");
    expect(normalizePath("src\\a.ts")).toBe("src/a.ts");
    expect(normalizePath("/wt/src/a.ts", "/wt")).toBe("src/a.ts");
    expect(normalizePath("/wt/src/a.ts", "/wt/")).toBe("src/a.ts");
    expect(normalizePath("  src/a.ts  ")).toBe("src/a.ts");
  });

  test("matchesPath covers exact, prefix and glob forms", () => {
    expect(matchesPath("src/a.ts", "src/a.ts")).toBe(true);
    expect(matchesPath("src/settings", "src/settings/api.ts")).toBe(true);
    expect(matchesPath("src/settings/", "src/settings/api.ts")).toBe(true);
    expect(matchesPath("src/*.ts", "src/a.ts")).toBe(true);
    expect(matchesPath("src/*.ts", "src/nested/a.ts")).toBe(false);
    expect(matchesPath("src/**/*.ts", "src/nested/deep/a.ts")).toBe(true);
    expect(matchesPath("src/**", "src/nested/a.ts")).toBe(true);
    expect(matchesPath("src", "srcfoo/a.ts")).toBe(false);
  });
});
