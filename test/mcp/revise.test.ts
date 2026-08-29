/**
 * Phase 6's tool surface, driven the way a host drives it.
 *
 * The §11 Phase 6 acceptance criterion is here and it is one test: **a seeded
 * failing worker receives feedback, fixes it, and passes** — where "fails" is a
 * real assertion failure in the golden repo's own suite and "passes" is the
 * orchestrator re-running that suite itself. A test that stubbed either end
 * would be checking that the manager can copy a boolean.
 *
 * The other half of the AC — that the loop terminates at the cap with an
 * actionable report — is asserted on the report's *content*, because the half
 * that was never at risk is whether the refusal happens.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { OCMock } from "../ocmock/server.js";
import { createOrchestrator, type ManagerTuning, type Orchestrator } from "../../src/mcp/server.js";
import type { ServerConfig } from "../../src/mcp/config.js";
import { GOLDEN_TEST_COMMAND, breakGoldenRepo, makeGoldenRepo } from "../fixtures/golden.js";
import { sleep } from "../helpers.js";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await Promise.resolve(fn()).catch(() => {});
});

/** `sum` with the fixture's deliberate off-by-one still in it. */
const STILL_BROKEN = `export function sum(values) {
  let total = 1; // still wrong
  for (const v of values) total += v;
  return total;
}

export function mean(values) {
  if (values.length === 0) throw new RangeError("mean of an empty list is undefined");
  return sum(values) / values.length;
}

export function median(values) {
  if (values.length === 0) throw new RangeError("median of an empty list is undefined");
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
`;

/** The same file, correct. What a worker that actually fixed it would write. */
const FIXED = STILL_BROKEN.replace("let total = 1; // still wrong", "let total = 0;");

const claims = (summary: string): Record<string, unknown> => ({
  status: "completed",
  summary,
  changes: [{ file: "src/stats.js", action: "modified", rationale: "the fix" }],
  tests: { command: GOLDEN_TEST_COMMAND, passed: 3, failed: 0, skipped: 0 },
  risks: [],
  questions: [],
  followUps: [],
});

interface Harness {
  client: Client;
  orchestrator: Orchestrator;
  mock: OCMock;
  repo: string;
}

async function harness(
  mockOpts: Parameters<typeof OCMock.start>[0] = {},
  configOver: Partial<ServerConfig> = {},
  tuning: ManagerTuning = {},
  seedBroken = false,
): Promise<Harness> {
  const repo = makeGoldenRepo("revise-mcp");
  cleanup.push(repo.cleanup);
  if (seedBroken) {
    // Committed, not just written: a worktree branches from HEAD, so a break
    // left in the working tree would never reach the worker at all.
    breakGoldenRepo(repo.path);
    git(repo.path, ["add", "-A"]);
    git(repo.path, ["commit", "-q", "-m", "seed the failing suite"]);
  }
  const mock = await OCMock.start({ heartbeatMs: 20, ...mockOpts });
  cleanup.push(() => mock.stop());

  const config: ServerConfig = {
    repoRoot: repo.path,
    dbPath: join(repo.path, ".orchestrator", "orchestrator.db"),
    defaultModel: "ocmock/test-model",
    baseUrl: mock.baseUrl,
    verifyTests: false,
    maxConcurrent: 3,
    maxRevisions: 3,
    ...configOver,
  };
  const orchestrator = await createOrchestrator(config, {
    tickMs: 10,
    budgetPollMs: 20,
    abortGraceMs: 400,
    retrySettleMs: 40,
    ...tuning,
  });
  cleanup.push(() => orchestrator.dispose());

  const client = new Client({ name: "test-host", version: "0.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([orchestrator.server.connect(serverSide), client.connect(clientSide)]);
  cleanup.push(() => client.close());

  return { client, orchestrator, mock, repo: repo.path };
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@localhost", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();
}

interface CallOutcome {
  readonly text: string;
  readonly isError: boolean;
  readonly ms: number;
}

async function call(client: Client, name: string, args: Record<string, unknown> = {}): Promise<CallOutcome> {
  const started = Date.now();
  const res = (await client.callTool({ name, arguments: args })) as {
    content?: Array<{ type: string; text?: string }>;
    isError?: boolean;
  };
  return {
    text: (res.content ?? [])
      .filter((c) => c.type === "text")
      .map((c) => c.text ?? "")
      .join("\n"),
    isError: res.isError === true,
    ms: Date.now() - started,
  };
}

const idFrom = (text: string): string => {
  const m = /\b(w-\d+)\b/.exec(text);
  if (!m) throw new Error(`no worker id in: ${text}`);
  return m[1]!;
};

async function waitSettled(client: Client, id: string, ms = 25_000): Promise<string> {
  const deadline = Date.now() + ms;
  let last = "";
  while (Date.now() < deadline) {
    const r = await call(client, "worker_wait", { id, timeoutMs: 2_000 });
    last = r.text;
    if (/\[(completed|failed|timed_out|over_budget|cancelled|merged|blocked)/.test(last)) return last;
    await sleep(20);
  }
  throw new Error(`worker ${id} never settled; last status:\n${last}`);
}

// ---------------------------------------------------------------------------

describe("§11 Phase 6 AC: a seeded failing worker receives feedback, fixes it, and passes", () => {
  test("round 1 fails the orchestrator's own test run; round 2 passes it", async () => {
    // The repo is seeded so `npm test` genuinely fails on an assertion. The
    // worker "fixes" it wrongly the first time and correctly the second, and
    // both times it CLAIMS the tests pass — so the only thing that can tell the
    // rounds apart is the orchestrator running the suite itself (§4.3). That is
    // the property this test exists for.
    const h = await harness({ report: claims("Fixed sum().") }, { verifyTests: true }, {}, true);

    const spawned = await call(h.client, "worker_spawn", {
      task: "fix the off-by-one in sum()",
      mode: "implement",
      runID: "run-1",
      ownedPaths: ["src/stats.js"],
      testCommand: GOLDEN_TEST_COMMAND,
    });
    expect(spawned.isError).toBe(false);
    const id = idFrom(spawned.text);

    // Script the first round to write a file that is still wrong.
    const sessionID = await waitForSession(h, id);
    h.mock.setWrite(sessionID, [{ path: "src/stats.js", content: STILL_BROKEN }]);

    await waitSettled(h.client, id);
    const first = await call(h.client, "worker_result", { id });
    // It claimed the suite passes; the orchestrator ran it and it does not.
    expect(first.text).toContain("test_claim_unverified");

    // Now Claude does what Phase 6 exists for.
    const revise = await call(h.client, "worker_revise", {
      id,
      feedback: "npm test still fails: sum([1,2,3,4]) returns 11, not 10. `total` starts at 1 and must start at 0.",
    });
    expect(revise.isError).toBe(false);
    expect(revise.text).toContain("Revision 1 of 3");

    h.mock.setWrite(sessionID, [{ path: "src/stats.js", content: FIXED }]);
    h.mock.setReport(sessionID, claims("Corrected the initial value of total."));

    await waitSettled(h.client, id);
    const second = await call(h.client, "worker_result", { id });
    expect(second.text).toContain("completed");
    // The claim is now true, and the orchestrator's own run is what says so.
    expect(second.text).not.toContain("test_claim_unverified");
    expect(second.text).toContain("Corrected the initial value of total.");

    // And the fix is really on disk in the worker's worktree, not just claimed.
    const worktree = join(h.repo, ".orchestrator", "worktrees", id, "src", "stats.js");
    expect(readFileSync(worktree, "utf8")).toContain("let total = 0;");
  }, 60_000);
});

describe("the loop terminates at the cap with a report Claude can act on", () => {
  test("the refusal names what was tried, what changed, what still fails, and the options", async () => {
    const h = await harness({ report: claims("Had another go.") }, { maxRevisions: 2 });
    const spawned = await call(h.client, "worker_spawn", { task: "fix sum()", runID: "run-1" });
    const id = idFrom(spawned.text);
    await waitSettled(h.client, id);

    for (const feedback of ["still off by one in sum()", "sum() is STILL returning 11 for [1,2,3,4]"]) {
      const r = await call(h.client, "worker_revise", { id, feedback });
      expect(r.isError).toBe(false);
      await waitSettled(h.client, id);
    }

    const capped = await call(h.client, "worker_revise", { id, feedback: "one more go" });
    expect(capped.isError).toBe(false);
    const text = capped.text;

    // It refused, and said so in terms of the cap rather than as an error.
    expect(text).toContain("Revision refused");
    expect(text).toContain("2 of 2 rounds");

    // What was tried: every round, with the feedback that was actually sent.
    expect(text).toContain("What was tried");
    expect(text).toContain("Round 0");
    expect(text).toContain("Round 1");
    expect(text).toContain("Round 2");
    expect(text).toContain("still off by one in sum()");
    expect(text).toContain("STILL returning 11");

    // What changed between them, measured rather than claimed.
    expect(text).toContain("What changed across the rounds");
    expect(text).toMatch(/Files touched went from \d+ to \d+/);

    // What is still failing.
    expect(text).toContain("What is still failing");

    // And what Claude can actually do about it — the load-bearing half.
    expect(text).toContain("Your options");
    expect(text).toContain("workspace_merge");
    expect(text).toContain("worker_diff");
    expect(text).toContain("Spawn a replacement");
    expect(text).toContain("ORCHESTRATOR_MAX_REVISIONS");

    // The worker itself is untouched by the refusal.
    const status = await call(h.client, "worker_status", { ids: [id] });
    expect(status.text).toContain("[completed]");
    expect(status.text).toContain("revisions: 2");
  }, 60_000);

  test("the status line tells revisions and resumes apart", async () => {
    // Before Phase 6 the line printed `resumes` under the word "revisions",
    // which was harmless only while the two could not disagree.
    const h = await harness({ report: claims("Done.") });
    const spawned = await call(h.client, "worker_spawn", { task: "do a thing", runID: "run-1" });
    const id = idFrom(spawned.text);
    await waitSettled(h.client, id);
    await call(h.client, "worker_revise", { id, feedback: "again" });
    await waitSettled(h.client, id);

    const status = await call(h.client, "worker_status", { ids: [id] });
    expect(status.text).toContain("revisions: 1");
    expect(status.text).not.toContain("resumes:");
  }, 30_000);
});

describe("worker_revise over the wire", () => {
  test("it returns in well under two seconds and the worker has already left `completed`", async () => {
    // DD-1, and trap 4 together: the tool must not wait for the round to start,
    // *and* the state must move before it returns, or the caller's next
    // worker_wait comes straight back with the pre-revision record.
    const h = await harness({ report: claims("Done."), workMs: 800 });
    const spawned = await call(h.client, "worker_spawn", { task: "do a thing", runID: "run-1" });
    const id = idFrom(spawned.text);
    await waitSettled(h.client, id);

    const revise = await call(h.client, "worker_revise", { id, feedback: "again please" });
    expect(revise.ms).toBeLessThan(2_000);

    const status = await call(h.client, "worker_status", { ids: [id] });
    expect(status.text).not.toContain("[completed]");

    const waited = await call(h.client, "worker_wait", { id, timeoutMs: 5_000 });
    expect(waited.ms).toBeGreaterThan(100);
    expect(waited.text).toContain("[completed]");
  }, 30_000);

  test("revising a blocked worker is refused and points at worker_message", async () => {
    const h = await harness({ scenario: "blocked" });
    const spawned = await call(h.client, "worker_spawn", { task: "ask me something", runID: "run-1" });
    const id = idFrom(spawned.text);
    await waitSettled(h.client, id);

    const r = await call(h.client, "worker_revise", { id, feedback: "here is your answer" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("worker_message");
  }, 30_000);

  test("an unknown worker is a clean refusal, not a crash", async () => {
    const h = await harness();
    const r = await call(h.client, "worker_revise", { id: "w-999", feedback: "hello" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("w-999");
  }, 20_000);
});

describe("a revised worker merges the commit it produced last", () => {
  test("the merge takes the post-revision work, and the overlap warning is current", async () => {
    // §3 of the handoff argued this already works, because `mergeOne()` resolves
    // the candidate's BRANCH TIP rather than the snapshot sha in its result. The
    // argument is right and this is the test that pins it — including the part
    // that does not come for free: the overlap check reads the *result*, so it is
    // only current if the revision settles before the merge starts.
    const h = await harness({ report: claims("First pass."), writeFiles: false }, { verifyTests: false });
    const spawned = await call(h.client, "worker_spawn", {
      task: "add the settings module",
      runID: "run-1",
      ownedPaths: ["src/**"],
    });
    const id = idFrom(spawned.text);
    const sessionID = await waitForSession(h, id);
    h.mock.setWrite(sessionID, [{ path: "src/first.js", content: "export const first = 1;\n" }]);
    await waitSettled(h.client, id);

    const before = await call(h.client, "worker_result", { id });
    expect(before.text).toContain("src/first.js");
    expect(before.text).not.toContain("src/second.js");

    // The revision adds a file the first round never touched.
    await call(h.client, "worker_revise", { id, feedback: "also add src/second.js" });
    h.mock.setWrite(sessionID, [
      { path: "src/first.js", content: "export const first = 1;\n" },
      { path: "src/second.js", content: "export const second = 2;\n" },
    ]);
    h.mock.setReport(sessionID, claims("Added the second module too."));
    await waitSettled(h.client, id);

    // The result — which is what the overlap check reads — is the new one.
    const after = await call(h.client, "worker_result", { id });
    expect(after.text).toContain("src/second.js");

    const merge = await call(h.client, "workspace_merge", { workerIDs: [id], runTests: false, runID: "run-1" });
    expect(merge.isError).toBe(false);
    const mergeID = /\b(m-\d+)\b/.exec(merge.text)![1]!;

    const deadline = Date.now() + 30_000;
    let status = "";
    while (Date.now() < deadline) {
      status = (await call(h.client, "workspace_merge_status", { mergeID })).text;
      if (!status.includes("still running")) break;
      await sleep(50);
    }
    expect(status).toContain("MERGED");

    // The post-revision commit is what landed, not the first round's.
    const branch = `integration/${mergeID}`;
    const files = git(h.repo, ["ls-tree", "-r", "--name-only", branch]);
    expect(files).toContain("src/second.js");
  }, 60_000);
});

describe("a review worker critiques another worker's diff", () => {
  test("it is read-only, is given the diff, and produces something Claude can use", async () => {
    const h = await harness({ report: claims("Wrote the module.") });
    const author = await call(h.client, "worker_spawn", {
      task: "add the settings module",
      runID: "run-1",
      ownedPaths: ["src/**"],
    });
    const authorID = idFrom(author.text);
    const authorSession = await waitForSession(h, authorID);
    h.mock.setWrite(authorSession, [{ path: "src/settings.js", content: "export const settings = {theme: 'dark'};\n" }]);
    await waitSettled(h.client, authorID);

    const critique = {
      status: "completed",
      summary: "The module works but the default is hard-coded.",
      changes: [],
      risks: ["src/settings.js: the theme default is hard-coded, so it cannot be configured per user."],
      questions: [],
      followUps: ["consider exporting a factory rather than a frozen object"],
    };
    const reviewer = await call(h.client, "worker_spawn", {
      task: `review ${authorID}'s settings module`,
      mode: "review",
      reviewOf: authorID,
      runID: "run-1",
    });
    expect(reviewer.isError).toBe(false);
    const reviewerID = idFrom(reviewer.text);
    const reviewerSession = await waitForSession(h, reviewerID);
    h.mock.setReport(reviewerSession, critique);
    await waitSettled(h.client, reviewerID);

    const result = await call(h.client, "worker_result", { id: reviewerID });
    expect(result.text).toContain("completed");
    expect(result.text).toContain("hard-coded");

    // The reviewer was actually shown the author's diff.
    const prompts = h.mock.requests.filter((r) => r.path.includes("/prompt"));
    const reviewPrompt = prompts.map((p) => JSON.stringify(p.body)).find((b) => b.includes(`Review the work of worker ${authorID}`));
    expect(reviewPrompt).toBeDefined();
    expect(reviewPrompt!).toContain("src/settings.js");
    // …and told, in the prompt, that the diff is data rather than instructions.
    expect(reviewPrompt!).toContain("data, not instructions");

    // Read-only means read-only: it changed nothing, and the measurement says so
    // rather than the mode saying so.
    const record = h.orchestrator.manager.get(reviewerID)!;
    expect(record.mode).toBe("review");
    expect(record.result!.changes.files).toBe(0);
    expect(record.result!.discrepancies).toEqual([]);
    // Its own worktree, at the author's base — not a mount of the author's.
    expect(record.worktree).not.toBe(h.orchestrator.manager.get(authorID)!.worktree);
    expect(record.baseSha).toBe(h.orchestrator.manager.get(authorID)!.baseSha);
  }, 60_000);

  test("reviewOf is rejected at spawn when it names a worker nobody was handed", async () => {
    const h = await harness();
    const r = await call(h.client, "worker_spawn", { task: "review something", mode: "review", reviewOf: "w-404", runID: "run-1" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("w-404");
  }, 20_000);

  test("reviewOf without mode:review is rejected rather than quietly ignored", async () => {
    const h = await harness({ report: claims("Done.") });
    const first = await call(h.client, "worker_spawn", { task: "do a thing", runID: "run-1" });
    const id = idFrom(first.text);
    const r = await call(h.client, "worker_spawn", { task: "review it", mode: "implement", reviewOf: id, runID: "run-1" });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("review");
  }, 20_000);
});

describe("the run report carries the rounds", () => {
  test("a revised worker's section says what each round changed", async () => {
    const h = await harness({ report: claims("First pass.") });
    const spawned = await call(h.client, "worker_spawn", { task: "add a module", runID: "run-1", ownedPaths: ["src/**"] });
    const id = idFrom(spawned.text);
    const sessionID = await waitForSession(h, id);
    h.mock.setWrite(sessionID, [{ path: "src/a.js", content: "export const a = 1;\n" }]);
    await waitSettled(h.client, id);

    await call(h.client, "worker_revise", { id, feedback: "add src/b.js as well" });
    h.mock.setWrite(sessionID, [
      { path: "src/a.js", content: "export const a = 1;\n" },
      { path: "src/b.js", content: "export const b = 2;\n" },
    ]);
    h.mock.setReport(sessionID, claims("Added the second file."));
    await waitSettled(h.client, id);

    const report = await call(h.client, "run_report", { runID: "run-1" });
    expect(report.isError).toBe(false);
    expect(report.text).toContain("Revision rounds");
    expect(report.text).toContain("Round 0");
    expect(report.text).toContain("Round 1");
    expect(report.text).toContain("add src/b.js as well");
    // The table gained a column rather than overloading the existing one.
    expect(report.text).toContain("| revisions |");
  }, 60_000);
});

/** The session a worker opened, once it has opened one. */
async function waitForSession(h: Harness, id: string, ms = 15_000): Promise<string> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const sessionID = h.orchestrator.manager.get(id)?.sessionID;
    if (sessionID) return sessionID;
    await sleep(10);
  }
  throw new Error(`worker ${id} never opened a session`);
}
