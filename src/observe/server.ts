/**
 * The local dashboard (§11 Phase 9; §15's "web dashboard for run telemetry",
 * which every phase since v1 has deferred).
 *
 * The problem it solves is not telemetry. It is that **the orchestrator's whole
 * design is a context firewall, and a firewall has two sides.** Everything in
 * `src/mcp/` exists to keep worker transcripts out of Claude's context, and it
 * works — a spawn→poll→result round trip costs under 2k tokens where the raw
 * stream would cost fifty times that. The cost is that the human, who has no
 * context window and no token budget, ends up seeing *less than Claude does*,
 * through a terminal, second-hand, after the fact.
 *
 * This is the other side of that firewall. Same data, opposite constraint: as
 * much as there is, live, on a socket nobody is billed for.
 *
 * Three decisions worth stating, because each was the alternative to something
 * more obvious:
 *
 * 1. **Loopback only, and read-only.** It binds 127.0.0.1 and serves `GET`. No
 *    endpoint stops a worker, answers one, or spawns one — control stays on the
 *    MCP surface, where it is Claude's and is audited. A localhost page that can
 *    mutate an orchestration is a CSRF target that any tab in the same browser
 *    can reach, and "it is only on my machine" is exactly the assumption that
 *    makes those work.
 * 2. **No build step and no CDN.** The UI is three files served from disk. A
 *    dashboard that needs `npm run build` before it shows anything is a
 *    dashboard nobody runs, and one that fetches a framework from a CDN does not
 *    work on the aeroplane where you most want to know what your workers are
 *    doing.
 * 3. **A failure here is never a failure of the orchestration.** The port is
 *    busy, the UI files are missing, the browser disconnected mid-stream: every
 *    one of those is logged to stderr and stepped over. An MCP server that will
 *    not start because a dashboard could not bind a socket has its priorities
 *    exactly backwards.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, normalize, resolve, sep } from "node:path";

import type { StoredEvent, Store } from "../store/index.js";
import { DIFF_LINES_DEFAULT, readDiff } from "../workspace/index.js";
import { ActivityLog } from "./activity.js";
import { type DashboardSnapshot, type ServerView, type SnapshotManager, buildSnapshot, buildWorkerView } from "./snapshot.js";

export const DEFAULT_DASHBOARD_PORT = 4180;
/** Loopback, always. Not configurable, and that is the point — see the header. */
export const DASHBOARD_HOST = "127.0.0.1";

/** How often a live connection is nudged, so a proxy or a sleeping tab notices a dead socket. */
const SSE_KEEPALIVE_MS = 15_000;

export interface DashboardOptions {
  readonly manager: SnapshotManager;
  readonly store: Store;
  readonly activity: ActivityLog;
  readonly server: Omit<ServerView, "modelCapabilities">;
  readonly repoRoot: string;
  /** 0 asks the OS for any free port, which is what the tests want. */
  readonly port?: number;
  readonly log?: (line: string) => void;
  readonly uiDir?: string;
}

export interface Dashboard {
  readonly url: string;
  readonly port: number;
  /** Push a worker record change to every live connection. */
  readonly publishWorker: (workerID: string) => void;
  /** Push one audit-trail entry to every live connection. */
  readonly publishEvent: (event: StoredEvent) => void;
  readonly snapshot: () => DashboardSnapshot;
  readonly clients: () => number;
  readonly stop: () => void;
}

type Frame = { type: string; data: unknown };

/**
 * Where the three UI files live, resolved from this module rather than from
 * `process.cwd()`.
 *
 * The MCP server is launched by a host from whatever directory it happens to be
 * in, so a relative path here would work in development and nowhere else.
 */
function defaultUiDir(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "ui");
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
};

/**
 * Start the dashboard.
 *
 * Returns `undefined` rather than throwing when the socket cannot be had: the
 * caller is an MCP server whose job is orchestration, and a port collision is
 * not a reason to refuse to orchestrate.
 */
export function startDashboard(opts: DashboardOptions): Dashboard | undefined {
  const log = opts.log ?? ((line: string) => console.error(`[dashboard] ${line}`));
  const uiDir = opts.uiDir ?? defaultUiDir();
  const sources = { manager: opts.manager, store: opts.store, activity: opts.activity, server: opts.server };

  const clients = new Set<(frame: Frame) => void>();
  const broadcast = (frame: Frame): void => {
    for (const send of [...clients]) {
      try {
        send(frame);
      } catch {
        /* a dead connection is dropped by its own writer, not by this loop */
      }
    }
  };

  const unsubscribeActivity = opts.activity.subscribe((entry) => broadcast({ type: "activity", data: entry }));

  let server: { port: number | undefined; stop: (force?: boolean) => void };
  try {
    server = Bun.serve({
      hostname: DASHBOARD_HOST,
      port: opts.port ?? DEFAULT_DASHBOARD_PORT,
      // A worker can hold a stream open for the whole run; Bun's default request
      // timeout would cut it. 0 means "do not".
      idleTimeout: 0,
      fetch: (req) => handle(req),
    });
  } catch (e) {
    unsubscribeActivity();
    log(`could not start on ${DASHBOARD_HOST}:${opts.port ?? DEFAULT_DASHBOARD_PORT} — ${String(e)}`);
    log("the orchestrator is running normally; only the dashboard is unavailable");
    return undefined;
  }

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url);
    const path = url.pathname;

    // Read-only by construction (see the header). Anything else is refused here
    // rather than route by route, so a future route cannot forget.
    if (req.method !== "GET" && req.method !== "HEAD") {
      return json({ error: "the dashboard is read-only; control is on the MCP tool surface" }, 405);
    }

    if (path === "/api/state") return json(buildSnapshot(sources));

    if (path === "/api/stream") return stream(req);

    if (path.startsWith("/api/worker/")) {
      const rest = path.slice("/api/worker/".length);
      const [rawID = "", section = ""] = rest.split("/");
      const id = decodeURIComponent(rawID);
      const record = opts.manager.list().find((w) => w.workerID === id);
      if (!record) return json({ error: `no worker ${id}` }, 404);

      if (section === "" || section === "detail") {
        return json({
          worker: buildWorkerView(sources, record),
          brief: opts.manager.briefOf(id) ?? null,
          spec: record.spec,
          events: opts.store.listEvents(id, { limit: 500 }),
          activity: opts.activity.entries(id, Number(url.searchParams.get("afterSeq") ?? 0)),
        });
      }
      if (section === "activity") {
        return json({ activity: opts.activity.entries(id, Number(url.searchParams.get("afterSeq") ?? 0)) });
      }
      if (section === "events") {
        const after = Number(url.searchParams.get("afterID") ?? 0);
        return json({ events: opts.store.listEvents(id, { limit: 500, afterID: after }) });
      }
      if (section === "diff") {
        // A shared worker has no worktree of its own; its diff is the user's
        // working tree, which is exactly what the repo root reads.
        const root = record.worktree !== "" && existsSync(record.worktree) ? record.worktree : opts.repoRoot;
        try {
          const page = await readDiff(root, {
            baseSha: record.baseSha,
            maxLines: DIFF_LINES_DEFAULT,
            ...(record.spec.ownedPaths && record.spec.ownedPaths.length > 0
              ? { paths: [...record.spec.ownedPaths] }
              : {}),
          });
          return json({ diff: page });
        } catch (e) {
          return json({ error: String(e) }, 500);
        }
      }
      return json({ error: `no such section ${JSON.stringify(section)}` }, 404);
    }

    return serveStatic(path);
  }

  function stream(req: Request): Response {
    // The snapshot goes out first, on the same connection, so a client never has
    // to fetch state and subscribe separately and reconcile the gap between them.
    const encoder = new TextEncoder();
    let keepalive: ReturnType<typeof setInterval> | undefined;
    let unregister: (() => void) | undefined;

    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        const write = (frame: Frame): void => {
          controller.enqueue(encoder.encode(`event: ${frame.type}\ndata: ${JSON.stringify(frame.data)}\n\n`));
        };
        const safeWrite = (frame: Frame): void => {
          try {
            write(frame);
          } catch {
            unregister?.();
          }
        };
        safeWrite({ type: "snapshot", data: buildSnapshot(sources) });
        clients.add(safeWrite);
        unregister = () => {
          clients.delete(safeWrite);
          if (keepalive) clearInterval(keepalive);
          keepalive = undefined;
        };
        keepalive = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(": keepalive\n\n"));
          } catch {
            unregister?.();
          }
        }, SSE_KEEPALIVE_MS);
        keepalive.unref?.();
        req.signal.addEventListener("abort", () => unregister?.());
      },
      cancel() {
        unregister?.();
      },
    });

    return new Response(body, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache, no-transform",
        connection: "keep-alive",
        // Nothing on this page should ever be cached, embedded or framed.
        "x-content-type-options": "nosniff",
      },
    });
  }

  async function serveStatic(path: string): Promise<Response> {
    const rel = path === "/" ? "index.html" : path.replace(/^\/+/, "");
    // Traversal guard. The UI directory is the whole of what this server may
    // read, and a dashboard that will serve `../../.ssh/id_rsa` because someone
    // asked politely is worse than no dashboard.
    const target = normalize(join(uiDir, rel));
    if (target !== uiDir && !target.startsWith(uiDir + sep)) return new Response("not found", { status: 404 });
    const file = Bun.file(target);
    if (!(await file.exists())) return new Response("not found", { status: 404 });
    const ext = target.slice(target.lastIndexOf("."));
    return new Response(file, {
      headers: {
        "content-type": CONTENT_TYPES[ext] ?? "application/octet-stream",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  }

  const port = server.port ?? opts.port ?? DEFAULT_DASHBOARD_PORT;
  const url = `http://${DASHBOARD_HOST}:${port}`;
  log(`watching this run at ${url}`);

  return {
    url,
    port,
    snapshot: () => buildSnapshot(sources),
    clients: () => clients.size,
    publishWorker: (workerID) => {
      const record = opts.manager.list().find((w) => w.workerID === workerID);
      if (!record) return;
      broadcast({ type: "worker", data: buildWorkerView(sources, record) });
    },
    publishEvent: (event) => broadcast({ type: "event", data: event }),
    stop: () => {
      unsubscribeActivity();
      clients.clear();
      try {
        server.stop(true);
      } catch {
        /* already stopped */
      }
    },
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}
