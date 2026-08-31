/**
 * Persistence (DD-7). SQLite is the index; the worktrees are the state.
 */

export { type ModelCapability, type RunRow, Store, type StoreHooks, type StoredEvent, type WorkerFilter } from "./sqlite.js";
export { SCHEMA_SQL, SCHEMA_VERSION } from "./schema.js";
