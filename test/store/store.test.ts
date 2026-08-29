/**
 * The index, and what happens when you lose it (DD-7, §9).
 *
 * The interesting assertions here are the recovery ones. Persisting a row and
 * reading it back is table stakes; the claim DD-7 actually makes is that a lost
 * database is *recoverable, not catastrophic*, and that claim is only true if
 * something rebuilds it from the worktrees.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SCHEMA_VERSION, Store } from "../../src/store/index.js";
import type { WorkerManifest, WorkerRecord } from "../../src/manager/types.js";

const temps: string[] = [];
const stores: Store[] = [];
afterEach(() => {
  for (const s of stores.splice(0)) s.close();
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

function store(path = ":memory:"): Store {
  const s = new Store(path);
  stores.push(s);
  return s;
}

function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "store-"));
  temps.push(d);
  return d;
}

function record(over: Partial<WorkerRecord> = {}): WorkerRecord {
  return {
    workerID: "w-001",
    runID: "run-1",
    state: "running",
    mode: "implement",
    model: "opencode/muse-spark-1.2-contributor-free",
    task: "add the settings API",
    spec: { task: "add the settings API", ownedPaths: ["src/settings/"] },
    worktree: "/tmp/wt/w-001",
    branch: "worker/w-001",
    baseSha: "a".repeat(40),
    createdAt: 1_000,
    updatedAt: 1_000,
    totalTokens: 0,
    cost: 0,
    resumes: 0,
    revisions: 0,
    questions: [],
    ...over,
  };
}

describe("persistence", () => {
  test("a worker round-trips with its spec and questions intact", () => {
    const s = store();
    s.createRun({ id: "run-1", repoRoot: "/repo" });
    s.putWorker(record({ sessionID: "ses_1", questions: ["may I touch the router?"] }));

    const back = s.getWorker("w-001")!;
    expect(back).toMatchObject({
      workerID: "w-001",
      state: "running",
      sessionID: "ses_1",
      questions: ["may I touch the router?"],
    });
    expect(back.spec.ownedPaths).toEqual(["src/settings/"]);
    expect(back.endedAt).toBeUndefined();
  });

  test("putWorker upserts, so the run loop can write on every transition", () => {
    const s = store();
    s.createRun({ id: "run-1", repoRoot: "/repo" });
    s.putWorker(record());
    s.putWorker(record({ state: "completed", endedAt: 2_000, totalTokens: 4_321 }));
    expect(s.listWorkers()).toHaveLength(1);
    expect(s.getWorker("w-001")).toMatchObject({ state: "completed", endedAt: 2_000, totalTokens: 4_321 });
  });

  test("filters by run and by state", () => {
    const s = store();
    s.createRun({ id: "run-1", repoRoot: "/repo" });
    s.createRun({ id: "run-2", repoRoot: "/repo" });
    s.putWorker(record({ workerID: "w-001", state: "completed" }));
    s.putWorker(record({ workerID: "w-002", state: "running" }));
    s.putWorker(record({ workerID: "w-003", runID: "run-2", state: "running" }));

    expect(s.listWorkers({ runID: "run-1" }).map((w) => w.workerID)).toEqual(["w-001", "w-002"]);
    expect(s.listWorkers({ states: ["running"] }).map((w) => w.workerID)).toEqual(["w-002", "w-003"]);
  });

  test("events are an ordered, pageable audit trail", () => {
    const s = store();
    s.createRun({ id: "run-1", repoRoot: "/repo" });
    s.putWorker(record());
    for (const kind of ["spawned", "state:preparing", "state:running", "escalation", "settled"]) {
      s.appendEvent("w-001", kind, { note: kind });
    }
    const first = s.listEvents("w-001", { limit: 2 });
    expect(first.map((e) => e.kind)).toEqual(["spawned", "state:preparing"]);
    expect(first[0]!.detail).toEqual({ note: "spawned" });
    const next = s.listEvents("w-001", { limit: 2, afterID: first.at(-1)!.id });
    expect(next.map((e) => e.kind)).toEqual(["state:running", "escalation"]);
  });

  test("survives a close and reopen on disk", () => {
    const dir = tempDir();
    const path = join(dir, "orchestrator.db");
    const first = new Store(path);
    first.createRun({ id: "run-1", repoRoot: "/repo" });
    first.putWorker(record({ state: "running" }));
    first.appendEvent("w-001", "spawned", {});
    first.close();

    const second = store(path);
    // Phase 4 added the `merges` table and bumped the version with it. The
    // constant is the assertion's source of truth so that a future migration
    // shows up as a schema change rather than as a broken test.
    expect(second.schemaVersion).toBe(SCHEMA_VERSION);
    expect(second.getWorker("w-001")).toMatchObject({ state: "running" });
    expect(second.listEvents("w-001")).toHaveLength(1);
  });
});

describe("recovery (§9)", () => {
  test("listUnfinished is exactly the rows a dead process left lying", () => {
    const s = store();
    s.createRun({ id: "run-1", repoRoot: "/repo" });
    s.putWorker(record({ workerID: "w-001", state: "running" }));
    s.putWorker(record({ workerID: "w-002", state: "blocked" }));
    s.putWorker(record({ workerID: "w-003", state: "preparing" }));
    s.putWorker(record({ workerID: "w-004", state: "completed" }));
    s.putWorker(record({ workerID: "w-005", state: "failed" }));

    // A blocked worker counts: its question is outstanding and the process that
    // was going to deliver the answer no longer exists.
    expect(s.listUnfinished().map((w) => w.workerID)).toEqual(["w-001", "w-002", "w-003"]);
  });
});

describe("rebuilding a lost index (DD-7)", () => {
  const manifest = (id: string): WorkerManifest => ({
    version: 1,
    workerID: id,
    runID: "run-lost",
    task: `task for ${id}`,
    mode: "implement",
    model: "opencode/muse-spark-1.2-contributor-free",
    branch: `worker/${id}`,
    baseSha: "b".repeat(40),
    createdAt: 5_000,
    spec: { task: `task for ${id}` },
  });

  test("worktrees put the rows back, in the only honest state", () => {
    // A manifest is written at spawn, so it cannot know how the worker ended.
    // `interrupted` is the truthful answer to "there is work here and nobody
    // knows its outcome" — and it is exactly the state §9 already handles.
    const s = store();
    const rebuilt = s.rebuildFromWorktrees([manifest("w-001"), manifest("w-002")], (m) => `/wt/${m.workerID}`);

    expect(rebuilt.map((w) => w.workerID)).toEqual(["w-001", "w-002"]);
    expect(rebuilt[0]).toMatchObject({
      state: "interrupted",
      reason: "rebuilt_from_worktree",
      branch: "worker/w-001",
      worktree: "/wt/w-001",
      runID: "run-lost",
    });
    // The run row is recreated too, or the worker would reference nothing.
    expect(s.getRun("run-lost")?.meta).toEqual({ rebuilt: true });
    expect(s.listEvents("w-001").map((e) => e.kind)).toEqual(["rebuilt_from_worktree"]);
  });

  test("a live row beats a manifest", () => {
    // The manifest is a snapshot of intent from spawn time; a surviving row knows
    // what actually happened. Overwriting the second with the first would turn a
    // completed worker back into an unknown one.
    const s = store();
    s.createRun({ id: "run-lost", repoRoot: "/repo" });
    s.putWorker(record({ workerID: "w-001", runID: "run-lost", state: "completed" }));

    expect(s.rebuildFromWorktrees([manifest("w-001")], (m) => `/wt/${m.workerID}`)).toEqual([]);
    expect(s.getWorker("w-001")?.state).toBe("completed");
  });
});
