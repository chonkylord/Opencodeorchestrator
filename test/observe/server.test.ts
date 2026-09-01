/**
 * The dashboard server (§11 Phase 9), over a real socket.
 *
 * `port: 0` throughout: several test files run at once and a fixed port makes
 * the suite fail for a reason that has nothing to do with the code.
 *
 * The security properties are asserted here rather than assumed, because they
 * are the ones that turn a convenience into a liability if they ever quietly
 * stop holding: **read-only**, so no browser tab can act on an orchestration,
 * and **no traversal**, so the UI directory is the whole of what it will serve.
 * Both are one-line changes away from being wrong and neither is visible in
 * ordinary use.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import { ActivityLog, type Dashboard, startDashboard } from "../../src/observe/index.js";
import { Store } from "../../src/store/index.js";
import { makeGoldenRepo } from "../fixtures/golden.js";
import type { WorkerRecord } from "../../src/manager/types.js";

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) {
    try {
      fn();
    } catch {
      /* best effort */
    }
  }
});

const now = 1_700_000_000_000;

function record(over: Partial<WorkerRecord> = {}): WorkerRecord {
  return {
    workerID: "w-001",
    runID: "run-1",
    state: "running",
    mode: "implement",
    model: "opencode/muse",
    task: "rework the house generator",
    spec: { task: "rework the house generator", ownedPaths: ["houses.js"] },
    worktree: "",
    branch: "",
    baseSha: "abc1234",
    createdAt: now,
    updatedAt: now,
    startedAt: now,
    totalTokens: 1_234,
    cost: 0,
    resumes: 0,
    revisions: 0,
    questions: [],
    ...over,
  };
}

interface Fixture {
  dash: Dashboard;
  store: Store;
  activity: ActivityLog;
  repo: string;
}

function fixture(records: WorkerRecord[] = [record()], orphans: string[] = []): Fixture {
  const repo = makeGoldenRepo("dash");
  cleanup.push(() => void repo.cleanup());
  const store = new Store(join(repo.path, "dash.db"));
  cleanup.push(() => store.close());
  for (const r of records) store.putWorker(r);
  const activity = new ActivityLog();

  const dash = startDashboard({
    manager: {
      list: () => store.listWorkers(),
      queueHint: () => undefined,
      isOrphaned: (id) => orphans.includes(id),
      supportsStructuredOutput: (m) => !m.includes("muse"),
      isShared: () => true,
      briefOf: (id) => (id === "w-001" ? { system: "You are worker w-001", text: "Task: go" } : undefined),
    },
    store,
    activity,
    repoRoot: repo.path,
    port: 0,
    log: () => {},
    server: {
      name: "dispatched-code",
      version: "test",
      repoRoot: repo.path,
      defaultModel: "opencode/muse",
      workspace: "shared",
      maxConcurrent: 3,
      maxRevisions: 3,
      runBudgetTokens: 0,
      waitMaxMs: 30_000,
      verifyTests: false,
      startedAt: now,
    },
  })!;
  cleanup.push(() => dash.stop());
  return { dash, store, activity, repo: repo.path };
}

const get = async (dash: Dashboard, path: string): Promise<Response> => fetch(dash.url + path);

/* eslint-disable @typescript-eslint/no-explicit-any */
/** The server owns these shapes; asserting on them does not need them re-declared. */
const getJson = async (dash: Dashboard, path: string): Promise<any> => (await get(dash, path)).json();

describe("the static UI", () => {
  test("the three files are served, with the right types and no caching", async () => {
    const { dash } = fixture();
    for (const [path, type] of [
      ["/", "text/html"],
      ["/app.css", "text/css"],
      ["/app.js", "text/javascript"],
    ] as const) {
      const res = await get(dash, path);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain(type);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect((await res.text()).length).toBeGreaterThan(100);
    }
  });

  test("the page is the dashboard rather than whatever else is on disk", async () => {
    const { dash } = fixture();
    const html = await (await get(dash, "/")).text();
    expect(html).toContain("<title>Dispatched Code</title>");
    expect(html).toContain('id="graph"');
  });
});

describe("it refuses everything it has no business doing", () => {
  test("a write method is refused whatever the path", async () => {
    const { dash } = fixture();
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const res = await fetch(dash.url + "/api/state", { method });
      expect(res.status).toBe(405);
      expect(await res.text()).toContain("read-only");
    }
  });

  test("path traversal out of the UI directory is refused, encoded or not", async () => {
    const { dash } = fixture();
    for (const path of ["/../package.json", "/%2e%2e%2fpackage.json", "/../../etc/passwd", "/..%2F..%2Fpackage.json"]) {
      const res = await get(dash, path);
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain("dispatched-code");
    }
  });

  test("an unknown worker is a 404 rather than an empty page", async () => {
    const { dash } = fixture();
    expect((await get(dash, "/api/worker/w-999/detail")).status).toBe(404);
    expect((await get(dash, "/api/worker/w-001/nonsense")).status).toBe(404);
  });
});

describe("/api/state", () => {
  test("carries the whole run: server settings, workers, totals", async () => {
    const { dash } = fixture([
      record(),
      record({ workerID: "w-002", state: "completed", totalTokens: 900, endedAt: now + 1000 }),
      record({ workerID: "w-003", state: "blocked", questions: ["may I?"] }),
      record({ workerID: "w-004", state: "failed" }),
    ]);
    const body = await getJson(dash, "/api/state");

    expect(body.workers).toHaveLength(4);
    expect(body.totals.running).toBe(1);
    expect(body.totals.blocked).toBe(1);
    expect(body.totals.failed).toBe(1);
    // `settled` counts everything that will do nothing more of its own accord,
    // which includes the failures — they are done, not pending.
    expect(body.totals.settled).toBe(2);
    expect(body.totals.tokens).toBe(1_234 * 3 + 900);
    expect(body.server.maxConcurrent).toBe(3);
    expect(body.server.repoRoot).toBeTruthy();
  });

  test("a worker view says whether it is orphaned and whether its model takes the schema", async () => {
    const { dash } = fixture([record({ state: "blocked", questions: ["may I?"] })], ["w-001"]);
    const body = await getJson(dash, "/api/state");
    const w = body.workers[0];
    expect(w.orphaned).toBe(true);
    // The whole point of surfacing this: a result with no report is explained
    // rather than mysterious.
    expect(w.structuredOutput).toBe(false);
    expect(w.questions).toEqual(["may I?"]);
    expect(w.workspace).toBe("shared");
  });

  test("model capabilities travel with the server view", async () => {
    const { dash, store } = fixture();
    store.putModelCapability("opencode/muse", { structuredOutput: false, at: now, code: "api", message: "tool_choice" });
    const body = await getJson(dash, "/api/state");
    expect(body.server.modelCapabilities["opencode/muse"].structuredOutput).toBe(false);
  });
});

describe("/api/worker/:id/detail", () => {
  test("brings the brief, the spec, the trail and the transcript in one call", async () => {
    const { dash, store, activity } = fixture();
    store.appendEvent("w-001", "state:running", { from: "preparing" });
    store.appendEvent("w-001", "scratch_ready", { path: "/x/.dispatched-code/scratch/w-001" });
    activity.append("w-001", { kind: "text", at: now, text: "reading houses.js" });

    const body = await getJson(dash, "/api/worker/w-001/detail");
    expect(body.worker.id).toBe("w-001");
    expect(body.brief.system).toContain("worker w-001");
    expect(body.spec.ownedPaths).toEqual(["houses.js"]);
    expect(body.events.map((e: { kind: string }) => e.kind)).toEqual(["state:running", "scratch_ready"]);
    expect(body.activity).toHaveLength(1);
    expect(body.activity[0].text).toBe("reading houses.js");
  });

  test("a worker from a previous process has no live brief, and says so with null", async () => {
    const { dash } = fixture([record({ workerID: "w-002" })]);
    const body = await getJson(dash, "/api/worker/w-002/detail");
    expect(body.brief).toBeNull();
    expect(body.spec).toBeTruthy();
  });

  test("afterSeq pages the transcript", async () => {
    const { dash, activity } = fixture();
    activity.append("w-001", { kind: "tool", at: now, tool: "read" });
    activity.append("w-001", { kind: "tool", at: now, tool: "edit" });
    const body = await getJson(dash, "/api/worker/w-001/activity?afterSeq=1");
    expect(body.activity.map((e: { tool: string }) => e.tool)).toEqual(["edit"]);
  });
});

describe("/api/stream", () => {
  /** Read the stream in the background; racing `read()` against a timer loses chunks. */
  function drain(res: Response): { text: () => string; stop: () => void } {
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = "";
    let stopped = false;
    void (async () => {
      try {
        while (!stopped) {
          const chunk = await reader.read();
          if (chunk.done) break;
          buf += dec.decode(chunk.value, { stream: true });
        }
      } catch {
        /* cancelled */
      }
    })();
    return {
      text: () => buf,
      stop: () => {
        stopped = true;
        void reader.cancel();
      },
    };
  }

  const settle = (ms = 250): Promise<void> => new Promise((r) => setTimeout(r, ms));

  test("opens with a full snapshot, so a client never has to reconcile two sources", async () => {
    const { dash } = fixture();
    const res = await get(dash, "/api/stream");
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const stream = drain(res);
    cleanup.push(stream.stop);
    await settle();
    expect(stream.text()).toContain("event: snapshot");
    expect(stream.text()).toContain("w-001");
  });

  test("pushes activity, worker changes and trail entries as they happen", async () => {
    const { dash, store, activity } = fixture();
    const stream = drain(await get(dash, "/api/stream"));
    cleanup.push(stream.stop);
    await settle();

    activity.append("w-001", { kind: "text", at: Date.now(), text: "Reading " });
    activity.append("w-001", { kind: "text", at: Date.now(), text: "houses.js" });
    dash.publishWorker("w-001");
    dash.publishEvent({ id: 1, workerID: "w-001", at: Date.now(), kind: "state:completed", detail: {} });
    await settle();

    const frames = [...stream.text().matchAll(/^event: (\w+)$/gm)].map((m) => m[1]);
    expect(frames[0]).toBe("snapshot");
    expect(frames).toContain("activity");
    expect(frames).toContain("worker");
    expect(frames).toContain("event");
    // The deltas arrive merged, which is what makes the feed readable.
    expect(stream.text()).toContain("Reading houses.js");
  });

  test("a client that goes away is dropped rather than accumulated", async () => {
    const { dash } = fixture();
    // An AbortController rather than `reader.cancel()`: measured on Bun 1.3.11,
    // cancelling the reader leaves the TCP connection open and the server
    // rightly still considers the client present. Aborting the request closes
    // it, which is what a closed browser tab does.
    const ac = new AbortController();
    const res = await fetch(dash.url + "/api/stream", { signal: ac.signal });
    const stream = drain(res);
    await settle();
    expect(dash.clients()).toBe(1);
    stream.stop();
    ac.abort();
    await settle(400);
    expect(dash.clients()).toBe(0);
  });

  test("publishing about a worker that does not exist is a no-op, not a crash", async () => {
    const { dash } = fixture();
    expect(() => dash.publishWorker("w-nope")).not.toThrow();
  });
});

describe("failing to start is not failing to orchestrate", () => {
  test("a port already taken returns undefined and logs, rather than throwing", async () => {
    const first = fixture();
    const lines: string[] = [];
    const repo = makeGoldenRepo("dash-collide");
    cleanup.push(() => void repo.cleanup());
    const store = new Store(":memory:");
    cleanup.push(() => store.close());

    const second = startDashboard({
      manager: {
        list: () => [],
        queueHint: () => undefined,
        isOrphaned: () => false,
        supportsStructuredOutput: () => true,
        isShared: () => true,
        briefOf: () => undefined,
      },
      store,
      activity: new ActivityLog(),
      repoRoot: repo.path,
      port: first.dash.port,
      log: (l) => lines.push(l),
      server: {
        name: "dispatched-code",
        version: "test",
        repoRoot: repo.path,
        defaultModel: "opencode/muse",
        workspace: "shared",
        maxConcurrent: 3,
        maxRevisions: 3,
        runBudgetTokens: 0,
        waitMaxMs: 30_000,
        verifyTests: false,
        startedAt: now,
      },
    });

    expect(second).toBeUndefined();
    expect(lines.join(" ")).toContain("running normally");
  });
});
