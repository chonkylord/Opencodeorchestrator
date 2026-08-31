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

import {
  DEFAULT_MAX_RETRIES,
  DEFAULT_MAX_REVISIONS,
  DEFAULT_RUN_BUDGET_TOKENS,
  type WorkerMode,
  type WorkspaceMode,
  clampConcurrency,
  parseModelPool,
} from "../manager/index.js";
import { DEFAULT_DASHBOARD_PORT } from "../observe/index.js";
import { clampWaitMax } from "./tools.js";

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
  /**
   * How many times a turn is re-sent after a **retryable** provider error
   * (§11 Phase 7).
   *
   * Only errors the provider itself marks retryable are retried — a content
   * filter reproduces and is failed on the first try. `0` turns retries off.
   */
  readonly maxRetries: number;
  /**
   * §8's global run cap, in tokens across every worker sharing a `runID`.
   *
   * Per-worker budgets stop one worker running away; this stops a wave doing it.
   * `0` disables it.
   */
  readonly runBudgetTokens: number;
  /**
   * DD-9's per-mode model presets (§11 Phase 8).
   *
   * Configuration has always had a slot for these; Phase 8 is where something
   * reads them. `ORCHESTRATOR_MODEL_IMPLEMENT` / `_RESEARCH` / `_REVIEW`.
   */
  readonly models: Partial<Record<WorkerMode, string>>;
  /**
   * Models a `review` worker may be routed to, so it is not the model that wrote
   * the code (§11 Phase 8, §15's "cross-model adversarial review").
   *
   * `ORCHESTRATOR_REVIEW_POOL`, comma-separated and in preference order.
   */
  readonly reviewPool: readonly string[];
  /**
   * Where workers work unless a spawn says otherwise (§11 Phase 8).
   *
   * `shared` (the default) puts every worker in **your repository**, together,
   * the way Claude's own subagents work: they see each other's edits, nothing is
   * committed for you, and there is no merge because the work is already in your
   * tree. `isolated` gives each worker its own worktree and branch behind the
   * gated merge — stronger evidence, at the cost of workers not seeing each
   * other. `ORCHESTRATOR_WORKSPACE`.
   */
  readonly workspace: WorkspaceMode;
  /**
   * `worker_wait`'s cap, in milliseconds (§11 Phase 9).
   *
   * Defaults to 30,000 — half the one host ceiling anybody has measured. Raise
   * it only after measuring your own with `orchestrator_timeout_probe`, and
   * measure it *with* `progressEveryMs`, because a host that resets its timeout
   * on progress notifications has a completely different ceiling from one that
   * does not. Setting it past what your host will actually wait for does not
   * buy longer waits; it turns every wait into a failed tool call, and a failed
   * wait leaves a worker running with nobody watching it.
   */
  readonly waitMaxMs: number;
  /**
   * The local dashboard's port (§11 Phase 9), or a negative number to switch it
   * off entirely.
   *
   * `ORCHESTRATOR_DASHBOARD_PORT`; `ORCHESTRATOR_DASHBOARD=0` turns it off. `0`
   * asks the operating system for any free port, which is what you want when
   * several orchestrators run at once — the URL is printed to stderr at startup
   * either way.
   *
   * It binds 127.0.0.1 and serves `GET` only. That is not configurable: a
   * dashboard reachable from the network, or one that can act on a worker, is a
   * different and much more dangerous program than this one.
   */
  readonly dashboardPort: number;
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
    maxRetries: clampRetries(numberOr(env["ORCHESTRATOR_MAX_RETRIES"])),
    runBudgetTokens: clampRunBudget(numberOr(env["ORCHESTRATOR_RUN_BUDGET_TOKENS"])),
    models: {
      ...(env["ORCHESTRATOR_MODEL_IMPLEMENT"] ? { implement: env["ORCHESTRATOR_MODEL_IMPLEMENT"] } : {}),
      ...(env["ORCHESTRATOR_MODEL_RESEARCH"] ? { research: env["ORCHESTRATOR_MODEL_RESEARCH"] } : {}),
      ...(env["ORCHESTRATOR_MODEL_REVIEW"] ? { review: env["ORCHESTRATOR_MODEL_REVIEW"] } : {}),
    },
    reviewPool: parseModelPool(env["ORCHESTRATOR_REVIEW_POOL"]),
    // Anything but an exact "isolated" means shared: the default is the mode the
    // orchestrator is meant to be used in, and a typo should not silently opt a
    // user into the slower one.
    workspace: env["ORCHESTRATOR_WORKSPACE"] === "isolated" ? "isolated" : "shared",
    waitMaxMs: clampWaitMax(numberOr(env["ORCHESTRATOR_WAIT_MAX_MS"])),
    dashboardPort: dashboardPort(env),
  };
}

/**
 * Off, on a fixed port, or on whatever the OS has.
 *
 * On by default. The whole point of Phase 9 is that a user running an
 * orchestration can see it, and a dashboard you have to know an environment
 * variable to switch on is one most people never learn exists. Opting out is one
 * variable; a port collision costs a log line and nothing else.
 */
function dashboardPort(env: NodeJS.ProcessEnv): number {
  if (env["ORCHESTRATOR_DASHBOARD"] === "0" || env["ORCHESTRATOR_DASHBOARD"] === "off") return -1;
  const raw = numberOr(env["ORCHESTRATOR_DASHBOARD_PORT"]);
  if (raw === undefined) return DEFAULT_DASHBOARD_PORT;
  // A port outside the legal range is a typo, and a typo should not silently
  // disable the dashboard — that is what the explicit off switch is for.
  const port = Math.floor(raw);
  return port >= 0 && port <= 65_535 ? port : DEFAULT_DASHBOARD_PORT;
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

/** A ceiling on retries. Past this it is not a transient failure any more. */
export const MAX_RETRIES_LIMIT = 10;

export function clampRetries(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_MAX_RETRIES;
  return Math.max(0, Math.min(MAX_RETRIES_LIMIT, Math.floor(value)));
}

/**
 * The run cap, clamped only at the bottom.
 *
 * No upper limit, unlike every other clamp here: a big number is somebody who
 * has measured their own spend and means it, and refusing to honour it would be
 * this file deciding how much a run is allowed to be worth. `0` disables the cap
 * and is a legitimate setting rather than a typo to correct.
 */
export function clampRunBudget(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_RUN_BUDGET_TOKENS;
  return Math.max(0, Math.floor(value));
}
