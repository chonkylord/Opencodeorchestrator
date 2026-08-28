/**
 * The server around the tools: configuration, start-up order, and what the host
 * sees after a crash.
 *
 * §9 says recovery runs before anything else, and the reason it is tested here
 * rather than only in the manager's own suite is that Phase 3 is where it
 * becomes visible: a row left `running` by a dead process is a lie the *tools*
 * would otherwise report as a live worker.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { OCMock } from "../ocmock/server.js";
import { DEFAULT_DB_RELATIVE, DEFAULT_MODEL_ENV, loadConfig, type ServerConfig } from "../../src/mcp/config.js";
import { createOrchestrator, type Orchestrator } from "../../src/mcp/server.js";
import { makeGoldenRepo } from "../fixtures/golden.js";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await Promise.resolve(fn()).catch(() => {});
});

async function connect(o: Orchestrator): Promise<Client> {
  const client = new Client({ name: "test-host", version: "0.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([o.server.connect(serverSide), client.connect(clientSide)]);
  cleanup.push(() => client.close());
  return client;
}

async function textOf(client: Client, name: string, args: Record<string, unknown> = {}): Promise<string> {
  const res = (await client.callTool({ name, arguments: args })) as { content?: Array<{ text?: string }> };
  return (res.content ?? []).map((c) => c.text ?? "").join("\n");
}

describe("configuration", () => {
  test("defaults orchestrate the directory the host started in", () => {
    const c = loadConfig({}, "/srv/project");
    expect(c.repoRoot).toBe("/srv/project");
    expect(c.dbPath).toBe(join("/srv/project", DEFAULT_DB_RELATIVE));
    expect(c.defaultModel).toBe(DEFAULT_MODEL_ENV);
    expect(c.verifyTests).toBe(true);
    expect(c.baseUrl).toBeUndefined();
  });

  test("every documented variable is honoured, and relative paths are resolved", () => {
    const c = loadConfig(
      {
        ORCHESTRATOR_REPO: "/repo",
        ORCHESTRATOR_DB: "/var/lib/orch.db",
        ORCHESTRATOR_MODEL: "acme/big",
        ORCHESTRATOR_BASE_URL: "http://127.0.0.1:4096",
        ORCHESTRATOR_VERIFY_TESTS: "0",
      },
      "/ignored",
    );
    expect(c).toEqual({
      repoRoot: "/repo",
      dbPath: "/var/lib/orch.db",
      defaultModel: "acme/big",
      baseUrl: "http://127.0.0.1:4096",
      verifyTests: false,
    });
    // `:memory:` is a SQLite keyword, not a path, and must survive resolution.
    expect(loadConfig({ ORCHESTRATOR_DB: ":memory:" }, "/x").dbPath).toBe(":memory:");
  });
});

describe("start-up and recovery (§9)", () => {
  test("a worker orphaned by a dead process comes back as interrupted, with its worktree intact", async () => {
    const repo = makeGoldenRepo("mcp-recover");
    cleanup.push(repo.cleanup);
    const mock = await OCMock.start({ scenario: "hang", heartbeatMs: 20 });
    cleanup.push(() => mock.stop());

    const config: ServerConfig = {
      repoRoot: repo.path,
      dbPath: join(repo.path, ".orchestrator", "orchestrator.db"),
      defaultModel: "ocmock/test-model",
      baseUrl: mock.baseUrl,
      verifyTests: false,
    };

    const first = await createOrchestrator(config, { tickMs: 10, abortGraceMs: 200 });
    const clientA = await connect(first);
    const spawned = await textOf(clientA, "worker_spawn", { task: "hang around", ownedPaths: ["x"] });
    const id = /\b(w-\d+)\b/.exec(spawned)![1]!;
    // Let it get as far as `running` before the process "dies".
    const deadline = Date.now() + 3_000;
    while (first.manager.get(id)?.state !== "running" && Date.now() < deadline) await Bun.sleep(10);
    expect(first.manager.get(id)!.state).toBe("running");
    const worktree = first.manager.get(id)!.worktree;

    // `halt()` is a crash, not a shutdown: it writes nothing, which is exactly
    // the state recovery has to cope with.
    first.manager.halt();
    await clientA.close();

    const second = await createOrchestrator(config, { tickMs: 10 });
    cleanup.push(() => second.dispose());
    const clientB = await connect(second);

    // The row said `running`. Nothing was running. That is the lie §9 exists for.
    const status = await textOf(clientB, "worker_status", { ids: [id] });
    expect(status).toMatch(/\[interrupted/);
    expect(status).toContain("manager_restart");

    // And the tool that reads results does not dereference one that was never built.
    const result = await textOf(clientB, "worker_result", { id });
    expect(result).toMatch(/no stored result/);
    expect(result).toContain(worktree);
    expect(result).not.toContain("undefined");
  }, 20_000);

  test("dispose stops the workers and closes the index", async () => {
    const repo = makeGoldenRepo("mcp-dispose");
    cleanup.push(repo.cleanup);
    const mock = await OCMock.start({ scenario: "hang", heartbeatMs: 20 });
    cleanup.push(() => mock.stop());

    const o = await createOrchestrator(
      {
        repoRoot: repo.path,
        dbPath: ":memory:",
        defaultModel: "ocmock/test-model",
        baseUrl: mock.baseUrl,
        verifyTests: false,
      },
      { tickMs: 10, abortGraceMs: 200 },
    );
    const client = await connect(o);
    const spawned = await textOf(client, "worker_spawn", { task: "hang around" });
    const id = /\b(w-\d+)\b/.exec(spawned)![1]!;

    await o.dispose();
    expect(o.manager.get(id)!.state).toBe("cancelled");
    // Idempotent: a SIGINT arriving twice must not double-close the database.
    await o.dispose();
  }, 20_000);
});
