/**
 * The §5 lifecycle end to end, against `ocmock` and a real git worktree.
 *
 * This is Phase 2's acceptance criteria as tests: the full
 * spawn→running→completed path, the blocked path, a timeout that lands in
 * `timed_out` rather than `failed`, a budget that lands in `over_budget`, a
 * manager restart that recovers state, and the lying report that reconciliation
 * is supposed to catch.
 *
 * Milliseconds everywhere, deliberately. The watchdogs are wall-clock machines
 * and the only way to test them honestly is to make the clock cheap: ocmock runs
 * a whole worker's life in about the time real OpenCode spends warming up.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { OCMock } from "../ocmock/server.js";
import { ServeBackend } from "../../src/opencode/index.js";
import { WorkerManager, renderResult } from "../../src/manager/index.js";
import { Store } from "../../src/store/index.js";
import { GOLDEN_TEST_COMMAND, makeGoldenRepo } from "../fixtures/golden.js";
import { sleep } from "../helpers.js";
import type { WorkerSpec } from "../../src/manager/types.js";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await Promise.resolve(fn()).catch(() => {});
});

/** A report that is true about what ocmock's `writeFiles` actually does. */
const TRUTHFUL = {
  workerId: "w-001",
  status: "completed",
  summary: "Created hello.txt as asked.",
  changes: [{ file: "hello.txt", action: "added", rationale: "the deliverable" }],
  tests: { command: "npm test", passed: 3, failed: 0, skipped: 0 },
  risks: [],
  questions: [],
  followUps: ["nothing outstanding"],
};

interface Harness {
  mock: OCMock;
  manager: WorkerManager;
  store: Store;
  repo: string;
  baseSha: string;
  dbPath: string;
}

async function harness(
  mockOpts: Parameters<typeof OCMock.start>[0] = {},
  managerOpts: Partial<ConstructorParameters<typeof WorkerManager>[0]> = {},
): Promise<Harness> {
  const repo = makeGoldenRepo("lifecycle");
  cleanup.push(repo.cleanup);
  const mock = await OCMock.start({ heartbeatMs: 20, ...mockOpts });
  cleanup.push(() => mock.stop());
  const backend = new ServeBackend({ baseUrl: mock.baseUrl });
  cleanup.push(() => backend.dispose());
  await backend.start();

  const dbPath = join(repo.path, "orchestrator.db");
  const store = new Store(dbPath);
  cleanup.push(() => store.close());

  const manager = new WorkerManager({
    backend,
    store,
    repoRoot: repo.path,
    // Phase 8 made `shared` the product default; these suites exercise the
    // isolated path (worktrees, branches, snapshots) and say so rather than
    // depending on a default.
    defaultWorkspace: "isolated",
    tickMs: 10,
    budgetPollMs: 20,
    abortGraceMs: 400,
    retrySettleMs: 60,
    verifyTests: false,
    ...managerOpts,
  });
  cleanup.push(() => manager.dispose());
  return { mock, manager, store, repo: repo.path, baseSha: repo.baseSha, dbPath };
}

const spec = (over: Partial<WorkerSpec> = {}): WorkerSpec => ({
  runID: "run-1",
  task: "create hello.txt",
  mode: "implement",
  ownedPaths: ["hello.txt"],
  ...over,
});

/** Poll until `pred`, because `wait()` deliberately only resolves on settled. */
async function waitFor(pred: () => boolean, ms = 3_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error("timed out waiting for a condition");
    await sleep(5);
  }
}

// ---------------------------------------------------------------------------

describe("spawn to completed", () => {
  test("the whole happy path, with the worktree committed and the diff measured", async () => {
    const { manager, store, repo } = await harness({ writeFiles: true, report: TRUTHFUL });

    const spawned = await manager.spawn(spec());
    // DD-1: spawn returns immediately, before any of the work.
    expect(spawned.state).toBe("spawned");

    const done = await manager.wait(spawned.workerID, 5_000);
    expect(done.state).toBe("completed");
    expect(done.reason).toBeUndefined();

    const result = done.result!;
    expect(result.summary).toBe("Created hello.txt as asked.");
    expect(result.changes.paths).toEqual(["hello.txt"]);
    expect(result.changes.files).toBe(1);
    expect(result.discrepancies).toEqual([]);
    expect(result.reportSource).toBe("reply");
    expect(result.usage.totalTokens).toBeGreaterThan(0);

    // DD-5: the manager committed, not the worker.
    expect(result.snapshot?.committed).toBe(true);
    expect(existsSync(join(done.worktree, "hello.txt"))).toBe(true);
    expect(readFileSync(join(done.worktree, "hello.txt"), "utf8")).toContain("ocmock");

    // The lifecycle is in the audit trail, in order.
    const states = store
      .listEvents(spawned.workerID, { limit: 100 })
      .map((e) => e.kind)
      .filter((k) => k.startsWith("state:"));
    expect(states).toEqual(["state:preparing", "state:running", "state:completed"]);
    expect(existsSync(join(repo, ".orchestrator", "worktrees", spawned.workerID))).toBe(true);
  });

  test("the worktree carries its own manifest (DD-7)", async () => {
    const { manager } = await harness({ writeFiles: true, report: TRUTHFUL });
    const w = await manager.spawn(spec());
    const done = await manager.wait(w.workerID, 5_000);

    const manifest = JSON.parse(readFileSync(join(done.worktree, ".orchestrator", "worker.json"), "utf8"));
    expect(manifest).toMatchObject({ version: 1, workerID: w.workerID, runID: "run-1", branch: `worker/${w.workerID}` });
    // Written again once the session exists, so a rebuilt index can still find it.
    expect(manifest.sessionID).toBe(done.sessionID);
  });

  test("the result fits the §4.3 shape and the context budget", async () => {
    const { manager } = await harness({ writeFiles: true, report: TRUTHFUL });
    const w = await manager.spawn(spec());
    const rendered = renderResult((await manager.wait(w.workerID, 5_000)).result!);

    expect(rendered).toContain(`Worker: ${w.workerID}`);
    expect(rendered).toContain("status: completed");
    expect(rendered).toContain("Task: create hello.txt");
    expect(rendered).toContain("Summary: Created hello.txt as asked.");
    expect(rendered).toContain("Changes (1 file, +1/−0): hello.txt");
    expect(rendered).toContain("Discrepancies: none");
    // §4.3's budget is <1,500 tokens; four characters per token is the usual
    // rule of thumb and this leaves an order of magnitude of headroom.
    expect(rendered.length).toBeLessThan(1_500 * 4);
  });

  test("re-runs the brief's test command and says so", async () => {
    const { manager } = await harness({ writeFiles: true, report: TRUTHFUL }, { verifyTests: true });
    const w = await manager.spawn(spec({ testCommand: GOLDEN_TEST_COMMAND }));
    const done = await manager.wait(w.workerID, 30_000);

    expect(done.state).toBe("completed");
    expect(done.result!.tests?.command).toBe(GOLDEN_TEST_COMMAND);
    // The golden repo's suite really passes, so a truthful claim survives.
    expect(done.result!.discrepancies).toEqual([]);
  }, 40_000);
});

// ---------------------------------------------------------------------------

describe("the blocked path (§5)", () => {
  test("worker asks, manager surfaces, the answer resumes the same session", async () => {
    const blocked = { status: "blocked", summary: "I need a decision", changes: [], questions: ["May I edit src/router.ts?"] };
    // Same guard as the retry path: answering a blocked worker is a prompt to a
    // session that has just gone terminal, and a dropped one would look like a
    // worker that ignored its answer.
    const { mock, manager, store } = await harness({ writeFiles: true, report: blocked, dropPromptsWithinMs: 30 });

    const w = await manager.spawn(spec());
    const asked = await manager.wait(w.workerID, 5_000);
    expect(asked.state).toBe("blocked");
    expect(asked.questions).toEqual(["May I edit src/router.ts?"]);

    // Script the second turn, then answer. The session is the same one — Phase 0
    // verified reuse keeps context, which is the whole reason this is a prompt
    // and not a respawn.
    const sessionID = asked.sessionID!;
    mock.setReport(sessionID, TRUTHFUL);
    await manager.answer(w.workerID, "Yes, but only the route table.");

    const done = await manager.wait(w.workerID, 5_000);
    expect(done.state).toBe("completed");
    expect(mock.droppedPromptsOf(sessionID)).toBe(0);
    expect(done.resumes).toBe(1);
    expect(done.questions).toEqual([]);
    expect(done.result!.summary).toBe("Created hello.txt as asked.");

    // One session, two prompts, and the answer is quoted into the second.
    const prompts = mock.requests.filter((r) => r.path.includes(sessionID) && r.path.endsWith("/prompt_async"));
    expect(prompts).toHaveLength(2);
    expect(JSON.stringify(prompts[1]!.body)).toContain("only the route table");
    // One subscription for the whole path: breaking out of the loop did not end it.
    expect(mock.requests.filter((r) => r.path === "/event")).toHaveLength(1);

    expect(store.listEvents(w.workerID, { limit: 100 }).map((e) => e.kind)).toContain("answered");
  });

  test("a mid-run permission wall becomes an escalation instead of a hang", async () => {
    // The adapter cannot answer one of these in band, so the turn is stopped and
    // the question is put to Claude. §8 wants exactly this shape: a worker
    // reaching for something it may not have raises a question rather than
    // silently doing it or silently waiting forever.
    const { manager } = await harness({ scenario: "blocked" });
    const w = await manager.spawn(spec());
    const asked = await manager.wait(w.workerID, 5_000);

    expect(asked.state).toBe("blocked");
    expect(asked.reason).toBe("permission_required");
    expect(asked.questions[0]).toContain("bash");
    expect(asked.questions[0]).toContain("rm -rf *");
  });

  test("a blocked worker can be cancelled instead of answered", async () => {
    const blocked = { status: "blocked", summary: "stuck", changes: [], questions: ["what now?"] };
    const { manager } = await harness({ report: blocked });
    const w = await manager.spawn(spec());
    await manager.wait(w.workerID, 5_000);

    await manager.cancel(w.workerID);
    const done = await manager.wait(w.workerID, 5_000);
    expect(done.state).toBe("cancelled");
    expect(done.reason).toBe("cancelled_while_blocked");
  });

  test("answering a worker that is not blocked is refused", async () => {
    const { manager } = await harness({ writeFiles: true, report: TRUTHFUL });
    const w = await manager.spawn(spec());
    await manager.wait(w.workerID, 5_000);
    await expect(manager.answer(w.workerID, "hello?")).rejects.toThrow(/not blocked/);
  });
});

// ---------------------------------------------------------------------------

describe("watchdogs", () => {
  test("a wedged worker times out — and lands in `timed_out`, not `failed`", async () => {
    // The distinction the fact sheet warns about: the abort arrives as an error,
    // and a loop that settles on the first terminal event calls this `failed`,
    // losing the one signal that says a retry might work.
    const { manager, store } = await harness({ scenario: "hang", heartbeatMs: 10 });
    const w = await manager.spawn(spec({ budget: { idleMs: 120, wallClockMs: 60_000 } }));
    const done = await manager.wait(w.workerID, 6_000);

    expect(done.state).toBe("timed_out");
    expect(done.reason).toBe("idle_watchdog");
    expect(done.result!.state).toBe("timed_out");
    expect(store.listEvents(w.workerID, { limit: 100 }).map((e) => e.kind)).toContain("abort_requested");
  });

  test("liveness ticks alone never satisfy the idle watchdog", async () => {
    // `hang` keeps the heartbeat going. A watchdog that reset on any frame would
    // wait forever here, which is the bug this test exists to prevent.
    const { manager } = await harness({ scenario: "hang", heartbeatMs: 5 });
    const w = await manager.spawn(spec({ budget: { idleMs: 100, wallClockMs: 60_000 } }));
    expect((await manager.wait(w.workerID, 6_000)).state).toBe("timed_out");
  });

  test("the hard deadline is separate from the idle one", async () => {
    const { manager } = await harness({ scenario: "hang", heartbeatMs: 10 });
    const w = await manager.spawn(spec({ budget: { idleMs: 60_000, wallClockMs: 150 } }));
    const done = await manager.wait(w.workerID, 6_000);
    expect(done.state).toBe("timed_out");
    expect(done.reason).toBe("hard_timeout");
  });

  test("a dead server is the server's failure, not the worker's timeout", async () => {
    const { manager } = await harness({ scenario: "crash", heartbeatMs: 10, workMs: 30 });
    const w = await manager.spawn(spec({ budget: { idleMs: 100, wallClockMs: 60_000 } }));
    const done = await manager.wait(w.workerID, 6_000);

    // Not `timed_out`: nothing about this says the worker was slow.
    expect(done.state).toBe("failed");
    expect(done.reason).toBe("server_gone");
  });

  test("a runaway worker lands in `over_budget`, and the budget is in tokens", async () => {
    const { manager, store } = await harness({ scenario: "over_budget", latencyMs: 5, burnPerTickTokens: 5_000 });
    const w = await manager.spawn(spec({ budget: { tokens: 12_000, wallClockMs: 60_000, idleMs: 60_000 } }));
    const done = await manager.wait(w.workerID, 6_000);

    expect(done.state).toBe("over_budget");
    expect(done.reason).toBe("token_budget");
    expect(done.result!.usage.totalTokens).toBeGreaterThan(12_000);
    // Free-tier cost stays 0 throughout, which is exactly why the cap is on tokens.
    expect(done.result!.usage.cost).toBe(0);
    const detail = store.listEvents(w.workerID, { limit: 100 }).find((e) => e.kind === "budget_exceeded")!;
    expect(detail.detail["limit"]).toBe(12_000);
  });

  test("a chatty worker cannot starve the watchdogs", async () => {
    // The regression this exists for: the run loop races the event stream
    // against a `tickMs` timer and used to run the watchdogs only when the timer
    // won. A worker emitting text deltas every millisecond wins that race every
    // time, so the budget, the idle timer and the hard deadline never fired at
    // all — and the runaway worker the token budget exists to stop is the
    // chattiest one there is. Deltas here arrive 20x faster than the tick.
    const { manager, store } = await harness(
      { scenario: "over_budget", latencyMs: 1, burnPerTickTokens: 5_000 },
      { tickMs: 20, budgetPollMs: 20 },
    );
    const w = await manager.spawn(spec({ budget: { tokens: 12_000, wallClockMs: 60_000, idleMs: 60_000 } }));
    const done = await manager.wait(w.workerID, 6_000);

    expect(done.state).toBe("over_budget");
    expect(done.reason).toBe("token_budget");
    expect(store.listEvents(w.workerID, { limit: 100 }).map((e) => e.kind)).toContain("budget_exceeded");
  }, 10_000);

  test("cancelling a running worker settles it as cancelled", async () => {
    const { manager } = await harness({ scenario: "hang" });
    const w = await manager.spawn(spec());
    await waitFor(() => manager.get(w.workerID)?.state === "running");

    await manager.cancel(w.workerID);
    const done = await manager.wait(w.workerID, 5_000);
    expect(done.state).toBe("cancelled");
    expect(done.reason).toBe("cancelled_by_request");
  });
});

// ---------------------------------------------------------------------------

describe("reconciliation in the loop (DD-4)", () => {
  test("a lying report completes, and every false claim is in the result", async () => {
    // ocmock's `lying_report` claims two files and touches none. The run really
    // did finish, so the state is `completed` — the discrepancies are what tell
    // Claude the summary is worthless.
    const { manager } = await harness({ scenario: "lying_report" });
    const w = await manager.spawn(spec({ ownedPaths: ["src/**"] }));
    const done = await manager.wait(w.workerID, 5_000);

    expect(done.state).toBe("completed");
    expect(done.result!.summary).toContain("Updated src/index.ts");
    expect(done.result!.changes.files).toBe(0);

    const claimed = done.result!.discrepancies.filter((d) => d.kind === "claimed_not_changed");
    expect(claimed.map((d) => d.file).sort()).toEqual(["src/index.ts", "test/index.test.ts"]);
    expect(renderResult(done.result!)).toContain("claimed_not_changed");
  });

  test("an out-of-scope edit is flagged even though the worker owned up to it", async () => {
    const { manager } = await harness({
      writeFiles: true,
      report: { ...TRUTHFUL, changes: [{ file: "hello.txt", action: "added" }] },
    });
    const w = await manager.spawn(spec({ ownedPaths: ["src/**"] }));
    const done = await manager.wait(w.workerID, 5_000);

    const scope = done.result!.discrepancies.filter((d) => d.kind === "out_of_scope");
    expect(scope.map((d) => d.file)).toEqual(["hello.txt"]);
  });

  test("a worker that says nothing still gets a measured result", async () => {
    const { manager } = await harness({ writeFiles: true, report: null });
    const w = await manager.spawn(spec());
    const done = await manager.wait(w.workerID, 5_000);

    expect(done.state).toBe("completed");
    expect(done.result!.reportSource).toBe("none");
    expect(done.result!.changes.paths).toEqual(["hello.txt"]);
    expect(done.result!.discrepancies.some((d) => d.kind === "unparseable_report")).toBe(true);
    expect(renderResult(done.result!)).toContain("the orchestrator's own measurement");
  });

  test("§5's secondary channel: a report.json in the worktree is used when the reply is empty", async () => {
    const { manager } = await harness({ writeFiles: true, report: null });
    const w = await manager.spawn(spec());
    // Write the file the way a worker would, while it is still running.
    await waitFor(() => (manager.get(w.workerID)?.worktree ?? "") !== "");
    writeFileSync(
      join(manager.get(w.workerID)!.worktree, "report.json"),
      JSON.stringify({ status: "completed", summary: "wrote it to a file", changes: [{ file: "hello.txt", action: "added" }] }),
    );

    const done = await manager.wait(w.workerID, 5_000);
    expect(done.result!.reportSource).toBe("report_file");
    expect(done.result!.summary).toBe("wrote it to a file");
    // The report file is orchestration, not the worker's deliverable.
    expect(done.result!.changes.paths).toEqual(["hello.txt"]);
  });
});

// ---------------------------------------------------------------------------

describe("worker modes (DD-10)", () => {
  test("a research worker is read-only at the session and at the prompt", async () => {
    const { mock, manager } = await harness({ report: { status: "completed", summary: "found it", changes: [] } });
    const w = await manager.spawn(spec({ mode: "research", task: "where is the settings store?" }));
    await manager.wait(w.workerID, 5_000);

    const create = mock.requests.find((r) => r.method === "POST" && r.path === "/session")!;
    expect((create.body as Record<string, unknown>)["permission"]).toEqual([
      { permission: "edit", pattern: "**", action: "deny" },
      { permission: "bash", pattern: "**", action: "deny" },
    ]);
    const prompt = mock.requests.find((r) => r.path.endsWith("/prompt_async"))!;
    expect((prompt.body as Record<string, unknown>)["tools"]).toMatchObject({ bash: false, edit: false });
  });

  test("an implement worker gets headless permissions and no tool restrictions", async () => {
    const { mock, manager } = await harness({ writeFiles: true, report: TRUTHFUL });
    const w = await manager.spawn(spec());
    await manager.wait(w.workerID, 5_000);

    const create = mock.requests.find((r) => r.method === "POST" && r.path === "/session")!;
    expect((create.body as Record<string, unknown>)["permission"]).toEqual([
      { permission: "edit", pattern: "**", action: "allow" },
      { permission: "bash", pattern: "**", action: "allow" },
      // `doom_loop` is an interactive guard, and an unattended worker cannot
      // answer it: left at `ask` it deadlocks the run the manager's own
      // watchdogs already bound. `external_directory` is deliberately absent —
      // that ask is §8's jail signal and is meant to reach Claude.
      { permission: "doom_loop", pattern: "**", action: "allow" },
    ]);
    const prompt = mock.requests.find((r) => r.path.endsWith("/prompt_async"))!;
    const body = prompt.body as Record<string, unknown>;
    expect(body["tools"]).toBeUndefined();
    // The contract goes in the system channel and the reply is schema-constrained
    // — ADR-0002's two decisions, on the wire.
    expect(String(body["system"])).toContain("## Required output");
    expect(body["format"]).toMatchObject({ type: "json_schema", retryCount: 2 });
  });
});

// ---------------------------------------------------------------------------

describe("providers that refuse schema-constrained output", () => {
  test("the turn is re-sent without the constraint and the worker still completes", async () => {
    // Verified against real OpenCode 1.18.25: the default free-tier model rejects
    // `format: json_schema` outright, because it is implemented as a forced tool
    // call. The schema was only ever the *enforcement* of the contract — the
    // brief states it in words — so losing it must not lose the worker.
    const { mock, manager, store } = await harness({
      scenario: "format_unsupported",
      writeFiles: true,
      report: TRUTHFUL,
      // A prompt sent straight after a terminal event is accepted and dropped by
      // the real server. If the manager re-sent immediately, this worker would
      // sit silent until the idle watchdog gave up on it.
      dropPromptsWithinMs: 30,
    });
    const w = await manager.spawn(spec());
    const done = await manager.wait(w.workerID, 5_000);

    expect(done.state).toBe("completed");
    expect(mock.droppedPromptsOf(done.sessionID!)).toBe(0);
    expect(done.result!.summary).toBe("Created hello.txt as asked.");

    const prompts = mock.requests.filter((r) => r.path.endsWith("/prompt_async"));
    expect(prompts).toHaveLength(2);
    expect((prompts[0]!.body as Record<string, unknown>)["format"]).toBeDefined();
    expect((prompts[1]!.body as Record<string, unknown>)["format"]).toBeUndefined();
    // The same instruction, re-sent unchanged.
    expect((prompts[1]!.body as Record<string, unknown>)["parts"]).toEqual(
      (prompts[0]!.body as Record<string, unknown>)["parts"] as never,
    );
    expect(store.listEvents(w.workerID, { limit: 100 }).map((e) => e.kind)).toContain("structured_output_unsupported");
  });

  test("the discovery is paid once, not by every worker", async () => {
    const { mock, manager } = await harness({ scenario: "format_unsupported", writeFiles: true, report: TRUTHFUL });
    const first = await manager.spawn(spec());
    await manager.wait(first.workerID, 5_000);
    const second = await manager.spawn(spec());
    expect((await manager.wait(second.workerID, 5_000)).state).toBe("completed");

    // Three prompts total: two for the first worker's discovery, one for the
    // second, which never asks for a constraint this backend cannot honour.
    const prompts = mock.requests.filter((r) => r.path.endsWith("/prompt_async"));
    expect(prompts).toHaveLength(3);
    expect((prompts[2]!.body as Record<string, unknown>)["format"]).toBeUndefined();
  });

  test("an unrelated provider error still fails the worker", async () => {
    // The fallback is narrow on purpose: it must not turn every API error into a
    // silent retry that hides a real provider problem.
    const { manager } = await harness({ scenario: "format_unsupported" }, { structuredOutput: false });
    const w = await manager.spawn(spec());
    const done = await manager.wait(w.workerID, 5_000);
    expect(done.state).toBe("completed"); // no format was sent, so no rejection
  });
});

// ---------------------------------------------------------------------------

describe("manager restart (§9)", () => {
  test("a killed manager leaves running workers recoverable, worktrees intact", async () => {
    const { manager, store, repo, dbPath, mock } = await harness({ scenario: "hang" });
    const w = await manager.spawn(spec());
    await waitFor(() => manager.get(w.workerID)?.state === "running");
    const worktree = manager.get(w.workerID)!.worktree;
    writeFileSync(join(worktree, "work-in-progress.txt"), "half done\n");

    // Not `dispose()`: a manager that is killed writes nothing on the way out,
    // and recovering from a clean shutdown would prove nothing.
    manager.halt();
    store.close();

    const restarted = new Store(dbPath);
    cleanup.push(() => restarted.close());
    expect(restarted.getWorker(w.workerID)?.state).toBe("running"); // the stale lie

    const backend = new ServeBackend({ baseUrl: mock.baseUrl });
    cleanup.push(() => backend.dispose());
    await backend.start();
    const second = new WorkerManager({ backend, store: restarted, repoRoot: repo, tickMs: 10 });
    cleanup.push(() => second.dispose());

    const recovered = await second.recover();
    expect(recovered.map((r) => r.workerID)).toEqual([w.workerID]);
    expect(recovered[0]).toMatchObject({ state: "interrupted", reason: "manager_restart" });
    expect(second.get(w.workerID)?.state).toBe("interrupted");

    // The work survives: DD-7's durable state is the worktree, and recovery that
    // destroyed it would be the opposite of recovery.
    expect(readFileSync(join(worktree, "work-in-progress.txt"), "utf8")).toBe("half done\n");
    expect(existsSync(join(worktree, "package.json"))).toBe(true);
  });

  test("a lost database is rebuilt from the worktrees (DD-7)", async () => {
    const { manager, store, repo, mock } = await harness({ writeFiles: true, report: TRUTHFUL });
    const w = await manager.spawn(spec());
    await manager.wait(w.workerID, 5_000);
    const worktree = manager.get(w.workerID)!.worktree;
    store.close();

    // The database is simply gone. The worktrees are all that is left.
    const fresh = new Store(":memory:");
    cleanup.push(() => fresh.close());
    const backend = new ServeBackend({ baseUrl: mock.baseUrl });
    cleanup.push(() => backend.dispose());
    await backend.start();
    const second = new WorkerManager({ backend, store: fresh, repoRoot: repo, tickMs: 10 });
    cleanup.push(() => second.dispose());

    expect(fresh.getWorker(w.workerID)).toBeUndefined();
    const rebuilt = await second.rebuildIndex();
    expect(rebuilt.map((r) => r.workerID)).toEqual([w.workerID]);
    expect(rebuilt[0]).toMatchObject({
      state: "interrupted",
      reason: "rebuilt_from_worktree",
      task: "create hello.txt",
      worktree,
    });
    expect(rebuilt[0]!.spec.ownedPaths).toEqual(["hello.txt"]);
  });
});
