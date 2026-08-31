/**
 * §11 Phase 9 at the tool surface, over real JSON-RPC.
 *
 * The manager-side tests (`test/manager/phase9.test.ts`) prove the mechanisms.
 * These prove the thing that actually cost a run: **what Claude is told**. A
 * `worker_message` that reports "Answer delivered to w-001" about a write that
 * threw is not a mechanism bug at all — the manager rejected correctly — it is a
 * tool that lied about the rejection, and the only place to catch that is here,
 * in the text the host receives.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { OCMock } from "../ocmock/server.js";
import { createOrchestrator, type ManagerTuning, type Orchestrator } from "../../src/mcp/server.js";
import { ANSWER_CONFIRM_MS, WAIT_TIMEOUT_CEILING_MS, WAIT_TIMEOUT_MAX_MS, clampWaitMax } from "../../src/mcp/tools.js";
import { loadConfig, type ServerConfig } from "../../src/mcp/config.js";
import { DEFAULT_DASHBOARD_PORT } from "../../src/observe/index.js";
import { makeGoldenRepo } from "../fixtures/golden.js";
import { sleep } from "../helpers.js";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await Promise.resolve(fn()).catch(() => {});
});

const BLOCKED = {
  status: "blocked",
  summary: "I need a decision",
  changes: [] as unknown[],
  risks: [] as string[],
  questions: ["May I write scratch files to /tmp?"],
  followUps: [] as string[],
};

const DONE = {
  status: "completed",
  summary: "Created hello.txt as asked.",
  changes: [{ file: "hello.txt", action: "added" }],
  risks: [] as string[],
  questions: [] as string[],
  followUps: [] as string[],
};

interface Harness {
  client: Client;
  orchestrator: Orchestrator;
  mock: OCMock;
  repo: string;
}

async function harness(
  mockOpts: Parameters<typeof OCMock.start>[0] = {},
  tuning: ManagerTuning = {},
  configOver: Partial<ServerConfig> = {},
): Promise<Harness> {
  const repo = makeGoldenRepo("mcp9");
  cleanup.push(repo.cleanup);
  const mock = await OCMock.start({ heartbeatMs: 20, report: DONE, writeFiles: true, ...mockOpts });
  cleanup.push(() => mock.stop());

  const config: ServerConfig = {
    repoRoot: repo.path,
    dbPath: join(repo.path, ".orchestrator", "orchestrator.db"),
    defaultModel: "ocmock/test-model",
    baseUrl: mock.baseUrl,
    verifyTests: false,
    maxConcurrent: 3,
    maxRevisions: 3,
    maxRetries: 2,
    runBudgetTokens: 0,
    models: {},
    reviewPool: [],
    workspace: "isolated",
    waitMaxMs: 30_000,
    // A fixed port would collide with the other suites running alongside.
    dashboardPort: -1,
    permissionMode: "full",
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

  return { client, orchestrator, mock, repo: repo.path };
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
  const text = (res.content ?? [])
    .filter((c) => c.type === "text")
    .map((c) => c.text ?? "")
    .join("\n");
  return { text, isError: res.isError === true, ms: Date.now() - started };
}

function idFrom(text: string): string {
  const m = /\b(w-\d+)\b/.exec(text);
  if (!m) throw new Error(`no worker id in: ${text}`);
  return m[1]!;
}

async function pollUntil(client: Client, id: string, want: RegExp, ms = 6_000): Promise<string> {
  const deadline = Date.now() + ms;
  let last = "";
  while (Date.now() < deadline) {
    last = (await call(client, "worker_status", { ids: [id] })).text;
    if (want.test(last)) return last;
    await sleep(20);
  }
  throw new Error(`timed out waiting for ${want} on ${id}; last: ${last}`);
}

describe("worker_message never reports a delivery that did not happen", () => {
  test("a real answer is accepted, and says so without claiming it has resumed", async () => {
    const { client } = await harness({ report: BLOCKED, dropPromptsWithinMs: 30 });
    const id = idFrom((await call(client, "worker_spawn", { task: "create hello.txt" })).text);
    await pollUntil(client, id, /blocked/);

    const res = await call(client, "worker_message", { id, message: "yes, use your scratch directory" });
    expect(res.isError).toBe(false);
    expect(res.text).toContain("accepted");
    // DD-1 still holds: the confirmation window is an order of magnitude inside
    // the two-second budget.
    expect(res.ms).toBeLessThan(2_000);
  });

  test("a worker that is not blocked is refused, and the refusal says nothing was delivered", async () => {
    const { client } = await harness({ workMs: 500 });
    const id = idFrom((await call(client, "worker_spawn", { task: "create hello.txt" })).text);
    await pollUntil(client, id, /running/);

    const res = await call(client, "worker_message", { id, message: "hello?" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("NOTHING WAS DELIVERED");
  });

  test("a worker orphaned by a restart is refused and pointed at worker_recover", async () => {
    // The exact sequence from the field: block, lose the process, come back.
    const { client, orchestrator, mock, repo } = await harness({ report: BLOCKED, dropPromptsWithinMs: 30 });
    const id = idFrom((await call(client, "worker_spawn", { task: "create hello.txt" })).text);
    await pollUntil(client, id, /blocked/);
    orchestrator.manager.halt();

    const second = await createOrchestrator(
      {
        ...orchestrator.config,
        repoRoot: repo,
        baseUrl: mock.baseUrl,
      },
      { tickMs: 10 },
    );
    cleanup.push(() => second.dispose());
    const client2 = new Client({ name: "second-host", version: "0.0.0" });
    const [c2, s2] = InMemoryTransport.createLinkedPair();
    await Promise.all([second.server.connect(s2), client2.connect(c2)]);
    cleanup.push(() => client2.close());

    // `createOrchestrator` runs the restart sweep, so the row is `interrupted`
    // here. Either way the answer is the same and the recovery is named.
    const res = await call(client2, "worker_message", { id, message: "yes" });
    expect(res.isError).toBe(true);
    expect(res.text).toContain("NOTHING WAS DELIVERED");
    expect(res.text).toContain("worker_recover");

    // And the recovery it names actually works, which is the half that was
    // missing: worker_recover used to refuse anything that was not `interrupted`.
    const recovered = await call(client2, "worker_recover", { id, action: "discard" });
    expect(recovered.isError).toBe(false);
  });
});

describe("worker_result tells a blocked worker's story truthfully", () => {
  test("a live blocked worker is pointed at worker_message", async () => {
    const { client } = await harness({ report: BLOCKED, dropPromptsWithinMs: 30 });
    const id = idFrom((await call(client, "worker_spawn", { task: "create hello.txt" })).text);
    await pollUntil(client, id, /blocked/);
    const res = await call(client, "worker_result", { id });
    expect(res.text).toContain("worker_message");
    expect(res.text).not.toContain("NOTHING CAN ANSWER");
  });

  test("an unreachable blocked worker is pointed at worker_recover instead", async () => {
    const { client, orchestrator } = await harness({ report: BLOCKED, dropPromptsWithinMs: 30 });
    const id = idFrom((await call(client, "worker_spawn", { task: "create hello.txt" })).text);
    await pollUntil(client, id, /blocked/);

    // Drop the registry without writing, and without the restart sweep — the row
    // stays `blocked`, which is precisely the state that had no way out.
    orchestrator.manager.halt();

    const res = await call(client, "worker_result", { id });
    expect(res.text).toContain("NOTHING CAN ANSWER THEM ANY MORE");
    expect(res.text).toContain("worker_recover");
  });

  // §11 Phase 10. `renderBlocked` learned this in Phase 9 and the status line did
  // not, so the two halves of one tool call disagreed: `worker_result` said the
  // session was gone while the `next:` hint beside it still said to answer the
  // worker. Both now come from `manager.isOrphaned`.

  test("worker_status gives the same advice as worker_result about an unreachable worker", async () => {
    const { client, orchestrator } = await harness({ report: BLOCKED, dropPromptsWithinMs: 30 });
    const id = idFrom((await call(client, "worker_spawn", { task: "create hello.txt" })).text);
    await pollUntil(client, id, /blocked/);
    orchestrator.manager.halt();

    const res = await call(client, "worker_status", { ids: [id] });
    expect(res.text).toContain("worker_recover");
    // The one that mattered: sending Claude to a tool that cannot possibly work
    // is worse than saying nothing, because it looks like progress.
    expect(res.text).not.toContain("worker_message");
  });

  test("a live blocked worker is still pointed at worker_message by worker_status", async () => {
    // The negative half. A hint that names `worker_recover` for every blocked
    // worker would be just as wrong, in the other direction.
    const { client } = await harness({ report: BLOCKED, dropPromptsWithinMs: 30 });
    const id = idFrom((await call(client, "worker_spawn", { task: "create hello.txt" })).text);
    await pollUntil(client, id, /blocked/);

    const res = await call(client, "worker_status", { ids: [id] });
    expect(res.text).toContain("worker_message");
    expect(res.text).not.toContain("worker_recover");
  });

  test("worker_wait's status line carries the same correction", async () => {
    // `wait` resolves on `blocked` as well as on settled, so it renders the same
    // line from a different call path — and had the same bug.
    const { client, orchestrator } = await harness({ report: BLOCKED, dropPromptsWithinMs: 30 });
    const id = idFrom((await call(client, "worker_spawn", { task: "create hello.txt" })).text);
    await pollUntil(client, id, /blocked/);
    orchestrator.manager.halt();

    const res = await call(client, "worker_wait", { ids: [id], timeoutMs: 2_000 });
    expect(res.text).toContain("worker_recover");
    expect(res.text).not.toContain("worker_message");
  });
});

describe("worker_spawn surfaces a model capability instead of burying it", () => {
  test("a model measured refusing the schema is named at spawn", async () => {
    const { client, orchestrator } = await harness();
    orchestrator.store.putModelCapability("ocmock/test-model", {
      structuredOutput: false,
      at: Date.now(),
      code: "api",
      message: "tool_choice required",
    });
    // The manager caches the set at construction, so a second one is what a
    // real restart gives — and is what makes this observable through the tools.
    const second = await createOrchestrator({ ...orchestrator.config }, { tickMs: 10 });
    cleanup.push(() => second.dispose());
    const c = new Client({ name: "host", version: "0.0.0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([second.server.connect(b), c.connect(a)]);
    cleanup.push(() => c.close());

    const res = await call(c, "worker_spawn", { task: "create hello.txt" });
    expect(res.text).toContain("rejecting schema-constrained replies");
    expect(res.text).toContain("reportSource");
  });

  test("nothing is said about a model nothing is known about", async () => {
    const { client } = await harness();
    const res = await call(client, "worker_spawn", { task: "create hello.txt" });
    expect(res.text).not.toContain("rejecting schema-constrained replies");
  });
});

describe("worker_wait's cap is configurable and bounded", () => {
  test("the schema advertises the configured cap, not the built-in default", async () => {
    const { client } = await harness({}, {}, { waitMaxMs: 45_000 });
    const tools = await client.listTools();
    const wait = tools.tools.find((t) => t.name === "worker_wait")!;
    expect(wait.description).toContain("up to 45 seconds");
    const schema = wait.inputSchema as { properties?: Record<string, { maximum?: number }> };
    expect(schema.properties?.["timeoutMs"]?.maximum).toBe(45_000);
  });

  test("a wait still returns inside the cap it was given", async () => {
    const { client } = await harness({ workMs: 5_000 });
    const id = idFrom((await call(client, "worker_spawn", { task: "create hello.txt" })).text);
    const res = await call(client, "worker_wait", { id, timeoutMs: 300 });
    expect(res.isError).toBe(false);
    expect(res.text).toContain("still working");
    expect(res.ms).toBeLessThan(2_500);
  });

  test("clampWaitMax turns a typo into a default rather than a broken server", () => {
    expect(clampWaitMax(undefined)).toBe(WAIT_TIMEOUT_MAX_MS);
    expect(clampWaitMax(Number.NaN)).toBe(WAIT_TIMEOUT_MAX_MS);
    expect(clampWaitMax(0)).toBe(1_000);
    expect(clampWaitMax(-5)).toBe(1_000);
    expect(clampWaitMax(45_000)).toBe(45_000);
    // No upper surprise either: a value past the ceiling is clamped, not honoured.
    expect(clampWaitMax(99_999_999)).toBe(WAIT_TIMEOUT_CEILING_MS);
  });

  test("the confirmation window leaves the two-second budget intact", () => {
    expect(ANSWER_CONFIRM_MS).toBeLessThan(2_000);
  });
});

describe("the timeout probe can measure the ceiling that progress notifications buy", () => {
  test("it takes progressEveryMs and reports how many frames it sent", async () => {
    const { client } = await harness();
    const res = await call(client, "orchestrator_timeout_probe", { delayMs: 350, progressEveryMs: 250 });
    const body = JSON.parse(res.text) as { returned: boolean; progressSent: number; progressRequested: boolean };
    expect(body.returned).toBe(true);
    // No progress token is sent unless the client asks for one, so
    // `progressRequested` is what distinguishes "measured nothing" from
    // "measured a host that ignores progress".
    expect(body.progressRequested).toBe(false);
    expect(body.progressSent).toBe(0);
  });

  test("without progressEveryMs it behaves exactly as it did before", async () => {
    const { client } = await harness();
    const res = await call(client, "orchestrator_timeout_probe", { delayMs: 50 });
    const body = JSON.parse(res.text) as { requestedMs: number; returned: boolean };
    expect(body.requestedMs).toBe(50);
    expect(body.returned).toBe(true);
  });
});

describe("configuration", () => {
  test("the dashboard is on by default and takes one variable to switch off", () => {
    expect(loadConfig({}, "/repo").dashboardPort).toBe(DEFAULT_DASHBOARD_PORT);
    expect(loadConfig({ ORCHESTRATOR_DASHBOARD: "0" }, "/repo").dashboardPort).toBe(-1);
    expect(loadConfig({ ORCHESTRATOR_DASHBOARD: "off" }, "/repo").dashboardPort).toBe(-1);
    expect(loadConfig({ ORCHESTRATOR_DASHBOARD_PORT: "9999" }, "/repo").dashboardPort).toBe(9999);
    // 0 means "any free port", which is a legitimate setting rather than off.
    expect(loadConfig({ ORCHESTRATOR_DASHBOARD_PORT: "0" }, "/repo").dashboardPort).toBe(0);
    // A typo falls back to the default rather than silently disabling it — the
    // explicit off switch is the way to turn it off.
    expect(loadConfig({ ORCHESTRATOR_DASHBOARD_PORT: "nonsense" }, "/repo").dashboardPort).toBe(DEFAULT_DASHBOARD_PORT);
    expect(loadConfig({ ORCHESTRATOR_DASHBOARD_PORT: "70000" }, "/repo").dashboardPort).toBe(DEFAULT_DASHBOARD_PORT);
  });

  test("the wait cap comes from the environment, clamped", () => {
    expect(loadConfig({}, "/repo").waitMaxMs).toBe(WAIT_TIMEOUT_MAX_MS);
    expect(loadConfig({ ORCHESTRATOR_WAIT_MAX_MS: "50000" }, "/repo").waitMaxMs).toBe(50_000);
    expect(loadConfig({ ORCHESTRATOR_WAIT_MAX_MS: "banana" }, "/repo").waitMaxMs).toBe(WAIT_TIMEOUT_MAX_MS);
  });
});

describe("the orchestrator wires the dashboard to the run", () => {
  test("with the dashboard on, the transcript reaches the ring and the store reaches the stream", async () => {
    const { client, orchestrator } = await harness({}, {}, { dashboardPort: 0 });
    expect(orchestrator.dashboard).toBeDefined();

    const id = idFrom((await call(client, "worker_spawn", { task: "create hello.txt" })).text);
    await pollUntil(client, id, /completed/, 10_000);

    // The live transcript exists and is about this worker...
    expect(orchestrator.activity.entries(id).length).toBeGreaterThan(0);
    // ...and is reachable from the dashboard rather than from any tool.
    const res = await fetch(`${orchestrator.dashboard!.url}/api/worker/${id}/detail`);
    const body = (await res.json()) as { activity: unknown[]; events: unknown[] };
    expect(body.activity.length).toBeGreaterThan(0);
    expect(body.events.length).toBeGreaterThan(0);

    // The firewall still holds in the direction that matters: no tool returns it.
    const output = await call(client, "worker_output", { id });
    expect(output.text).not.toContain("prompt sent");
  });

  test("with the dashboard off, nothing binds and the run is unaffected", async () => {
    const { client, orchestrator } = await harness({}, {}, { dashboardPort: -1 });
    expect(orchestrator.dashboard).toBeUndefined();
    const id = idFrom((await call(client, "worker_spawn", { task: "create hello.txt" })).text);
    await pollUntil(client, id, /completed/, 10_000);
    // The ring is still filled — it costs nothing and is what a later `watch`
    // would show — but nothing is listening on a socket.
    expect(orchestrator.activity.entries(id).length).toBeGreaterThan(0);
  });
});
