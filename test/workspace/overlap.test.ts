/**
 * Overlap detection (§6.2).
 *
 * A pure function over sets, so a pure test: no git, no fixtures, no clock. The
 * intersection is the easy half and it is barely tested here; what is tested is
 * the **classification**, because that is what changes what Claude does — a
 * shared `README.md` is a shrug and a shared `package.json` is a warning, and
 * getting those the same way round is the whole point of the module.
 */

import { describe, expect, test } from "bun:test";

import { detectOverlap, isIntegrationFile, suggestMergeOrder } from "../../src/workspace/overlap.js";

const w = (workerID: string, files: string[], baseSha = "base") => ({ workerID, files, baseSha });

describe("classification (§6.2)", () => {
  test("disjoint file sets are disjoint", () => {
    const r = detectOverlap([w("w-001", ["src/a.ts", "test/a.test.ts"]), w("w-002", ["src/b.ts"])]);
    expect(r.classification).toBe("disjoint");
    expect(r.shared).toEqual([]);
    expect(r.pairs).toEqual([]);
  });

  test("a shared ordinary file is `shared_file`, and names who shares it", () => {
    const r = detectOverlap([w("w-001", ["src/a.ts", "README.md"]), w("w-002", ["README.md"])]);
    expect(r.classification).toBe("shared_file");
    expect(r.shared).toEqual([{ path: "README.md", workers: ["w-001", "w-002"], integration: false }]);
    expect(r.pairs).toEqual([{ a: "w-001", b: "w-002", files: ["README.md"] }]);
  });

  test("a shared manifest outranks a shared source file", () => {
    // Both kinds present: the classification reports the *worst* one, because a
    // caller acts on the worst case and a mixed answer would need re-deriving.
    const r = detectOverlap([w("w-001", ["src/a.ts", "package.json"]), w("w-002", ["src/a.ts", "package.json"])]);
    expect(r.classification).toBe("shared_integration_file");
    expect(r.integrationFiles).toEqual(["package.json"]);
    expect(r.shared.map((s) => s.path)).toEqual(["package.json", "src/a.ts"]);
  });

  test("three workers on one file produce every pair", () => {
    const r = detectOverlap([w("w-001", ["x.ts"]), w("w-002", ["x.ts"]), w("w-003", ["x.ts"])]);
    expect(r.shared[0]?.workers).toEqual(["w-001", "w-002", "w-003"]);
    expect(r.pairs.map((p) => `${p.a}|${p.b}`)).toEqual(["w-001|w-002", "w-001|w-003", "w-002|w-003"]);
  });

  test("a worker that changed nothing is still a worker", () => {
    const r = detectOverlap([w("w-001", []), w("w-002", ["src/a.ts"])]);
    expect(r.workers).toEqual(["w-001", "w-002"]);
    expect(r.classification).toBe("disjoint");
  });

  test("a duplicated path within one worker is not an overlap", () => {
    // A `changedFiles` list should not contain duplicates, but an overlap
    // detector that counts occurrences rather than owners would report a false
    // collision if it ever did — and a false collision reads as merge danger.
    const r = detectOverlap([w("w-001", ["src/a.ts", "src/a.ts"])]);
    expect(r.classification).toBe("disjoint");
  });

  test("differing bases are reported, because the intersection assumes one", () => {
    // `createWorktree` resolves a ref to a sha precisely so every worker in a run
    // shares a base. If they do not, comparing file *names* across bases can
    // mean nothing, and saying so beats a confident wrong answer.
    const r = detectOverlap([w("w-001", ["a.ts"], "sha-1"), w("w-002", ["a.ts"], "sha-2")]);
    expect(r.baseMismatch?.bases).toEqual(["sha-1", "sha-2"]);
  });
});

describe("what counts as an integration file", () => {
  test("manifests, lockfiles, barrels and wiring", () => {
    for (const path of [
      "package.json",
      "package-lock.json",
      "pnpm-lock.yaml",
      "bun.lock",
      "Cargo.toml",
      "go.sum",
      "pyproject.toml",
      "tsconfig.json",
      "src/index.ts",
      "src/api/__init__.py",
      "src/routes.ts",
      "src/app/router/index.tsx",
      "db/migrations/001_init.sql",
    ]) {
      expect(isIntegrationFile(path)).toBe(true);
    }
  });

  test("ordinary source and docs are not", () => {
    for (const path of ["src/stats.js", "README.md", "test/a.test.ts", "src/indexer.ts", "docs/routing-notes.md"]) {
      expect(isIntegrationFile(path)).toBe(false);
    }
  });
});

describe("merge order", () => {
  test("the least entangled worker goes first, deterministically", () => {
    const r = detectOverlap([
      w("w-001", ["package.json", "src/a.ts"]),
      w("w-002", ["package.json"]),
      w("w-003", ["src/z.ts"]),
    ]);
    // w-003 collides with nothing; the two sharing a manifest come after, and
    // ties break on id so a re-run produces the same order.
    expect(suggestMergeOrder(r)[0]).toBe("w-003");
    expect(suggestMergeOrder(r)).toEqual(suggestMergeOrder(r));
  });
});
