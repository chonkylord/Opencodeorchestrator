/**
 * The paginated diff reader (§7's `worker_diff`, §8's 400-line cap).
 *
 * Against a real repository, because the thing being tested is what git prints
 * and how it is sliced. The two properties that matter are the cap and the
 * cursor: a cap that rounds up to whole files is not a cap, and a cursor that
 * skips or repeats a line silently corrupts what Claude reads.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { makeGoldenRepo } from "../fixtures/golden.js";
import { DIFF_LINES_DEFAULT, DIFF_LINE_CHARS, readCommitDiff, readDiff } from "../../src/workspace/diff.js";
import { createWorktree, snapshotCommit } from "../../src/workspace/worktree.js";

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
  const r = makeGoldenRepo("diff");
  cleanup.push(r.cleanup);
  return r.path;
}

async function tree(repoRoot: string, id = "w-001"): Promise<{ path: string; branch: string; baseSha: string }> {
  return createWorktree({ repoRoot, workerID: id });
}

describe("readDiff", () => {
  test("an untouched worktree has no diff, and says so as a fact", async () => {
    const wt = await tree(repo());
    const page = await readDiff(wt.path, { baseSha: wt.baseSha });
    expect(page.totalLines).toBe(0);
    expect(page.lines).toEqual([]);
    expect(page.hasMore).toBe(false);
  });

  test("tracked edits and untracked files both appear", async () => {
    const wt = await tree(repo());
    writeFileSync(join(wt.path, "src", "stats.js"), "export const sum = () => 1;\n");
    writeFileSync(join(wt.path, "brand-new.txt"), "new\n");

    const page = await readDiff(wt.path, { baseSha: wt.baseSha });
    const text = page.lines.join("\n");
    // A worker that has not been snapshotted yet has all its new files
    // untracked; a diff that omitted them would read as a worker that wrote
    // nothing, which is the most misleading answer available.
    expect(text).toContain("src/stats.js");
    expect(text).toContain("brand-new.txt");
    expect(text).toContain("+new");
  });

  test("the diff survives the snapshot commit unchanged", async () => {
    const wt = await tree(repo());
    writeFileSync(join(wt.path, "brand-new.txt"), "new\n");
    const before = await readDiff(wt.path, { baseSha: wt.baseSha });
    await snapshotCommit(wt.path, "snapshot");
    const after = await readDiff(wt.path, { baseSha: wt.baseSha });
    // Same change, whether it is untracked or committed. `worker_diff` must not
    // change its answer just because DD-5's snapshot ran.
    expect(after.totalLines).toBe(before.totalLines);
    expect(after.lines.join("\n")).toContain("+new");
  });

  test("`.dispatched-code/` is never in a diff, even if asked for", async () => {
    const wt = await tree(repo());
    writeFileSync(join(wt.path, "src", "stats.js"), "export const sum = () => 1;\n");
    const page = await readDiff(wt.path, { baseSha: wt.baseSha, paths: [".dispatched-code", "src"] });
    expect(page.lines.join("\n")).not.toContain(".dispatched-code");
    expect(page.lines.join("\n")).toContain("src/stats.js");
  });

  test("the cap holds and the cursor walks the whole diff exactly once", async () => {
    const wt = await tree(repo());
    // 1,200 lines: three default pages and change, so paging is real rather
    // than a single page with a cursor nobody uses.
    writeFileSync(join(wt.path, "big.txt"), Array.from({ length: 1_200 }, (_, i) => `line ${i}`).join("\n") + "\n");

    const first = await readDiff(wt.path, { baseSha: wt.baseSha });
    expect(first.lines.length).toBe(DIFF_LINES_DEFAULT);
    expect(first.totalLines).toBeGreaterThan(1_200);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).toBe(DIFF_LINES_DEFAULT);

    const seen: string[] = [...first.lines];
    let cursor = first.nextCursor;
    let pages = 1;
    while (cursor !== undefined && pages < 20) {
      const page = await readDiff(wt.path, { baseSha: wt.baseSha, cursor });
      expect(page.from).toBe(cursor);
      seen.push(...page.lines);
      cursor = page.nextCursor;
      pages++;
    }
    // Every line exactly once, in order, with no gap and no repeat.
    expect(seen.length).toBe(first.totalLines);
    expect(seen).toContain("+line 0");
    expect(seen).toContain("+line 1199");
  });

  test("an over-long line is clipped rather than allowed to blow the page", async () => {
    const wt = await tree(repo());
    writeFileSync(join(wt.path, "minified.js"), `${"x".repeat(5_000)}\n`);
    const page = await readDiff(wt.path, { baseSha: wt.baseSha });
    expect(page.clippedLines).toBeGreaterThan(0);
    for (const line of page.lines) expect(line.length).toBeLessThanOrEqual(DIFF_LINE_CHARS + 20);
  });

  test("`paths` narrows the diff", async () => {
    const wt = await tree(repo());
    writeFileSync(join(wt.path, "src", "stats.js"), "export const sum = () => 1;\n");
    writeFileSync(join(wt.path, "README.md"), "changed\n");
    const page = await readDiff(wt.path, { baseSha: wt.baseSha, paths: ["src"] });
    expect(page.lines.join("\n")).toContain("src/stats.js");
    expect(page.lines.join("\n")).not.toContain("README.md");
  });
});

describe("readCommitDiff", () => {
  test("diffs a branch against its base without needing the worktree", async () => {
    const root = repo();
    const wt = await tree(root);
    writeFileSync(join(wt.path, "alpha.txt"), "alpha\n");
    await snapshotCommit(wt.path, "snapshot");

    // This is the path `worker_diff` falls back to once cleanup has reclaimed
    // the directory: the branch is the work, and it outlives its worktree.
    const page = await readCommitDiff(root, wt.baseSha, wt.branch);
    expect(page.lines.join("\n")).toContain("+alpha");
  });
});
