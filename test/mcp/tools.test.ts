/**
 * The tool surface, driven the way a host drives it (§11 Phase 3).
 *
 * Every test here goes over real JSON-RPC — a `Client` and the real `McpServer`
 * joined by the SDK's in-memory transport pair — rather than calling the
 * handlers directly. That is not ceremony. Calling a handler skips schema
 * validation, skips serialization, and skips registration entirely, so a zod
 * schema the SDK refuses to convert to JSON Schema passes every direct-call test
 * and then fails at `listTools` in front of the user. Here it fails in the
 * suite.
 *
 * The backend underneath is `ocmock`, so a whole worker's life takes about as
 * long as real OpenCode spends warming up.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { OCMock } from "../ocmock/server.js";
import { createDispatchedCode, type ManagerTuning, type DispatchedCode } from "../../src/mcp/server.js";
import { WAIT_TIMEOUT_MAX_MS } from "../../src/mcp/tools.js";
import type { ServerConfig } from "../../src/mcp/config.js";
import { makeGoldenRepo } from "../fixtures/golden.js";
import { sleep } from "../helpers.js";

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
  followUps: [],
};

interface Harness {
  client: Client;
  dispatched: DispatchedCode;
  mock: OCMock;
  repo: string;
  /** Total characters of tool-result text this client has been handed. */
  chars: () => number;
}

async function harness(
  mockOpts: Parameters<typeof OCMock.start>[0] = {},
  tuning: ManagerTuning = {},
  configOver: Partial<ServerConfig> = {},
): Promise<Harness> {
  const repo = makeGoldenRepo("mcp");
  cleanup.push(repo.cleanup);
  const mock = await OCMock.start({ heartbeatMs: 20, ...mockOpts });
  cleanup.push(() => mock.stop());

  const config: ServerConfig = {
    repoRoot: repo.path,
    dbPath: join(repo.path, ".dispatched-code", "dispatched-code.db"),
    defaultModel: "ocmock/test-model",
    baseUrl: mock.baseUrl,
    verifyTests: false,
    maxConcurrent: 3,
    maxRevisions: 3,
    maxRetries: 2,
    runBudgetTokens: 0,
    models: {},
    reviewPool: [],
    // These suites are about ISOLATION — worktrees, branches, the merge gate.
    // Phase 8 made `shared` the product default, so they now say so explicitly.
    workspace: "isolated",
    waitMaxMs: 30_000,
    // Off in tests: a fixed port would collide across parallel test files, and
    // nothing here is asserting on the dashboard.
    dashboardPort: -1,
    permissionMode: "full",
    ...configOver,
  };
  const dispatched = await createDispatchedCode(config, {
    tickMs: 10,
    budgetPollMs: 20,
    abortGraceMs: 400,
    retrySettleMs: 60,
    ...tuning,
  });
  cleanup.push(() => dispatched.dispose());

  const client = new Client({ name: "test-host", version: "0.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([dispatched.server.connect(serverSide), client.connect(clientSide)]);
  cleanup.push(() => client.close());

  return { client, dispatched, mock, repo: repo.path, chars: () => budget.total };
}

/** Accumulates what every tool result cost, for the §8 / Phase 3 budget check. */
const budget = { total: 0 };

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
  const text = (res.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
  budget.total += text.length;
  return { text, isError: res.isError === true, ms: Date.now() - started };
}

/** The id `worker_spawn` reports back, so the tests read it the way Claude does. */
function idFrom(text: string): string {
  const m = /\b(w-\d+)\b/.exec(text);
  if (!m) throw new Error(`no worker id in: ${text}`);
  return m[1]!;
}

async function pollUntil(client: Client, id: string, want: RegExp, ms = 5_000): Promise<string> {
  const deadline = Date.now() + ms;
  let last = "";
  while (Date.now() < deadline) {
    last = (await call(client, "worker_status", { ids: [id] })).text;
    if (want.test(last)) return last;
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${want} on ${id}; last status was: ${last}`);
}

const spawnArgs = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  task: "create hello.txt",
  mode: "implement",
  ownedPaths: ["hello.txt"],
  runID: "run-1",
  ...over,
});

// ---------------------------------------------------------------------------

describe("registration", () => {
  test("every tool the phase promised is registered, with a schema the SDK accepts", async () => {
    // `listTools` is where zod becomes JSON Schema. A schema the SDK cannot
    // convert throws here and nowhere earlier — which is the whole reason these
    // tests go over the protocol instead of calling the handlers.
    const { client } = await harness();
    const names = (await client.listTools()).tools.map((t) => t.name).sort();

    expect(names).toEqual([
      "dispatched_code_timeout_probe",
      "run_report",
      "worker_budget",
      "worker_diff",
      "worker_list",
      "worker_message",
      "worker_output",
      "worker_recover",
      "worker_result",
      "worker_revise",
      "worker_spawn",
      "worker_status",
      "worker_stop",
      "worker_wait",
      "workspace_cleanup",
      "workspace_merge",
      "workspace_merge_status",
    ]);
  });

  test("the descriptions carry the delegation heuristics and the trust model", async () => {
    // §7: "delegation heuristics live in the tool descriptions so Claude
    // self-calibrates". They are the least testable and most load-bearing part
    // of the phase; this at least fails if someone deletes them.
    const { client } = await harness();
    const tools = (await client.listTools()).tools;
    const spawn = tools.find((t) => t.name === "worker_spawn")!;
    const result = tools.find((t) => t.name === "worker_result")!;

    expect(spawn.description).toMatch(/DO NOT DELEGATE/);
    expect(spawn.description).toMatch(/single-file/i);
    expect(spawn.description).toMatch(/2-5/);
    // DD-8: the summary is a claim, the discrepancies are the finding.
    expect(result.description).toMatch(/claim/i);
    expect(result.description).toMatch(/discrepanc/i);
  });

  test("tools that were never designed stay absent rather than half-built", async () => {
    // Phase 4 moved `worker_diff`, `workspace_merge` and `workspace_cleanup` out
    // of this list by building them; Phase 5 took the batched wait out by
    // building it *into* `worker_wait` rather than beside it — one tool that
    // takes `id` or `ids` beats two that differ by a suffix. **Phase 6 took
    // `worker_revise` out by building it**, and deliberately did not add a
    // `worker_review` beside it: a reviewer is a worker, so it is spawned by
    // `worker_spawn({mode: "review", reviewOf})` like every other worker, and a
    // second spawn tool that differed only in its mode would be the same mistake
    // `worker_wait_all` would have been.
    const { client } = await harness();
    const tools = (await client.listTools()).tools;
    const names = tools.map((t) => t.name);
    expect(names).toContain("worker_revise");
    for (const absent of ["worker_wait_all", "worker_review", "workspace_status"]) {
      expect(names).not.toContain(absent);
    }
    const spawn = tools.find((t) => t.name === "worker_spawn")!;
    expect(Object.keys((spawn.inputSchema as { properties: Record<string, unknown> }).properties)).toContain("reviewOf");
    const wait = tools.find((t) => t.name === "worker_wait")!;
    expect(Object.keys((wait.inputSchema as { properties: Record<string, unknown> }).properties)).toContain("ids");
  });

  test("workspace_merge says it returns before the merge finishes, and that it is gated", async () => {
    // §7's row read "merge + test-gate result", which is synchronous and
    // impossible against a 60s host ceiling. The description is where a model
    // learns otherwise, so the description is what this asserts on.
    const { client } = await harness();
    const tools = (await client.listTools()).tools;
    const merge = tools.find((t) => t.name === "workspace_merge")!;
    const cleanup = tools.find((t) => t.name === "workspace_cleanup")!;

    expect(merge.description).toMatch(/workspace_merge_status/);
    expect(merge.description).toMatch(/ONE AT A TIME/);
    // The two safety properties a model must not have to infer.
    expect(merge.description).toMatch(/reset\s+--hard|rolled back|never left half-merged/i);
    expect(merge.description).toMatch(/CHECKOUT IS NOT TOUCHED/);
    // Cleanup's `force` has to say what it destroys, not just that it forces.
    expect(cleanup.description).toMatch(/DELETES UNMERGED COMMITS/);
  });
});

// ---------------------------------------------------------------------------

describe("the full loop over JSON-RPC", () => {
  test("spawn → wait → result", async () => {
    const { client } = await harness({ writeFiles: true, report: TRUTHFUL });

    const spawned = await call(client, "worker_spawn", spawnArgs());
    expect(spawned.isError).toBe(false);
    // DD-1: the work has not started yet, and the tool is already back.
    expect(spawned.ms).toBeLessThan(2_000);
    const id = idFrom(spawned.text);

    const waited = await call(client, "worker_wait", { id, timeoutMs: 5_000 });
    expect(waited.text).toMatch(/\[completed[\]:]/);
    expect(waited.text).toMatch(/settled after/);

    const result = await call(client, "worker_result", { id });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("Created hello.txt as asked.");
    expect(result.text).toContain("hello.txt");
    expect(result.text).toContain("Discrepancies: none");
    expect(result.text).toContain("status: completed");
  });

  test("a lying report reaches Claude as a finding, not as a summary to believe", async () => {
    const { client } = await harness({ scenario: "lying_report" });
    const id = idFrom((await call(client, "worker_spawn", spawnArgs({ ownedPaths: ["src/**"] }))).text);
    await call(client, "worker_wait", { id, timeoutMs: 5_000 });

    const result = await call(client, "worker_result", { id });
    expect(result.text).toContain("claimed_not_changed");
    expect(result.text).toContain("src/index.ts");
  });

  test("worker_list and worker_status agree about what exists", async () => {
    const { client } = await harness({ writeFiles: true, report: TRUTHFUL });
    const id = idFrom((await call(client, "worker_spawn", spawnArgs())).text);
    await call(client, "worker_wait", { id, timeoutMs: 5_000 });

    const list = await call(client, "worker_list", {});
    expect(list.text).toContain(id);
    expect(list.text).toContain("completed");
    expect((await call(client, "worker_list", { state: "failed" })).text).toMatch(/No workers match/);
    expect((await call(client, "worker_list", { runID: "run-1" })).text).toContain(id);

    // With nothing active, `worker_status` says so rather than listing history.
    expect((await call(client, "worker_status", {})).text).toMatch(/No workers are active/);
    expect((await call(client, "worker_status", { ids: [id] })).text).toContain("[completed]");
  });
});

// ---------------------------------------------------------------------------

describe("the blocked path", () => {
  const BLOCKED = {
    status: "blocked",
    summary: "I need a decision",
    changes: [],
    questions: ["May I edit src/router.ts? It is outside the paths I was given."],
  };

  test("worker_result on a blocked worker renders the record, not a crash and not an empty result", async () => {
    // The single most likely null-dereference in the phase: `blocked` is settled
    // but has no `WorkerResult`, because results are built at settle and this is
    // a worker that stopped to ask, not one that finished.
    const { client } = await harness({ writeFiles: true, report: BLOCKED, dropPromptsWithinMs: 30 });
    const id = idFrom((await call(client, "worker_spawn", spawnArgs())).text);
    await call(client, "worker_wait", { id, timeoutMs: 5_000 });

    const result = await call(client, "worker_result", { id });
    expect(result.isError).toBe(false);
    expect(result.text).toContain("status: blocked");
    expect(result.text).toContain("May I edit src/router.ts?");
    expect(result.text).toContain("worker_message");
    // The failure mode this replaces: a result that reads like a worker that did nothing.
    expect(result.text).not.toContain("produced no usable report");
  });

  test("blocked → message → completed, on the same session", async () => {
    const { client, mock, dispatched } = await harness({
      writeFiles: true,
      report: BLOCKED,
      dropPromptsWithinMs: 30,
    });
    const id = idFrom((await call(client, "worker_spawn", spawnArgs())).text);
    await call(client, "worker_wait", { id, timeoutMs: 5_000 });

    const sessionID = dispatched.manager.get(id)!.sessionID!;
    mock.setReport(sessionID, TRUTHFUL);

    const answered = await call(client, "worker_message", { id, message: "Yes, but only the route table." });
    expect(answered.isError).toBe(false);

    await pollUntil(client, id, /\[completed[\]:]/);
    const result = await call(client, "worker_result", { id });
    expect(result.text).toContain("Created hello.txt as asked.");

    // One session, two prompts: the answer resumed the worker rather than restarting it.
    const prompts = mock.requests.filter((r) => r.path.includes(sessionID) && r.path.endsWith("/prompt_async"));
    expect(prompts).toHaveLength(2);
    expect(mock.droppedPromptsOf(sessionID)).toBe(0);
  }, 15_000);

  test("answering a worker that is not blocked is refused with a reason", async () => {
    const { client } = await harness({ writeFiles: true, report: TRUTHFUL });
    const id = idFrom((await call(client, "worker_spawn", spawnArgs())).text);
    await call(client, "worker_wait", { id, timeoutMs: 5_000 });

    const refused = await call(client, "worker_message", { id, message: "hello?" });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/not blocked/);
  });
});

// ---------------------------------------------------------------------------

describe("DD-1: nothing blocks", () => {
  test("worker_message returns before the worker has resumed", async () => {
    // `manager.answer()` resolves only once the follow-up prompt is away, and a
    // session that has just gone terminal will not accept one for
    // `retrySettleMs`. Held at 2.5s here, so a tool that awaited the manager
    // could not come back inside DD-1's two seconds. A test that only checked
    // the final state would pass either way — which is the trap.
    const { client } = await harness(
      { writeFiles: true, report: { status: "blocked", summary: "?", changes: [], questions: ["which one?"] } },
      { retrySettleMs: 2_500 },
    );
    const id = idFrom((await call(client, "worker_spawn", spawnArgs())).text);
    await call(client, "worker_wait", { id, timeoutMs: 5_000 });

    const answered = await call(client, "worker_message", { id, message: "the first one" });
    expect(answered.ms).toBeLessThan(2_000);
    // Still blocked: proof the tool returned while the operation was in flight.
    expect((await call(client, "worker_status", { ids: [id] })).text).toMatch(/\[blocked/);
  });

  test("worker_stop returns before the worker has stopped", async () => {
    // Same shape, the other slow method: `cancel()` waits for the run loop to
    // settle, and here even the abort request itself is held for 2.5s.
    const { client } = await harness({ scenario: "hang", abortDelayMs: 2_500 }, { abortGraceMs: 10_000 });
    const id = idFrom((await call(client, "worker_spawn", spawnArgs())).text);
    await pollUntil(client, id, /\[running/);

    const stopped = await call(client, "worker_stop", { id, reason: "changed my mind" });
    expect(stopped.isError).toBe(false);
    expect(stopped.ms).toBeLessThan(2_000);
    expect((await call(client, "worker_status", { ids: [id] })).text).not.toMatch(/\[cancelled/);

    // And it really does stop, once the abort lands.
    await pollUntil(client, id, /\[cancelled/, 8_000);
    expect((await call(client, "worker_result", { id })).text).toContain("status: cancelled");
  });

  test("every read tool returns well inside two seconds", async () => {
    const { client } = await harness({ writeFiles: true, report: TRUTHFUL });
    const id = idFrom((await call(client, "worker_spawn", spawnArgs())).text);
    await call(client, "worker_wait", { id, timeoutMs: 5_000 });

    for (const [name, args] of [
      ["worker_status", { ids: [id] }],
      ["worker_result", { id }],
      ["worker_output", { id }],
      ["worker_list", {}],
      ["worker_stop", { id }],
    ] as const) {
      const outcome = await call(client, name, args);
      expect({ name, ms: outcome.ms }).toMatchObject({ name });
      expect(outcome.ms).toBeLessThan(2_000);
    }
  });

  test("worker_wait honours its cap and a timeout is not an error", async () => {
    const { client } = await harness({ scenario: "hang" });
    const id = idFrom((await call(client, "worker_spawn", spawnArgs())).text);

    const waited = await call(client, "worker_wait", { id, timeoutMs: 300 });
    expect(waited.isError).toBe(false);
    expect(waited.ms).toBeLessThan(2_000);
    expect(waited.text).toMatch(/still working/);

    // The cap is in the published JSON Schema, so a well-behaved host never
    // sends an over-long request; one that does is refused by the SDK before the
    // handler runs, which is the belt to that braces.
    const over = await call(client, "worker_wait", { id, timeoutMs: 120_000 });
    expect(over.isError).toBe(true);
    expect(over.text).toMatch(/30000/);

    const schema = (await client.listTools()).tools.find((t) => t.name === "worker_wait")!.inputSchema as unknown as {
      properties: { timeoutMs: { maximum: number } };
    };
    expect(schema.properties.timeoutMs.maximum).toBe(WAIT_TIMEOUT_MAX_MS);
  });
});

// ---------------------------------------------------------------------------

describe("pagination and truncation (§8)", () => {
  test("worker_output pages, and the cursor continues rather than repeats", async () => {
    const { client, dispatched } = await harness({ writeFiles: true, report: TRUTHFUL });
    const id = idFrom((await call(client, "worker_spawn", spawnArgs())).text);
    await call(client, "worker_wait", { id, timeoutMs: 5_000 });
    for (let i = 0; i < 12; i++) dispatched.store.appendEvent(id, `synthetic_${i}`, { i });

    const first = await call(client, "worker_output", { id, limit: 5 });
    expect(first.text).toMatch(/more remain — call again with cursor: (\d+)/);
    const cursor = Number(/cursor: (\d+)/.exec(first.text)![1]);

    const second = await call(client, "worker_output", { id, cursor, limit: 5 });
    // Ids are monotonic, so "continues" is checkable: nothing on page two may
    // appear on page one.
    const idsOf = (t: string): number[] => [...t.matchAll(/^\s*(\d+) \+/gm)].map((m) => Number(m[1]));
    expect(idsOf(second.text).every((n) => n > cursor)).toBe(true);
    expect(idsOf(first.text)).not.toContain(idsOf(second.text)[0]);

    // Past the end is an answer, not an error.
    const end = await call(client, "worker_output", { id, cursor: 100_000 });
    expect(end.isError).toBe(false);
    expect(end.text).toMatch(/trail is complete/);
  });

  test("a worker cannot flood the context by asking a very long question", async () => {
    // DD-8: questions are worker-authored text. The cap is a boundary, not tidiness.
    const flood = {
      status: "blocked",
      summary: "x".repeat(20_000),
      changes: [],
      questions: Array.from({ length: 40 }, (_, i) => `q${i} ${"y".repeat(5_000)}`),
    };
    const { client } = await harness({ report: flood });
    const id = idFrom((await call(client, "worker_spawn", spawnArgs())).text);
    await call(client, "worker_wait", { id, timeoutMs: 5_000 });

    const result = await call(client, "worker_result", { id });
    // 40 questions of 5k characters each is 200KB of model-authored text. What
    // reaches Claude is a page.
    expect(result.text.length).toBeLessThan(4_000);
    expect(result.text).toMatch(/…and \d+ more/);
  });

  test("a status line stays small however long the task was", async () => {
    const { client } = await harness({ scenario: "hang" });
    const id = idFrom((await call(client, "worker_spawn", spawnArgs({ task: "T".repeat(1_900) }))).text);
    const status = await call(client, "worker_status", { ids: [id] });
    expect(status.text.length).toBeLessThan(500);
  });
});

// ---------------------------------------------------------------------------

describe("errors are answers, not exceptions", () => {
  test("an unknown worker id gets a usable message from every tool", async () => {
    const { client } = await harness();
    for (const [name, args] of [
      ["worker_status", { ids: ["w-999"] }],
      ["worker_result", { id: "w-999" }],
      ["worker_output", { id: "w-999" }],
      ["worker_wait", { id: "w-999" }],
      ["worker_stop", { id: "w-999" }],
      ["worker_message", { id: "w-999", message: "hi" }],
    ] as const) {
      const outcome = await call(client, name, args);
      expect(outcome.text).toMatch(/w-999/);
    }
    expect((await call(client, "worker_result", { id: "w-999" })).isError).toBe(true);
  });

  test("a dependsOn naming a worker that does not exist is rejected, and leaves no row", async () => {
    // Phase 5 implemented `dependsOn`; what is still rejected is a dependency
    // that could never be satisfied. Ids are minted by worker_spawn, so an id
    // nobody has been handed is a typo, and honouring it would produce a worker
    // that never starts and never says why. The `worker_list` assertion is the
    // load-bearing half: a rejected spawn must not leave a row behind to explain.
    const { client } = await harness();
    const rejected = await call(client, "worker_spawn", spawnArgs({ dependsOn: ["w-999"] }));
    expect(rejected.isError).toBe(true);
    expect(rejected.text).toMatch(/w-999/);
    expect(rejected.text).toMatch(/do not exist/);
    expect((await call(client, "worker_list", {})).text).toMatch(/No workers/);
  });

  test("stopping an already-settled worker is a no-op, not a failure", async () => {
    const { client } = await harness({ writeFiles: true, report: TRUTHFUL });
    const id = idFrom((await call(client, "worker_spawn", spawnArgs())).text);
    await call(client, "worker_wait", { id, timeoutMs: 5_000 });

    const stopped = await call(client, "worker_stop", { id });
    expect(stopped.isError).toBe(false);
    expect(stopped.text).toMatch(/already stopped/);
  });
});

// ---------------------------------------------------------------------------

describe("the context budget (Phase 3 AC)", () => {
  test("a whole spawn → wait → result round trip costs under 2k tokens", async () => {
    // The acceptance criterion is a number, so this measures rather than
    // asserts. Method: sum the characters of every tool result the host was
    // handed during the interaction and divide by four — the same method
    // recorded in docs/phase3-notes.md, so the two can be compared.
    const { client } = await harness({ writeFiles: true, report: TRUTHFUL });
    const before = budget.total;

    const spawned = await call(client, "worker_spawn", spawnArgs());
    const id = idFrom(spawned.text);
    await call(client, "worker_wait", { id, timeoutMs: 5_000 });
    await call(client, "worker_result", { id });

    const chars = budget.total - before;
    const tokens = Math.ceil(chars / 4);
    expect(tokens).toBeLessThan(2_000);
    // Headroom check: if this ever creeps up, it is a rendering change and the
    // number in the phase notes needs re-taking.
    expect(chars).toBeLessThan(3_000);
  });
});
