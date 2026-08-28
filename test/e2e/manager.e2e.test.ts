/**
 * Phase 2's acceptance criterion against real OpenCode: "full
 * spawn→running→completed lifecycle on the golden repo".
 *
 * Gated behind `OC_E2E=1` because it spends real tokens:
 *
 *   OC_E2E=1 bun test test/e2e/manager.e2e.test.ts
 *
 * `ocmock` proves the manager handles the *shapes* OpenCode produces. This
 * proves the shapes are right — that a real model, given a real brief over the
 * per-prompt system channel, with its reply constrained to the report schema,
 * comes back with something the parser and the reconciliation can use. If this
 * fails while the unit suite passes, ADR-0002 is what needs revisiting, not the
 * manager.
 *
 * A second, separately-gated test settles Phase 0's unresolved item 3
 * (`AGENTS.md` pickup) with a marker string:
 *
 *   OC_E2E=1 OC_E2E_AGENTS=1 bun test test/e2e/manager.e2e.test.ts
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { ServeBackend } from "../../src/opencode/index.js";
import { WorkerManager, renderResult } from "../../src/manager/index.js";
import { Store } from "../../src/store/index.js";
import { GOLDEN_TEST_COMMAND, makeGoldenRepo } from "../fixtures/golden.js";

const ENABLED = process.env["OC_E2E"] === "1";
const AGENTS_PROBE = ENABLED && process.env["OC_E2E_AGENTS"] === "1";
const MODEL = process.env["OC_E2E_MODEL"] ?? "opencode/muse-spark-1.2-contributor-free";
const RUN_TIMEOUT_MS = Number(process.env["OC_E2E_TIMEOUT_MS"] ?? 240_000);

const cleanup: Array<() => Promise<void> | void> = [];
afterAll(async () => {
  for (const fn of cleanup.splice(0).reverse()) await Promise.resolve(fn()).catch(() => {});
});

async function harness() {
  const repo = makeGoldenRepo("e2e");
  cleanup.push(repo.cleanup);
  // A real server, spawned the way production spawns one: `--port 0` and parse
  // the port it chose. Hardcoding one works locally and collides under load.
  const backend = new ServeBackend({ cwd: repo.path, startTimeoutMs: 60_000 });
  cleanup.push(() => backend.dispose());
  await backend.start();
  const store = new Store(join(repo.path, "orchestrator.db"));
  cleanup.push(() => store.close());
  const manager = new WorkerManager({
    backend,
    store,
    repoRoot: repo.path,
    defaultModel: MODEL,
    tickMs: 500,
    budgetPollMs: 10_000,
    budget: { wallClockMs: RUN_TIMEOUT_MS, idleMs: 120_000 },
  });
  cleanup.push(() => manager.dispose());
  return { repo, manager, store };
}

describe.skipIf(!ENABLED)("Phase 2 AC: the golden repo, end to end", () => {
  test(
    "a real worker takes a real task from spawn to completed, and the claims check out",
    async () => {
      const { manager } = await harness();

      const spawned = await manager.spawn({
        runID: "e2e",
        task: "Add a `range` function to src/stats.js that returns the largest value minus the smallest.",
        scope:
          "Export `range(values)` from src/stats.js alongside the existing helpers. Throw a RangeError on an empty list, " +
          "the way `mean` and `median` already do. Add cases for it to test/checks.mjs.",
        mode: "implement",
        ownedPaths: ["src/stats.js", "test/checks.mjs"],
        acceptance: ["range([3,1,4]) === 3", "range([]) throws RangeError"],
        testCommand: GOLDEN_TEST_COMMAND,
      });

      const done = await manager.wait(spawned.workerID, RUN_TIMEOUT_MS);
      // The whole point of the phase: the state is real, not inferred.
      expect(done.state).toBe("completed");
      expect(done.startedAt).toBeGreaterThan(0);

      const result = done.result!;
      // The report channel worked: a schema-constrained reply, parsed.
      expect(result.reportSource).not.toBe("none");
      expect(result.summary.length).toBeGreaterThan(0);

      // The work is real, committed by the manager, and passes the repo's own
      // suite — which the manager re-ran itself rather than taking on trust.
      expect(result.changes.paths).toContain("src/stats.js");
      expect(result.snapshot?.committed).toBe(true);
      expect(readFileSync(join(done.worktree, "src", "stats.js"), "utf8")).toContain("range");
      expect(result.discrepancies.filter((d) => d.kind === "test_claim_unverified")).toEqual([]);
      expect(result.usage.totalTokens).toBeGreaterThan(0);

      // And Claude's view of all that stays inside §4.3's budget.
      const rendered = renderResult(result);
      expect(rendered).toContain("status: completed");
      expect(rendered.length).toBeLessThan(1_500 * 4);
      console.log(`\n${rendered}\n`);
    },
    RUN_TIMEOUT_MS + 60_000,
  );
});

describe.skipIf(!AGENTS_PROBE)("phase 0 unresolved #3: AGENTS.md pickup", () => {
  test(
    "does a worker actually read AGENTS.md from its worktree?",
    async () => {
      // Phase 0 placed the file and never asked the model to prove it read it.
      // A marker string settles it: if the reply carries the marker, the file was
      // in context; if not, it was not. Either answer goes in the fact sheet.
      const { manager } = await harness();
      const marker = `AGENTS_MARKER_${Math.random().toString(36).slice(2, 10).toUpperCase()}`;

      const spawned = await manager.spawn({
        runID: "e2e-agents",
        task: "Report the marker.",
        scope:
          "Do not edit any file. Read AGENTS.md in the root of this worktree and put the marker string it contains " +
          "into your report's `summary`, verbatim. If there is no such file, say exactly: NO AGENTS FILE.",
        mode: "research",
      });
      // Written after the worktree exists and before the model gets far.
      const worktree = await (async () => {
        for (let i = 0; i < 200; i++) {
          const w = manager.get(spawned.workerID);
          if (w?.worktree && existsSync(w.worktree)) return w.worktree;
          await new Promise((r) => setTimeout(r, 25));
        }
        throw new Error("worktree never appeared");
      })();
      writeFileSync(join(worktree, "AGENTS.md"), `# Project notes\n\nThe marker for this worktree is ${marker}.\n`);

      const done = await manager.wait(spawned.workerID, RUN_TIMEOUT_MS);
      const summary = done.result?.summary ?? "";
      console.log(`\nAGENTS.md probe: marker=${marker}\nsummary: ${summary}\n`);
      // Not asserted either way — this is a measurement, and the result belongs
      // in docs/phase0-facts.md. It fails only if the worker never reported.
      expect(done.state).toBe("completed");
      expect(summary.length).toBeGreaterThan(0);
    },
    RUN_TIMEOUT_MS + 60_000,
  );
});
