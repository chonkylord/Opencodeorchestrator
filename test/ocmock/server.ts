/**
 * `ocmock` — a scriptable fake OpenCode server (`projectplan.md` §12).
 *
 * Implements only the HTTP + SSE surface `ServeBackend` actually touches, and
 * implements it *faithfully enough to fail the adapter when the adapter is
 * wrong*. In particular it reproduces the one behaviour that is a silent hang
 * against the real thing:
 *
 *   **`GET /event?directory=X` never delivers events for a session created
 *   against directory Y.** No error, no warning, just silence. An adapter that
 *   forgets to scope its subscription passes every "does it parse SSE" test and
 *   then waits forever in production. Here it waits forever in a unit test
 *   instead, in three seconds, with a name.
 *
 * Scenarios: `success`, `hang`, `blocked`, `over_budget`, `crash`, and the
 * `lying_report` hook that Phase 2's reconciliation will assert against.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { Socket } from "node:net";

export type Scenario = "success" | "hang" | "blocked" | "over_budget" | "crash" | "lying_report";

export interface OCMockOptions {
  /** Applies to every session unless overridden per-session. Default `success`. */
  readonly scenario?: Scenario;
  /** Delay from `prompt_async` to the first worker event. Default 10ms. */
  readonly latencyMs?: number;
  /** Delay from first worker event to `session.idle`. Default 30ms. */
  readonly workMs?: number;
  /**
   * Heartbeat period. The real server ticks every 10s; tests want milliseconds.
   * Default 25ms. Set 0 to disable and simulate a wedged/dead server.
   */
  readonly heartbeatMs?: number;
  /**
   * Emit this many `plugin.added` frames plus `catalog.updated` before the first
   * prompt's real work, reproducing the ~45-event cold-start burst.
   */
  readonly coldStartEvents?: number;
  /** Tokens added to the session per prompt. Default 1000. */
  readonly tokensPerPrompt?: number;
  /** `over_budget`: tokens added per tick while the run refuses to finish. */
  readonly burnPerTickTokens?: number;
  /** Cost added per prompt. Default 0 — free-tier behaviour, deliberately. */
  readonly costPerPrompt?: number;
  readonly version?: string;
}

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly query: Readonly<Record<string, string>>;
  readonly body: unknown;
  readonly at: number;
}

interface MockSession {
  id: string;
  directory: string;
  title?: string;
  agent?: string;
  model?: unknown;
  permission?: unknown;
  parentID?: string;
  scenario: Scenario;
  tokens: { input: number; output: number; reasoning: number; cache: { read: number; write: number } };
  cost: number;
  summary: { additions: number; deletions: number; files: number };
  /** Set while a prompt is in flight; cleared on idle/abort. */
  running: boolean;
  /** `blocked`: the outstanding request id, if any. */
  pendingRequestID?: string;
  timers: Set<NodeJS.Timeout>;
  /** `lying_report`: what the worker claimed, for Phase 2 to cross-check. */
  claim?: string;
  prompts: unknown[];
}

interface Subscriber {
  res: ServerResponse;
  /** `undefined` = unscoped subscription: server frames only, no session events. */
  directory: string | undefined;
}

const DEFAULTS = {
  scenario: "success" as Scenario,
  latencyMs: 10,
  workMs: 30,
  heartbeatMs: 25,
  coldStartEvents: 0,
  tokensPerPrompt: 1000,
  burnPerTickTokens: 5000,
  costPerPrompt: 0,
  version: "1.18.25-ocmock",
};

let evtSeq = 0;
const evtID = () => `evt_ocmock_${(evtSeq++).toString(36).padStart(6, "0")}`;

export class OCMock {
  readonly requests: RecordedRequest[] = [];

  private readonly opts: Required<OCMockOptions>;
  private readonly server: Server;
  private readonly sessions = new Map<string, MockSession>();
  private readonly subscribers = new Set<Subscriber>();
  private readonly sockets = new Set<Socket>();
  private heartbeat: NodeJS.Timeout | undefined;
  private seq = 0;
  private crashed = false;
  private coldStartDone = false;

  private constructor(opts: OCMockOptions) {
    this.opts = { ...DEFAULTS, ...stripUndefined(opts) };
    this.server = createServer((req, res) => {
      void this.handle(req, res).catch((e) => {
        if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(e) }));
      });
    });
    this.server.on("connection", (s) => {
      this.sockets.add(s);
      s.on("close", () => this.sockets.delete(s));
    });
  }

  static async start(opts: OCMockOptions = {}): Promise<OCMock> {
    const mock = new OCMock(opts);
    await new Promise<void>((resolve) => mock.server.listen(0, "127.0.0.1", resolve));
    if (mock.opts.heartbeatMs > 0) {
      mock.heartbeat = setInterval(() => mock.broadcast(undefined, "server.heartbeat", {}), mock.opts.heartbeatMs);
      mock.heartbeat.unref?.();
    }
    return mock;
  }

  get port(): number {
    return (this.server.address() as AddressInfo).port;
  }

  get baseUrl(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  /** The line the real server prints, so spawn-and-parse can be tested verbatim. */
  get listeningLine(): string {
    return `opencode server listening on ${this.baseUrl}`;
  }

  // --- scripting ----------------------------------------------------------

  /** Point an existing session at a different scenario mid-flight. */
  setScenario(sessionID: string, scenario: Scenario): void {
    const s = this.sessions.get(sessionID);
    if (s) s.scenario = scenario;
  }

  /** `blocked`: answer the outstanding request so the run resumes and finishes. */
  resolveBlock(sessionID: string): boolean {
    const s = this.sessions.get(sessionID);
    if (!s?.pendingRequestID) return false;
    const requestID = s.pendingRequestID;
    s.pendingRequestID = undefined;
    this.emit(s, "permission.replied", { sessionID: s.id, requestID, reply: "once" });
    this.finish(s, this.opts.workMs);
    return true;
  }

  /** Whatever a `lying_report` worker claimed. Phase 2 checks it against git. */
  claimOf(sessionID: string): string | undefined {
    return this.sessions.get(sessionID)?.claim;
  }

  /** Usage as the mock currently sees it, for over-budget assertions. */
  tokensOf(sessionID: string): number {
    const s = this.sessions.get(sessionID);
    return s ? s.tokens.input + s.tokens.output + s.tokens.reasoning : 0;
  }

  /**
   * Die the way a crashed server dies: stop listening, drop every socket
   * mid-frame. Subscribers see EOF, not a clean close — and no heartbeat, which
   * is how the watchdog is meant to tell this apart from a wedged worker.
   */
  crash(): void {
    if (this.crashed) return;
    this.crashed = true;
    this.stopTimers();
    this.server.close();
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    this.subscribers.clear();
  }

  async stop(): Promise<void> {
    this.stopTimers();
    for (const sub of this.subscribers) sub.res.end();
    this.subscribers.clear();
    for (const s of this.sockets) s.destroy();
    this.sockets.clear();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private stopTimers(): void {
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
    for (const s of this.sessions.values()) {
      for (const t of s.timers) clearTimeout(t);
      s.timers.clear();
    }
  }

  // --- HTTP ---------------------------------------------------------------

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", this.baseUrl);
    const path = url.pathname;
    const query = Object.fromEntries(url.searchParams.entries());
    const body = await readBody(req);
    this.requests.push({ method: req.method ?? "GET", path, query, body, at: Date.now() });

    if (req.method === "GET" && path === "/global/health") {
      return json(res, 200, { healthy: true, version: this.opts.version });
    }
    if (req.method === "GET" && path === "/event") {
      return this.subscribe(res, query["directory"]);
    }
    if (req.method === "POST" && path === "/session") {
      return json(res, 200, this.createSession(query["directory"], body));
    }

    const m = /^\/session\/([^/]+)(\/[^?]*)?$/.exec(path);
    if (m) {
      const session = this.sessions.get(decodeURIComponent(m[1] ?? ""));
      const sub = m[2] ?? "";
      if (!session) return json(res, 404, { error: "session not found" });
      if (req.method === "GET" && sub === "") return json(res, 200, serialize(session));
      if (req.method === "POST" && sub === "/prompt_async") {
        this.prompt(session, body);
        // 204, empty, immediately — the whole reason DD-1 works.
        res.writeHead(204).end();
        return;
      }
      if (req.method === "POST" && sub === "/abort") {
        return json(res, 200, this.abort(session));
      }
    }
    return json(res, 404, { error: `ocmock does not implement ${req.method} ${path}` });
  }

  private subscribe(res: ServerResponse, directory: string | undefined): void {
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    });
    const sub: Subscriber = { res, directory };
    this.subscribers.add(sub);
    res.on("close", () => this.subscribers.delete(sub));
    // The real server's first frame on every subscription.
    writeFrame(res, { id: evtID(), type: "server.connected", properties: {} });
  }

  private createSession(directory: string | undefined, body: unknown): Record<string, unknown> {
    if (!directory) throw new Error("ocmock: POST /session requires ?directory= (it is a query param, not a body field)");
    const b = asRecord(body);
    const id = `ses_ocmock${(this.seq++).toString(36).padStart(4, "0")}`;
    const session: MockSession = {
      id,
      directory,
      ...(typeof b["title"] === "string" ? { title: b["title"] } : {}),
      ...(typeof b["agent"] === "string" ? { agent: b["agent"] } : {}),
      ...(b["model"] === undefined ? {} : { model: b["model"] }),
      ...(b["permission"] === undefined ? {} : { permission: b["permission"] }),
      ...(typeof b["parentID"] === "string" ? { parentID: b["parentID"] } : {}),
      scenario: this.opts.scenario,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
      cost: 0,
      summary: { additions: 0, deletions: 0, files: 0 },
      running: false,
      timers: new Set(),
      prompts: [],
    };
    this.sessions.set(id, session);
    this.emit(session, "session.updated", { sessionID: id, info: serialize(session) });
    return serialize(session);
  }

  private prompt(session: MockSession, body: unknown): void {
    session.prompts.push(body);
    session.running = true;
    session.tokens.input += this.opts.tokensPerPrompt;
    session.cost += this.opts.costPerPrompt;

    let delay = this.opts.latencyMs;
    if (!this.coldStartDone && this.opts.coldStartEvents > 0) {
      this.coldStartDone = true;
      // The real burst: ~45 plugin.added plus catalog.updated, none of them
      // carrying a sessionID, all of them before any generation happens.
      for (let i = 0; i < this.opts.coldStartEvents; i++) {
        this.broadcast(undefined, "plugin.added", { id: `plugin-${i}` });
      }
      this.broadcast(undefined, "catalog.updated", {});
    }

    this.after(session, delay, () => {
      this.emit(session, "session.status", { sessionID: session.id, status: { type: "busy" } });
      switch (session.scenario) {
        case "success":
          this.work(session);
          this.finish(session, this.opts.workMs);
          return;
        case "lying_report":
          // Claims edits; the diff says otherwise. That gap is the whole point.
          session.claim = "Updated src/index.ts and added tests.";
          this.emit(session, "message.part.delta", {
            sessionID: session.id,
            messageID: "msg_ocmock",
            partID: "prt_ocmock",
            field: "text",
            delta: session.claim,
          });
          this.emit(session, "session.diff", { sessionID: session.id, diff: [] });
          this.finish(session, this.opts.workMs);
          return;
        case "hang":
          // One tool call that starts and never completes. Heartbeats keep
          // arriving: the server is fine, the worker is not.
          this.emit(session, "message.part.updated", {
            sessionID: session.id,
            time: Date.now(),
            part: {
              id: "prt_hang",
              sessionID: session.id,
              messageID: "msg_hang",
              type: "tool",
              callID: "call_hang",
              tool: "bash",
              state: { status: "running", input: {}, title: "sleep infinity" },
            },
          });
          return;
        case "blocked": {
          const requestID = `per_ocmock${this.seq++}`;
          session.pendingRequestID = requestID;
          this.emit(session, "permission.asked", {
            id: requestID,
            sessionID: session.id,
            permission: "bash",
            patterns: ["rm -rf *"],
            metadata: {},
            always: [],
            tool: {},
          });
          return;
        }
        case "over_budget":
          // Burns tokens forever and never idles. Only a budget poll plus abort
          // gets out of this — which is exactly what §8 has to do.
          this.burn(session);
          return;
        case "crash":
          this.after(session, this.opts.workMs, () => this.crash());
          return;
      }
    });
  }

  private work(session: MockSession): void {
    this.emit(session, "message.part.updated", {
      sessionID: session.id,
      time: Date.now(),
      part: {
        id: "prt_ok",
        sessionID: session.id,
        messageID: "msg_ok",
        type: "tool",
        callID: "call_ok",
        tool: "write",
        state: { status: "completed", input: {}, output: "ok", title: "hello.txt", metadata: {}, time: {} },
      },
    });
    this.emit(session, "file.edited", { file: `${session.directory}/hello.txt` });
    session.summary = { additions: 1, deletions: 0, files: 1 };
    this.emit(session, "session.diff", { sessionID: session.id, diff: [{ file: "hello.txt" }] });
  }

  private burn(session: MockSession): void {
    this.after(session, this.opts.latencyMs, () => {
      if (!session.running) return;
      session.tokens.output += this.opts.burnPerTickTokens;
      this.emit(session, "message.part.delta", {
        sessionID: session.id,
        messageID: "msg_burn",
        partID: "prt_burn",
        field: "text",
        delta: "…",
      });
      this.burn(session);
    });
  }

  private finish(session: MockSession, delay: number): void {
    this.after(session, delay, () => {
      if (!session.running) return;
      session.running = false;
      session.tokens.output += Math.round(this.opts.tokensPerPrompt / 4);
      this.emit(session, "session.status", { sessionID: session.id, status: { type: "idle" } });
      this.emit(session, "session.idle", { sessionID: session.id });
    });
  }

  private abort(session: MockSession): boolean {
    if (!session.running) return false;
    session.running = false;
    for (const t of session.timers) clearTimeout(t);
    session.timers.clear();
    // The union member the real server uses for this.
    this.emit(session, "session.error", {
      sessionID: session.id,
      error: { name: "MessageAbortedError", data: { message: "aborted" } },
    });
    this.emit(session, "session.idle", { sessionID: session.id });
    return true;
  }

  private after(session: MockSession, ms: number, fn: () => void): void {
    const t = setTimeout(() => {
      session.timers.delete(t);
      fn();
    }, ms);
    t.unref?.();
    session.timers.add(t);
  }

  /** Emit a session-scoped event — delivered only to matching subscriptions. */
  private emit(session: MockSession, type: string, properties: Record<string, unknown>): void {
    this.broadcast(session.directory, type, properties);
  }

  /**
   * `directory === undefined` marks a server-level frame (heartbeat, plugin
   * churn): every subscriber gets it. Otherwise only subscribers scoped to that
   * exact directory do — an unscoped subscriber gets nothing, silently, which is
   * the failure this mock exists to reproduce.
   */
  private broadcast(directory: string | undefined, type: string, properties: Record<string, unknown>): void {
    if (this.crashed) return;
    const frame = { id: evtID(), type, properties };
    for (const sub of this.subscribers) {
      if (directory !== undefined && sub.directory !== directory) continue;
      writeFrame(sub.res, frame);
    }
  }
}

// ---------------------------------------------------------------------------

function serialize(s: MockSession): Record<string, unknown> {
  return {
    id: s.id,
    slug: s.id,
    projectID: "prj_ocmock",
    directory: s.directory,
    title: s.title ?? "ocmock session",
    version: "1.18.25-ocmock",
    time: { created: Date.now(), updated: Date.now() },
    tokens: { ...s.tokens, cache: { ...s.tokens.cache } },
    cost: s.cost,
    summary: { ...s.summary },
    ...(s.agent === undefined ? {} : { agent: s.agent }),
    ...(s.model === undefined ? {} : { model: s.model }),
    ...(s.permission === undefined ? {} : { permission: s.permission }),
    ...(s.parentID === undefined ? {} : { parentID: s.parentID }),
  };
}

function writeFrame(res: ServerResponse, frame: unknown): void {
  if (res.writableEnded) return;
  res.write(`data: ${JSON.stringify(frame)}\n\n`);
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

function stripUndefined<T extends object>(o: T): T {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;
}
