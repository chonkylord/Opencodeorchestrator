/**
 * `ServeBackend` — one long-lived `opencode serve` process hosting N sessions,
 * each rooted in its own directory. The default backend, per ADR-0001.
 *
 * Everything here is a refactor of `spike/spike.ts` behind {@link OpenCodeBackend},
 * plus the three things the spike did not have to care about: fan-out to several
 * consumers of one directory stream, bounded buffering, and lifecycle.
 *
 * The load-bearing detail is in {@link DirectorySubscription}: SSE streams are
 * scoped by directory, and getting that wrong is a silent hang rather than an
 * error. Read that comment before changing anything about subscriptions.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";

import {
  type BackendHealth,
  type CreateSessionOptions,
  type EventStream,
  type EventStreamOptions,
  type ModelRef,
  type OCEvent,
  type OpenCodeBackend,
  OpenCodeError,
  type PermissionReply,
  type PromptRequest,
  type RunHandle,
  type SessionHandle,
  type SessionRef,
  type Usage,
  isBlocking,
  isTerminal,
  parseModel,
  toTypedError,
} from "./types.js";

export interface ServeBackendOptions {
  /**
   * Attach to an already-running server instead of spawning one. When set, the
   * backend never spawns and never kills — `dispose()` only drops subscriptions.
   */
  readonly baseUrl?: string;
  /**
   * Working directory of the *server process*. Sessions get their own
   * directories; this one only matters for what the server can discover at
   * start-up (custom agents, project config), so it should be the repo root.
   */
  readonly cwd?: string;
  /** Executable to spawn. Overridable so tests can spawn a fake. */
  readonly bin?: string;
  /** Args for the executable. Default `["serve", "--port", "0"]`. */
  readonly args?: readonly string[];
  readonly env?: NodeJS.ProcessEnv;
  /** How long to wait for the `listening on …` line. Default 60s. */
  readonly startTimeoutMs?: number;
  /** Per-request deadline for ordinary HTTP calls. Default 30s. */
  readonly requestTimeoutMs?: number;
  /**
   * Per-consumer event buffer. Terminal and blocking events are never dropped;
   * everything else is dropped oldest-first once the buffer is full, and counted
   * on {@link EventStream.dropped}. Default 4096.
   */
  readonly maxQueue?: number;
  /** Receives the server's stdout/stderr lines. Default: discard. */
  readonly onServerLog?: (line: string) => void;
}

const DEFAULTS = {
  bin: "opencode",
  args: ["serve", "--port", "0"] as const,
  startTimeoutMs: 60_000,
  requestTimeoutMs: 30_000,
  maxQueue: 4096,
};

/**
 * Make sure loopback traffic is never sent to an outbound proxy.
 *
 * Bun's `fetch` honours `$HTTP_PROXY`/`$NO_PROXY`; in a proxied environment
 * (this repo's CI is one) a request to `http://127.0.0.1:PORT` is otherwise
 * tunnelled and fails in a way that looks like the server never started.
 * Mutating the environment is blunt, but the alternative is every caller
 * remembering to do it — which is exactly the class of footgun this adapter
 * exists to absorb.
 */
export function ensureLocalhostBypassesProxy(env: NodeJS.ProcessEnv = process.env): void {
  const needed = ["127.0.0.1", "localhost"];
  const current = (env["NO_PROXY"] ?? env["no_proxy"] ?? "").split(",").map((s) => s.trim());
  const missing = needed.filter((h) => !current.includes(h));
  if (missing.length === 0) return;
  env["NO_PROXY"] = [...current.filter(Boolean), ...missing].join(",");
  env["no_proxy"] = env["NO_PROXY"];
}

export class ServeBackend implements OpenCodeBackend {
  readonly kind = "serve" as const;

  private readonly opts: ServeBackendOptions;
  private proc: ChildProcess | undefined;
  private baseUrl: string | undefined;
  private starting: Promise<void> | undefined;
  private disposed = false;
  /**
   * directory → subscription. Not one global stream: `GET /event` without a
   * matching `?directory=` delivers nothing for a session opened elsewhere.
   */
  private readonly subs = new Map<string, DirectorySubscription>();

  constructor(opts: ServeBackendOptions = {}) {
    this.opts = opts;
    if (opts.baseUrl) this.baseUrl = opts.baseUrl.replace(/\/$/, "");
  }

  /** The URL in use. Throws before {@link start}. */
  get url(): string {
    if (!this.baseUrl) throw new OpenCodeError("backend_unavailable", "ServeBackend.start() has not completed");
    return this.baseUrl;
  }

  async start(): Promise<void> {
    if (this.disposed) throw new OpenCodeError("backend_unavailable", "ServeBackend has been disposed");
    this.starting ??= this.doStart();
    return this.starting;
  }

  private async doStart(): Promise<void> {
    ensureLocalhostBypassesProxy();
    if (this.opts.baseUrl) {
      // Attached mode: prove it is really there rather than failing later, mid-run.
      const health = await this.health();
      if (!health.alive) {
        throw new OpenCodeError("backend_unavailable", `no OpenCode server at ${this.opts.baseUrl}: ${health.detail}`);
      }
      return;
    }
    this.baseUrl = await this.spawnServer();
  }

  private spawnServer(): Promise<string> {
    const bin = this.opts.bin ?? DEFAULTS.bin;
    const args = [...(this.opts.args ?? DEFAULTS.args)];
    const timeoutMs = this.opts.startTimeoutMs ?? DEFAULTS.startTimeoutMs;
    const env = { ...process.env, ...(this.opts.env ?? {}) };
    ensureLocalhostBypassesProxy(env);

    return new Promise<string>((resolve, reject) => {
      let proc: ChildProcess;
      try {
        proc = spawn(bin, args, { cwd: this.opts.cwd, stdio: ["ignore", "pipe", "pipe"], env });
      } catch (cause) {
        reject(new OpenCodeError("backend_unavailable", `could not spawn ${bin}`, { cause }));
        return;
      }
      this.proc = proc;

      let settled = false;
      let buf = "";
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        proc.kill("SIGKILL");
        reject(
          new OpenCodeError("timeout", `${bin} did not announce a port within ${timeoutMs}ms`, {
            detail: { output: buf.slice(-2000) },
          }),
        );
      }, timeoutMs);

      const onChunk = (chunk: Buffer) => {
        const text = chunk.toString();
        buf += text;
        for (const line of text.split("\n")) if (line.trim()) this.opts.onServerLog?.(line);
        if (settled) return;
        // `--port 0` means "pick a free port and say which". It picked 4096 on
        // every observed run, which is exactly how a hardcoded 4096 survives
        // local testing and then collides under concurrency. Always parse.
        const m = buf.match(/listening on (https?:\/\/\S+)/i);
        if (m?.[1]) {
          settled = true;
          clearTimeout(timer);
          resolve(m[1].replace(/\/$/, ""));
        }
      };
      proc.stdout?.on("data", onChunk);
      proc.stderr?.on("data", onChunk);
      proc.on("error", (cause) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(new OpenCodeError("backend_unavailable", `could not spawn ${bin}: ${cause.message}`, { cause }));
      });
      proc.on("exit", (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(
          new OpenCodeError("backend_unavailable", `${bin} exited before listening (code ${code}, signal ${signal})`, {
            detail: { output: buf.slice(-2000) },
          }),
        );
      });
    });
  }

  async health(): Promise<BackendHealth> {
    const base = this.baseUrl ?? this.opts.baseUrl?.replace(/\/$/, "");
    if (!base) return { alive: false, detail: "not started" };
    if (this.proc && this.proc.exitCode !== null) {
      return { alive: false, detail: `server process exited with code ${this.proc.exitCode}` };
    }
    try {
      // /global/health is session-independent and free — exactly what a watchdog
      // needs to tell "the server is gone" from "the worker is wedged".
      const body = await this.request<{ healthy: boolean; version?: string }>("GET", "/global/health", {
        timeoutMs: 5_000,
      });
      return { alive: body?.healthy === true, version: body?.version };
    } catch (e) {
      return { alive: false, detail: e instanceof Error ? e.message : String(e) };
    }
  }

  async createSession(opts: CreateSessionOptions): Promise<SessionHandle> {
    await this.start();
    const directory = normalizeDirectory(opts.cwd);
    const model = opts.model === undefined ? undefined : parseModel(opts.model);

    const body: Record<string, unknown> = {};
    if (opts.title !== undefined) body["title"] = opts.title;
    if (opts.agent !== undefined) body["agent"] = opts.agent;
    if (opts.parentID !== undefined) body["parentID"] = opts.parentID;
    if (opts.permissions !== undefined) body["permission"] = opts.permissions.map((r) => ({ ...r }));
    // Beware: `POST /session` wants `{id, providerID}` while
    // `prompt_async` wants `{providerID, modelID}` for the same concept. Sending
    // the prompt shape here is accepted and silently ignored.
    if (model) body["model"] = { providerID: model.providerID, id: model.modelID };

    const session = await this.request<Record<string, unknown>>("POST", "/session", {
      query: { directory },
      body,
    });
    const sessionID = typeof session?.["id"] === "string" ? session["id"] : undefined;
    if (!session || !sessionID) {
      throw new OpenCodeError("protocol", "POST /session returned no session id", { detail: { got: session } });
    }
    const echoed = typeof session["directory"] === "string" ? session["directory"] : directory;
    if (echoed !== directory) {
      // A mismatch means every later subscription would be scoped to the wrong
      // path and would sit silent forever. Fail loudly, here, once.
      throw new OpenCodeError("protocol", `session directory mismatch: asked ${directory}, got ${echoed}`, {
        detail: { sessionID, requested: directory, actual: echoed },
      });
    }
    return {
      sessionID,
      directory,
      ...(opts.title === undefined ? {} : { title: opts.title }),
      ...(opts.agent === undefined ? {} : { agent: opts.agent }),
      ...(model === undefined ? {} : { model }),
      ...(opts.parentID === undefined ? {} : { parentID: opts.parentID }),
      createdAt: Date.now(),
    };
  }

  async prompt(session: SessionRef, req: PromptRequest): Promise<RunHandle> {
    await this.start();
    const directory = normalizeDirectory(session.directory);
    const model = req.model === undefined ? undefined : parseModel(req.model);

    const body: Record<string, unknown> = { parts: [{ type: "text", text: req.text }] };
    if (model) body["model"] = { providerID: model.providerID, modelID: model.modelID };
    if (req.system !== undefined) body["system"] = req.system;
    if (req.agent !== undefined) body["agent"] = req.agent;
    if (req.tools !== undefined) body["tools"] = { ...req.tools };
    if (req.variant !== undefined) body["variant"] = req.variant;
    if (req.format !== undefined) body["format"] = req.format;
    if (req.messageID !== undefined) body["messageID"] = req.messageID;

    const startedAt = Date.now();
    // 204, empty body, ~30ms. The work continues in the background; completion
    // arrives on the event stream, which is why callers must subscribe first.
    await this.request<null>("POST", `/session/${encodeURIComponent(session.sessionID)}/prompt_async`, {
      query: { directory },
      body,
    });
    return {
      runID: `run_${randomUUID()}`,
      sessionID: session.sessionID,
      directory,
      ...(req.messageID === undefined ? {} : { messageID: req.messageID }),
      startedAt,
    };
  }

  async events(session: SessionRef, opts: EventStreamOptions = {}): Promise<EventStream> {
    await this.start();
    const directory = normalizeDirectory(session.directory);
    let sub = this.subs.get(directory);
    if (!sub || sub.finished) {
      sub = new DirectorySubscription(this.url, directory, () => {
        if (this.subs.get(directory) === sub) this.subs.delete(directory);
      });
      this.subs.set(directory, sub);
    }
    // Resolves only once the stream is actually open, so `await events(); prompt()`
    // cannot race — see [DEVIATION 4] in types.ts.
    await sub.ready();
    return sub.consumer(session.sessionID, {
      deltas: opts.deltas ?? false,
      maxQueue: this.opts.maxQueue ?? DEFAULTS.maxQueue,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
  }

  async abort(target: SessionRef): Promise<boolean> {
    await this.start();
    const result = await this.request<unknown>("POST", `/session/${encodeURIComponent(target.sessionID)}/abort`, {
      query: { directory: normalizeDirectory(target.directory) },
      body: {},
    });
    return result === true;
  }

  /**
   * Answer a permission request the worker raised, in band (§11 Phase 7).
   *
   * Closes `docs/phase0-facts.md` "Unresolved" 5, and the answer is not the one
   * the fact sheet expected. Three shapes for this exist in the OpenAPI document
   * and the row listed the v2 one, on the strength of having read it:
   *
   * ```
   * POST /api/session/{id}/permission/{requestID}/reply  {reply}      -> 404
   * POST /session/{id}/permissions/{permissionID}        {response}   -> 200
   * ```
   *
   * Measured on the wire against OpenCode 1.18.25 on 2026-08-29: a request
   * raised as `permission.asked` is **not found** by the v2 endpoint — it belongs
   * to a different registry — and is answered by the v1 session-scoped one. The
   * probe let the worker carry on and write its file, which is the property that
   * matters: the turn continues rather than being abandoned.
   *
   * This is why the fact sheet distinguishes "verified (schema)" from
   * "verified": the first means somebody read the document.
   */
  async respond(session: SessionRef, requestID: string, reply: PermissionReply): Promise<boolean> {
    await this.start();
    try {
      const result = await this.request<unknown>(
        "POST",
        `/session/${encodeURIComponent(session.sessionID)}/permissions/${encodeURIComponent(requestID)}`,
        {
          query: { directory: normalizeDirectory(session.directory) },
          body: { response: reply },
        },
      );
      return result === true || result === null || result === undefined;
    } catch (e) {
      // A request the backend no longer knows is the ordinary outcome of
      // answering one twice, or of answering one the turn has already abandoned.
      // `false` rather than a throw, for the same reason `usage()` answers `null`
      // on a 404: "it is not there" is an answer to the question that was asked,
      // and a caller that has to catch an exception to learn it will eventually
      // catch one that meant something else.
      if (e instanceof OpenCodeError && e.detail["status"] === 404) return false;
      throw e;
    }
  }

  async usage(session: SessionRef): Promise<Usage | null> {
    await this.start();
    let raw: Record<string, unknown> | null;
    try {
      raw = await this.request<Record<string, unknown>>("GET", `/session/${encodeURIComponent(session.sessionID)}`, {
        query: { directory: normalizeDirectory(session.directory) },
      });
    } catch (e) {
      if (e instanceof OpenCodeError && e.detail["status"] === 404) return null;
      throw e;
    }
    if (!raw) return null;
    return toUsage(raw);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    for (const sub of [...this.subs.values()]) sub.destroy();
    this.subs.clear();
    // Attached mode: someone else owns the process.
    if (this.opts.baseUrl || !this.proc) return;
    const proc = this.proc;
    this.proc = undefined;
    if (proc.exitCode !== null || proc.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const kill = setTimeout(() => proc.kill("SIGKILL"), 5_000);
      proc.once("exit", () => {
        clearTimeout(kill);
        resolve();
      });
      proc.kill("SIGTERM");
    });
  }

  // -------------------------------------------------------------------------

  private async request<T>(
    method: string,
    path: string,
    opts: { query?: Record<string, string>; body?: unknown; timeoutMs?: number } = {},
  ): Promise<T | null> {
    const url = new URL(this.url + path);
    for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);

    const ctrl = new AbortController();
    const timeoutMs = opts.timeoutMs ?? this.opts.requestTimeoutMs ?? DEFAULTS.requestTimeoutMs;
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetch(url, {
        method,
        signal: ctrl.signal,
        headers: { "content-type": "application/json", accept: "application/json" },
        ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }),
      });
    } catch (cause) {
      if (ctrl.signal.aborted) {
        throw new OpenCodeError("timeout", `${method} ${path} exceeded ${timeoutMs}ms`, { cause });
      }
      throw new OpenCodeError("transport", `${method} ${path} failed: ${errText(cause)}`, { cause });
    } finally {
      clearTimeout(timer);
    }

    const text = await res.text().catch(() => "");
    if (!res.ok) {
      throw new OpenCodeError(res.status >= 500 ? "transport" : "protocol", `${method} ${path} -> ${res.status}`, {
        retryable: res.status >= 500 || res.status === 429,
        detail: { status: res.status, body: text.slice(0, 1000) },
      });
    }
    if (!text) return null;
    try {
      return JSON.parse(text) as T;
    } catch (cause) {
      throw new OpenCodeError("protocol", `${method} ${path} returned non-JSON`, {
        cause,
        detail: { body: text.slice(0, 400) },
      });
    }
  }
}

// ---------------------------------------------------------------------------
// Subscriptions
// ---------------------------------------------------------------------------

interface ConsumerOptions {
  readonly deltas: boolean;
  readonly maxQueue: number;
  readonly signal?: AbortSignal;
}

/**
 * One `GET /event?directory=…` request, fanned out to every consumer interested
 * in that directory.
 *
 * **Why per-directory and not one global stream.** OpenCode scopes the event
 * stream by directory. A subscription to bare `GET /event` receives server-level
 * frames (`server.connected`, `server.heartbeat`) but *nothing* for a session
 * created against another directory — measured: 90s of silence unscoped versus
 * `session.idle` at 10.9s scoped. There is no error and no warning; the wait
 * simply never ends. So the adapter keys subscriptions by the same absolute path
 * it passed at session create, and `ServeBackend` holds a map of them.
 *
 * Consumers share the HTTP request; the last one to close releases it.
 */
class DirectorySubscription {
  readonly directory: string;
  finished = false;

  private readonly baseUrl: string;
  private readonly onFinish: () => void;
  private readonly ctrl = new AbortController();
  private readonly consumers = new Set<Consumer>();
  private open: Promise<void> | undefined;

  constructor(baseUrl: string, directory: string, onFinish: () => void) {
    this.baseUrl = baseUrl;
    this.directory = directory;
    this.onFinish = onFinish;
  }

  /** Resolves once the HTTP response headers are in and frames can arrive. */
  ready(): Promise<void> {
    this.open ??= this.run();
    return this.open;
  }

  consumer(sessionID: string, opts: ConsumerOptions): EventStream {
    const c = new Consumer(sessionID, this.directory, opts, () => {
      this.consumers.delete(c);
      if (this.consumers.size === 0) this.destroy();
    });
    if (this.finished) {
      c.end();
      return c;
    }
    this.consumers.add(c);
    opts.signal?.addEventListener("abort", () => c.close(), { once: true });
    return c;
  }

  destroy(): void {
    if (this.finished) return;
    this.finished = true;
    this.ctrl.abort();
    for (const c of this.consumers) c.end();
    this.consumers.clear();
    this.onFinish();
  }

  private async run(): Promise<void> {
    const url = new URL(`${this.baseUrl}/event`);
    url.searchParams.set("directory", this.directory);
    let res: Response;
    try {
      res = await fetch(url, { signal: this.ctrl.signal, headers: { accept: "text/event-stream" } });
    } catch (cause) {
      this.destroy();
      throw new OpenCodeError("transport", `GET /event?directory=${this.directory} failed: ${errText(cause)}`, { cause });
    }
    if (!res.ok || !res.body) {
      this.destroy();
      throw new OpenCodeError("transport", `GET /event -> ${res.status}`, { detail: { status: res.status } });
    }
    // Headers are in: the server is now buffering for us, so it is safe to prompt.
    void this.pump(res.body);
  }

  private async pump(body: ReadableStream<Uint8Array>): Promise<void> {
    try {
      for await (const raw of readSSE(body)) {
        const evt = normalizeEvent(raw);
        if (!evt) continue;
        for (const c of this.consumers) c.push(evt);
      }
      // Clean EOF is still the end of the world for anyone waiting on idle.
      this.destroy();
    } catch (e) {
      if (!this.ctrl.signal.aborted) {
        const err = new OpenCodeError("transport", `event stream for ${this.directory} broke: ${errText(e)}`, {
          cause: e,
        });
        for (const c of this.consumers) c.fail(err);
      }
      this.destroy();
    }
  }
}

/** One caller's view of a directory subscription: filtered, bounded, closeable. */
class Consumer implements EventStream {
  readonly directory: string;
  readonly sessionID: string;
  dropped = 0;

  private readonly opts: ConsumerOptions;
  private readonly onClose: () => void;
  private readonly queue: OCEvent[] = [];
  private waiting: ((r: IteratorResult<OCEvent>) => void) | undefined;
  private waitingReject: ((e: unknown) => void) | undefined;
  private ended = false;
  private error: unknown;

  constructor(sessionID: string, directory: string, opts: ConsumerOptions, onClose: () => void) {
    this.sessionID = sessionID;
    this.directory = directory;
    this.opts = opts;
    this.onClose = onClose;
  }

  push(evt: OCEvent): void {
    if (this.ended) return;
    if (!this.wants(evt)) return;
    if (this.waiting) {
      const resolve = this.waiting;
      this.waiting = undefined;
      this.waitingReject = undefined;
      resolve({ value: evt, done: false });
      return;
    }
    if (this.queue.length >= this.opts.maxQueue) {
      // Bound memory without ever losing the events a caller is actually waiting
      // for: drop the oldest event that is neither terminal nor blocking.
      const victim = this.queue.findIndex((e) => !isTerminal(e) && !isBlocking(e));
      if (victim === -1) return; // queue is all terminal/blocking: keep it, take the memory
      this.queue.splice(victim, 1);
      this.dropped++;
    }
    this.queue.push(evt);
  }

  private wants(evt: OCEvent): boolean {
    if (evt.kind === "text" && !this.opts.deltas) return false;
    // Frames with no session (heartbeat, stream.open, file.edited) belong to
    // every consumer on this directory — they are how liveness is observed.
    const sid = "sessionID" in evt ? evt.sessionID : undefined;
    return sid === undefined || sid === this.sessionID;
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;
    const resolve = this.waiting;
    this.waiting = undefined;
    this.waitingReject = undefined;
    resolve?.({ value: undefined, done: true });
  }

  fail(err: unknown): void {
    if (this.ended) return;
    this.error = err;
    const reject = this.waitingReject;
    this.waiting = undefined;
    this.waitingReject = undefined;
    if (reject) {
      this.ended = true;
      reject(err);
    }
  }

  close(): void {
    if (this.ended) {
      this.onClose();
      return;
    }
    this.end();
    this.onClose();
  }

  [Symbol.asyncIterator](): AsyncIterator<OCEvent> {
    return {
      next: (): Promise<IteratorResult<OCEvent>> => {
        const queued = this.queue.shift();
        if (queued) return Promise.resolve({ value: queued, done: false });
        if (this.error) {
          const err = this.error;
          this.error = undefined;
          this.ended = true;
          return Promise.reject(err);
        }
        if (this.ended) return Promise.resolve({ value: undefined, done: true });
        return new Promise<IteratorResult<OCEvent>>((resolve, reject) => {
          this.waiting = resolve;
          this.waitingReject = reject;
        });
      },
      // Deliberately does NOT close the subscription. `for await … break` is how
      // a caller stops at a blocking event and resumes iterating after answering
      // it (§5's blocked -> running edge); a stream that quietly died on `break`
      // would put back exactly the silent-hang class this adapter exists to
      // remove. The lifecycle is explicit: `close()`, or `dispose()`.
      return: (): Promise<IteratorResult<OCEvent>> => Promise.resolve({ value: undefined, done: true }),
    };
  }
}

// ---------------------------------------------------------------------------
// Wire parsing
// ---------------------------------------------------------------------------

/**
 * Yield one parsed JSON payload per SSE frame.
 *
 * Frames are separated by a blank line; a frame's payload is the concatenation
 * of its `data:` lines. Comment lines (`:` keep-alives) and unparseable payloads
 * are skipped rather than throwing — a malformed frame must not kill a stream
 * that is otherwise delivering a worker's completion event.
 */
export async function* readSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const frames = buf.split("\n\n");
      buf = frames.pop() ?? "";
      for (const frame of frames) {
        const payload = frame
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trim())
          .join("");
        if (!payload) continue;
        try {
          yield JSON.parse(payload);
        } catch {
          /* keep the stream alive */
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function rec(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

/**
 * Raw OpenCode frame → {@link OCEvent}.
 *
 * The payload lives under `properties` on the live SSE stream. The OpenAPI spec
 * also describes a `data`-keyed envelope for the same event types (the durable
 * event log), so both are accepted; only `properties` has been observed on
 * `/event`.
 *
 * Returns `undefined` only for frames with no usable `type`.
 */
export function normalizeEvent(raw: unknown, at = Date.now()): OCEvent | undefined {
  const frame = rec(raw);
  const type = str(frame["type"]);
  if (!type) return undefined;
  const p = rec(frame["properties"] ?? frame["data"]);
  const sessionID = str(p["sessionID"]);

  switch (type) {
    case "server.connected":
      return { kind: "stream.open", at, raw };
    case "server.heartbeat":
      return { kind: "heartbeat", at, raw };
    case "session.idle":
      return sessionID ? { kind: "idle", at, sessionID, raw } : undefined;
    case "session.error": {
      if (!sessionID) return undefined;
      return { kind: "error", at, sessionID, error: toTypedError(p["error"]), raw };
    }
    case "session.status": {
      if (!sessionID) return undefined;
      const status = rec(p["status"]);
      const kindOfStatus = str(status["type"]);
      const retryMessage = str(status["message"]);
      return {
        kind: "status",
        at,
        sessionID,
        busy: kindOfStatus === "busy",
        ...(kindOfStatus === "retry"
          ? {
              retry: {
                attempt: typeof status["attempt"] === "number" ? status["attempt"] : 0,
                ...(retryMessage === undefined ? {} : { message: retryMessage }),
              },
            }
          : {}),
        raw,
      };
    }
    case "message.part.updated": {
      if (!sessionID) return undefined;
      const part = rec(p["part"]);
      if (str(part["type"]) !== "tool") {
        // Real worker progress, just not something we act on. `other` keeps it
        // countable by the watchdog (see isWorkerEvent) without inventing a kind.
        return { kind: "other", at, type, sessionID, raw };
      }
      const state = rec(part["state"]);
      const status = str(state["status"]);
      const title = str(state["title"]);
      return {
        kind: "tool",
        at,
        sessionID,
        tool: str(part["tool"]) ?? "unknown",
        callID: str(part["callID"]) ?? "",
        state:
          status === "pending" || status === "running" || status === "completed" || status === "error"
            ? status
            : "pending",
        ...(title === undefined ? {} : { title }),
        raw,
      };
    }
    case "message.part.delta": {
      if (!sessionID) return undefined;
      return { kind: "text", at, sessionID, delta: str(p["delta"]) ?? "", raw };
    }
    case "file.edited": {
      const file = str(p["file"]);
      return file ? { kind: "file.edited", at, file, raw } : undefined;
    }
    case "session.diff": {
      if (!sessionID) return undefined;
      const diff = p["diff"];
      return { kind: "diff", at, sessionID, files: Array.isArray(diff) ? diff.length : 0, raw };
    }
    case "permission.asked":
    case "permission.v2.asked": {
      if (!sessionID) return undefined;
      const patterns = p["patterns"] ?? p["resources"];
      return {
        kind: "permission.asked",
        at,
        sessionID,
        // The *.asked events key the request as `id`; the replies key it as
        // `requestID`. Normalize to one name so callers can pair them.
        requestID: str(p["id"]) ?? "",
        permission: str(p["permission"]) ?? str(p["action"]) ?? "unknown",
        patterns: Array.isArray(patterns) ? patterns.filter((x): x is string => typeof x === "string") : [],
        raw,
      };
    }
    case "permission.replied":
    case "permission.v2.replied": {
      if (!sessionID) return undefined;
      return { kind: "permission.replied", at, sessionID, requestID: str(p["requestID"]) ?? "", raw };
    }
    case "question.asked":
    case "question.v2.asked": {
      if (!sessionID) return undefined;
      const qs = Array.isArray(p["questions"]) ? p["questions"] : [];
      return {
        kind: "question.asked",
        at,
        sessionID,
        requestID: str(p["id"]) ?? "",
        questions: qs.map((q) => str(rec(q)["question"]) ?? "").filter(Boolean),
        raw,
      };
    }
    case "question.replied":
    case "question.v2.replied":
    case "question.rejected":
    case "question.v2.rejected": {
      if (!sessionID) return undefined;
      return {
        kind: "question.replied",
        at,
        sessionID,
        requestID: str(p["requestID"]) ?? "",
        rejected: type.endsWith("rejected"),
        raw,
      };
    }
    default:
      return { kind: "other", at, type, ...(sessionID === undefined ? {} : { sessionID }), raw };
  }
}

/** Session JSON → {@link Usage}. Missing counters read as 0, never NaN. */
export function toUsage(session: Record<string, unknown>): Usage {
  const tokens = rec(session["tokens"]);
  const cache = rec(tokens["cache"]);
  const n = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const input = n(tokens["input"]);
  const output = n(tokens["output"]);
  const reasoning = n(tokens["reasoning"]);
  return {
    input,
    output,
    reasoning,
    cacheRead: n(cache["read"]),
    cacheWrite: n(cache["write"]),
    totalTokens: input + output + reasoning,
    cost: n(session["cost"]),
  };
}

function normalizeDirectory(dir: string): string {
  if (!dir || !isAbsolute(dir)) {
    throw new OpenCodeError("config", `directory must be an absolute path, got ${JSON.stringify(dir)}`);
  }
  // Trailing slashes make the session's directory and the stream's scope differ
  // as strings, which is the silent-hang failure mode all over again.
  return dir.length > 1 ? dir.replace(/\/+$/, "") : dir;
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Re-exported so callers never need to reach past the boundary. */
export type { ModelRef, OCEvent, SessionHandle, RunHandle, Usage };
