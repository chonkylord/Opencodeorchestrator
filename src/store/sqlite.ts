/**
 * SQLite persistence (DD-7, §3.4, §9).
 *
 * Synchronous on purpose. `bun:sqlite` is synchronous, the writes are tiny, and
 * a manager that awaits its own bookkeeping acquires a class of interleaving bug
 * — a state written after the next state — that is miserable to debug and buys
 * nothing at this size.
 *
 * The important property is the one DD-7 names: losing this file must be
 * survivable. Every worker's identity is also written into its worktree as a
 * manifest, and {@link Store.rebuildFromWorktrees} puts the index back from
 * those. That is why there is no column here whose loss is unrecoverable.
 */

import { Database } from "bun:sqlite";

import type { MergeRecord } from "../manager/types.js";
import type { WorkerManifest, WorkerRecord, WorkerResult, WorkerSpec } from "../manager/types.js";
import { isActive, type WorkerState } from "../manager/state.js";
import { MIGRATIONS, SCHEMA_SQL, SCHEMA_VERSION } from "./schema.js";

export interface RunRow {
  readonly id: string;
  readonly repoRoot: string;
  readonly baseSha: string;
  readonly status: string;
  readonly createdAt: number;
  readonly endedAt?: number;
  readonly meta: Record<string, unknown>;
}

/**
 * What one `provider/model` has been observed to support (§11 Phase 9).
 *
 * Observations, not documentation: every field here was measured by a real turn
 * against a real provider, which is why the shape carries the error that proved
 * it rather than only the verdict.
 */
export interface ModelCapability {
  /** False once the provider has rejected a schema-constrained request. */
  readonly structuredOutput: boolean;
  /** When the observation was made. */
  readonly at: number;
  /** The provider's own error code, when there was one. */
  readonly code?: string;
  /** The provider's message, truncated. Untrusted text (DD-8). */
  readonly message?: string;
}

/** `meta` keys holding a {@link ModelCapability}. */
const MODEL_CAP_PREFIX = "model_cap:";

export interface StoredEvent {
  readonly id: number;
  readonly workerID: string;
  readonly at: number;
  readonly kind: string;
  readonly detail: Record<string, unknown>;
}

export interface WorkerFilter {
  readonly runID?: string;
  readonly states?: readonly WorkerState[];
}

/** The `workers` row shape as SQLite hands it back. */
interface WorkerRow {
  id: string;
  run_id: string;
  state: string;
  mode: string;
  model: string;
  task: string;
  spec: string;
  worktree: string;
  branch: string;
  base_sha: string;
  session_id: string | null;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  ended_at: number | null;
  total_tokens: number;
  cost: number;
  resumes: number;
  revisions: number;
  reason: string | null;
  questions: string;
  result: string | null;
}

/** The `merges` row shape as SQLite hands it back. */
interface MergeRow {
  id: string;
  run_id: string;
  state: string;
  branch: string;
  base_sha: string;
  head_sha: string;
  workers: string;
  test_command: string | null;
  started_at: number;
  ended_at: number | null;
  outcome: string | null;
  error: string | null;
}

/**
 * Where the index tells somebody it changed (§11 Phase 9).
 *
 * Every write in this system passes through {@link Store.putWorker} or
 * {@link Store.appendEvent} — that is what makes it the right seam for the
 * dashboard, and the reason Phase 9 added no notification plumbing to the
 * manager at all. Two callbacks here see everything a dozen call sites do.
 *
 * Both are best-effort and are called *after* the row is committed: a subscriber
 * that throws must not take the write with it.
 */
export interface StoreHooks {
  readonly onWorker?: (record: WorkerRecord) => void;
  readonly onEvent?: (event: StoredEvent) => void;
}

export class Store {
  private readonly db: Database;
  private readonly hooks: StoreHooks;

  constructor(path = ":memory:", hooks: StoreHooks = {}) {
    this.hooks = hooks;
    this.db = new Database(path, { create: true });
    // WAL keeps a reader (a run report, a status poll) from blocking the run
    // loop's writes. `:memory:` ignores it, which is fine.
    try {
      this.db.exec("PRAGMA journal_mode = WAL");
    } catch {
      /* not fatal: a store that cannot use WAL still works */
    }
    this.db.exec("PRAGMA foreign_keys = ON");
    this.db.exec(SCHEMA_SQL);
    this.migrate();
    this.db.query("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(String(SCHEMA_VERSION));
  }

  get schemaVersion(): number {
    const row = this.db.query<{ value: string }, []>("SELECT value FROM meta WHERE key = 'schema_version'").get();
    return row ? Number.parseInt(row.value, 10) : 0;
  }

  close(): void {
    this.db.close();
  }

  /**
   * Bring an older file up to {@link SCHEMA_VERSION}.
   *
   * `CREATE TABLE IF NOT EXISTS` adds a *table* to an existing database and adds
   * nothing at all to an existing table, so a column declared in `SCHEMA_SQL`
   * reaches fresh databases only. Phase 6's `workers.revisions` is the first
   * column any phase has added, and this is what makes it reach the databases
   * that already have rows in them.
   *
   * Re-running an `ADD COLUMN` that is already there is the expected case, not
   * an error case — these run on every open — so a duplicate-column failure is
   * swallowed and everything else is left to throw, because a migration failing
   * for any other reason is a database this process should not keep writing to.
   */
  private migrate(): void {
    for (const statement of MIGRATIONS) {
      try {
        this.db.exec(statement);
      } catch (e) {
        if (!/duplicate column name/i.test(String(e))) throw e;
      }
    }
  }

  // --- runs ---------------------------------------------------------------

  createRun(run: { id: string; repoRoot: string; baseSha?: string; meta?: Record<string, unknown> }): RunRow {
    const now = Date.now();
    this.db
      .query(
        `INSERT INTO runs (id, repo_root, base_sha, status, created_at, meta) VALUES (?, ?, ?, 'open', ?, ?)
         ON CONFLICT(id) DO UPDATE SET repo_root = excluded.repo_root, base_sha = excluded.base_sha`,
      )
      .run(run.id, run.repoRoot, run.baseSha ?? "", now, JSON.stringify(run.meta ?? {}));
    return this.getRun(run.id)!;
  }

  getRun(id: string): RunRow | undefined {
    const row = this.db
      .query<
        {
          id: string;
          repo_root: string;
          base_sha: string;
          status: string;
          created_at: number;
          ended_at: number | null;
          meta: string;
        },
        [string]
      >("SELECT * FROM runs WHERE id = ?")
      .get(id);
    if (!row) return undefined;
    return {
      id: row.id,
      repoRoot: row.repo_root,
      baseSha: row.base_sha,
      status: row.status,
      createdAt: row.created_at,
      ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
      meta: parseJson<Record<string, unknown>>(row.meta, {}),
    };
  }

  endRun(id: string, status = "closed"): void {
    this.db.query("UPDATE runs SET status = ?, ended_at = ? WHERE id = ?").run(status, Date.now(), id);
  }

  listRuns(): RunRow[] {
    return this.db
      .query<{ id: string }, []>("SELECT id FROM runs ORDER BY created_at DESC")
      .all()
      .flatMap((r) => {
        const run = this.getRun(r.id);
        return run ? [run] : [];
      });
  }

  // --- workers ------------------------------------------------------------

  putWorker(record: WorkerRecord): void {
    this.db
      .query(
        `INSERT INTO workers
           (id, run_id, state, mode, model, task, spec, worktree, branch, base_sha, session_id,
            created_at, updated_at, started_at, ended_at, total_tokens, cost, resumes, revisions, reason, questions, result)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           run_id = excluded.run_id, state = excluded.state, mode = excluded.mode, model = excluded.model,
           task = excluded.task, spec = excluded.spec, worktree = excluded.worktree, branch = excluded.branch,
           base_sha = excluded.base_sha, session_id = excluded.session_id, updated_at = excluded.updated_at,
           started_at = excluded.started_at, ended_at = excluded.ended_at, total_tokens = excluded.total_tokens,
           cost = excluded.cost, resumes = excluded.resumes, revisions = excluded.revisions, reason = excluded.reason,
           questions = excluded.questions, result = excluded.result`,
      )
      .run(
        record.workerID,
        record.runID,
        record.state,
        record.mode,
        record.model,
        record.task,
        JSON.stringify(record.spec),
        record.worktree,
        record.branch,
        record.baseSha,
        record.sessionID ?? null,
        record.createdAt,
        record.updatedAt,
        record.startedAt ?? null,
        record.endedAt ?? null,
        record.totalTokens,
        record.cost,
        record.resumes,
        record.revisions,
        record.reason ?? null,
        JSON.stringify(record.questions),
        record.result ? JSON.stringify(record.result) : null,
      );
    this.notify(() => this.hooks.onWorker?.(record));
  }

  getWorker(id: string): WorkerRecord | undefined {
    const row = this.db.query<WorkerRow, [string]>("SELECT * FROM workers WHERE id = ?").get(id);
    return row ? toRecord(row) : undefined;
  }

  listWorkers(filter: WorkerFilter = {}): WorkerRecord[] {
    const where: string[] = [];
    const params: string[] = [];
    if (filter.runID) {
      where.push("run_id = ?");
      params.push(filter.runID);
    }
    if (filter.states && filter.states.length > 0) {
      where.push(`state IN (${filter.states.map(() => "?").join(", ")})`);
      params.push(...filter.states);
    }
    const sql = `SELECT * FROM workers${where.length ? ` WHERE ${where.join(" AND ")}` : ""} ORDER BY created_at, id`;
    return this.db
      .query<WorkerRow, string[]>(sql)
      .all(...params)
      .map(toRecord);
  }

  // --- model capabilities (§11 Phase 9) -----------------------------------

  /**
   * What a provider has been *observed* to refuse, keyed by `provider/model`.
   *
   * Discovering that a model cannot emit a schema-constrained reply costs a
   * failed turn — the request is rejected, the constraint is dropped and the
   * turn is re-sent. Before this the discovery was thrown away twice over: it
   * was held in a single manager-wide boolean, so **one** model's refusal
   * silenced structured output for **every** model the router might pick next,
   * and it lived only in memory, so every new process paid for it again.
   *
   * Keeping it here fixes both. It belongs in `meta` rather than a table of its
   * own because DD-7 still holds: this is an observation that can be re-made by
   * running a worker, so losing it costs one turn, not a run.
   */
  putModelCapability(model: string, cap: ModelCapability): void {
    this.db
      .query("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)")
      .run(`${MODEL_CAP_PREFIX}${model}`, JSON.stringify(cap));
  }

  getModelCapability(model: string): ModelCapability | undefined {
    const row = this.db
      .query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?")
      .get(`${MODEL_CAP_PREFIX}${model}`);
    if (!row) return undefined;
    try {
      const parsed: unknown = JSON.parse(row.value);
      if (typeof parsed !== "object" || parsed === null) return undefined;
      return parsed as ModelCapability;
    } catch {
      // A row we cannot read is a discovery we have to re-make, which costs one
      // turn. Refusing to start over it would cost the run.
      return undefined;
    }
  }

  /** Every recorded capability, for seeding a fresh manager and for the dashboard. */
  listModelCapabilities(): Record<string, ModelCapability> {
    const rows = this.db
      .query<{ key: string; value: string }, [string]>("SELECT key, value FROM meta WHERE key LIKE ?")
      .all(`${MODEL_CAP_PREFIX}%`);
    const out: Record<string, ModelCapability> = {};
    for (const r of rows) {
      const model = r.key.slice(MODEL_CAP_PREFIX.length);
      const cap = this.getModelCapability(model);
      if (cap) out[model] = cap;
    }
    return out;
  }

  // --- events -------------------------------------------------------------

  /**
   * Append to the audit trail (§8's run report, §9's forensics).
   *
   * Lifecycle-grained, not stream-grained: state changes, watchdog fires,
   * escalations, aborts. Every backend frame would be tens of thousands of rows
   * per run for information nobody reads, and the transcript is precisely what
   * the context firewall exists to keep out.
   */
  appendEvent(workerID: string, kind: string, detail: Record<string, unknown> = {}): void {
    const at = Date.now();
    const info = this.db
      .query("INSERT INTO events (worker_id, at, kind, detail) VALUES (?, ?, ?, ?)")
      .run(workerID, at, kind, JSON.stringify(detail));
    this.notify(() => this.hooks.onEvent?.({ id: Number(info.lastInsertRowid), workerID, at, kind, detail }));
  }

  /**
   * Run a hook without letting it reach the caller.
   *
   * A subscriber is a spectator. The write has already committed by the time
   * this runs, so the only thing a throw here could achieve is to fail an
   * orchestration because a dashboard tab is in a bad state.
   */
  private notify(fn: () => void): void {
    try {
      fn();
    } catch {
      /* a spectator does not get to fail the run */
    }
  }

  listEvents(workerID: string, opts: { limit?: number; afterID?: number } = {}): StoredEvent[] {
    const limit = Math.min(opts.limit ?? 50, 1000);
    const rows = this.db
      .query<{ id: number; worker_id: string; at: number; kind: string; detail: string }, [string, number, number]>(
        "SELECT * FROM events WHERE worker_id = ? AND id > ? ORDER BY id LIMIT ?",
      )
      .all(workerID, opts.afterID ?? 0, limit);
    return rows.map((r) => ({
      id: r.id,
      workerID: r.worker_id,
      at: r.at,
      kind: r.kind,
      detail: parseJson<Record<string, unknown>>(r.detail, {}),
    }));
  }

  // --- merges (§6.3, Phase 4) ---------------------------------------------

  /**
   * Write a merge row, in full, on every change.
   *
   * Same upsert shape as `putWorker` and for the same reason: a merge is written
   * once when it starts and again after each step, and a partial update is a
   * chance for the row to disagree with itself. DD-7 still holds — losing this
   * table costs the merge's history, not its result, because the result is a
   * branch in the repository.
   */
  putMerge(record: MergeRecord): void {
    this.db
      .query(
        `INSERT INTO merges
           (id, run_id, state, branch, base_sha, head_sha, workers, test_command,
            started_at, ended_at, outcome, error)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           run_id = excluded.run_id, state = excluded.state, branch = excluded.branch,
           base_sha = excluded.base_sha, head_sha = excluded.head_sha, workers = excluded.workers,
           test_command = excluded.test_command, ended_at = excluded.ended_at,
           outcome = excluded.outcome, error = excluded.error`,
      )
      .run(
        record.mergeID,
        record.runID ?? "",
        record.state,
        record.integrationBranch,
        record.baseSha,
        record.headSha,
        JSON.stringify(record.workers),
        record.testCommand ?? null,
        record.startedAt,
        record.endedAt ?? null,
        record.outcome ? JSON.stringify(record.outcome) : null,
        record.error ?? null,
      );
  }

  getMerge(id: string): MergeRecord | undefined {
    const row = this.db.query<MergeRow, [string]>("SELECT * FROM merges WHERE id = ?").get(id);
    return row ? toMerge(row) : undefined;
  }

  listMerges(filter: { runID?: string } = {}): MergeRecord[] {
    const sql = `SELECT * FROM merges${filter.runID ? " WHERE run_id = ?" : ""} ORDER BY started_at, id`;
    const rows = filter.runID
      ? this.db.query<MergeRow, [string]>(sql).all(filter.runID)
      : this.db.query<MergeRow, []>(sql).all();
    return rows.map(toMerge);
  }

  // --- recovery (§9) ------------------------------------------------------

  /**
   * Everything that was mid-flight when the process stopped.
   *
   * Called on startup, before anything else touches the database: these rows are
   * lies until proven otherwise, because the process that was maintaining them
   * is gone.
   */
  listUnfinished(): WorkerRecord[] {
    return this.listWorkers().filter((w) => isActive(w.state) || w.state === "blocked");
  }

  /**
   * Rebuild index rows from worktree manifests (DD-7's actual test).
   *
   * A manifest says who a worktree belongs to and what it was asked to do; it
   * cannot say how the worker ended, because it was written before the worker
   * ran. So a rebuilt row lands in `interrupted` — the honest state for "there is
   * work here and nobody knows its outcome" — and §9's decision applies to it
   * exactly as it would to a worker orphaned by a crash. Existing rows win: a
   * live index is better evidence than a manifest written at spawn.
   */
  rebuildFromWorktrees(manifests: readonly WorkerManifest[], worktreeOf: (m: WorkerManifest) => string): WorkerRecord[] {
    const rebuilt: WorkerRecord[] = [];
    for (const m of manifests) {
      if (this.getWorker(m.workerID)) continue;
      const now = Date.now();
      const record: WorkerRecord = {
        workerID: m.workerID,
        runID: m.runID,
        state: "interrupted",
        mode: m.mode,
        model: m.model,
        task: m.task,
        spec: m.spec,
        worktree: worktreeOf(m),
        branch: m.branch,
        baseSha: m.baseSha,
        ...(m.sessionID === undefined ? {} : { sessionID: m.sessionID }),
        createdAt: m.createdAt,
        updatedAt: now,
        totalTokens: 0,
        cost: 0,
        resumes: 0,
        revisions: 0,
        reason: "rebuilt_from_worktree",
        questions: [],
      };
      if (!this.getRun(m.runID)) {
        this.createRun({ id: m.runID, repoRoot: "", baseSha: m.baseSha, meta: { rebuilt: true } });
      }
      this.putWorker(record);
      this.appendEvent(m.workerID, "rebuilt_from_worktree", { worktree: record.worktree, branch: m.branch });
      rebuilt.push(record);
    }
    return rebuilt;
  }
}

// ---------------------------------------------------------------------------

function toRecord(row: WorkerRow): WorkerRecord {
  return {
    workerID: row.id,
    runID: row.run_id,
    state: row.state as WorkerState,
    mode: row.mode as WorkerRecord["mode"],
    model: row.model,
    task: row.task,
    spec: parseJson<WorkerSpec>(row.spec, { task: row.task }),
    worktree: row.worktree,
    branch: row.branch,
    baseSha: row.base_sha,
    ...(row.session_id === null ? {} : { sessionID: row.session_id }),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.started_at === null ? {} : { startedAt: row.started_at }),
    ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
    totalTokens: row.total_tokens,
    cost: row.cost,
    resumes: row.resumes,
    // `?? 0` rather than a bare read: a row written by a pre-Phase-6 process and
    // migrated in place has the column, but a `SELECT *` over a database opened
    // read-only somewhere else may not, and a counter is exactly the kind of
    // thing DD-7 says must be cheap to lose.
    revisions: row.revisions ?? 0,
    ...(row.reason === null ? {} : { reason: row.reason }),
    questions: parseJson<string[]>(row.questions, []),
    ...(row.result === null ? {} : { result: parseJson<WorkerResult>(row.result, undefined as never) }),
  };
}

function toMerge(row: MergeRow): MergeRecord {
  return {
    mergeID: row.id,
    ...(row.run_id === "" ? {} : { runID: row.run_id }),
    state: row.state as MergeRecord["state"],
    integrationBranch: row.branch,
    baseSha: row.base_sha,
    headSha: row.head_sha,
    workers: parseJson<string[]>(row.workers, []),
    ...(row.test_command === null ? {} : { testCommand: row.test_command }),
    startedAt: row.started_at,
    ...(row.ended_at === null ? {} : { endedAt: row.ended_at }),
    ...(row.outcome === null ? {} : { outcome: parseJson<MergeRecord["outcome"]>(row.outcome, undefined) }),
    ...(row.error === null ? {} : { error: row.error }),
  };
}

function parseJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}
