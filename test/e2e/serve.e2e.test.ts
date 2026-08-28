/**
 * The one integration test against a real `opencode serve` (Phase 1 AC).
 *
 * Gated behind `OC_E2E=1` because it spends real tokens:
 *
 *   OC_E2E=1 bun test test/e2e
 *
 * It is the same ground `spike/spike.ts` covers, re-aimed at the adapter: if
 * this passes and the unit suite passes, `ocmock` is telling the truth about
 * OpenCode. If this fails while the unit suite passes, the fact sheet has
 * drifted and `docs/phase0-facts.md` is what needs fixing first.
 *
 * A second, separately-gated test answers §14 Q5 (4+ concurrent sessions on one
 * server), which Phase 0 left open:
 *
 *   OC_E2E=1 OC_E2E_CONCURRENCY=1 bun test test/e2e
 */

import { afterAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  HEADLESS_PERMISSIONS,
  type OCEvent,
  ServeBackend,
  type SessionHandle,
  isTerminal,
  isWorkerEvent,
} from "../../src/opencode/index.js";
import { until } from "../helpers.js";

const ENABLED = process.env["OC_E2E"] === "1";
const CONCURRENCY = ENABLED && process.env["OC_E2E_CONCURRENCY"] === "1";
const MODEL = process.env["OC_E2E_MODEL"] ?? "opencode/muse-spark-1.2-contributor-free";
const RUN_TIMEOUT_MS = Number(process.env["OC_E2E_TIMEOUT_MS"] ?? 180_000);

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

/** A throwaway repo plus `count` worktrees — the shape DD-2 has to survive. */
function fixture(count: number): { repo: string; worktrees: string[] } {
  const root = mkdtempSync(join(tmpdir(), "oc-e2e-"));
  roots.push(root);
  const repo = join(root, "repo");
  mkdirSync(repo);
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, stdio: "pipe" }).toString();
  git("init", "-q");
  git("config", "user.email", "e2e@example.com");
  git("config", "user.name", "Phase 1 E2E");
  writeFileSync(join(repo, "README.md"), "# fixture\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  const worktrees: string[] = [];
  for (let i = 1; i <= count; i++) {
    const id = `w-${String(i).padStart(3, "0")}`;
    const wt = join(root, id);
    git("worktree", "add", "-q", wt, "-b", `worker/${id}`);
    worktrees.push(wt);
  }
  return { repo, worktrees };
}

const marker = (id: string) => `PHASE1_OK_${id}`;
const brief = (id: string) =>
  `Create a file named hello.txt in the current directory containing exactly: ${marker(id)}`;

describe.skipIf(!ENABLED)("ServeBackend against real OpenCode", () => {
  test(
    "creates a worktree session, runs a prompt to completion, and reports usage",
    async () => {
      const { repo, worktrees } = fixture(1);
      const wt = worktrees[0]!;
      const backend = new ServeBackend({ cwd: repo });
      try {
        await backend.start();
        expect(backend.url).toMatch(/^http:\/\/\S+:\d+$/);
        // --port 0 picks a free port. It picks 4096 almost every time, which is
        // exactly why this is asserted rather than assumed.
        expect(new URL(backend.url).port).not.toBe("");
        const health = await backend.health();
        expect(health.alive).toBe(true);
        expect(health.version).toBeTruthy();

        const session = await backend.createSession({
          cwd: wt,
          title: "phase1-e2e",
          model: MODEL,
          permissions: HEADLESS_PERMISSIONS,
        });
        expect(session.directory).toBe(wt);

        // Subscribe first — a trivial task finishes in ~11s and a late
        // subscriber misses the completion event entirely.
        const stream = await backend.events(session);
        const t0 = Date.now();
        await backend.prompt(session, {
          text: brief("E2E"),
          system: "You are a headless worker. Do exactly what is asked, nothing more.",
        });
        // DD-1: the tool call returns immediately; the work continues behind it.
        expect(Date.now() - t0).toBeLessThan(2_000);

        const events = await until(stream, isTerminal, RUN_TIMEOUT_MS, "session.idle from real OpenCode");
        const last = events.at(-1)!;
        if (last.kind === "error") throw last.error;
        expect(last.kind).toBe("idle");

        // The stream carried real work, not just liveness.
        expect(events.filter(isWorkerEvent).length).toBeGreaterThan(0);
        expect(events.some((e) => e.kind === "heartbeat" || e.kind === "stream.open")).toBe(true);
        expect(events.some((e) => e.kind === "tool")).toBe(true);

        // Trust, but verify (DD-4): the event says done, the filesystem says what.
        const target = join(wt, "hello.txt");
        expect(existsSync(target)).toBe(true);
        expect(readFileSync(target, "utf8").trim()).toBe(marker("E2E"));

        const usage = await backend.usage(session);
        expect(usage).not.toBeNull();
        // Tokens are the budget signal; cost is 0 on free-tier providers even
        // after real work, so it is exposed but never gated on.
        expect(usage!.totalTokens).toBeGreaterThan(0);
        expect(typeof usage!.cost).toBe("number");

        stream.close();
      } finally {
        await backend.dispose();
      }
      expect((await backend.health()).alive).toBe(false);
    },
    RUN_TIMEOUT_MS + 60_000,
  );
});

describe.skipIf(!CONCURRENCY)("one serve process, four concurrent worktree sessions (§14 Q5)", () => {
  test(
    "four workers run at once without interfering",
    async () => {
      const { repo, worktrees } = fixture(4);
      const backend = new ServeBackend({ cwd: repo });
      try {
        await backend.start();

        const sessions: SessionHandle[] = [];
        const streams = [];
        for (const wt of worktrees) {
          const session = await backend.createSession({
            cwd: wt,
            title: `concurrent-${wt.split("/").pop()}`,
            model: MODEL,
            permissions: HEADLESS_PERMISSIONS,
          });
          sessions.push(session);
          streams.push(await backend.events(session));
        }

        const started = Date.now();
        await Promise.all(
          sessions.map((s, i) =>
            backend.prompt(s, {
              text: brief(`C${i}`),
              system: "You are a headless worker. Do exactly what is asked, nothing more.",
            }),
          ),
        );

        const results = await Promise.all(
          streams.map((s, i) =>
            until(s, isTerminal, RUN_TIMEOUT_MS, `idle for concurrent worker ${i}`).then((events) => ({
              events,
              ms: Date.now() - started,
            })),
          ),
        );

        for (const [i, { events, ms }] of results.entries()) {
          const last = events.at(-1)!;
          if (last.kind === "error") throw last.error;
          expect(last.kind).toBe("idle");
          // Each stream is scoped to its own worktree: no cross-talk.
          const foreign = events.filter(
            (e: OCEvent) => "sessionID" in e && e.sessionID !== sessions[i]!.sessionID,
          );
          expect(foreign).toHaveLength(0);
          expect(readFileSync(join(worktrees[i]!, "hello.txt"), "utf8").trim()).toBe(marker(`C${i}`));
          console.log(`  worker ${i}: idle after ${ms}ms, ${events.length} events`);
        }

        const usages = await Promise.all(sessions.map((s) => backend.usage(s)));
        for (const u of usages) expect(u!.totalTokens).toBeGreaterThan(0);
        expect((await backend.health()).alive).toBe(true);
      } finally {
        await backend.dispose();
      }
    },
    RUN_TIMEOUT_MS + 120_000,
  );
});
