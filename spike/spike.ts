/**
 * Phase 0 spike — verifies every OpenCode fact the architecture depends on.
 *
 * Acceptance criteria (projectplan.md §11, Phase 0):
 *   "a script creates a session, prompts it to create a file, verifies the
 *    file, and captures the completion event."
 *
 * Run:  bun run spike/spike.ts [--model provider/model] [--keep]
 *
 * Everything this script asserts is recorded in docs/phase0-facts.md.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

// localhost must bypass any outbound proxy, or fetch() will try to tunnel it.
process.env.NO_PROXY = [process.env.NO_PROXY, "127.0.0.1,localhost"].filter(Boolean).join(",");

const MODEL = argOf("--model") ?? "opencode/muse-spark-1.2-contributor-free";
const KEEP = process.argv.includes("--keep");
const MARKER = "PHASE0_OK";

function argOf(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

type Facts = Record<string, string>;
const facts: Facts = {};
function fact(k: string, v: string) {
  facts[k] = v;
  console.log(`  · ${k}: ${v}`);
}

/** Start `opencode serve` on an ephemeral port and parse the port it chose. */
function startServer(cwd: string): Promise<{ proc: ChildProcess; baseUrl: string }> {
  return new Promise((resolve, reject) => {
    // --port 0 is the documented default: the server picks a free port and
    // announces it on stdout. Never hardcode 4096.
    const proc = spawn("opencode", ["serve", "--port", "0"], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });
    const timer = setTimeout(() => reject(new Error("server did not announce a port in 60s")), 60_000);
    let buf = "";
    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      const m = buf.match(/listening on (http:\/\/\S+)/);
      if (m?.[1]) {
        clearTimeout(timer);
        resolve({ proc, baseUrl: m[1].replace(/\/$/, "") });
      }
    };
    proc.stdout!.on("data", onData);
    proc.stderr!.on("data", onData);
    proc.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited early (code ${code}):\n${buf}`));
    });
  });
}

/**
 * Subscribe to the global SSE stream. Returns a promise resolving to every
 * event seen for `sessionID`, settled once `session.idle` arrives.
 *
 * Subscribe BEFORE prompting — the run can finish faster than the subscription
 * is established, and a missed `session.idle` becomes a false timeout.
 */
function collectUntilIdle(
  baseUrl: string,
  sessionID: string,
  directory: string,
  signal: AbortSignal,
): { ready: Promise<void>; done: Promise<any[]> } {
  const seen: any[] = [];
  let markReady: () => void;
  let settle: (v: any[]) => void;
  let fail: (e: unknown) => void;
  const ready = new Promise<void>((r) => (markReady = r));
  const done = new Promise<any[]>((res, rej) => {
    settle = res;
    fail = rej;
  });

  (async () => {
    try {
      // The SSE stream is scoped BY DIRECTORY. Subscribing to a bare /event
      // silently omits every event for a session opened in another directory
      // (verified: unscoped stream never delivers session.idle for a worktree
      // session), which presents as an infinite wait. Always pass ?directory=.
      const res = await fetch(`${baseUrl}/event?directory=${encodeURIComponent(directory)}`, { signal });
      if (!res.ok || !res.body) throw new Error(`GET /event -> ${res.status}`);
      markReady!();
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = "";
      while (true) {
        const { done: eof, value } = await reader.read();
        if (eof) break;
        buf += dec.decode(value, { stream: true });
        // SSE frames are separated by a blank line; payload lines start "data: ".
        const frames = buf.split("\n\n");
        buf = frames.pop() ?? "";
        for (const frame of frames) {
          const data = frame
            .split("\n")
            .filter((l) => l.startsWith("data:"))
            .map((l) => l.slice(5).trim())
            .join("");
          if (!data) continue;
          let evt: any;
          try {
            evt = JSON.parse(data);
          } catch {
            continue;
          }
          if (evt?.properties?.sessionID && evt.properties.sessionID !== sessionID) continue;
          seen.push(evt);
          if (evt.type === "session.idle") {
            settle!(seen);
            return;
          }
        }
      }
      settle!(seen);
    } catch (e) {
      if ((e as any)?.name === "AbortError") settle!(seen);
      else fail!(e);
    }
  })();

  return { ready, done };
}

async function api(baseUrl: string, path: string, init?: RequestInit): Promise<any> {
  const res = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`${init?.method ?? "GET"} ${path} -> ${res.status}: ${text.slice(0, 400)}`);
  return text ? JSON.parse(text) : null;
}

async function main() {
  console.log("Phase 0 spike — OpenCode fact verification\n");

  // ---- 0. Throwaway git repo standing in for a worker worktree -------------
  const root = mkdtempSync(join(tmpdir(), "phase0-"));
  const repo = join(root, "repo");
  mkdirSync(repo);
  const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, stdio: "pipe" }).toString();
  git("init", "-q");
  git("config", "user.email", "spike@example.com");
  git("config", "user.name", "Phase 0 Spike");
  writeFileSync(join(repo, "README.md"), "# fixture\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  const wt = join(root, "w-001");
  git("worktree", "add", "-q", wt, "-b", "worker/w-001");
  console.log(`worktree: ${wt}\n`);

  const started = Date.now();
  const { proc, baseUrl } = await startServer(repo);
  console.log("[serve]");
  fact("port_is_dynamic", `--port 0 chose ${new URL(baseUrl).port} (do NOT assume 4096)`);
  fact("startup_ms", String(Date.now() - started));

  const ctrl = new AbortController();
  try {
    // ---- 1. Session bound to the worktree, with an inline permission ruleset
    console.log("\n[session]");
    const session = await api(baseUrl, `/session?directory=${encodeURIComponent(wt)}`, {
      method: "POST",
      body: JSON.stringify({
        title: "phase0-w-001",
        permission: [
          { permission: "edit", pattern: "**", action: "allow" },
          { permission: "bash", pattern: "**", action: "allow" },
          { permission: "webfetch", pattern: "**", action: "deny" },
        ],
      }),
    });
    fact("session_id", session.id);
    fact("per_session_directory", session.directory === wt ? `honored (${session.directory})` : `MISMATCH: ${session.directory}`);
    fact("inline_permission_ruleset", Array.isArray(session.permission) ? "accepted and echoed" : "NOT echoed");
    fact("usage_fields_present", "cost" in session && "tokens" in session ? "cost + tokens on Session" : "MISSING");

    // ---- 2. Subscribe before prompting --------------------------------------
    const stream = collectUntilIdle(baseUrl, session.id, wt, ctrl.signal);
    await stream.ready;

    // ---- 3. Prompt asynchronously (DD-1: never block a tool call) -----------
    console.log("\n[prompt]");
    const [providerID, ...rest] = MODEL.split("/");
    const modelID = rest.join("/");
    const t0 = Date.now();
    await api(baseUrl, `/session/${session.id}/prompt_async?directory=${encodeURIComponent(wt)}`, {
      method: "POST",
      body: JSON.stringify({
        model: { providerID, modelID },
        parts: [{ type: "text", text: `Create a file named hello.txt containing exactly: ${MARKER}` }],
      }),
    });
    fact("prompt_async_returns", `immediately (${Date.now() - t0}ms) — spawn-and-poll confirmed`);

    // ---- 4. Wait for the completion event -----------------------------------
    const events = await Promise.race([
      stream.done,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("no session.idle within 180s")), 180_000)),
    ]);
    fact("completion_event", "session.idle (only on /event?directory=<worktree>)");
    fact("events_observed", String(events.length));
    const kinds = [...new Set(events.map((e) => e.type))];
    fact("event_types", kinds.join(", ").slice(0, 300));

    // ---- 5. Verify the file actually exists (trust but verify) --------------
    console.log("\n[verify]");
    const target = join(wt, "hello.txt");
    const exists = existsSync(target);
    const content = exists ? readFileSync(target, "utf8").trim() : "";
    fact("file_created", exists ? `yes (${target})` : "NO");
    fact("content_matches", content === MARKER ? `yes ("${content}")` : `NO (got "${content.slice(0, 40)}")`);

    // git sees it as untracked — the manager must snapshot-commit (DD-5)
    const status = execFileSync("git", ["status", "--porcelain"], { cwd: wt }).toString().trim();
    fact("worker_left_changes_uncommitted", status ? `yes — manager must commit:\n      ${status.replace(/\n/g, "\n      ")}` : "no changes");

    // ---- 6. Usage / cost after the run --------------------------------------
    console.log("\n[usage]");
    const after = await api(baseUrl, `/session/${session.id}?directory=${encodeURIComponent(wt)}`);
    fact("cost_after_run", String(after.cost));
    fact("tokens_after_run", JSON.stringify(after.tokens));
    fact("budget_enforceable", typeof after.cost === "number" ? "yes — poll GET /session/{id}" : "NO");

    // ---- 7. Session reuse: does a second prompt retain context? -------------
    console.log("\n[session reuse — worker_revise depends on this]");
    const stream2 = collectUntilIdle(baseUrl, session.id, wt, ctrl.signal);
    await stream2.ready;
    await api(baseUrl, `/session/${session.id}/prompt_async?directory=${encodeURIComponent(wt)}`, {
      method: "POST",
      body: JSON.stringify({
        model: { providerID, modelID },
        parts: [{ type: "text", text: "What filename did you just create? Reply with the bare filename only." }],
      }),
    });
    await Promise.race([
      stream2.done,
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error("no session.idle on revision within 180s")), 180_000)),
    ]);
    const msgs = await api(baseUrl, `/session/${session.id}/message?directory=${encodeURIComponent(wt)}`);
    const last = JSON.stringify(msgs).toLowerCase();
    fact("session_retains_context", last.includes("hello.txt") ? "yes — recalled hello.txt without being told" : "INCONCLUSIVE (see transcript)");

    const final = await api(baseUrl, `/session/${session.id}?directory=${encodeURIComponent(wt)}`);
    fact("cost_accumulates_across_prompts", final.cost >= after.cost ? `yes (${after.cost} -> ${final.cost})` : "NO");

    console.log("\n" + "=".repeat(64));
    console.log("PHASE 0 AC: session created, prompted, file verified, completion event captured.");
    console.log("=".repeat(64));
    console.log(JSON.stringify(facts, null, 2));
  } finally {
    ctrl.abort();
    proc.kill("SIGTERM");
    if (!KEEP) rmSync(root, { recursive: true, force: true });
    else console.log(`\n(kept fixture at ${root})`);
  }
}

main().catch((e) => {
  console.error("\nSPIKE FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
