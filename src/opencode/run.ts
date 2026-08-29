/**
 * `RunBackend` — the documented fallback. **Deliberately unimplemented.**
 *
 * ADR-0001 chose `ServeBackend` as the default and explicitly scoped this to
 * "interface only, do not build in Phase 1". This file exists so that the
 * decision stays reversible: the interface has a second implementor, so nothing
 * can quietly grow a dependency on `ServeBackend`'s concrete type, and the day
 * `RunBackend` is needed the work is confined to one file.
 *
 * ## What it would do
 *
 * Spawn `opencode run` once per prompt instead of holding one server open:
 *
 * ```
 * opencode run --session <id> --model <provider/model> --agent <name> \
 *              --variant <effort> --format json --auto -- "<prompt>"
 * ```
 *
 * The flags exist and are documented; none of them has been exercised
 * (`docs/phase0-facts.md`, unresolved item 5). Before building this, verify:
 *
 * 1. **Working directory.** `run` takes cwd from the process, so isolation comes
 *    free — but confirm it does not also pick up the worktree's `.opencode/`
 *    config in a way that diverges from `serve`'s behaviour.
 * 2. **Eventing.** There is no SSE stream per subprocess. Completion would be
 *    process exit, and the rich mid-run signal (`session.status`, tool states,
 *    `permission.asked`) either arrives on `--format json` stdout or is lost.
 *    If it is lost, the §5 watchdog and the blocked state both degrade, and
 *    {@link OCEvent} would have to be synthesized from exit codes — decide
 *    whether that is acceptable before, not after.
 * 3. **Session reuse.** `--session <id>` claims to continue an existing session.
 *    `worker_revise` depends on that being true, exactly as it is for `serve`.
 * 4. **Usage.** `Session.cost`/`tokens` come from the HTTP API. Without a server
 *    there may be no budget signal at all, which would make §8's enforcement
 *    unavailable on this backend — a real constraint, not a detail.
 *
 * ## When to reach for it
 *
 * Per ADR-0001: one server degrading with 4+ concurrent sessions, a worker that
 * needs an agent definition that cannot be expressed per-prompt, or a stronger
 * isolation requirement than a shared process gives.
 */

import {
  type BackendHealth,
  type CreateSessionOptions,
  type EventStream,
  type EventStreamOptions,
  NotImplementedError,
  type PermissionReply,
  type OpenCodeBackend,
  type PromptRequest,
  type RunHandle,
  type SessionHandle,
  type SessionRef,
  type Usage,
} from "./types.js";

export interface RunBackendOptions {
  /** Executable to spawn. Default `opencode`. */
  readonly bin?: string;
  /** Repo root the subprocess runs in when a session does not specify one. */
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Hard ceiling on a single `opencode run` invocation. */
  readonly timeoutMs?: number;
}

const WHY = "ADR-0001 selected ServeBackend; RunBackend is a documented fallback and is not built. See src/opencode/run.ts.";

export class RunBackend implements OpenCodeBackend {
  readonly kind = "run" as const;

  constructor(readonly options: RunBackendOptions = {}) {}

  start(): Promise<void> {
    throw new NotImplementedError("RunBackend.start", WHY);
  }

  health(): Promise<BackendHealth> {
    // Answering rather than throwing: a supervisor polling health across
    // backends should learn this one is unavailable, not crash on it.
    return Promise.resolve({ alive: false, detail: WHY });
  }

  createSession(_opts: CreateSessionOptions): Promise<SessionHandle> {
    throw new NotImplementedError("RunBackend.createSession", WHY);
  }

  prompt(_session: SessionRef, _req: PromptRequest): Promise<RunHandle> {
    throw new NotImplementedError("RunBackend.prompt", WHY);
  }

  events(_session: SessionRef, _opts?: EventStreamOptions): Promise<EventStream> {
    throw new NotImplementedError("RunBackend.events", WHY);
  }

  abort(_target: SessionRef): Promise<boolean> {
    throw new NotImplementedError("RunBackend.abort", WHY);
  }

  respond(_session: SessionRef, _requestID: string, _reply: PermissionReply): Promise<boolean> {
    throw new NotImplementedError("RunBackend.respond", WHY);
  }

  usage(_session: SessionRef): Promise<Usage | null> {
    throw new NotImplementedError("RunBackend.usage", WHY);
  }

  /** Safe to call: disposing something that never started is a no-op, not an error. */
  dispose(): Promise<void> {
    return Promise.resolve();
  }
}
