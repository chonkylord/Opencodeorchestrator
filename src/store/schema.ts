/**
 * The schema (`projectplan.md` §3.4, DD-7).
 *
 * Three tables in Phase 2: `runs`, `workers`, `events`. **Phase 4 adds the
 * fourth, `merges`** — held back until something wrote to it, because an empty
 * table nobody writes to is a promise the next agent has to check.
 *
 * `merges` is a first-class entity rather than a column on `workers`, and that
 * is the phase's largest structural decision: a merge has its own lifecycle (it
 * runs for minutes, gates, rolls back), its own identity to poll, and a set of
 * workers rather than one. See `docs/adr/0003-integration-worktree.md`.
 *
 * The design constraint that shapes all of this is DD-7: **the worktrees are the
 * durable state and this database is an index.** So every column is either
 * reconstructible from a worktree manifest or is cheap to lose (timings,
 * counters, the event trail). Nothing lives *only* here that a run cannot
 * continue without. `store.rebuildFromWorktrees()` is the proof.
 */

// Bumped by Phase 4's `merges` table, and again by Phase 6's `workers.revisions`
// column. Nothing reads the number to gate behaviour; it is there to date a file.
//
// **A new table and a new column are not the same migration, and Phase 6 found
// that out.** Every `CREATE TABLE` below is `IF NOT EXISTS`, so Phase 4's
// `merges` really did land on a version-1 database on disk simply by running
// this script again. A *column* added to an existing `CREATE TABLE` statement
// does not: SQLite sees the table already exists, skips the statement whole, and
// the new column silently never appears — after which every `INSERT` naming it
// fails at runtime on exactly the databases that already had data worth keeping.
// So `revisions` is declared below for fresh databases *and* added by
// {@link MIGRATIONS} for existing ones, and the two must agree.
export const SCHEMA_VERSION = 3;

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
  revisions    INTEGER NOT NULL DEFAULT 0,
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

CREATE TABLE IF NOT EXISTS merges (
  id            TEXT PRIMARY KEY,
  run_id        TEXT NOT NULL DEFAULT '',
  state         TEXT NOT NULL,
  branch        TEXT NOT NULL,
  base_sha      TEXT NOT NULL,
  head_sha      TEXT NOT NULL DEFAULT '',
  workers       TEXT NOT NULL DEFAULT '[]',
  test_command  TEXT,
  started_at    INTEGER NOT NULL,
  ended_at      INTEGER,
  outcome       TEXT,
  error         TEXT
);

CREATE INDEX IF NOT EXISTS merges_by_run ON merges(run_id);
`;

/**
 * Statements that bring an older database up to {@link SCHEMA_VERSION}.
 *
 * Each one must be safe to run against a database that already has the change,
 * because they run unconditionally on every open — there is no migration
 * bookkeeping and there should not be one at this size. `ALTER TABLE … ADD
 * COLUMN` is not idempotent (it errors with "duplicate column name"), so the
 * store swallows exactly that failure; anything else is a real problem and is
 * left to throw.
 *
 * DD-7 keeps this cheap: the worktrees are the durable state and this database
 * is an index, so the worst case for a migration nobody can run is
 * `rebuildFromWorktrees()`.
 */
export const MIGRATIONS: readonly string[] = Object.freeze([
  // Phase 6: the revision counter, separate from `resumes` (§11 Phase 6).
  "ALTER TABLE workers ADD COLUMN revisions INTEGER NOT NULL DEFAULT 0",
]);
