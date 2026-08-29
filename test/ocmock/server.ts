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
 * Scenarios: `success`, `hang`, `blocked`, `over_budget`, `crash`,
 * `format_unsupported`, and the `lying_report` hook that Phase 2's
 * reconciliation asserts against.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AddressInfo } from "node:net";
import type { Socket } from "node:net";

export type Scenario =
  | "success"
  | "hang"
  | "blocked"
  | "over_budget"
  | "crash"
  | "lying_report"
  /** Rejects any prompt carrying `format`, the way a free-tier provider does. */
  | "format_unsupported";

export interface OCMockOptions {
  /** Applies to every session unless overridden per-session. Default `success`. */
  readonly scenario?: Scenario;
  /** Delay from `prompt_async` to the first worker event. Default 10ms. */
  readonly latencyMs?: number;
  /** Delay from first worker event to `session.idle`. Default 30ms. */
  readonly workMs?: number;
  /**
   * Per-worker work time, keyed by the last segment of the session's directory
   * — which is the worker id, because that is what `createWorktree` names the
   * directory. Anything not named here uses {@link OCMockOptions.workMs}.
   *
   * Phase 5 needs this the way Phase 3 needed `abortDelayMs`. A semaphore test
   * has to know which worker is still running when another is admitted, and a
   * dependency test has to know its dependency is *still going* when the
   * dependent is skipped over. Racing real latency to arrange that is how a
   * concurrency suite becomes the flaky one everybody re-runs.
   */
  readonly workMsFor?: Readonly<Record<string, number>>;
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
  /**
   * The report the "worker" replies with, streamed as text the way a real
   * schema-constrained reply arrives. `null` means it says nothing, which is
   * itself a case the manager has to survive.
   */
  readonly report?: unknown;
  /**
   * Actually create files in the session's directory.
   *
   * Off by default because most adapter tests do not care. On, the mock leaves a
   * real diff behind — which is what makes a *truthful* report distinguishable
   * from a lying one, rather than both looking like an empty worktree.
   */
  readonly writeFiles?: boolean;
  /**
   * Give each session's file a name derived from its own directory.
   *
   * Phase 4 needs two workers whose changed-file sets are *disjoint*, which the
   * fixed `hello.txt` cannot produce: two branches that add the same path with
   * the same content are not disjoint, they are identical. With this on, a
   * worker in `.../w-001` writes `w-001.txt`, so an overlap check has something
   * real to be right about.
   */
  readonly perWorktreeFileName?: boolean;
  /**
   * Give each session's file *content* derived from its own directory.
   *
   * The other half of the same need: two branches that add the same path with
   * *different* content is precisely a merge conflict, and a conflict has to be
   * producible on demand rather than hoped for.
   */
  readonly perWorktreeFileContent?: boolean;
  /**
   * Silently drop a prompt that arrives within this many ms of the session's
   * last terminal event — accepted with 204, then nothing.
   *
   * Reproduces OpenCode 1.18.25: a session that has just gone terminal ignores a
   * prompt sent immediately afterwards. Default 0 (never drop), because most
   * tests do not re-prompt and should not pay for the guard.
   */
  readonly dropPromptsWithinMs?: number;
  /**
   * Delay before `abort` answers, simulating a server that is slow to stop.
   *
   * The knob exists for one assertion Phase 3 cannot make without it. DD-1 says
   * every MCP tool returns in under two seconds, and `manager.cancel()`
   * deliberately does not — it resolves only once the worker has genuinely
   * stopped. So `worker_stop` must start the abort and return, and a test that
   * checks only the final state passes whether it awaited or not. With the abort
   * held here, "the tool returned while the worker was still running" becomes a
   * fact rather than a race. Default 0.
   */
  readonly abortDelayMs?: number;
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
  /** Per-session reply, overriding the mock-wide default. */
  report?: unknown;
  /** When this session last emitted a terminal event. */
  lastIdleAt?: number;
  /** Prompts accepted and dropped, for tests that assert on the guard. */
  dropped: number;
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
  workMsFor: {} as Readonly<Record<string, number>>,
  heartbeatMs: 25,
  coldStartEvents: 0,
  tokensPerPrompt: 1000,
  burnPerTickTokens: 5000,
  costPerPrompt: 0,
  version: "1.18.25-ocmock",
  report: null as unknown,
  writeFiles: false,
  perWorktreeFileName: false,
  perWorktreeFileContent: false,
  dropPromptsWithinMs: 0,
  abortDelayMs: 0,
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

  /**
   * Set what this session replies with on its next turn.
   *
   * The blocked -> answer -> resume path needs a worker that says one thing and
   * then, having been answered, says another; scripting the reply per turn is
   * the smallest way to reproduce that.
   */
  setReport(sessionID: string, report: unknown): void {
    const s = this.sessions.get(sessionID);
    if (s) s.report = report;
  }

  /** `blocked`: answer the outstanding request so the run resumes and finishes. */
  resolveBlock(sessionID: string): boolean {
    const s = this.sessions.get(sessionID);
    if (!s?.pendingRequestID) return false;
    const requestID = s.pendingRequestID;
    s.pendingRequestID = undefined;
    this.emit(s, "permission.replied", { sessionID: s.id, requestID, reply: "once" });
    this.finish(s, this.workMsOf(s));
    return true;
  }

  /** How many prompts this session accepted and silently dropped. */
  droppedPromptsOf(sessionID: string): number {
    return this.sessions.get(sessionID)?.dropped ?? 0;
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
        if (this.opts.abortDelayMs > 0) {
          const t = setTimeout(() => json(res, 200, this.abort(session)), this.opts.abortDelayMs);
          t.unref?.();
          return;
        }
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
      dropped: 0,
      ...(this.opts.report === null || this.opts.report === undefined ? {} : { report: this.opts.report }),
    };
    this.sessions.set(id, session);
    this.emit(session, "session.updated", { sessionID: id, info: serialize(session) });
    return serialize(session);
  }

  private prompt(session: MockSession, body: unknown): void {
    session.prompts.push(body);
    if (
      this.opts.dropPromptsWithinMs > 0 &&
      session.lastIdleAt !== undefined &&
      Date.now() - session.lastIdleAt < this.opts.dropPromptsWithinMs
    ) {
      // Accepted, and then nothing at all. The real server does this too.
      session.dropped += 1;
      return;
    }
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
          this.reply(session);
          this.finish(session, this.workMsOf(session));
          return;
        case "lying_report":
          // Claims edits; the diff says otherwise. That gap is the whole point.
          // The claim is a well-formed report, because the interesting failure is
          // not a malformed reply — it is a perfectly valid one that is false.
          session.claim = JSON.stringify({
            workerId: session.title ?? "w-lying",
            status: "completed",
            summary: "Updated src/index.ts and added tests.",
            changes: [
              { file: "src/index.ts", action: "modified", rationale: "refactored the entry point" },
              { file: "test/index.test.ts", action: "added", rationale: "coverage for the refactor" },
            ],
            tests: { command: "npm test", passed: 12, failed: 0, skipped: 0 },
            risks: [],
            questions: [],
            followUps: [],
          });
          this.emitText(session, session.claim);
          this.emit(session, "session.diff", { sessionID: session.id, diff: [] });
          this.finish(session, this.workMsOf(session));
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
          this.after(session, this.workMsOf(session), () => this.crash());
          return;
        case "format_unsupported": {
          // Observed on OpenCode 1.18.25 against a free-tier model: schema-
          // constrained output is implemented by forcing a tool call, and a
          // provider that only accepts `tool_choice: "auto"` rejects the whole
          // request. The message is the one the real provider returned.
          const last = asRecord(session.prompts.at(-1));
          if (last["format"] !== undefined) {
            this.emit(session, "session.error", {
              sessionID: session.id,
              error: {
                name: "APIError",
                data: {
                  message:
                    'Error from provider (Console): Upstream request failed: [invalid_request_error] only `"auto"` is ' +
                    "supported for `tool_choice`. `\"none\"`, `\"required\"`, and named function choices are not currently supported",
                  isRetryable: false,
                },
              },
            });
            this.emit(session, "session.idle", { sessionID: session.id });
            session.running = false;
            // Real OpenCode emits a *second* idle a moment later, after a
            // trailing `message.updated`. Measured at ~30ms on 1.18.25. A manager
            // that re-prompts on the first one reads this second one as its new
            // turn ending instantly — which is exactly the bug worth catching in
            // milliseconds rather than in a live run.
            this.after(session, Math.max(1, Math.round(this.opts.latencyMs / 2)), () => {
              this.emit(session, "message.updated", { sessionID: session.id, info: {} });
              this.emit(session, "session.idle", { sessionID: session.id });
            });
            return;
          }
          this.work(session);
          this.reply(session);
          this.finish(session, this.workMsOf(session));
          return;
        }
      }
    });
  }

  /** Stream whatever this session is scripted to reply, as a real one would. */
  private reply(session: MockSession): void {
    const report = session.report ?? null;
    if (report === null) return;
    session.claim = typeof report === "string" ? report : JSON.stringify(report);
    this.emitText(session, session.claim);
  }

  /** Text arrives as deltas, in pieces, because that is how it really arrives. */
  private emitText(session: MockSession, text: string): void {
    for (let i = 0; i < text.length; i += 64) {
      this.emit(session, "message.part.delta", {
        sessionID: session.id,
        messageID: "msg_ocmock",
        partID: "prt_ocmock",
        field: "text",
        delta: text.slice(i, i + 64),
      });
    }
  }

  /** This session's work time: its worker id's, or the mock-wide default. */
  private workMsOf(session: MockSession): number {
    const stem = session.directory.split("/").filter(Boolean).pop() ?? "";
    return this.opts.workMsFor[stem] ?? this.opts.workMs;
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
    const stem = session.directory.split("/").filter(Boolean).pop() ?? "worker";
    const fileName = this.opts.perWorktreeFileName ? `${stem}.txt` : "hello.txt";
    if (this.opts.writeFiles) {
      // A real file, so `git diff` has something to agree or disagree with.
      try {
        mkdirSync(session.directory, { recursive: true });
        writeFileSync(
          join(session.directory, fileName),
          this.opts.perWorktreeFileContent ? `hello from ${stem}\n` : "hello from ocmock\n",
        );
      } catch {
        /* the test did not give us a real directory; the events are the point */
      }
    }
    this.emit(session, "file.edited", { file: `${session.directory}/${fileName}` });
    session.summary = { additions: 1, deletions: 0, files: 1 };
    this.emit(session, "session.diff", { sessionID: session.id, diff: [{ file: fileName }] });
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
    if (type === "session.idle") session.lastIdleAt = Date.now();
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
