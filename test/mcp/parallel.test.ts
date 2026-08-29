/**
 * Phase 5's tool surface, driven the way a host drives it.
 *
 * Same rule as the other `test/mcp/` suites: every call goes over real JSON-RPC
 * through the SDK's in-memory transport, because a handler called directly skips
 * schema validation and registration entirely — and a schema the SDK cannot
 * convert fails at `listTools` in front of the user rather than here.
 *
 * The §11 Phase 5 acceptance criterion lives at the bottom of this file: three
 * workers run concurrently under the cap, a dependent waits for its dependency,
 * and the wave reaches a gated merge and a run report. (The *full* v1 demo,
 * revisions included, is Phase 6's — see §11.)
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { OCMock } from "../ocmock/server.js";
import { createOrchestrator, type ManagerTuning, type Orchestrator } from "../../src/mcp/server.js";
import { WAIT_TIMEOUT_MAX_MS } from "../../src/mcp/tools.js";
import type { ServerConfig } from "../../src/mcp/config.js";
import { GOLDEN_TEST_COMMAND, makeGoldenRepo } from "../fixtures/golden.js";
import { sleep } from "../helpers.js";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await Promise.resolve(fn()).catch(() => {});
});

const TRUTHFUL = {
  status: "completed",
  summary: "Wrote the file this worker was asked for.",
  changes: [],
  tests: { command: GOLDEN_TEST_COMMAND, passed: 3, failed: 0, skipped: 0 },
  risks: [],
  questions: [],
  followUps: [],
};

interface Harness {
  client: Client;
  orchestrator: Orchestrator;
  repo: string;
}

async function harness(
  mockOpts: Parameters<typeof OCMock.start>[0] = {},
  configOver: Partial<ServerConfig> = {},
  tuning: ManagerTuning = {},
): Promise<Harness> {
  const repo = makeGoldenRepo("par");
  cleanup.push(repo.cleanup);
  const mock = await OCMock.start({ heartbeatMs: 20, report: TRUTHFUL, ...mockOpts });
  cleanup.push(() => mock.stop());

  const config: ServerConfig = {
    repoRoot: repo.path,
    dbPath: join(repo.path, ".orchestrator", "orchestrator.db"),
    defaultModel: "ocmock/test-model",
    baseUrl: mock.baseUrl,
    verifyTests: false,
    maxConcurrent: 3,
    ...configOver,
  };
  const orchestrator = await createOrchestrator(config, {
    tickMs: 10,
    budgetPollMs: 20,
    abortGraceMs: 400,
    retrySettleMs: 60,
    ...tuning,
  });
  cleanup.push(() => orchestrator.dispose());

  const client = new Client({ name: "test-host", version: "0.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([orchestrator.server.connect(serverSide), client.connect(clientSide)]);
  cleanup.push(() => client.close());

  return { client, orchestrator, repo: repo.path };
}

interface CallOutcome {
  readonly text: string;
  readonly isError: boolean;
  readonly ms: number;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<CallOutcome> {
  const started = Date.now();
  const res = (await client.callTool({ name, arguments: args })) as {
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
  return {
    text: (res.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n"),
    isError: res.isError === true,
    ms: Date.now() - started,
  };
}

const idFrom = (text: string): string => {
  const m = /\b(w-\d+)\b/.exec(text);
  if (!m) throw new Error(`no worker id in: ${text}`);
  return m[1]!;
};

const mergeIDFrom = (text: string): string => {
  const m = /\b(m-\d+)\b/.exec(text);
  if (!m) throw new Error(`no merge id in: ${text}`);
  return m[1]!;
};

async function spawn(client: Client, task: string, over: Record<string, unknown> = {}): Promise<string> {
  const r = await call(client, "worker_spawn", { task, mode: "implement", runID: "run-1", ...over });
  expect(r.isError).toBe(false);
  return idFrom(r.text);
}

async function pollUntil(client: Client, ids: string[], want: RegExp, ms = 20_000): Promise<string> {
  const deadline = Date.now() + ms;
  let last = "";
  while (Date.now() < deadline) {
    last = (await call(client, "worker_status", { ids })).text;
    if (want.test(last)) return last;
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${want}; last status was:\n${last}`);
}

async function pollMerge(client: Client, mergeID: string, ms = 40_000): Promise<string> {
  const deadline = Date.now() + ms;
  let last = "";
  while (Date.now() < deadline) {
    last = (await call(client, "workspace_merge_status", { mergeID })).text;
    if (!last.includes("still running")) return last;
    await sleep(50);
  }
  throw new Error(`merge ${mergeID} never settled; last status: ${last}`);
}

// ---------------------------------------------------------------------------

describe("the queue, as Claude sees it", () => {
  test("worker_spawn says a worker is queued, and how deep, rather than implying it started", async () => {
    const { client } = await harness({ workMs: 300 }, { maxConcurrent: 1 });
    const first = await call(client, "worker_spawn", { task: "first", runID: "run-1" });
    expect(first.text).toMatch(/preparing its worktree/);

    const second = await call(client, "worker_spawn", { task: "second", runID: "run-1" });
    expect(second.isError).toBe(false);
    expect(second.text).toMatch(/QUEUED/);
    expect(second.text).toMatch(/slots are busy/);
    // The property a queued worker's caller most needs to know.
    expect(second.text).toMatch(/time limits have not started/);
    // Both tool calls still returned inside DD-1's two seconds.
    expect(first.ms).toBeLessThan(2_000);
    expect(second.ms).toBeLessThan(2_000);
  }, 30_000);

  test("worker_status tells a queued worker apart from one about to start, and says so in `next:`", async () => {
    // Without this, two workers in `spawned` are indistinguishable and
    // "next: worker_wait" is the wrong advice for one of them.
    const { client } = await harness({ workMs: 400 }, { maxConcurrent: 1 });
    const a = await spawn(client, "running");
    const b = await spawn(client, "queued");

    const status = (await call(client, "worker_status", { ids: [a, b] })).text;
    const lineB = status.split("\n").find((l) => l.startsWith(b))!;
    expect(lineB).toMatch(/queued 1st of 1/);
    expect(lineB).toContain("1/1 slots busy");
    expect(lineB).toMatch(/next: worker_status/);
    expect(lineB).not.toMatch(/next: worker_wait/);

    const lineA = status.split("\n").find((l) => l.startsWith(a))!;
    expect(lineA).toMatch(/next: worker_wait/);
  }, 30_000);

  test("a worker waiting on a dependency says which one, and points the wait at it", async () => {
    const { client } = await harness({ workMs: 300 }, { maxConcurrent: 3 });
    const a = await spawn(client, "the dependency");
    const b = await call(client, "worker_spawn", { task: "the dependent", runID: "run-1", dependsOn: [a] });

    expect(b.text).toMatch(new RegExp(`waiting for ${a}`));
    const id = idFrom(b.text);
    const line = (await call(client, "worker_status", { ids: [id] })).text;
    expect(line).toMatch(new RegExp(`waiting for ${a}`));
    // The `next:` hint points the wait at the dependency, not at the worker
    // that is not running.
    expect(line).toContain(`next: worker_wait({ids: ["${a}"], mode: "all"})`);

    // worker_result on a queued worker explains the queue rather than the
    // absence of a result.
    const result = await call(client, "worker_result", { id });
    expect(result.isError).toBe(false);
    expect(result.text).toMatch(/has not started/);
  }, 30_000);

  test("a dependsOn naming an unknown worker is rejected with the id in the message", async () => {
    const { client } = await harness();
    const rejected = await call(client, "worker_spawn", { task: "x", runID: "run-1", dependsOn: ["w-321"] });
    expect(rejected.isError).toBe(true);
    expect(rejected.text).toMatch(/w-321/);
    expect(rejected.text).toMatch(/spawn it first/);
  });

  test("a dependent whose dependency is stopped is cancelled with a reason naming it", async () => {
    const { client } = await harness({ workMs: 3_000 }, { maxConcurrent: 3 });
    const a = await spawn(client, "will be stopped");
    const b = await spawn(client, "depends on it", { dependsOn: [a] });

    await pollUntil(client, [a], /running/);
    await call(client, "worker_stop", { id: a, reason: "changed_my_mind" });
    await pollUntil(client, [b], /cancelled/);

    const status = (await call(client, "worker_status", { ids: [b] })).text;
    expect(status).toContain(`dependency_failed:${a}`);
    const result = await call(client, "worker_result", { id: b });
    expect(result.text).toMatch(/never started/);
  }, 40_000);
});

// ---------------------------------------------------------------------------

describe("batched worker_wait", () => {
  test("mode `any` returns as soon as one of the wave settles", async () => {
    const { client } = await harness({ workMsFor: { "w-001": 30, "w-002": 4_000, "w-003": 4_000 } }, { maxConcurrent: 3 });
    const ids = [await spawn(client, "fast"), await spawn(client, "slow one"), await spawn(client, "slow two")];

    const waited = await call(client, "worker_wait", { ids, mode: "any", timeoutMs: WAIT_TIMEOUT_MAX_MS });
    expect(waited.isError).toBe(false);
    expect(waited.text).toMatch(/1 of 3 worker\(s\) have settled/);
    expect(waited.text).toContain(ids[0]!);
    // It returned on the *first*, not after the slowest — that is the whole point.
    expect(waited.ms).toBeLessThan(3_000);
  }, 40_000);

  test("mode `all` waits for every one of them, and names who is still working on a timeout", async () => {
    const { client } = await harness({ workMsFor: { "w-001": 20, "w-002": 20, "w-003": 5_000 } }, { maxConcurrent: 3 });
    const ids = [await spawn(client, "a"), await spawn(client, "b"), await spawn(client, "c")];

    const short = await call(client, "worker_wait", { ids, mode: "all", timeoutMs: 800 });
    expect(short.isError).toBe(false);
    expect(short.text).toMatch(/2 of 3 settled/);
    expect(short.text).toContain(`still working: ${ids[2]}`);

    const full = await call(client, "worker_wait", { ids, mode: "all", timeoutMs: WAIT_TIMEOUT_MAX_MS });
    expect(full.text).toMatch(/All 3 worker\(s\) have settled/);
  }, 60_000);

  test("the cap does not move for a batch, and a batched timeout is not an error", async () => {
    const { client } = await harness({ scenario: "hang" }, { maxConcurrent: 3 });
    const ids = [await spawn(client, "hang one"), await spawn(client, "hang two")];

    const waited = await call(client, "worker_wait", { ids, mode: "all", timeoutMs: 600 });
    expect(waited.isError).toBe(false);
    expect(waited.text).toMatch(/still working/);
    // Half a *measured* 60s host ceiling; the schema refuses to go past it.
    const overCap = await call(client, "worker_wait", { ids, timeoutMs: WAIT_TIMEOUT_MAX_MS + 1 });
    expect(overCap.isError).toBe(true);
  }, 30_000);

  test("worker_wait with neither id nor ids says what to pass, and an unknown id is named", async () => {
    const { client } = await harness();
    const empty = await call(client, "worker_wait", {});
    expect(empty.isError).toBe(true);
    expect(empty.text).toMatch(/`id`.*`ids`|id.*ids/);

    const bogus = await call(client, "worker_wait", { ids: ["w-777"] });
    expect(bogus.isError).toBe(true);
    expect(bogus.text).toContain("w-777");
  });
});

// ---------------------------------------------------------------------------

describe("run_report", () => {
  test("keeps the worker's claims and the orchestrator's measurements apart, and writes the file", async () => {
    const { client, repo } = await harness({ writeFiles: true, perWorktreeFileName: true }, { maxConcurrent: 3 });
    const a = await spawn(client, "write a file", { ownedPaths: ["**"] });
    await call(client, "worker_wait", { id: a, timeoutMs: 10_000 });

    const report = await call(client, "run_report", { runID: "run-1" });
    expect(report.isError).toBe(false);
    expect(report.text).toContain("# Run report — run-1");
    expect(report.text).toContain("## Workers");
    expect(report.text).toContain("## Discrepancies");
    expect(report.text).toContain("## Merges");
    expect(report.text).toContain("## Timeline");
    expect(report.text).toContain("Concurrency cap:** 3");
    // DD-8: the summary is quoted and marked; the measurements are not.
    expect(report.text).toContain("> Wrote the file this worker was asked for.");
    expect(report.text).toMatch(/Changed files \(measured by git\)/);
    expect(report.text).toMatch(/the worker's own words/);

    const path = join(repo, ".orchestrator", "runs", "run-1.md");
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toContain(a);
  }, 30_000);

  test("an unknown run is an error that lists the runs there are; no runs at all is not", async () => {
    const { client } = await harness();
    expect((await call(client, "run_report", {})).text).toMatch(/No runs exist/);

    await spawn(client, "something");
    const bad = await call(client, "run_report", { runID: "run-nope" });
    expect(bad.isError).toBe(true);
    expect(bad.text).toContain("run-1");
  }, 20_000);

  test("every Phase 5 tool still returns inside two seconds (DD-1)", async () => {
    const { client } = await harness({ writeFiles: true }, { maxConcurrent: 2 });
    const a = await spawn(client, "one");
    const b = await spawn(client, "two");
    const c = await spawn(client, "three, queued");
    await call(client, "worker_wait", { ids: [a, b, c], mode: "all", timeoutMs: 15_000 });

    for (const [name, args] of [
      ["worker_spawn", { task: "another", runID: "run-1" }],
      ["worker_status", { ids: [a, b, c] }],
      ["worker_list", {}],
      ["run_report", { runID: "run-1" }],
    ] as const) {
      const r = await call(client, name, args as Record<string, unknown>);
      expect({ name, under2s: r.ms < 2_000 }).toEqual({ name, under2s: true });
    }
  }, 40_000);
});

// ---------------------------------------------------------------------------

describe("§11 Phase 5 AC", () => {
  test("three concurrent workers plus a dependent reach a gated merge and a run report", async () => {
    // Phase 5's half of the v1 demo: three workers run *at once* under the cap,
    // a fourth waits for one of them, and the wave lands on an integration
    // branch behind the test gate with a document to show for it. (Revisions —
    // the other half of §11's AC as written — are Phase 6's.)
    const { client, repo, orchestrator } = await harness(
      { writeFiles: true, perWorktreeFileName: true, workMs: 120 },
      { maxConcurrent: 3 },
    );

    const ui = await spawn(client, "build the settings UI", { ownedPaths: ["**"], testCommand: GOLDEN_TEST_COMMAND });
    const api = await spawn(client, "build the settings API", { ownedPaths: ["**"], testCommand: GOLDEN_TEST_COMMAND });
    const tests = await spawn(client, "write the settings tests", { ownedPaths: ["**"], testCommand: GOLDEN_TEST_COMMAND });
    // The fourth is over the cap *and* depends on the API — it must not start
    // before the API completes, whatever the cap does.
    const docs = await spawn(client, "document the settings page", {
      ownedPaths: ["**"],
      testCommand: GOLDEN_TEST_COMMAND,
      dependsOn: [api],
    });

    // Three concurrent, observed on the records rather than on a counter.
    let peak = 0;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const admitted = [ui, api, tests, docs].filter((id) =>
        ["preparing", "running", "blocked"].includes(orchestrator.manager.get(id)!.state),
      ).length;
      peak = Math.max(peak, admitted);
      expect(admitted).toBeLessThanOrEqual(3);
      if ([ui, api, tests, docs].every((id) => orchestrator.manager.get(id)!.state === "completed")) break;
      await sleep(5);
    }
    expect(peak).toBe(3);

    const all = await call(client, "worker_wait", { ids: [ui, api, tests, docs], mode: "all", timeoutMs: 20_000 });
    expect(all.text).toMatch(/All 4 worker\(s\) have settled/);
    // The dependent ran after its dependency, not merely at some point.
    expect(orchestrator.manager.get(docs)!.startedAt!).toBeGreaterThanOrEqual(orchestrator.manager.get(api)!.endedAt!);

    const started = await call(client, "workspace_merge", { workerIDs: [ui, api, tests, docs], runID: "run-1" });
    expect(started.isError).toBe(false);
    expect(started.ms).toBeLessThan(2_000);
    const mergeID = mergeIDFrom(started.text);
    const settled = await pollMerge(client, mergeID);
    expect(settled).toContain("MERGED GREEN");

    // Phase 4 wrote `state:merged` twice per worker — once from the state
    // machine's own hook and once beside it, with different detail. The run
    // report is what made it visible, as two identical timeline rows, so the
    // regression test lives next to the thing that caught it.
    const trail = await call(client, "worker_output", { id: ui, limit: 200 });
    expect(trail.text.split("\n").filter((l) => l.includes("state:merged"))).toHaveLength(1);
    expect(trail.text).toContain(mergeID);

    const report = await call(client, "run_report", { runID: "run-1" });
    expect(report.isError).toBe(false);
    for (const id of [ui, api, tests, docs]) expect(report.text).toContain(id);
    expect(report.text).toContain(mergeID);
    expect(report.text).toMatch(/\| merged \|/);
    expect(existsSync(join(repo, ".orchestrator", "runs", "run-1.md"))).toBe(true);
  }, 90_000);
});
