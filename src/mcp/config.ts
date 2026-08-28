/**
 * How the server learns which repository it orchestrates (§11 Phase 3, item 5).
 *
 * Environment variables rather than a config file or flags, for one reason: an
 * MCP server is launched by its host, from a command line the user writes once
 * into `claude mcp add`. Flags there are invisible six months later; a file is
 * one more thing to find. `env` is the channel the host already has.
 *
 * Every value has a defensible default, so the zero-configuration launch —
 * `claude mcp add orchestrator -- bun run src/mcp/server.ts` — orchestrates the
 * directory the host started in.
 */

import { resolve } from "node:path";

export interface ServerConfig {
  /** The repository the workers branch from. */
  readonly repoRoot: string;
  /** SQLite index. `:memory:` is honoured, and means the run is not restartable. */
  readonly dbPath: string;
  /** `provider/model` for workers that do not name one. */
  readonly defaultModel: string;
  /**
   * Attach to an already-running OpenCode server instead of spawning one.
   *
   * Undefined means spawn. Set it when something else owns the server process —
   * a dev loop, a container, or a test.
   */
  readonly baseUrl?: string;
  /** Re-run the brief's test command after a worker completes (§4.3). */
  readonly verifyTests: boolean;
}

/** `.orchestrator/` is already git-excluded for the worktrees; the index joins it. */
export const DEFAULT_DB_RELATIVE = ".orchestrator/orchestrator.db";

/**
 * DD-9's default. Free-tier, needs no configured credentials, and rejects
 * schema-constrained output — which the manager handles and ADR-0002 explains.
 */
export const DEFAULT_MODEL_ENV = "opencode/muse-spark-1.2-contributor-free";

export function loadConfig(env: NodeJS.ProcessEnv = process.env, cwd = process.cwd()): ServerConfig {
  const repoRoot = resolve(env["ORCHESTRATOR_REPO"] ?? cwd);
  const rawDb = env["ORCHESTRATOR_DB"];
  return {
    repoRoot,
    dbPath: rawDb === undefined ? resolve(repoRoot, DEFAULT_DB_RELATIVE) : rawDb === ":memory:" ? rawDb : resolve(rawDb),
    defaultModel: env["ORCHESTRATOR_MODEL"] ?? DEFAULT_MODEL_ENV,
    ...(env["ORCHESTRATOR_BASE_URL"] === undefined ? {} : { baseUrl: env["ORCHESTRATOR_BASE_URL"] }),
    // Opt-out rather than opt-in: the manager's own test run is the evidence
    // behind a worker's "tests pass", and DD-4 is worth less without it.
    verifyTests: env["ORCHESTRATOR_VERIFY_TESTS"] !== "0",
  };
}
