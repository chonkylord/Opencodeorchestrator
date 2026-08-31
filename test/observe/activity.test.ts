/**
 * The live transcript ring (§11 Phase 9).
 *
 * Two properties carry this module and both are about failure rather than
 * feature. **It must never grow without bound** — Phase 8 measured a worker that
 * generated 39,004 tokens with no terminal event, and an unbounded buffer behind
 * a live stream turns that into somebody's laptop swapping. And **it must
 * coalesce** — text arrives a few characters at a time, so one entry per delta
 * would be a thousand rows describing one paragraph, which is a log rather than
 * a screen you can watch.
 */

import { describe, expect, test } from "bun:test";

import { ActivityLog } from "../../src/observe/index.js";

const at = 1_700_000_000_000;

describe("coalescing", () => {
  test("consecutive text deltas become one growing entry", () => {
    const log = new ActivityLog();
    log.append("w-001", { kind: "text", at, text: "Reading " });
    log.append("w-001", { kind: "text", at, text: "houses.js" });
    log.append("w-001", { kind: "text", at, text: " now" });

    const entries = log.entries("w-001");
    expect(entries).toHaveLength(1);
    expect(entries[0]!.text).toBe("Reading houses.js now");
    // Still open: the client renders a caret on it, and appends to it in place.
    expect(entries[0]!.open).toBe(true);
    expect(entries[0]!.seq).toBe(1);
  });

  test("anything that is not text closes the burst before it", () => {
    const log = new ActivityLog();
    log.append("w-001", { kind: "text", at, text: "thinking" });
    log.append("w-001", { kind: "tool", at, tool: "edit", text: "houses.js" });
    log.append("w-001", { kind: "text", at, text: "more thinking" });

    const entries = log.entries("w-001");
    expect(entries.map((e) => e.kind)).toEqual(["text", "tool", "text"]);
    expect(entries[0]!.open).toBe(false);
    expect(entries[1]!.open).toBeUndefined();
    expect(entries[2]!.open).toBe(true);
    expect(entries.map((e) => e.seq)).toEqual([1, 2, 3]);
  });

  test("a burst past the cap is split rather than grown for ever", () => {
    // 200 is the constructor's floor: a burst cap small enough to make a single
    // sentence unreadable is a misconfiguration, so it is clamped rather than
    // honoured, and a test that asks for 20 is silently testing 200.
    const log = new ActivityLog({ maxBurstChars: 200 });
    for (let i = 0; i < 6; i += 1) log.append("w-001", { kind: "text", at, text: "x".repeat(100) });
    const entries = log.entries("w-001");
    expect(entries.length).toBeGreaterThan(1);
    for (const e of entries) expect(e.text.length).toBeLessThanOrEqual(200);
  });
});

describe("bounds", () => {
  test("the entry cap drops the oldest, never the newest", () => {
    const log = new ActivityLog({ maxEntries: 3 });
    for (let i = 1; i <= 6; i += 1) log.append("w-001", { kind: "tool", at, tool: `t${i}` });
    const entries = log.entries("w-001");
    expect(entries).toHaveLength(3);
    expect(entries.map((e) => e.tool)).toEqual(["t4", "t5", "t6"]);
  });

  test("the character cap holds even when the entry count does not", () => {
    // One entry per call (each is a separate burst), well under `maxEntries`,
    // so only the character cap can stop this.
    const log = new ActivityLog({ maxEntries: 1_000, maxChars: 1_000, maxBurstChars: 200 });
    for (let i = 0; i < 40; i += 1) {
      log.append("w-001", { kind: "tool", at, tool: "t", text: "x".repeat(100) });
    }
    const total = log.entries("w-001").reduce((n, e) => n + e.text.length, 0);
    expect(total).toBeLessThanOrEqual(1_000);
    expect(log.summary("w-001").chars).toBeLessThanOrEqual(1_000);
  });

  test("rings are per worker and do not bleed into each other", () => {
    const log = new ActivityLog({ maxEntries: 2 });
    log.append("w-001", { kind: "tool", at, tool: "a" });
    log.append("w-002", { kind: "tool", at, tool: "b" });
    log.append("w-001", { kind: "tool", at, tool: "c" });
    expect(log.entries("w-001").map((e) => e.tool)).toEqual(["a", "c"]);
    expect(log.entries("w-002").map((e) => e.tool)).toEqual(["b"]);
    expect(log.workers().sort()).toEqual(["w-001", "w-002"]);
  });

  test("a worker with no ring answers empty rather than throwing", () => {
    const log = new ActivityLog();
    expect(log.entries("w-999")).toEqual([]);
    expect(log.summary("w-999")).toEqual({ count: 0, chars: 0 });
  });

  test("forget drops a ring, for when its worktree is cleaned up", () => {
    const log = new ActivityLog();
    log.append("w-001", { kind: "tool", at, tool: "a" });
    log.forget("w-001");
    expect(log.entries("w-001")).toEqual([]);
    expect(log.workers()).toEqual([]);
  });
});

describe("cursors and subscribers", () => {
  test("afterSeq is what a reconnecting client resumes from", () => {
    const log = new ActivityLog();
    log.append("w-001", { kind: "tool", at, tool: "a" });
    log.append("w-001", { kind: "tool", at, tool: "b" });
    log.append("w-001", { kind: "tool", at, tool: "c" });
    expect(log.entries("w-001", 1).map((e) => e.tool)).toEqual(["b", "c"]);
    expect(log.entries("w-001", 3)).toEqual([]);
  });

  test("subscribers see every append, including the in-place updates to an open burst", () => {
    const log = new ActivityLog();
    const seen: string[] = [];
    const off = log.subscribe((e) => seen.push(e.text));
    log.append("w-001", { kind: "text", at, text: "one" });
    log.append("w-001", { kind: "text", at, text: " two" });
    off();
    log.append("w-001", { kind: "text", at, text: " three" });
    expect(seen).toEqual(["one", "one two"]);
  });

  test("one subscriber that throws does not stop the others", () => {
    const log = new ActivityLog();
    const seen: string[] = [];
    log.subscribe(() => {
      throw new Error("a browser tab went away mid-write");
    });
    log.subscribe((e) => seen.push(e.kind));
    expect(() => log.append("w-001", { kind: "tool", at, tool: "a" })).not.toThrow();
    expect(seen).toEqual(["tool"]);
  });
});
