/**
 * The OpenCode adapter's public surface (DD-2).
 *
 * Import from here and nowhere deeper. Nothing outside `src/opencode/` may name
 * an endpoint path, an OpenCode event type, or a raw OpenCode payload shape —
 * that boundary is what keeps ADR-0001's backend choice reversible and what
 * absorbs OpenCode API drift into one directory.
 */

export {
  type BackendHealth,
  type CreateSessionOptions,
  type EventStream,
  type EventStreamOptions,
  FULL_PERMISSIONS,
  HEADLESS_PERMISSIONS,
  type ModelRef,
  NotImplementedError,
  type OCErrorCode,
  type OCEvent,
  type OpenCodeBackend,
  OpenCodeError,
  type OutputFormat,
  type PermissionAction,
  type PermissionReply,
  type PermissionRule,
  type PromptRequest,
  type RunHandle,
  type SessionHandle,
  type SessionRef,
  type ToolState,
  type Usage,
  isAnswerable,
  isBlocking,
  isTerminal,
  isWorkerEvent,
  parseModel,
  toTypedError,
} from "./types.js";

export { ServeBackend, type ServeBackendOptions } from "./serve.js";
export { RunBackend, type RunBackendOptions } from "./run.js";
