/**
 * §11 Phase 8's shared-workspace mode: every worker in the user's own repository.
 *
 * This is the mode that trades evidence for the ergonomics of Claude's native
 * subagents — workers see each other's edits, nothing is committed, nothing is
 * merged. The trade is deliberate ([ADR-0008](../../docs/adr/0008-shared-workspace.md)),
 * and these tests are mostly about the half of it that must NOT be traded away:
 *
 * - The orchestrator must never commit in the user's checkout.
 * - It must never `git reset --hard` there, which means the merge pipeline must
 *   refuse a shared worker rather than treat the repo as an integration branch.
 * - `workspace_cleanup` must never delete it.
 * - Work that was already in progress before a worker started must not be
 *   attributed to that worker.
 *
 * The attribution tests assert on what the system *admits it does not know*,
 * which is the part most likely to be quietly dropped.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { OCMock } from "../ocmock/server.js";
import { ServeBackend } from "../../src/opencode/index.js";
import { MergeCoordinator, WorkerManager } from "../../src/manager/index.js";
import { Store } from "../../src/store/index.js";
import { cleanupWorkspace, gitLine } from "../../src/workspace/index.js";
import { makeGoldenRepo } from "../fixtures/golden.js";
import { sleep } from "../helpers.js";
import type { WorkerSpec } from "../../src/manager/types.js";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await Promise.resolve(fn()).catch(() => {});
});

const REPORT = {
  status: "completed",
  summary: "Did the thing.",
  changes: [],
  tests: {},
  risks: [],
  questions: [],
  followUps: [],
};

interface Harness {
  manager: WorkerManager;
  store: Store;
  mock: OCMock;
  repo: string;
}

async function harness(
  mockOpts: Parameters<typeof OCMock.start>[0] = {},
  managerOpts: Partial<ConstructorParameters<typeof WorkerManager>[0]> = {},
): Promise<Harness> {
  const repo = makeGoldenRepo("shared");
  cleanup.push(repo.cleanup);
  const mock = await OCMock.start({ heartbeatMs: 20, report: REPORT, writeFiles: true, ...mockOpts });
  cleanup.push(() => mock.stop());
  const backend = new ServeBackend({ baseUrl: mock.baseUrl });
  cleanup.push(() => backend.dispose());
  await backend.start();
  // Inside `.orchestrator/`, which is excluded from every diff and every dirty
  // scan — a database sitting loose in the repo root would show up as an
  // untracked file and be attributed to whichever worker settled first.
  mkdirSync(join(repo.path, ".orchestrator"), { recursive: true });
  const store = new Store(join(repo.path, ".orchestrator", "db.sqlite"));
  cleanup.push(() => store.close());
  const manager = new WorkerManager({
    backend,
    store,
    repoRoot: repo.path,
    tickMs: 10,
    verifyTests: false,
    // The product default, stated because this suite is about it.
    defaultWorkspace: "shared",
    ...managerOpts,
  });
  cleanup.push(() => manager.dispose());
  return { manager, store, mock, repo: repo.path };
}

const spec = (over: Partial<WorkerSpec> = {}): WorkerSpec => ({ runID: "run-1", task: "do a thing", mode: "implement", ...over });

const headOf = (repo: string): Promise<string> => gitLine(repo, ["rev-parse", "HEAD"]);
const statusOf = (repo: string): Promise<string> => gitLine(repo, ["status", "--porcelain"]);

async function sessionOf(manager: WorkerManager, id: string, ms = 8_000): Promise<string> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const s = manager.get(id)?.sessionID;
    if (s) return s;
    await sleep(10);
  }
  throw new Error(`${id} never opened a session`);
}

// ---------------------------------------------------------------------------

describe("a shared worker works in the repository itself", () => {
  test("no worktree, no branch — the file lands in your checkout", async () => {
    const h = await harness();
    const r = await h.manager.spawn(spec());
    const sessionID = await sessionOf(h.manager, r.workerID);
    h.mock.setWrite(sessionID, [{ path: "src/added.js", content: "export const added = 1;\n" }]);

    const done = await h.manager.wait(r.workerID, 8_000);
    expect(done.state).toBe("completed");
    // The repository itself, not `.orchestrator/worktrees/...`.
    expect(done.worktree).toBe(h.repo);
    expect(done.branch).toBe("");
    expect(readFileSync(join(h.repo, "src", "added.js"), "utf8")).toContain("added = 1");
    expect(done.result!.changes.paths).toContain("src/added.js");
  });

  test("nothing is committed, and HEAD does not move", async () => {
    // DD-5 has the manager commit so the worker does not have to, which is right
    // in a worktree the orchestrator owns. In the user's checkout `git add -A`
    // would sweep up whatever else they had in progress, onto whatever branch
    // they are on, and call it this worker's snapshot.
    const h = await harness();
    const before = await headOf(h.repo);
    const r = await h.manager.spawn(spec());
    const sessionID = await sessionOf(h.manager, r.workerID);
    h.mock.setWrite(sessionID, [{ path: "src/added.js", content: "export const added = 1;\n" }]);
    const done = await h.manager.wait(r.workerID, 8_000);

    expect(await headOf(h.repo)).toBe(before);
    expect(done.result!.snapshot).toBeUndefined();
    // The work is there, uncommitted, for a human to read — which is also what a
    // native subagent leaves behind.
    expect(await statusOf(h.repo)).toContain("src/added.js");
  });

  test("no worktree directory is created for it", async () => {
    const h = await harness();
    const r = await h.manager.spawn(spec());
    await h.manager.wait(r.workerID, 8_000);
    expect(existsSync(join(h.repo, ".orchestrator", "worktrees", r.workerID))).toBe(false);
  });

  test("the brief tells it the tree is shared and not to tidy other people's work", async () => {
    const h = await harness();
    const r = await h.manager.spawn(spec({ ownedPaths: ["src/mine.js"] }));
    await h.manager.wait(r.workerID, 8_000);
    const prompts = h.mock.requests.filter((q) => q.path.includes("/prompt"));
    const system = JSON.stringify(prompts[0]!.body);
    expect(system).toContain("shared checkout");
    expect(system).toContain("Other workers are editing it");
    // The instruction that keeps one worker from undoing another's turn.
    expect(system).toContain("tidy");
    expect(system).toContain("no commit");
  });
});

describe("attribution, and what it admits it cannot know", () => {
  test("work already in progress before it started is not attributed to it", async () => {
    // The failure that would matter most in practice: a user with half a feature
    // in their tree spawns a worker, and the worker is credited with their work.
    const h = await harness();
    writeFileSync(join(h.repo, "src", "mine-already.js"), "export const mine = 1;\n");

    const r = await h.manager.spawn(spec({ ownedPaths: ["src/worker.js"] }));
    const sessionID = await sessionOf(h.manager, r.workerID);
    h.mock.setWrite(sessionID, [{ path: "src/worker.js", content: "export const w = 1;\n" }]);
    const done = await h.manager.wait(r.workerID, 8_000);

    const a = done.result!.attribution!;
    expect(a.mode).toBe("shared");
    expect(a.preexisting).toContain("src/mine-already.js");
    expect(a.owned).toContain("src/worker.js");
    expect(a.unattributed).not.toContain("src/mine-already.js");
  });

  test("a worker that ran alone is measured exactly, and says so", async () => {
    // A shared worker that happened to have the tree to itself is as well
    // measured as an isolated one, and should not be discounted for the mode.
    const h = await harness();
    const r = await h.manager.spawn(spec({ ownedPaths: ["src/**"] }));
    const done = await h.manager.wait(r.workerID, 8_000);
    expect(done.result!.attribution!.concurrent).toEqual([]);
  });

  test("with no ownedPaths, everything is unattributed rather than assumed", async () => {
    // The honest default. A worker that declared nothing has claimed nothing,
    // and crediting it with whatever changed while it ran would be the exact
    // failure DD-4 exists to prevent — in the mode where it is easiest to hide.
    const h = await harness();
    const r = await h.manager.spawn(spec());
    const sessionID = await sessionOf(h.manager, r.workerID);
    h.mock.setWrite(sessionID, [{ path: "src/x.js", content: "export const x = 1;\n" }]);
    const done = await h.manager.wait(r.workerID, 8_000);

    const a = done.result!.attribution!;
    expect(a.owned).toEqual([]);
    expect(a.unattributed).toContain("src/x.js");
  });

  test("concurrent workers are named in each other's results", async () => {
    const h = await harness({ workMs: 400 }, { maxConcurrent: 3 });
    const a = await h.manager.spawn(spec({ task: "worker a", ownedPaths: ["src/a.js"] }));
    const b = await h.manager.spawn(spec({ task: "worker b", ownedPaths: ["src/b.js"] }));
    await Promise.all([h.manager.wait(a.workerID, 10_000), h.manager.wait(b.workerID, 10_000)]);

    const attrA = h.manager.get(a.workerID)!.result!.attribution!;
    expect(attrA.concurrent).toContain(b.workerID);
  });
});

describe("the safety properties shared mode must not trade away", () => {
  test("workspace_merge refuses a shared worker instead of resetting your checkout", async () => {
    // The pipeline's rollback is `git reset --hard`. Pointed at the user's own
    // checkout that destroys work nobody asked it to touch, so the refusal is
    // structural rather than advisory.
    const h = await harness();
    const merges = new MergeCoordinator({ manager: h.manager, store: h.store, repoRoot: h.repo });
    const r = await h.manager.spawn(spec());
    await h.manager.wait(r.workerID, 8_000);

    // `start()` is synchronous by design — it validates, then hands back a handle
    // to poll — so the refusal is a throw rather than a rejection.
    expect(() => merges.start({ workerIDs: [r.workerID], runTests: false })).toThrow(/already in your tree/);
    // And it names the way to get the gate if that is what was wanted.
    expect(() => merges.start({ workerIDs: [r.workerID], runTests: false })).toThrow(/isolated/);
    // Nothing was started, so nothing can roll anything back.
    expect(await statusOf(h.repo)).not.toBe("");
  });

  test("workspace_cleanup keeps the repository rather than pruning it", async () => {
    const h = await harness();
    const r = await h.manager.spawn(spec());
    const done = await h.manager.wait(r.workerID, 8_000);

    const report = await cleanupWorkspace({
      repoRoot: h.repo,
      candidates: [{ workerID: done.workerID, branch: done.branch, worktree: done.worktree }],
      knownIDs: [done.workerID],
      force: true,
    });
    const pruned = report.pruned.find((p) => p.workerID === done.workerID)!;
    expect(pruned.worktreeRemoved).toBe(false);
    expect(pruned.kept).toContain("your repository");
    // The thing that must still be true afterwards.
    expect(existsSync(join(h.repo, "src", "stats.js"))).toBe(true);
    expect(existsSync(join(h.repo, ".git"))).toBe(true);
  });

  test("isolated mode still does all of the above, so the choice is real", async () => {
    const h = await harness({}, { defaultWorkspace: "isolated" });
    const r = await h.manager.spawn(spec());
    const done = await h.manager.wait(r.workerID, 8_000);

    expect(done.worktree).not.toBe(h.repo);
    expect(done.branch).toBe(`worker/${r.workerID}`);
    expect(done.result!.snapshot?.committed).toBe(true);
    expect(done.result!.attribution).toBeUndefined();
    // And the user's checkout is untouched by it.
    expect(await statusOf(h.repo)).toBe("");
  });

  test("a per-worker override beats the manager default, both ways", async () => {
    const h = await harness({}, { defaultWorkspace: "shared" });
    const iso = await h.manager.spawn(spec({ workspace: "isolated" }));
    const done = await h.manager.wait(iso.workerID, 8_000);
    expect(done.branch).toBe(`worker/${iso.workerID}`);

    const h2 = await harness({}, { defaultWorkspace: "isolated" });
    const shared = await h2.manager.spawn(spec({ workspace: "shared" }));
    const done2 = await h2.manager.wait(shared.workerID, 8_000);
    expect(done2.branch).toBe("");
  });
});
