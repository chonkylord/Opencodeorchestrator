/**
 * The schema (`projectplan.md` §3.4, DD-7).
 *
 * Three tables in Phase 2: `runs`, `workers`, `events`. `merges` is Phase 4's
 * and is not created here — an empty table nobody writes to is a promise the
 * next agent has to check.
 *
 * The design constraint that shapes all of this is DD-7: **the worktrees are the
 * durable state and this database is an index.** So every column is either
 * reconstructible from a worktree manifest or is cheap to lose (timings,
 * counters, the event trail). Nothing lives *only* here that a run cannot
 * continue without. `store.rebuildFromWorktrees()` is the proof.
 */

export const SCHEMA_VERSION = 1;

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id         TEXT PRIMARY KEY,
  repo_root  TEXT NOT NULL,
  base_sha   TEXT NOT NULL DEFAULT '',
  status     TEXT NOT NULL DEFAULT 'open',
  created_at INTEGER NOT NULL,
  ended_at   INTEGER,
  meta       TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS workers (
  id           TEXT PRIMARY KEY,
  run_id       TEXT NOT NULL,
  state        TEXT NOT NULL,
  mode         TEXT NOT NULL,
  model        TEXT NOT NULL,
  task         TEXT NOT NULL,
  spec         TEXT NOT NULL,
  worktree     TEXT NOT NULL,
  branch       TEXT NOT NULL,
  base_sha     TEXT NOT NULL,
  session_id   TEXT,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  started_at   INTEGER,
  ended_at     INTEGER,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cost         REAL    NOT NULL DEFAULT 0,
  resumes      INTEGER NOT NULL DEFAULT 0,
  reason       TEXT,
  questions    TEXT NOT NULL DEFAULT '[]',
  result       TEXT
);

CREATE INDEX IF NOT EXISTS workers_by_run   ON workers(run_id);
CREATE INDEX IF NOT EXISTS workers_by_state ON workers(state);

CREATE TABLE IF NOT EXISTS events (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  worker_id TEXT NOT NULL,
  at        INTEGER NOT NULL,
  kind      TEXT NOT NULL,
  detail    TEXT NOT NULL DEFAULT '{}'
);

CREATE INDEX IF NOT EXISTS events_by_worker ON events(worker_id, id);
`;
