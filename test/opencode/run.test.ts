/**
 * `RunBackend` is a stub on purpose (ADR-0001). These tests pin *how* it is a
 * stub: it satisfies the interface, it fails loudly and typed, and the two calls
 * a supervisor might make blind — `health()` and `dispose()` — answer instead of
 * throwing.
 */

import { describe, expect, test } from "bun:test";

import { NotImplementedError, type OpenCodeBackend, RunBackend } from "../../src/opencode/index.js";

const REF = { sessionID: "ses_x", directory: "/tmp/w" };

describe("RunBackend", () => {
  test("satisfies OpenCodeBackend, so the ADR's fallback stays a one-file change", () => {
    const backend: OpenCodeBackend = new RunBackend();
    expect(backend.kind).toBe("run");
  });

  test("every unbuilt path throws NotImplementedError, naming itself and the reason", async () => {
    const b = new RunBackend();
    const calls: Array<[string, () => unknown]> = [
      ["start", () => b.start()],
      ["createSession", () => b.createSession({ cwd: "/tmp/w" })],
      ["prompt", () => b.prompt(REF, { text: "hi" })],
      ["events", () => b.events(REF)],
      ["abort", () => b.abort(REF)],
      ["usage", () => b.usage(REF)],
    ];
    for (const [name, call] of calls) {
      let err: unknown;
      try {
        await call();
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(NotImplementedError);
      expect((err as NotImplementedError).code).toBe("not_implemented");
      expect((err as Error).message).toContain(`RunBackend.${name}`);
      expect((err as Error).message).toContain("ADR-0001");
    }
  });

  test("health reports unavailable rather than throwing", async () => {
    // A supervisor polling health across backends should learn this one is
    // unusable, not crash on it.
    const health = await new RunBackend().health();
    expect(health.alive).toBe(false);
    expect(health.detail).toContain("ADR-0001");
  });

  test("dispose is safe on something that never started", async () => {
    await expect(new RunBackend().dispose()).resolves.toBeUndefined();
  });
});
