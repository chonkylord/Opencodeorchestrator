/**
 * Pure-function tests for the wire→domain mapping: model parsing, the
 * `session.error` union, event normalization, usage, and SSE framing.
 *
 * These are the parts most exposed to OpenCode API drift, so they are tested
 * against literal payload shapes taken from the 1.18.25 OpenAPI document rather
 * than against the adapter's own idea of them.
 */

import { describe, expect, test } from "bun:test";

import { OpenCodeError, isWorkerEvent, parseModel, toTypedError } from "../../src/opencode/types.js";
import { normalizeEvent, readSSE, toUsage } from "../../src/opencode/serve.js";

const frame = (type: string, properties: Record<string, unknown> = {}) => ({ id: "evt_1", type, properties });

describe("parseModel", () => {
  test("splits on the first slash only", () => {
    expect(parseModel("opencode/muse-spark-1.2-contributor-free")).toEqual({
      providerID: "opencode",
      modelID: "muse-spark-1.2-contributor-free",
    });
    // Model ids contain slashes; providers do not. Splitting on the last slash,
    // or on all of them, quietly routes to a provider that does not exist.
    expect(parseModel("openrouter/meta-llama/llama-3.1-70b")).toEqual({
      providerID: "openrouter",
      modelID: "meta-llama/llama-3.1-70b",
    });
  });

  test("passes through an already-split ref", () => {
    const ref = { providerID: "a", modelID: "b" };
    expect(parseModel(ref)).toBe(ref);
  });

  test("rejects malformed specs before any I/O", () => {
    for (const bad of ["nope", "/leading", "trailing/", ""]) {
      const err = (() => {
        try {
          parseModel(bad);
        } catch (e) {
          return e;
        }
      })() as OpenCodeError;
      expect(err).toBeInstanceOf(OpenCodeError);
      expect(err.code).toBe("config");
    }
  });
});

describe("toTypedError", () => {
  test("maps every member of OpenCode's session.error union", () => {
    const cases: Array<[string, string]> = [
      ["ProviderAuthError", "provider_auth"],
      ["MessageOutputLengthError", "output_length"],
      ["MessageAbortedError", "aborted"],
      ["StructuredOutputError", "structured_output"],
      ["ContextOverflowError", "context_overflow"],
      ["ContentFilterError", "content_filter"],
      ["APIError", "api"],
      ["UnknownError", "unknown"],
    ];
    for (const [name, code] of cases) {
      expect(toTypedError({ name, data: { message: "boom" } }).code).toBe(code as never);
    }
  });

  test("dispatches on the discriminator, not on message text", () => {
    // A message that merely mentions another failure must not be reclassified.
    const err = toTypedError({ name: "APIError", data: { message: "ContextOverflowError-ish", isRetryable: true } });
    expect(err.code).toBe("api");
    expect(err.retryable).toBe(true);
  });

  test("APIError's own retryability wins over the default", () => {
    expect(toTypedError({ name: "APIError", data: { message: "x", isRetryable: false } }).retryable).toBe(false);
  });

  test("an unrecognized member degrades to unknown with the name preserved", () => {
    // OpenCode may add union members; losing the name would make the new failure
    // undiagnosable from logs.
    const err = toTypedError({ name: "SomeFutureError", data: { message: "hm" } });
    expect(err.code).toBe("unknown");
    expect(err.detail["name"]).toBe("SomeFutureError");
    expect(err.message).toBe("hm");
  });

  test("survives garbage", () => {
    expect(toTypedError(null).code).toBe("unknown");
    expect(toTypedError("nope").code).toBe("unknown");
  });
});

describe("normalizeEvent", () => {
  test("session.idle is the completion signal", () => {
    expect(normalizeEvent(frame("session.idle", { sessionID: "ses_1" }), 5)).toEqual({
      kind: "idle",
      at: 5,
      sessionID: "ses_1",
      raw: expect.anything(),
    });
  });

  test("server frames carry no session and are not worker progress", () => {
    for (const type of ["server.connected", "server.heartbeat"]) {
      const e = normalizeEvent(frame(type))!;
      expect(isWorkerEvent(e)).toBe(false);
    }
    expect(normalizeEvent(frame("server.heartbeat"))!.kind).toBe("heartbeat");
  });

  test("session.status distinguishes busy, idle and provider retries", () => {
    const busy = normalizeEvent(frame("session.status", { sessionID: "s", status: { type: "busy" } }))!;
    expect(busy).toMatchObject({ kind: "status", busy: true });
    const idle = normalizeEvent(frame("session.status", { sessionID: "s", status: { type: "idle" } }))!;
    expect(idle).toMatchObject({ kind: "status", busy: false });
    const retry = normalizeEvent(
      frame("session.status", { sessionID: "s", status: { type: "retry", attempt: 2, message: "429" } }),
    )!;
    expect(retry).toMatchObject({ kind: "status", busy: false, retry: { attempt: 2, message: "429" } });
  });

  test("tool parts become tool events; other parts stay countable progress", () => {
    const tool = normalizeEvent(
      frame("message.part.updated", {
        sessionID: "s",
        part: { type: "tool", tool: "bash", callID: "c1", state: { status: "running", title: "npm test" } },
      }),
    )!;
    expect(tool).toMatchObject({ kind: "tool", tool: "bash", callID: "c1", state: "running", title: "npm test" });

    // A text part is real worker activity even though nothing acts on it — if it
    // did not count, the idle watchdog would fire mid-run.
    const text = normalizeEvent(frame("message.part.updated", { sessionID: "s", part: { type: "text" } }))!;
    expect(text.kind).toBe("other");
    expect(isWorkerEvent(text)).toBe(true);
  });

  test("an unknown tool state falls back rather than escaping the union", () => {
    const e = normalizeEvent(
      frame("message.part.updated", { sessionID: "s", part: { type: "tool", tool: "x", state: { status: "weird" } } }),
    )!;
    expect(e).toMatchObject({ kind: "tool", state: "pending" });
  });

  test("permission and question asks are blocking, and pair with their replies", () => {
    const asked = normalizeEvent(
      frame("permission.asked", { id: "per_1", sessionID: "s", permission: "bash", patterns: ["rm *"] }),
    )!;
    expect(asked).toMatchObject({ kind: "permission.asked", requestID: "per_1", permission: "bash" });
    // The ask keys the id as `id`, the reply as `requestID`; normalizing both to
    // requestID is what lets a caller pair them at all.
    const replied = normalizeEvent(frame("permission.replied", { sessionID: "s", requestID: "per_1" }))!;
    expect(replied).toMatchObject({ kind: "permission.replied", requestID: "per_1" });

    const q = normalizeEvent(
      frame("question.asked", { id: "que_1", sessionID: "s", questions: [{ question: "which db?" }] }),
    )!;
    expect(q).toMatchObject({ kind: "question.asked", requestID: "que_1", questions: ["which db?"] });
    expect(normalizeEvent(frame("question.rejected", { sessionID: "s", requestID: "que_1" }))!).toMatchObject({
      kind: "question.replied",
      rejected: true,
    });
  });

  test("the v2 permission and question events map to the same kinds", () => {
    expect(
      normalizeEvent(frame("permission.v2.asked", { id: "per_2", sessionID: "s", action: "edit", resources: ["**"] }))!,
    ).toMatchObject({ kind: "permission.asked", permission: "edit", patterns: ["**"] });
    expect(
      normalizeEvent(frame("question.v2.asked", { id: "que_2", sessionID: "s", questions: [{ question: "?" }] }))!,
    ).toMatchObject({ kind: "question.asked", requestID: "que_2" });
  });

  test("file.edited has no session and still reaches every consumer", () => {
    const e = normalizeEvent(frame("file.edited", { file: "/w/a.ts" }))!;
    expect(e).toMatchObject({ kind: "file.edited", file: "/w/a.ts" });
    expect("sessionID" in e).toBe(false);
  });

  test("session.error becomes a typed error", () => {
    const e = normalizeEvent(
      frame("session.error", {
        sessionID: "s",
        error: { name: "ContextOverflowError", data: { message: "too long" } },
      }),
    )!;
    if (e.kind !== "error") throw new Error("expected error kind");
    expect(e.error.code).toBe("context_overflow");
    expect(e.error.message).toBe("too long");
  });

  test("the durable `data` envelope is accepted alongside the live `properties` one", () => {
    // /event uses `properties`; the spec also describes a `data`-keyed envelope
    // for the same types. Reading both costs nothing and removes a whole class
    // of "why is the stream silent" from a future version bump.
    expect(normalizeEvent({ id: "evt_1", type: "session.idle", data: { sessionID: "ses_9" } })!).toMatchObject({
      kind: "idle",
      sessionID: "ses_9",
    });
  });

  test("unmapped events keep their type and their session scope", () => {
    const scoped = normalizeEvent(frame("session.compacted", { sessionID: "s" }))!;
    expect(scoped).toMatchObject({ kind: "other", type: "session.compacted", sessionID: "s" });
    expect(isWorkerEvent(scoped)).toBe(true);
    const unscoped = normalizeEvent(frame("plugin.added", { id: "p" }))!;
    expect(isWorkerEvent(unscoped)).toBe(false);
  });

  test("typeless frames are dropped, not guessed at", () => {
    expect(normalizeEvent({})).toBeUndefined();
    expect(normalizeEvent(null)).toBeUndefined();
    expect(normalizeEvent(frame("session.idle", {}))).toBeUndefined();
  });
});

describe("toUsage", () => {
  test("totals the billable counters and keeps cost advisory", () => {
    const u = toUsage({
      cost: 0,
      tokens: { input: 8423, output: 228, reasoning: 361, cache: { read: 21779, write: 0 } },
    });
    // Cache reads are reported but excluded from the total: they are not what a
    // context budget is spent on.
    expect(u.totalTokens).toBe(8423 + 228 + 361);
    expect(u.cacheRead).toBe(21779);
    expect(u.cost).toBe(0);
  });

  test("missing or non-numeric counters read as zero, never NaN", () => {
    const u = toUsage({ tokens: { input: "lots" } });
    expect(u.totalTokens).toBe(0);
    expect(Number.isNaN(u.cost)).toBe(false);
    expect(toUsage({}).totalTokens).toBe(0);
  });
});

describe("readSSE", () => {
  const stream = (text: string): ReadableStream<Uint8Array> =>
    new ReadableStream({
      start(c) {
        // Split mid-frame on purpose: real chunks do not respect frame boundaries.
        const bytes = new TextEncoder().encode(text);
        c.enqueue(bytes.slice(0, Math.floor(bytes.length / 2)));
        c.enqueue(bytes.slice(Math.floor(bytes.length / 2)));
        c.close();
      },
    });

  test("reassembles frames split across chunks", async () => {
    const out: unknown[] = [];
    for await (const e of readSSE(stream(`data: {"type":"a"}\n\ndata: {"type":"b"}\n\n`))) out.push(e);
    expect(out).toEqual([{ type: "a" }, { type: "b" }]);
  });

  test("skips keep-alive comments and malformed payloads instead of dying", async () => {
    // One bad frame must not take down a stream that is about to deliver the
    // completion event for a fifteen-minute run.
    const out: unknown[] = [];
    for await (const e of readSSE(stream(`: ping\n\ndata: {oops\n\ndata: {"type":"ok"}\n\n`))) out.push(e);
    expect(out).toEqual([{ type: "ok" }]);
  });

  test("joins multi-line data payloads", async () => {
    const out: unknown[] = [];
    for await (const e of readSSE(stream(`data: {"type":\ndata: "split"}\n\n`))) out.push(e);
    expect(out).toEqual([{ type: "split" }]);
  });
});
