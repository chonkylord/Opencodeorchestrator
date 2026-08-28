/**
 * `ServeBackend` against `ocmock` — the five §12 scenarios plus the behaviours
 * that only bite in production: directory-scoped subscriptions, fan-out,
 * cold-start bursts, bounded buffers, and telling a stuck worker from a dead
 * server.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { OCMock } from "../ocmock/server.js";
import {
  HEADLESS_PERMISSIONS,
  type OCEvent,
  OpenCodeError,
  ServeBackend,
  isBlocking,
  isTerminal,
  isWorkerEvent,
} from "../../src/opencode/index.js";
import { drain, sleep, until } from "../helpers.js";

const WT = "/tmp/ocmock-worktree/w-001";
const OTHER_WT = "/tmp/ocmock-worktree/w-002";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn().catch(() => {});
});

async function harness(opts: Parameters<typeof OCMock.start>[0] = {}) {
  const mock = await OCMock.start(opts);
  const backend = new ServeBackend({ baseUrl: mock.baseUrl });
  cleanup.push(() => backend.dispose());
  cleanup.push(() => mock.stop());
  await backend.start();
  return { mock, backend };
}

// ---------------------------------------------------------------------------

describe("scenario: success", () => {
  test("subscribe, prompt, run to completion", async () => {
    const { mock, backend } = await harness({ scenario: "success" });
    const session = await backend.createSession({
      cwd: WT,
      title: "w-001",
      model: "opencode/muse-spark-1.2-contributor-free",
      permissions: HEADLESS_PERMISSIONS,
    });
    expect(session.directory).toBe(WT);
    expect(session.model).toEqual({ providerID: "opencode", modelID: "muse-spark-1.2-contributor-free" });

    // Subscribe first: the run can finish before a late subscriber is attached.
    const stream = await backend.events(session);
    const run = await backend.prompt(session, { text: "create hello.txt", system: "you are a worker" });
    expect(run.sessionID).toBe(session.sessionID);
    expect(run.runID).toStartWith("run_");

    const events = await until(stream, isTerminal, 3_000, "session.idle");
    const kinds = events.map((e) => e.kind);
    expect(kinds).toContain("stream.open");
    expect(kinds).toContain("status");
    expect(kinds).toContain("tool");
    expect(kinds).toContain("file.edited");
    expect(events.at(-1)!.kind).toBe("idle");

    const usage = await backend.usage(session);
    expect(usage!.totalTokens).toBeGreaterThan(0);
    // Free-tier providers report cost 0 even after real work — tokens are the
    // budget signal, cost is advisory. Both are exposed; only one is trusted.
    expect(usage!.cost).toBe(0);
  });

  test("config injection reaches the wire in the shapes each endpoint wants", async () => {
    const { mock, backend } = await harness();
    const session = await backend.createSession({
      cwd: WT,
      title: "w-007",
      agent: "build",
      model: "opencode/muse-spark-1.2-contributor-free",
      permissions: [{ permission: "webfetch", pattern: "**", action: "deny" }],
    });
    await backend.prompt(session, {
      text: "go",
      system: "worker contract",
      model: "openrouter/meta-llama/llama-3",
      tools: { bash: false },
      variant: "high",
      format: { type: "json_schema", schema: { type: "object" }, retryCount: 2 },
    });

    const create = mock.requests.find((r) => r.method === "POST" && r.path === "/session")!;
    // `directory` is a query parameter on create, not a body field.
    expect(create.query["directory"]).toBe(WT);
    const createBody = create.body as Record<string, unknown>;
    expect(createBody["directory"]).toBeUndefined();
    expect(createBody["title"]).toBe("w-007");
    expect(createBody["agent"]).toBe("build");
    expect(createBody["permission"]).toEqual([{ permission: "webfetch", pattern: "**", action: "deny" }]);
    // create wants {providerID, id}; prompt_async wants {providerID, modelID}.
    // Same concept, two shapes — sending the wrong one is silently ignored.
    expect(createBody["model"]).toEqual({ providerID: "opencode", id: "muse-spark-1.2-contributor-free" });

    const prompt = mock.requests.find((r) => r.path.endsWith("/prompt_async"))!;
    expect(prompt.query["directory"]).toBe(WT);
    const body = prompt.body as Record<string, unknown>;
    expect(body["parts"]).toEqual([{ type: "text", text: "go" }]);
    expect(body["system"]).toBe("worker contract");
    expect(body["tools"]).toEqual({ bash: false });
    expect(body["variant"]).toBe("high");
    expect(body["format"]).toEqual({ type: "json_schema", schema: { type: "object" }, retryCount: 2 });
    // Split on the FIRST slash only: the model id may contain more of them.
    expect(body["model"]).toEqual({ providerID: "openrouter", modelID: "meta-llama/llama-3" });
  });
});

// ---------------------------------------------------------------------------

describe("directory scoping — the silent hang", () => {
  test("the subscription is scoped to the session's own directory", async () => {
    const { mock, backend } = await harness();
    const session = await backend.createSession({ cwd: WT });
    const stream = await backend.events(session);
    cleanup.push(async () => stream.close());

    const sub = mock.requests.find((r) => r.path === "/event")!;
    expect(sub.query["directory"]).toBe(WT);
    expect(stream.directory).toBe(WT);
  });

  test("a stream scoped to the wrong directory sees heartbeats and never completes", async () => {
    // The negative control. Against the real server this is an infinite wait
    // with no error; ocmock reproduces it so the failure has a name and a
    // three-second deadline instead of a hung CI job.
    const { backend } = await harness({ heartbeatMs: 15 });
    const session = await backend.createSession({ cwd: WT });
    const wrong = await backend.events({ sessionID: session.sessionID, directory: OTHER_WT });
    await backend.prompt(session, { text: "go" });

    const seen = await drain(wrong, 400);
    expect(seen.some((e) => e.kind === "heartbeat")).toBe(true); // server is fine
    expect(seen.some(isTerminal)).toBe(false); // …and we would wait forever
    expect(seen.every((e) => !isWorkerEvent(e))).toBe(true);
  });

  test("trailing slashes do not fork the scope", async () => {
    const { mock, backend } = await harness();
    const session = await backend.createSession({ cwd: `${WT}/` });
    expect(session.directory).toBe(WT);
    const stream = await backend.events(session);
    cleanup.push(async () => stream.close());
    expect(mock.requests.find((r) => r.path === "/event")!.query["directory"]).toBe(WT);
  });

  test("one HTTP subscription is shared by every consumer of a directory", async () => {
    const { mock, backend } = await harness();
    const a = await backend.createSession({ cwd: WT });
    const b = await backend.createSession({ cwd: WT });
    const sa = await backend.events(a);
    const sb = await backend.events(b);

    await backend.prompt(a, { text: "go" });
    const seenA = await until(sa, isTerminal, 3_000, "idle for A");
    expect(seenA.at(-1)).toMatchObject({ kind: "idle", sessionID: a.sessionID });
    // B shares the stream but must not see A's session events.
    const seenB = await drain(sb, 150);
    expect(seenB.some((e) => "sessionID" in e && e.sessionID === a.sessionID)).toBe(false);
    expect(mock.requests.filter((r) => r.path === "/event")).toHaveLength(1);
  });

  test("separate directories get separate subscriptions", async () => {
    const { mock, backend } = await harness();
    const a = await backend.createSession({ cwd: WT });
    const b = await backend.createSession({ cwd: OTHER_WT });
    const sa = await backend.events(a);
    const sb = await backend.events(b);
    cleanup.push(async () => {
      sa.close();
      sb.close();
    });
    const dirs = mock.requests.filter((r) => r.path === "/event").map((r) => r.query["directory"]);
    expect(dirs.sort()).toEqual([WT, OTHER_WT].sort());
  });
});

// ---------------------------------------------------------------------------

describe("scenario: hang", () => {
  test("worker stops emitting while the server keeps beating", async () => {
    const { backend } = await harness({ scenario: "hang", heartbeatMs: 15 });
    const session = await backend.createSession({ cwd: WT });
    const stream = await backend.events(session);
    await backend.prompt(session, { text: "sleep forever" });

    const seen = await drain(stream, 500);
    expect(seen.some((e) => e.kind === "tool" && e.state === "running")).toBe(true);
    expect(seen.some(isTerminal)).toBe(false);

    // The discrimination the §5 watchdog needs: worker events stopped, server
    // events did not. That is a stuck worker, not a dead server — and it wants a
    // different response, so the adapter has to make the two distinguishable.
    const lastWorker = seen.filter(isWorkerEvent).at(-1)!;
    const beatsAfter = seen.filter((e) => e.kind === "heartbeat" && e.at >= lastWorker.at);
    expect(beatsAfter.length).toBeGreaterThan(0);
    expect(await backend.health()).toMatchObject({ alive: true });
  });
});

describe("scenario: crash", () => {
  test("server dies mid-run: stream ends and health goes red", async () => {
    const { backend } = await harness({ scenario: "crash", heartbeatMs: 15, workMs: 40 });
    const session = await backend.createSession({ cwd: WT });
    const stream = await backend.events(session);
    await backend.prompt(session, { text: "go" });

    const seen = await drain(stream, 1_000);
    expect(seen.some(isTerminal)).toBe(false);
    // Contrast with `hang`: no heartbeats after the end, because there is no
    // server left to send them.
    const health = await backend.health();
    expect(health.alive).toBe(false);
    expect(health.detail).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------

describe("scenario: blocked", () => {
  test("permission request surfaces, then the answer resumes the run", async () => {
    const { mock, backend } = await harness({ scenario: "blocked" });
    const session = await backend.createSession({ cwd: WT, permissions: HEADLESS_PERMISSIONS });
    const stream = await backend.events(session);
    await backend.prompt(session, { text: "rm -rf /" });

    const seen = await until(stream, isBlocking, 3_000, "permission.asked");
    const asked = seen.at(-1)!;
    expect(asked).toMatchObject({ kind: "permission.asked", permission: "bash" });
    expect(isTerminal(asked)).toBe(false);
    if (asked.kind !== "permission.asked") throw new Error("narrowing");
    expect(asked.requestID).toBeTruthy();
    expect(asked.patterns).toEqual(["rm -rf *"]);

    // …Claude answers, the same session resumes and finishes. This is the
    // blocked -> running edge in §5.
    expect(mock.resolveBlock(session.sessionID)).toBe(true);
    const after = await until(stream, isTerminal, 3_000, "idle after unblock");
    expect(after.some((e) => e.kind === "permission.replied")).toBe(true);
    expect(after.at(-1)!.kind).toBe("idle");
  });
});

// ---------------------------------------------------------------------------

describe("scenario: over budget", () => {
  test("usage climbs, abort stops it, and the abort is reported as a typed error", async () => {
    const { mock, backend } = await harness({ scenario: "over_budget", latencyMs: 5, burnPerTickTokens: 5_000 });
    const session = await backend.createSession({ cwd: WT });
    const stream = await backend.events(session);
    await backend.prompt(session, { text: "burn" });

    await sleep(120);
    const first = await backend.usage(session);
    await sleep(120);
    const second = await backend.usage(session);
    expect(second!.totalTokens).toBeGreaterThan(first!.totalTokens);
    // The adapter reports what the wire said when it asked; the mock has kept
    // burning since. Equality here would be a race, so assert the real
    // invariant: the reading is a true, not-yet-stale, lower bound.
    expect(mock.tokensOf(session.sessionID)).toBeGreaterThanOrEqual(second!.totalTokens);
    expect(second!.totalTokens).toBeGreaterThanOrEqual(5_000);

    // §8 enforcement: the poll notices, the abort lands.
    expect(await backend.abort(session)).toBe(true);
    // An abort lands as MessageAbortedError *and then* idle: the typed error
    // says why it stopped, the idle says it really did.
    const seen = await until(stream, (e) => e.kind === "idle", 3_000, "idle after abort");
    const err = seen.find((e): e is Extract<OCEvent, { kind: "error" }> => e.kind === "error")!;
    expect(err.error).toBeInstanceOf(OpenCodeError);
    expect(err.error.code).toBe("aborted");
    expect(err.error.retryable).toBe(false);
    expect(seen.at(-1)!.kind).toBe("idle");
  });

  test("aborting an idle session reports false rather than throwing", async () => {
    const { backend } = await harness();
    const session = await backend.createSession({ cwd: WT });
    expect(await backend.abort(session)).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("hook: lying report", () => {
  test("the claim and the diff are both surfaced, and they disagree", async () => {
    // Phase 2 owns the reconciliation assertion (report vs `git status`). Phase 1
    // owns making both halves observable without anyone parsing OpenCode shapes.
    const { mock, backend } = await harness({ scenario: "lying_report" });
    const session = await backend.createSession({ cwd: WT });
    const stream = await backend.events(session, { deltas: true });
    await backend.prompt(session, { text: "refactor everything" });

    const seen = await until(stream, isTerminal, 3_000, "idle");
    const claim = seen.filter((e): e is Extract<OCEvent, { kind: "text" }> => e.kind === "text");
    expect(claim.map((c) => c.delta).join("")).toContain("Updated src/index.ts");
    const diff = seen.find((e): e is Extract<OCEvent, { kind: "diff" }> => e.kind === "diff")!;
    expect(diff.files).toBe(0);
    expect(mock.claimOf(session.sessionID)).toBeTruthy();
    expect(seen.some((e) => e.kind === "file.edited")).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe("stream mechanics", () => {
  test("text deltas are off by default and opt-in", async () => {
    const { backend } = await harness({ scenario: "lying_report" });
    const session = await backend.createSession({ cwd: WT });
    const quiet = await backend.events(session);
    await backend.prompt(session, { text: "go" });
    const seen = await until(quiet, isTerminal, 3_000, "idle");
    expect(seen.some((e) => e.kind === "text")).toBe(false);
  });

  test("the cold-start plugin burst does not count as worker progress", async () => {
    const { backend } = await harness({ coldStartEvents: 45 });
    const session = await backend.createSession({ cwd: WT });
    const stream = await backend.events(session);
    await backend.prompt(session, { text: "go" });

    const seen = await until(stream, isTerminal, 5_000, "idle behind a cold start");
    const plugins = seen.filter((e) => e.kind === "other" && e.type === "plugin.added");
    expect(plugins.length).toBe(45);
    // Unscoped churn is not evidence the worker is doing anything — charging the
    // watchdog's idle timer to it would mask a hang.
    expect(plugins.every((e) => !isWorkerEvent(e))).toBe(true);
    expect(seen.at(-1)!.kind).toBe("idle");
  });

  test("a full buffer drops filler but never the events a caller waits on", async () => {
    const { mock, backend } = await harness({ scenario: "over_budget", latencyMs: 2, maxQueue: undefined } as never);
    const small = new ServeBackend({ baseUrl: mock.baseUrl, maxQueue: 4 });
    cleanup.push(() => small.dispose());
    await small.start();
    const session = await small.createSession({ cwd: WT });
    const stream = await small.events(session, { deltas: true });

    await small.prompt(session, { text: "burn" });
    await sleep(250); // fill the buffer while nobody is reading
    await small.abort(session);

    const seen = await until(stream, (e) => e.kind === "idle", 3_000, "idle despite a full buffer");
    expect(stream.dropped).toBeGreaterThan(0);
    expect(seen.some((e) => e.kind === "error")).toBe(true);
    expect(seen.at(-1)!.kind).toBe("idle");
  });

  test("closing a stream stops iteration without disturbing the backend", async () => {
    const { backend } = await harness();
    const session = await backend.createSession({ cwd: WT });
    const stream = await backend.events(session);
    stream.close();
    const seen = await drain(stream, 100);
    expect(seen).toHaveLength(0);
    expect(await backend.health()).toMatchObject({ alive: true });
  });
});

// ---------------------------------------------------------------------------

describe("lifecycle and failure modes", () => {
  test("spawns a server, parses the port it chose, and kills it on dispose", async () => {
    // The one path that cannot be tested against a URL: `--port 0` picks a free
    // port and announces it on stdout. Hardcoding 4096 passes locally and
    // collides under concurrency, so parse it for real, from a real process.
    const logs: string[] = [];
    const backend = new ServeBackend({
      bin: process.execPath, // bun
      args: ["run", new URL("../ocmock/bin.ts", import.meta.url).pathname, "serve", "--port", "0"],
      env: { OCMOCK_SCENARIO: "success", OCMOCK_HEARTBEAT_MS: "50" },
      startTimeoutMs: 30_000,
      onServerLog: (l) => logs.push(l),
    });
    cleanup.push(() => backend.dispose());
    await backend.start();

    expect(backend.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(new URL(backend.url).port).not.toBe("");
    expect(logs.some((l) => l.includes("OPENCODE_SERVER_PASSWORD"))).toBe(true);

    const session = await backend.createSession({ cwd: WT });
    const stream = await backend.events(session);
    await backend.prompt(session, { text: "go" });
    expect((await until(stream, isTerminal, 5_000, "idle")).at(-1)!.kind).toBe("idle");

    await backend.dispose();
    expect(await backend.health()).toMatchObject({ alive: false });
  });

  test("start() reports a server that never announces a port", async () => {
    const backend = new ServeBackend({ bin: process.execPath, args: ["-e", "process.exit(3)"] });
    cleanup.push(() => backend.dispose());
    const err = (await backend.start().catch((e) => e)) as OpenCodeError;
    expect(err).toBeInstanceOf(OpenCodeError);
    expect(err.code).toBe("backend_unavailable");
    expect(err.message).toContain("exited before listening");
  });

  test("attaching to nothing fails at start(), not mid-run", async () => {
    const backend = new ServeBackend({ baseUrl: "http://127.0.0.1:1" });
    cleanup.push(() => backend.dispose());
    const err = (await backend.start().catch((e) => e)) as OpenCodeError;
    expect(err.code).toBe("backend_unavailable");
  });

  test("usage() of an unknown session is null, not an exception", async () => {
    const { backend } = await harness();
    expect(await backend.usage({ sessionID: "ses_nope", directory: WT })).toBeNull();
  });

  test("relative directories are rejected before any I/O", async () => {
    const { backend } = await harness();
    const err = (await backend.createSession({ cwd: "relative/path" }).catch((e) => e)) as OpenCodeError;
    expect(err).toBeInstanceOf(OpenCodeError);
    expect(err.code).toBe("config");
  });

  test("dispose is idempotent and start() is not repeated", async () => {
    const { mock, backend } = await harness();
    await backend.createSession({ cwd: WT });
    await backend.dispose();
    await backend.dispose();
    expect(mock.requests.some((r) => r.path === "/session")).toBe(true);
  });
});
