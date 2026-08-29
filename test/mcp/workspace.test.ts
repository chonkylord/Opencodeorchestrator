/**
 * The Phase 4 tool surface, driven the way a host drives it.
 *
 * Same rule as `tools.test.ts`: every call goes over real JSON-RPC through the
 * SDK's in-memory transport, because a handler called directly skips schema
 * validation and registration, and a zod schema the SDK cannot convert fails at
 * `listTools` in front of the user rather than here.
 *
 * The §11 acceptance criterion — *two workers on disjoint files merge green* —
 * lives in this file, end to end: two real workers, two real worktrees, two real
 * snapshot commits, one real `git merge`, and a real test suite as the gate.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { OCMock } from "../ocmock/server.js";
import { createOrchestrator, type Orchestrator } from "../../src/mcp/server.js";
import type { ServerConfig } from "../../src/mcp/config.js";
import { GOLDEN_TEST_COMMAND, makeGoldenRepo } from "../fixtures/golden.js";
import { gitLine } from "../../src/workspace/git.js";
import { sleep } from "../helpers.js";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await Promise.resolve(fn()).catch(() => {});
});

interface Harness {
  client: Client;
  orchestrator: Orchestrator;
  repo: string;
}

async function harness(mockOpts: Parameters<typeof OCMock.start>[0] = {}): Promise<Harness> {
  const repo = makeGoldenRepo("ws");
  cleanup.push(repo.cleanup);
  const mock = await OCMock.start({ heartbeatMs: 20, writeFiles: true, ...mockOpts });
  cleanup.push(() => mock.stop());

  const config: ServerConfig = {
    repoRoot: repo.path,
    dbPath: join(repo.path, ".orchestrator", "orchestrator.db"),
    defaultModel: "ocmock/test-model",
    baseUrl: mock.baseUrl,
    verifyTests: false,
    maxConcurrent: 3,
    maxRevisions: 3,
  };
  const orchestrator = await createOrchestrator(config, {
    tickMs: 10,
    budgetPollMs: 20,
    abortGraceMs: 400,
    retrySettleMs: 60,
  });
  cleanup.push(() => orchestrator.dispose());

  const client = new Client({ name: "test-host", version: "0.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await Promise.all([orchestrator.server.connect(serverSide), client.connect(clientSide)]);
  cleanup.push(() => client.close());

  return { client, orchestrator, repo: repo.path };
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

const mergeIDFrom = (text: string): string => {
  const m = /\b(m-\d+)\b/.exec(text);
  if (!m) throw new Error(`no merge id in: ${text}`);
  return m[1]!;
};

/** Spawn a worker and wait for it to settle, the way Claude would. */
async function completedWorker(client: Client, task: string, over: Record<string, unknown> = {}): Promise<string> {
  const spawned = await call(client, "worker_spawn", {
    task,
    mode: "implement",
    testCommand: GOLDEN_TEST_COMMAND,
    runID: "run-1",
    ...over,
  });
  const id = idFrom(spawned.text);
  const waited = await call(client, "worker_wait", { id, timeoutMs: 10_000 });
  expect(waited.text).toContain("completed");
  return id;
}

async function pollMerge(client: Client, mergeID: string, ms = 30_000): Promise<string> {
  const deadline = Date.now() + ms;
  let last = "";
  while (Date.now() < deadline) {
    last = (await call(client, "workspace_merge_status", { mergeID })).text;
    if (!last.includes("still running")) return last;
    await sleep(50);
  }
  throw new Error(`merge ${mergeID} never settled; last status: ${last}`);
}

// ---------------------------------------------------------------------------

describe("workspace_merge over JSON-RPC", () => {
  test("two workers on disjoint files merge green — §11 Phase 4 AC", async () => {
    // Each worker writes a file named after its own worktree, so the two
    // changed-file sets are genuinely disjoint rather than identical.
    const { client, repo } = await harness({ perWorktreeFileName: true });
    const a = await completedWorker(client, "write the first file");
    const b = await completedWorker(client, "write the second file");

    const started = await call(client, "workspace_merge", { workerIDs: [a, b] });
    expect(started.isError).toBe(false);
    // DD-1: the gate has not run yet and the tool is already back.
    expect(started.ms).toBeLessThan(2_000);
    expect(started.text).toContain("Overlap: none");
    expect(started.text).toContain(GOLDEN_TEST_COMMAND);

    const mergeID = mergeIDFrom(started.text);
    const settled = await pollMerge(client, mergeID);
    expect(settled).toContain("MERGED GREEN");
    expect(settled).toContain(`${a}: merged`);
    expect(settled).toContain(`${b}: merged`);

    // Both workers are on the integration branch, in git, not just in prose.
    const branch = `integration/${mergeID}`;
    const tree = await gitLine(repo, ["ls-tree", "-r", "--name-only", branch]);
    expect(tree).toContain(`${a}.txt`);
    expect(tree).toContain(`${b}.txt`);

    // And the state machine's one Phase 4 edge actually fired.
    const listed = await call(client, "worker_list", { state: "merged" });
    expect(listed.text).toContain(a);
    expect(listed.text).toContain(b);
  }, 60_000);

  test("a conflicting merge is detected and the branch is left where it was", async () => {
    // Same file name, different content per worktree: a real conflict.
    const { client, repo } = await harness({ perWorktreeFileName: false, perWorktreeFileContent: true });
    const a = await completedWorker(client, "write hello");
    const b = await completedWorker(client, "write hello differently");

    const started = await call(client, "workspace_merge", { workerIDs: [a, b], runTests: false });
    // The overlap check warned before anything was merged.
    expect(started.text).toContain("Overlap: shared files");
    const mergeID = mergeIDFrom(started.text);

    const settled = await pollMerge(client, mergeID);
    expect(settled).toContain("ROLLED BACK");
    expect(settled).toContain(`${b}: conflict`);
    expect(settled).toContain("hello.txt");

    // The branch holds the first worker only, and the second worker is not
    // marked merged — its work is untouched on its own branch.
    const branch = `integration/${mergeID}`;
    const log = await gitLine(repo, ["log", "--oneline", branch]);
    expect(log).toContain(a);
    expect(log).not.toContain(b);
    expect((await call(client, "worker_status", { ids: [b] })).text).toContain("completed");
  }, 60_000);

  test("the user's checkout survives a merge cycle driven over the protocol", async () => {
    const { client, repo } = await harness({ perWorktreeFileName: false, perWorktreeFileContent: true });
    writeFileSync(join(repo, "scratch.txt"), "do not touch\n");

    const a = await completedWorker(client, "write hello");
    const b = await completedWorker(client, "write hello differently");
    // The baseline is taken once the workers exist, because spawning one adds
    // `/.orchestrator/` to `.git/info/exclude` — a deliberate, documented write
    // that changes `git status` output and has nothing to do with merging.
    const before = await gitLine(repo, ["status", "--porcelain"]);
    const head = await gitLine(repo, ["rev-parse", "HEAD"]);

    const started = await call(client, "workspace_merge", { workerIDs: [a, b], runTests: false });
    await pollMerge(client, mergeIDFrom(started.text));

    expect(await gitLine(repo, ["status", "--porcelain"])).toBe(before);
    expect(await gitLine(repo, ["rev-parse", "HEAD"])).toBe(head);
    expect(readFileSync(join(repo, "scratch.txt"), "utf8")).toBe("do not touch\n");
  }, 60_000);

  test("a worker that is not `completed` is rejected by name", async () => {
    const { client } = await harness();
    const rejected = await call(client, "workspace_merge", { workerIDs: ["w-404"] });
    expect(rejected.isError).toBe(true);
    expect(rejected.text).toContain("w-404");
  });

  test("merges can be listed, and an unknown id is an error with a way forward", async () => {
    const { client } = await harness({ perWorktreeFileName: true });
    expect((await call(client, "workspace_merge_status")).text).toContain("No merges");
    const a = await completedWorker(client, "write a file");
    const started = await call(client, "workspace_merge", { workerIDs: [a] });
    await pollMerge(client, mergeIDFrom(started.text));

    const listed = await call(client, "workspace_merge_status");
    expect(listed.text).toContain("succeeded");
    const missing = await call(client, "workspace_merge_status", { mergeID: "m-999" });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain("list them");
  }, 60_000);
});

describe("worker_diff over JSON-RPC", () => {
  test("renders the worker's diff, marked as untrusted, and paginates", async () => {
    const { client, orchestrator } = await harness({ perWorktreeFileName: true });
    const id = await completedWorker(client, "write a file");

    const page = await call(client, "worker_diff", { id });
    expect(page.isError).toBe(false);
    expect(page.ms).toBeLessThan(2_000);
    expect(page.text).toContain(`${id}.txt`);
    // DD-8: a diff is file content a model wrote, and the rendering says so.
    expect(page.text).toMatch(/A WORKER WROTE/);

    // Make the diff long enough to page, in the worker's own worktree.
    const worktree = orchestrator.manager.get(id)!.worktree;
    writeFileSync(join(worktree, "big.txt"), `${Array.from({ length: 900 }, (_, i) => `line ${i}`).join("\n")}\n`);

    const first = await call(client, "worker_diff", { id, maxLines: 400 });
    expect(first.text).toMatch(/lines 1–400 of \d+/);
    expect(first.text).toContain("cursor: 400");
    const second = await call(client, "worker_diff", { id, cursor: 400, maxLines: 400 });
    expect(second.text).toMatch(/lines 401–800 of \d+/);
  }, 60_000);

  test("an unknown worker is an error, not an empty diff", async () => {
    const { client } = await harness();
    const missing = await call(client, "worker_diff", { id: "w-404" });
    expect(missing.isError).toBe(true);
  });
});

describe("workspace_cleanup over JSON-RPC", () => {
  test("prunes merged workers, keeps unmerged ones, and reports orphans", async () => {
    const { client, orchestrator, repo } = await harness({ perWorktreeFileName: true });
    const a = await completedWorker(client, "write a file");
    const b = await completedWorker(client, "write another file");
    const worktreeB = orchestrator.manager.get(b)!.worktree;

    const started = await call(client, "workspace_merge", { workerIDs: [a] });
    await pollMerge(client, mergeIDFrom(started.text));

    // With no ids it cleans up exactly what has been merged — the safe set.
    const report = await call(client, "workspace_cleanup");
    expect(report.isError).toBe(false);
    expect(report.ms).toBeLessThan(2_000);
    expect(report.text).toContain(`${a}: worktree removed`);
    expect(report.text).toContain(`branch worker/${a} deleted`);
    expect(await gitLine(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/worker/${a}`], { allowFailure: true })).toBe(
      "",
    );

    // The unmerged worker was not named and is untouched.
    expect(existsSync(worktreeB)).toBe(true);

    // Naming it explicitly keeps the branch and says why.
    const kept = await call(client, "workspace_cleanup", { ids: [b] });
    expect(kept.text).toContain("KEPT");
    expect(kept.text).toContain("unmerged");
    expect(await gitLine(repo, ["rev-parse", "--verify", "--quiet", `refs/heads/worker/${b}`])).not.toBe("");
  }, 60_000);

  test("a diff still works after cleanup has taken the worktree", async () => {
    // The branch is the work; the directory is scaffolding. `worker_diff` falls
    // back to the branch, which is what makes cleanup safe to run early.
    const { client } = await harness({ perWorktreeFileName: true });
    const a = await completedWorker(client, "write a file");
    const started = await call(client, "workspace_merge", { workerIDs: [a] });
    await pollMerge(client, mergeIDFrom(started.text));
    await call(client, "workspace_cleanup", { ids: [a] });

    const page = await call(client, "worker_diff", { id: a });
    expect(page.isError).toBe(false);
  }, 60_000);
});
