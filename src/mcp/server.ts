/**
 * The MCP server (§3.5, §11 Phase 3) — the process the host actually launches.
 *
 * Wire it into Claude Code with:
 *   claude mcp add orchestrator -- bun run <repo>/src/mcp/server.ts
 *
 * One process owns one backend, one index and one manager, and the startup order
 * below is not arbitrary:
 *
 * 1. **Start the backend before serving any tool.** The first prompt against a
 *    cold server pays for a burst of ~45 unscoped start-up events before
 *    generation begins. Warming it here spends that once, at launch, instead of
 *    charging it to whichever worker happens to be first.
 * 2. **Recover before the transport is connected.** `recover()` turns rows left
 *    mid-flight by a dead process into `interrupted`, and `rebuildIndex()` puts
 *    rows back from the worktree manifests when the database itself is gone
 *    (DD-7). Both are cheap and both are meaningless if a `worker_spawn` has
 *    already raced past them — so the host cannot reach a tool until they are
 *    done, which is exactly what connecting last buys.
 *
 * **stdout is the JSON-RPC channel.** Every diagnostic in this process goes to
 * stderr. A single stray `console.log` corrupts the protocol, and the symptom is
 * a host that reports nothing wrong at all.
 */

import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { ServeBackend } from "../opencode/index.js";
import { MergeCoordinator, WorkerManager, type WorkerManagerOptions } from "../manager/index.js";
import { Store } from "../store/index.js";
import { type ServerConfig, loadConfig } from "./config.js";
import { registerWorkerTools } from "./tools.js";

export const SERVER_NAME = "opencode-orchestrator";
export const SERVER_VERSION = "0.4.0";

const log = (line: string): void => console.error(`[orchestrator] ${line}`);

export interface Orchestrator {
  readonly server: McpServer;
  readonly manager: WorkerManager;
  /** Phase 4's gated merge, tracked separately from the workers it merges. */
  readonly merges: MergeCoordinator;
  readonly store: Store;
  readonly config: ServerConfig;
  readonly dispose: () => Promise<void>;
}

/**
 * The manager's clock, exposed for tests.
 *
 * `WorkerManagerOptions` already documents `tickMs` as "small in tests, ~1s in
 * production" — the watchdogs are wall-clock machines and the only honest way to
 * exercise them is to make the clock cheap. This is that seam, and nothing but
 * the backend and the index is withheld, because those two are the server's to
 * own.
 */
export type ManagerTuning = Omit<Partial<WorkerManagerOptions>, "backend" | "store">;

/**
 * Build the whole thing, minus the transport.
 *
 * Separated from {@link main} so the tests can drive the real server over an
 * in-memory JSON-RPC pair — which is the only way to catch a schema the SDK
 * rejects at registration time, or a tool that answers correctly to a direct
 * call and not at all to a protocol one.
 */
export async function createOrchestrator(config: ServerConfig, tuning: ManagerTuning = {}): Promise<Orchestrator> {
  const backend = new ServeBackend({
    cwd: config.repoRoot,
    ...(config.baseUrl === undefined ? {} : { baseUrl: config.baseUrl }),
    onServerLog: (line) => log(`opencode: ${line}`),
  });
  await backend.start();
  log(`backend ready (repo ${config.repoRoot})`);

  if (config.dbPath !== ":memory:") mkdirSync(dirname(config.dbPath), { recursive: true });
  const store = new Store(config.dbPath);

  const manager = new WorkerManager({
    backend,
    store,
    repoRoot: config.repoRoot,
    defaultModel: config.defaultModel,
    verifyTests: config.verifyTests,
    ...tuning,
  });

  const recovered = await manager.recover();
  if (recovered.length > 0) log(`recovered ${recovered.length} interrupted worker(s) from a previous process`);
  const rebuilt = await manager.rebuildIndex().catch((e: unknown) => {
    // A missing or unreadable worktree root is not a reason to refuse to start:
    // the index is an index, and a server that will not launch because a
    // directory is gone is worse than one that starts with fewer known workers.
    log(`index rebuild skipped: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  });
  if (rebuilt.length > 0) log(`rebuilt ${rebuilt.length} worker row(s) from worktree manifests`);

  const merges = new MergeCoordinator({ manager, store, repoRoot: config.repoRoot, log });

  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerWorkerTools(server, { manager, store, merges, repoRoot: config.repoRoot, log });
  registerProbe(server);

  let disposed = false;
  const dispose = async (): Promise<void> => {
    if (disposed) return;
    disposed = true;
    // Order mirrors construction, reversed: let any merge in flight finish (it
    // holds an integration worktree and a `git reset` it must be allowed to
    // complete — a merge killed mid-rollback is the one way this system could
    // leave a repository in a state nobody asked for), then stop the workers,
    // then the backend they talk to, then the index that recorded them.
    await merges.drain().catch((e: unknown) => log(`merge drain: ${String(e)}`));
    await manager.dispose().catch((e: unknown) => log(`manager dispose: ${String(e)}`));
    await backend.dispose().catch((e: unknown) => log(`backend dispose: ${String(e)}`));
    store.close();
  };

  return { server, manager, merges, store, config, dispose };
}

/**
 * The Phase 0 instrument, kept.
 *
 * It is not part of the orchestrator's real surface — every production tool
 * returns in under two seconds (DD-1) — but it is the only way to measure the
 * ceiling that claim is calibrated against, and a host upgrade can move that
 * ceiling. Deleting it would mean rebuilding it the next time the number is in
 * doubt. See `docs/phase0-facts.md` §7.
 */
export function registerProbe(server: McpServer): void {
  server.registerTool(
    "orchestrator_timeout_probe",
    {
      title: "Host tool-call timeout probe",
      description:
        "MEASUREMENT INSTRUMENT, not part of the orchestrator. Sleeps for delayMs and returns. Used to " +
        "find the host's tool-call timeout by calling it with increasing delays until the call fails; " +
        "the largest delay that still returns is the ceiling worker_wait's cap sits under. Do not call " +
        "it in the course of ordinary work.",
      inputSchema: {
        delayMs: z.number().int().min(0).max(600_000).describe("How long to sleep before returning, in milliseconds"),
      },
      annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
    },
    async ({ delayMs }) => {
      const started = Date.now();
      await new Promise((r) => setTimeout(r, delayMs));
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ requestedMs: delayMs, actualMs: Date.now() - started, returned: true }),
          },
        ],
      };
    },
  );
}

async function main(): Promise<void> {
  const config = loadConfig();
  const orchestrator = await createOrchestrator(config);

  let shuttingDown = false;
  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`${signal} — stopping workers and shutting down`);
    void orchestrator
      .dispose()
      .catch((e: unknown) => log(`shutdown: ${String(e)}`))
      .finally(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  await orchestrator.server.connect(new StdioServerTransport());
  log(`ready on stdio · db ${config.dbPath} · model ${config.defaultModel}`);
}

// Only when launched directly, so the tests can import this module without it
// grabbing stdio out from under them.
if (import.meta.main) {
  await main().catch((e: unknown) => {
    log(`fatal: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
    process.exit(1);
  });
}
