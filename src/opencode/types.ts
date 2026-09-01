/**
 * The OpenCode adapter boundary (DD-2).
 *
 * This file and its siblings in `src/opencode/` are the only code in the system
 * allowed to know that OpenCode exists. Nothing outside this directory may
 * import an OpenCode type, name an endpoint path, or parse an OpenCode event.
 * Everything here is normalized: callers see `OCEvent`, `Usage`, `SessionHandle`
 * and typed errors, never a raw HTTP shape.
 *
 * The interface began as the sketch in `projectplan.md` §3.1. Phase 0 showed
 * four parts of that sketch could not be implemented as drawn; each deviation is
 * marked **[DEVIATION]** below with the fact that forced it. All facts cited are
 * from `docs/phase0-facts.md`, verified against OpenCode 1.18.23–1.18.25.
 */

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

/** A provider/model pair, already split. */
export interface ModelRef {
  readonly providerID: string;
  readonly modelID: string;
}

/**
 * Split a `"provider/model"` string into a {@link ModelRef}.
 *
 * Splits on the **first** `/` only: model IDs legitimately contain slashes
 * (`opencode/muse-spark-1.2-contributor-free` is provider `opencode`, model
 * `muse-spark-1.2-contributor-free`, but `openrouter/meta-llama/llama-3` is
 * provider `openrouter`, model `meta-llama/llama-3`).
 */
export function parseModel(spec: string | ModelRef): ModelRef {
  if (typeof spec !== "string") return spec;
  const slash = spec.indexOf("/");
  if (slash <= 0 || slash === spec.length - 1) {
    throw new OpenCodeError("config", `model must look like "provider/model", got ${JSON.stringify(spec)}`);
  }
  return { providerID: spec.slice(0, slash), modelID: spec.slice(slash + 1) };
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

export type PermissionAction = "allow" | "ask" | "deny";

/**
 * One inline permission rule, passed at session create.
 *
 * Phase 0 fact: permissions are configured **inline on the session**, not by
 * writing an `opencode.json` into the worktree. A ruleset of `edit`/`bash` =
 * `allow` produced a full headless run with zero pending permission requests.
 */
export interface PermissionRule {
  /** Permission name — `edit`, `bash`, `webfetch`, `*`, … */
  readonly permission: string;
  /** Glob the rule applies to; `**` for everything. */
  readonly pattern: string;
  readonly action: PermissionAction;
}

/** Deny-nothing, ask-nothing: what a headless worker needs to run unattended. */
export const HEADLESS_PERMISSIONS: readonly PermissionRule[] = [
  { permission: "edit", pattern: "**", action: "allow" },
  { permission: "bash", pattern: "**", action: "allow" },
];

/**
 * Everything, including the permissions this adapter does not know the names of.
 *
 * The wildcard entry is the load-bearing one. {@link HEADLESS_PERMISSIONS} names
 * two permissions because those are the two Phase 0 measured; a provider that
 * adds a third gets `ask` for it by default, and `ask` in a headless run is not a
 * safeguard — it is a worker waiting on an answer from nobody until a watchdog
 * kills it. `*` means a permission nobody here has heard of cannot become a
 * deadlock. The named entries stay in front of it because an implementation that
 * matches specific rules before wildcards should find the same answer either way,
 * and one that does not, fails loudly rather than subtly.
 */
export const FULL_PERMISSIONS: readonly PermissionRule[] = [
  { permission: "edit", pattern: "**", action: "allow" },
  { permission: "bash", pattern: "**", action: "allow" },
  { permission: "webfetch", pattern: "**", action: "allow" },
  // The jail signal, granted. See ADR-0011.
  { permission: "external_directory", pattern: "**", action: "allow" },
  // An interactive anti-loop guard, which is the one thing a headless worker
  // cannot be. The manager bounds loops three other ways.
  { permission: "doom_loop", pattern: "**", action: "allow" },
  { permission: "*", pattern: "**", action: "allow" },
];

// ---------------------------------------------------------------------------
// Handles
// ---------------------------------------------------------------------------

/**
 * The minimum needed to address a session.
 *
 * **[DEVIATION 1 — the important one]** The §3.1 sketch addressed sessions by
 * bare `sessionId: string`. That cannot work: SSE streams are *directory-scoped*
 * (`GET /event?directory=…`), and a subscription opened on the wrong directory
 * delivers nothing at all — no error, no warning, just an infinite wait. Every
 * session-addressing call therefore carries the directory alongside the id, so
 * the scope is structural rather than a lookup that can silently miss.
 */
export interface SessionRef {
  readonly sessionID: string;
  /** Absolute path the session was created against. The SSE scope key. */
  readonly directory: string;
}

/**
 * What may be said back to a permission request.
 *
 * The backend's own vocabulary, kept rather than renamed because these three are
 * genuinely distinct decisions and a boolean would lose the middle one: `always`
 * is remembered for the rest of the session, which is the difference between
 * answering a question and settling it.
 */
export type PermissionReply = "once" | "always" | "reject";

export interface SessionHandle extends SessionRef {
  readonly title?: string;
  /** Built-in agent the session was created with, if any. */
  readonly agent?: string;
  readonly model?: ModelRef;
  readonly parentID?: string;
  /** Local wall-clock ms at creation. */
  readonly createdAt: number;
}

/**
 * A single in-flight prompt.
 *
 * **[DEVIATION 2]** `runId` in the sketch implied OpenCode hands one back. It
 * does not: `POST /session/{id}/prompt_async` answers **HTTP 204 with an empty
 * body**. The adapter mints `runID` locally so callers have a correlation key
 * for logs and state; it is meaningless to OpenCode.
 */
export interface RunHandle extends SessionRef {
  /** Adapter-minted. Not an OpenCode identifier. */
  readonly runID: string;
  /** Set only when the caller supplied one, so it can match `message.*` events. */
  readonly messageID?: string;
  readonly startedAt: number;
}

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface CreateSessionOptions {
  /**
   * Absolute path the worker runs in — typically a git worktree.
   * Becomes `?directory=` on create *and* the scope of every event subscription.
   */
  readonly cwd: string;
  readonly title?: string;
  /**
   * A **built-in** agent name (`build`, `plan`, `explore`, `general`).
   *
   * **[DEVIATION 3]** The sketch treated `agent` as the channel for the worker
   * contract, via a `.opencode/agent/worker.md` dropped into each worktree.
   * Phase 0 proved that does not work under DD-2: custom agents are discovered
   * only at *server start*, from the *server's own cwd*, and
   * `GET /agent?directory=…` accepts the parameter and ignores it. A shared
   * server will never see a per-worktree agent file. The worker contract goes in
   * {@link PromptRequest.system} instead — fully dynamic, no files, no restart.
   */
  readonly agent?: string;
  readonly model?: string | ModelRef;
  /** Inline ruleset. See {@link HEADLESS_PERMISSIONS}. */
  readonly permissions?: readonly PermissionRule[];
  /** Parent session, for sub-sessions. */
  readonly parentID?: string;
}

/** Schema-constrained replies: OpenCode validates and retries server-side. */
export type OutputFormat =
  | { readonly type: "text" }
  | { readonly type: "json_schema"; readonly schema: unknown; readonly retryCount?: number };

export interface PromptRequest {
  readonly text: string;
  /** Overrides the session's model for this prompt. */
  readonly model?: string | ModelRef;
  /**
   * Per-prompt system prompt. **This is where the worker contract lives** — see
   * [DEVIATION 3] on {@link CreateSessionOptions.agent}.
   */
  readonly system?: string;
  /** Built-in agent override for this prompt. */
  readonly agent?: string;
  /** Per-tool enable map, e.g. `{ bash: false }` for a read-only worker. */
  readonly tools?: Readonly<Record<string, boolean>>;
  /** Reasoning-effort variant, provider-specific. */
  readonly variant?: string;
  readonly format?: OutputFormat;
  /** Supply to correlate `message.*` events with this prompt. Must match `^msg`. */
  readonly messageID?: string;
}

export interface EventStreamOptions {
  /**
   * Include `message.part.delta` token-by-token text events.
   *
   * Off by default: deltas are the overwhelming majority of stream volume (a
   * trivial task emitted 124 events, most of them deltas) and no consumer above
   * this layer needs them. Turn on only for live-transcript features.
   */
  readonly deltas?: boolean;
  /** Cancels the subscription. */
  readonly signal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// Usage
// ---------------------------------------------------------------------------

/**
 * Budget signal for a session.
 *
 * Phase 0 fact: `cost` is `0` on free-tier models, so **budget on tokens** and
 * treat `cost` as advisory — which is why {@link totalTokens} is precomputed and
 * `cost` is not.
 */
export interface Usage {
  readonly input: number;
  readonly output: number;
  readonly reasoning: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  /** `input + output + reasoning`. The primary budget signal. */
  readonly totalTokens: number;
  /** Advisory. `0` on free-tier providers even after real work. */
  readonly cost: number;
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Normalized error taxonomy.
 *
 * The first eight map 1:1 onto OpenCode's `session.error` discriminated union,
 * keyed off its `name` field — never off message text. The rest are the
 * adapter's own failure modes.
 */
export type OCErrorCode =
  // --- from session.error ---
  | "provider_auth"
  | "output_length"
  | "aborted"
  | "structured_output"
  | "context_overflow"
  | "content_filter"
  | "api"
  | "unknown"
  // --- adapter-side ---
  /** Socket died, DNS failed, connection refused. */
  | "transport"
  /** Server answered, but not with what the contract promises. */
  | "protocol"
  /** The backend process is not running / not reachable. */
  | "backend_unavailable"
  /** An adapter-side deadline elapsed. */
  | "timeout"
  /** Caller passed something the adapter rejects before any I/O. */
  | "config"
  /** Reached a deliberately unbuilt code path. */
  | "not_implemented";

/** Codes worth retrying without operator involvement. */
const RETRYABLE: ReadonlySet<OCErrorCode> = new Set<OCErrorCode>(["transport", "timeout", "backend_unavailable"]);

export class OpenCodeError extends Error {
  readonly code: OCErrorCode;
  readonly retryable: boolean;
  /** Structured payload from the source error. Data, never instructions (DD-8). */
  readonly detail: Readonly<Record<string, unknown>>;

  constructor(
    code: OCErrorCode,
    message: string,
    opts: { retryable?: boolean; detail?: Record<string, unknown>; cause?: unknown } = {},
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "OpenCodeError";
    this.code = code;
    this.retryable = opts.retryable ?? RETRYABLE.has(code);
    this.detail = Object.freeze({ ...(opts.detail ?? {}) });
  }
}

export class NotImplementedError extends OpenCodeError {
  constructor(what: string, why?: string) {
    super("not_implemented", why ? `${what} is not implemented: ${why}` : `${what} is not implemented`);
    this.name = "NotImplementedError";
  }
}

/** OpenCode's `session.error` discriminator → our code. Exhaustive as of 1.18.25. */
const SESSION_ERROR_CODES: Readonly<Record<string, OCErrorCode>> = {
  ProviderAuthError: "provider_auth",
  MessageOutputLengthError: "output_length",
  MessageAbortedError: "aborted",
  StructuredOutputError: "structured_output",
  ContextOverflowError: "context_overflow",
  ContentFilterError: "content_filter",
  APIError: "api",
  UnknownError: "unknown",
};

/**
 * Map a raw `session.error` payload (`{name, data}`) onto a typed error.
 *
 * Dispatches on `name`, per the fact sheet's "map these, do not string-match".
 * An unrecognized `name` becomes `unknown` with the original preserved in
 * `detail.name` rather than being dropped — OpenCode may add union members.
 */
export function toTypedError(raw: unknown): OpenCodeError {
  const rec = isRecord(raw) ? raw : {};
  const name = typeof rec["name"] === "string" ? rec["name"] : undefined;
  const data = isRecord(rec["data"]) ? rec["data"] : {};
  const code = (name && SESSION_ERROR_CODES[name]) || "unknown";
  const message = typeof data["message"] === "string" ? data["message"] : (name ?? "session error");
  // APIError self-declares retryability; trust it over our default.
  const retryable = typeof data["isRetryable"] === "boolean" ? data["isRetryable"] : undefined;
  return new OpenCodeError(code, message, { retryable, detail: { ...data, name: name ?? null } });
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

export type ToolState = "pending" | "running" | "completed" | "error";

interface EventBase {
  /** Local receipt time in ms. Not OpenCode's clock. */
  readonly at: number;
  /** The raw frame, for diagnostics only. Typed `unknown` on purpose: parsing
   *  OpenCode shapes outside this directory is exactly what DD-2 forbids. */
  readonly raw?: unknown;
}

/**
 * Normalized event vocabulary.
 *
 * OpenCode's stream carries 89+ documented variants plus at least one undocumented
 * (`server.heartbeat`). This union is the subset Dispatched Code acts on;
 * everything else arrives as `kind: "other"` with its type string intact, so an
 * unmapped-but-interesting event shows up in logs instead of vanishing.
 */
export type OCEvent =
  /** Subscription established (`server.connected`). Always the first frame. */
  | (EventBase & { readonly kind: "stream.open" })
  /**
   * Server liveness tick, ~every 10s regardless of session activity.
   * Heartbeats present + no worker events = the *worker* is stuck.
   * Heartbeats absent = the *server* is gone. Two different failures — see
   * {@link isWorkerEvent}.
   */
  | (EventBase & { readonly kind: "heartbeat" })
  | (EventBase & {
      readonly kind: "status";
      readonly sessionID: string;
      readonly busy: boolean;
      /** Present when the provider is retrying (`status.type === "retry"`). */
      readonly retry?: { readonly attempt: number; readonly message?: string };
    })
  /** Terminal: the run finished. The primary completion signal. */
  | (EventBase & { readonly kind: "idle"; readonly sessionID: string })
  /** Terminal: the run failed. */
  | (EventBase & { readonly kind: "error"; readonly sessionID: string; readonly error: OpenCodeError })
  | (EventBase & {
      readonly kind: "tool";
      readonly sessionID: string;
      readonly tool: string;
      readonly callID: string;
      readonly state: ToolState;
      readonly title?: string;
    })
  | (EventBase & { readonly kind: "text"; readonly sessionID: string; readonly delta: string })
  | (EventBase & { readonly kind: "file.edited"; readonly file: string })
  | (EventBase & {
      readonly kind: "diff";
      readonly sessionID: string;
      readonly files: number;
    })
  /** Worker is blocked on a permission grant. Maps to lifecycle `blocked` (§5). */
  | (EventBase & {
      readonly kind: "permission.asked";
      readonly sessionID: string;
      readonly requestID: string;
      readonly permission: string;
      readonly patterns: readonly string[];
    })
  | (EventBase & { readonly kind: "permission.replied"; readonly sessionID: string; readonly requestID: string })
  /** Worker is blocked on a question. The escalation channel (§5). */
  | (EventBase & {
      readonly kind: "question.asked";
      readonly sessionID: string;
      readonly requestID: string;
      readonly questions: readonly string[];
    })
  | (EventBase & {
      readonly kind: "question.replied";
      readonly sessionID: string;
      readonly requestID: string;
      readonly rejected: boolean;
    })
  /** Anything unmapped. `type` is OpenCode's own string. */
  | (EventBase & { readonly kind: "other"; readonly type: string; readonly sessionID?: string });

/** Terminal kinds: after one of these the run is over. */
export function isTerminal(e: OCEvent): e is Extract<OCEvent, { kind: "idle" | "error" }> {
  return e.kind === "idle" || e.kind === "error";
}

/** Blocked kinds: the worker is waiting on Dispatched Code (§5). */
export function isBlocking(e: OCEvent): boolean {
  return e.kind === "permission.asked" || e.kind === "question.asked";
}

/**
 * A block Dispatched Code can answer **in band**, leaving the turn running.
 *
 * The distinction is not cosmetic and it is not the caller's to work out: a
 * permission request is answered with one of three fixed decisions and the
 * worker resumes at the tool call it was waiting at, while a question expects a
 * selection from labels it offered and has already ended its turn. Only the
 * first can be replied to with {@link OpenCodeBackend.respond}.
 *
 * A predicate rather than a `kind` comparison at the call site, because DD-2
 * puts every event name on this side of the boundary — and the manager asking
 * "can I answer this?" is the question it actually has.
 */
export function isAnswerable(e: OCEvent): e is Extract<OCEvent, { kind: "permission.asked" }> {
  return e.kind === "permission.asked" && e.requestID !== "";
}

/**
 * True when the event is evidence the *worker* is making progress, as opposed to
 * evidence the *server* is alive.
 *
 * The §5 idle watchdog must key off this, not off stream silence: a stream that
 * carries heartbeats and nothing else means the worker hung, which is a
 * different failure from the server dying, and wants a different response.
 */
export function isWorkerEvent(e: OCEvent): boolean {
  if (e.kind === "heartbeat" || e.kind === "stream.open") return false;
  // An unmapped event still counts as progress if it is scoped to the session —
  // `message.updated` and friends are real worker activity even though
  // Dispatched Code does not act on them. Unscoped noise (`plugin.added`,
  // `catalog.updated`) is not.
  if (e.kind === "other") return e.sessionID !== undefined;
  return true;
}

/**
 * A live, already-established event subscription.
 *
 * **[DEVIATION 4]** The sketch had `events()` return a bare `AsyncIterable`.
 * That reintroduces the race the fact sheet warns about: a lazy iterable does not
 * open its HTTP request until the first `next()`, so `events(); prompt();` would
 * subscribe *after* prompting and could miss a `session.idle` that arrives ~11s
 * later. `events()` therefore returns a **promise of an open stream** — awaiting
 * it means the subscription is live and buffering, so the safe ordering is the
 * natural one to write.
 */
export interface EventStream extends AsyncIterable<OCEvent> {
  /** The directory this subscription is scoped to. */
  readonly directory: string;
  readonly sessionID: string;
  /** Events dropped to bound memory. Never counts terminal or blocking events. */
  readonly dropped: number;
  /**
   * Idempotent. Ends iteration and releases the underlying stream if this was
   * its last consumer.
   *
   * Breaking out of a `for await` does *not* do this — a subscription outlives
   * any one loop over it, so the same stream can be iterated, stopped at a
   * blocking event, and iterated again once the worker is unblocked.
   */
  close(): void;
}

// ---------------------------------------------------------------------------
// Backend
// ---------------------------------------------------------------------------

export interface BackendHealth {
  readonly alive: boolean;
  readonly version?: string;
  /** Why it is not alive, when it is not. */
  readonly detail?: string;
}

/**
 * The whole of OpenCode, as the rest of the system sees it.
 *
 * Implementations: {@link import("./serve").ServeBackend} (default, ADR-0001)
 * and {@link import("./run").RunBackend} (documented fallback, unbuilt).
 */
export interface OpenCodeBackend {
  readonly kind: "serve" | "run";

  /** Start or attach to the backend. Idempotent. */
  start(): Promise<void>;

  /**
   * Cheap liveness probe, independent of any session.
   *
   * **[DEVIATION 5]** Not in the sketch. Phase 2's watchdog cannot distinguish
   * "worker stuck" from "server gone" by stream silence alone, and the fact sheet
   * requires it to. This is the second half of that answer; {@link isWorkerEvent}
   * is the first.
   */
  health(): Promise<BackendHealth>;

  createSession(opts: CreateSessionOptions): Promise<SessionHandle>;

  /** Fire-and-forget. Returns as soon as OpenCode accepts the prompt (~30ms). */
  prompt(session: SessionRef, req: PromptRequest): Promise<RunHandle>;

  /** Resolves once the subscription is open — subscribe *before* prompting. */
  events(session: SessionRef, opts?: EventStreamOptions): Promise<EventStream>;

  /**
   * Abort whatever the session is currently running.
   *
   * **[DEVIATION 6]** The sketch had `abort(runId)`. OpenCode aborts at *session*
   * granularity (`POST /session/{id}/abort`) and never issued a run id in the
   * first place, so a {@link RunHandle} is accepted only because it is also a
   * {@link SessionRef}. Aborting a run aborts the session's current work,
   * whatever that turns out to be.
   */
  abort(target: SessionRef): Promise<boolean>;

  /**
   * Answer a permission request in band, letting the turn carry on.
   *
   * **[DEVIATION 7]** Not in the sketch, and the gap `docs/phase0-facts.md`
   * "Unresolved" 5 carried from Phase 1 to Phase 7. Without it the manager has
   * to convert a mid-run permission ask into an escalation — abort the turn,
   * surface the question, deliver the answer as the next prompt — which works
   * and costs a partial turn every time. Phase 6's v1 demo measured that cost as
   * real rather than theoretical: three asks in one four-worker run, and the
   * worker that escalated twice finished on 47,531 tokens against 7,715 for the
   * one that never did.
   *
   * Returns `false` when the request is unknown to the backend, which is the
   * ordinary outcome of answering one twice or answering one the turn has since
   * abandoned — a caller should treat it as "already resolved", not as an error.
   */
  respond(session: SessionRef, requestID: string, reply: PermissionReply): Promise<boolean>;

  /** `null` when the session is unknown to the backend. */
  usage(session: SessionRef): Promise<Usage | null>;

  /** Close subscriptions and stop the process if we started it. Idempotent. */
  dispose(): Promise<void>;
}
