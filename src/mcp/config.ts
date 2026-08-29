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

import { DEFAULT_MAX_REVISIONS, clampConcurrency } from "../manager/index.js";

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
  /**
   * How many workers may be past `spawned` at once (§11 Phase 5).
   *
   * Defaults to 3. Phase 1 measured four concurrent sessions on one server
   * completing with no cross-talk — one run, one free-tier model — so three is
   * headroom inside a measurement nobody has repeated rather than a limit
   * anybody hit. Raise it only after measuring your own provider under load;
   * see `docs/phase0-facts.md` "Unresolved" 2.
   */
  readonly maxConcurrent: number;
  /**
   * How many revision rounds one worker may take (§5, §13).
   *
   * Defaults to 3, which is the number §5 has carried since before Phase 0. The
   * cap is what keeps a review loop from becoming an infinite fix loop, and at
   * it `worker_revise` hands Claude a report of what was tried rather than an
   * error — so raising this trades a longer loop for a later decision, and 0
   * turns revisions off entirely.
   */
  readonly maxRevisions: number;
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
    // Clamped rather than validated: an unparseable or absurd value should start
    // the server on the default, not refuse to launch. A host that will not come
    // up because of a typo in one env var is worse than one that runs at 3.
    maxConcurrent: clampConcurrency(numberOr(env["ORCHESTRATOR_MAX_CONCURRENT"])),
    // Clamped, not validated, for the same reason as the cap above: a typo in an
    // env var should start the server on the default rather than refuse to launch.
    maxRevisions: clampRevisions(numberOr(env["ORCHESTRATOR_MAX_REVISIONS"])),
  };
}

function numberOr(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}

/** A ceiling that is a sanity limit, not a measurement — as with concurrency. */
export const MAX_REVISIONS_LIMIT = 20;

export function clampRevisions(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_REVISIONS;
  return Math.max(0, Math.min(MAX_REVISIONS_LIMIT, Math.floor(value)));
}
