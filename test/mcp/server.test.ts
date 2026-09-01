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
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { OCMock } from "../ocmock/server.js";
import {
  DEFAULT_MODEL_ENV,
  ENV_PREFIX,
  LEGACY_ENV_PREFIX,
  SETTINGS,
  type Setting,
  defaultDbPath,
  deprecatedEnv,
  loadConfig,
  type ServerConfig,
} from "../../src/mcp/config.js";
import { createDispatchedCode, type DispatchedCode } from "../../src/mcp/server.js";
import { makeGoldenRepo } from "../fixtures/golden.js";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await Promise.resolve(fn()).catch(() => {});
});

async function connect(o: DispatchedCode): Promise<Client> {
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
  test("defaults settle on the directory the host started in", () => {
    const c = loadConfig({}, "/srv/project");
    expect(c.repoRoot).toBe("/srv/project");
    expect(c.dbPath).toBe(defaultDbPath("/srv/project"));
    expect(c.defaultModel).toBe(DEFAULT_MODEL_ENV);
    expect(c.verifyTests).toBe(true);
    expect(c.baseUrl).toBeUndefined();
  });

  // ---------------------------------------------------------------------
  // The rename to Dispatched Code (see README, "If you set this up before the
  // rename"). Every one of these is a promise made to somebody who configured
  // this before the name changed, so each is asserted rather than assumed.
  // ---------------------------------------------------------------------

  test("a pre-rename ORCHESTRATOR_* variable is still honoured", () => {
    const c = loadConfig({ ORCHESTRATOR_MAX_CONCURRENT: "7", ORCHESTRATOR_WORKSPACE: "isolated" }, "/repo");
    expect(c.maxConcurrent).toBe(7);
    expect(c.workspace).toBe("isolated");
  });

  test("the new name wins when both are set", () => {
    const c = loadConfig({ ORCHESTRATOR_MAX_CONCURRENT: "7", DISPATCHED_CODE_MAX_CONCURRENT: "2" }, "/repo");
    expect(c.maxConcurrent).toBe(2);
  });

  // One value per setting, each chosen to land somewhere the default is not.
  // Typed as a total record, so a setting added to `SETTINGS` without a probe
  // here fails to compile rather than quietly going untested.
  const PROBE: Record<Setting, string> = {
    REPO: "/elsewhere",
    DB: "/var/lib/probe.db",
    MODEL: "acme/probe",
    BASE_URL: "http://127.0.0.1:4096",
    VERIFY_TESTS: "0",
    MAX_CONCURRENT: "7",
    MAX_REVISIONS: "5",
    MAX_RETRIES: "1",
    RUN_BUDGET_TOKENS: "500000",
    MODEL_IMPLEMENT: "acme/implementer",
    MODEL_RESEARCH: "acme/researcher",
    MODEL_REVIEW: "acme/reviewer",
    REVIEW_POOL: "acme/one,acme/two",
    WORKSPACE: "isolated",
    WAIT_MAX_MS: "5000",
    DASHBOARD: "0",
    DASHBOARD_PORT: "4242",
    PERMISSIONS: "jailed",
  };

  test("every setting reads under both spellings — none was missed in the rename", () => {
    const defaults = loadConfig({}, "/repo");
    for (const setting of SETTINGS) {
      const value = PROBE[setting];
      const legacy = loadConfig({ [`${LEGACY_ENV_PREFIX}${setting}`]: value }, "/repo");
      const renamed = loadConfig({ [`${ENV_PREFIX}${setting}`]: value }, "/repo");
      expect(legacy).toEqual(renamed);
      // Each probe must actually move the config, or the line above compares
      // two defaults and proves nothing about the name being read at all.
      expect(renamed).not.toEqual(defaults);
    }
  });

  test("a legacy name is reported, and a shadowed one is reported as ignored", () => {
    expect(deprecatedEnv({ ORCHESTRATOR_REPO: "/x" })).toEqual([
      { legacy: "ORCHESTRATOR_REPO", replacement: "DISPATCHED_CODE_REPO", shadowed: false },
    ]);
    expect(deprecatedEnv({ ORCHESTRATOR_REPO: "/x", DISPATCHED_CODE_REPO: "/y" })).toEqual([
      { legacy: "ORCHESTRATOR_REPO", replacement: "DISPATCHED_CODE_REPO", shadowed: true },
    ]);
    // Nothing to say when the environment is already on the new names.
    expect(deprecatedEnv({ DISPATCHED_CODE_REPO: "/y" })).toEqual([]);
  });

  test("the index stays where an existing checkout already put it", () => {
    const fresh = mkdtempSync(join(tmpdir(), "dbpath-"));
    cleanup.push(() => rmSync(fresh, { recursive: true, force: true }));
    expect(defaultDbPath(fresh)).toBe(join(fresh, ".dispatched-code", "dispatched-code.db"));

    // A tree that ran this before the rename keeps both halves of the old name:
    // a new filename inside the old directory would be an empty index.
    mkdirSync(join(fresh, ".orchestrator"), { recursive: true });
    expect(defaultDbPath(fresh)).toBe(join(fresh, ".orchestrator", "orchestrator.db"));
  });

  test("every documented variable is honoured, and relative paths are resolved", () => {
    const c = loadConfig(
      {
        DISPATCHED_CODE_REPO: "/repo",
        DISPATCHED_CODE_DB: "/var/lib/orch.db",
        DISPATCHED_CODE_MODEL: "acme/big",
        DISPATCHED_CODE_BASE_URL: "http://127.0.0.1:4096",
        DISPATCHED_CODE_VERIFY_TESTS: "0",
        DISPATCHED_CODE_MAX_REVISIONS: "5",
        DISPATCHED_CODE_MAX_RETRIES: "1",
        DISPATCHED_CODE_RUN_BUDGET_TOKENS: "500000",
        DISPATCHED_CODE_MODEL_REVIEW: "acme/reviewer",
        DISPATCHED_CODE_REVIEW_POOL: "acme/one, acme/two , ,acme/one",
        DISPATCHED_CODE_WORKSPACE: "isolated",
      },
      "/ignored",
    );
    expect(c).toEqual({
      repoRoot: "/repo",
      dbPath: "/var/lib/orch.db",
      defaultModel: "acme/big",
      baseUrl: "http://127.0.0.1:4096",
      verifyTests: false,
      maxConcurrent: 3,
      maxRevisions: 5,
      maxRetries: 1,
      runBudgetTokens: 500_000,
      models: { review: "acme/reviewer" },
      // Trimmed, de-duplicated, and empties dropped: an env var with a stray
      // comma should cost nothing, like every other value in this file.
      reviewPool: ["acme/one", "acme/two"],
      workspace: "isolated",
      waitMaxMs: 30_000,
      dashboardPort: 4180,
      permissionMode: "full",
    });
    // `:memory:` is a SQLite keyword, not a path, and must survive resolution.
    expect(loadConfig({ DISPATCHED_CODE_DB: ":memory:" }, "/x").dbPath).toBe(":memory:");
  });

  test("DISPATCHED_CODE_MAX_CONCURRENT is clamped rather than trusted, and a typo does not stop the server", () => {
    // A host that refuses to launch because of a typo in one env var is worse
    // than one that runs at the default. Phase 1 measured 4 concurrent sessions
    // on one server; 3 is the default because that measurement is one run.
    expect(loadConfig({}, "/x").maxConcurrent).toBe(3);
    expect(loadConfig({ DISPATCHED_CODE_MAX_CONCURRENT: "6" }, "/x").maxConcurrent).toBe(6);
    expect(loadConfig({ DISPATCHED_CODE_MAX_CONCURRENT: "0" }, "/x").maxConcurrent).toBe(1);
    expect(loadConfig({ DISPATCHED_CODE_MAX_CONCURRENT: "banana" }, "/x").maxConcurrent).toBe(3);
    expect(loadConfig({ DISPATCHED_CODE_MAX_CONCURRENT: "" }, "/x").maxConcurrent).toBe(3);
    expect(loadConfig({ DISPATCHED_CODE_MAX_CONCURRENT: "9999" }, "/x").maxConcurrent).toBe(32);
  });

  test("DISPATCHED_CODE_WORKSPACE defaults to shared, and only an exact 'isolated' opts out", () => {
    // The default is the mode Dispatched Code is meant to be used in — every
    // worker in your repository together, the way Claude's own subagents work.
    // A typo must not silently opt someone into the slower, isolated one.
    expect(loadConfig({}, "/x").workspace).toBe("shared");
    expect(loadConfig({ DISPATCHED_CODE_WORKSPACE: "isolated" }, "/x").workspace).toBe("isolated");
    expect(loadConfig({ DISPATCHED_CODE_WORKSPACE: "Isolated" }, "/x").workspace).toBe("shared");
    expect(loadConfig({ DISPATCHED_CODE_WORKSPACE: "banana" }, "/x").workspace).toBe("shared");
  });

  test("Phase 7's two new variables are clamped, and each has a meaningful zero", () => {
    // `maxRetries: 0` means "never retry"; `runBudgetTokens: 0` means "no run
    // cap". Both are settings somebody might genuinely want, so neither is
    // clamped up to 1 the way concurrency is.
    expect(loadConfig({}, "/x").maxRetries).toBe(2);
    expect(loadConfig({ DISPATCHED_CODE_MAX_RETRIES: "0" }, "/x").maxRetries).toBe(0);
    expect(loadConfig({ DISPATCHED_CODE_MAX_RETRIES: "banana" }, "/x").maxRetries).toBe(2);
    expect(loadConfig({ DISPATCHED_CODE_MAX_RETRIES: "999" }, "/x").maxRetries).toBe(10);

    expect(loadConfig({}, "/x").runBudgetTokens).toBe(2_000_000);
    expect(loadConfig({ DISPATCHED_CODE_RUN_BUDGET_TOKENS: "0" }, "/x").runBudgetTokens).toBe(0);
    expect(loadConfig({ DISPATCHED_CODE_RUN_BUDGET_TOKENS: "banana" }, "/x").runBudgetTokens).toBe(2_000_000);
    // No upper clamp: a big number is somebody who has measured their own spend.
    expect(loadConfig({ DISPATCHED_CODE_RUN_BUDGET_TOKENS: "50000000" }, "/x").runBudgetTokens).toBe(50_000_000);
  });

  test("DISPATCHED_CODE_MAX_REVISIONS is clamped the same way, and 0 turns revisions off", () => {
    // §5's default has been 3 since before Phase 0. Zero is a legitimate
    // setting rather than a typo to correct — a repository that wants Claude to
    // respawn rather than revise says so this way — so it is clamped to 0 and
    // not to 1, which is the one place this differs from the concurrency cap.
    expect(loadConfig({}, "/x").maxRevisions).toBe(3);
    expect(loadConfig({ DISPATCHED_CODE_MAX_REVISIONS: "5" }, "/x").maxRevisions).toBe(5);
    expect(loadConfig({ DISPATCHED_CODE_MAX_REVISIONS: "0" }, "/x").maxRevisions).toBe(0);
    expect(loadConfig({ DISPATCHED_CODE_MAX_REVISIONS: "banana" }, "/x").maxRevisions).toBe(3);
    expect(loadConfig({ DISPATCHED_CODE_MAX_REVISIONS: "9999" }, "/x").maxRevisions).toBe(20);
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
    dashboardPort: -1,
    permissionMode: "full",
    };

    const first = await createDispatchedCode(config, { tickMs: 10, abortGraceMs: 200 });
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

    const second = await createDispatchedCode(config, { tickMs: 10 });
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

    const o = await createDispatchedCode(
      {
        repoRoot: repo.path,
        dbPath: ":memory:",
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
    dashboardPort: -1,
    permissionMode: "full",
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
