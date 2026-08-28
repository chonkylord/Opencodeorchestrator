/**
 * What the tools actually put on the wire, and the caps that keep it small.
 *
 * §8 gives this layer three numbers — result summaries under ~1.5k tokens, event
 * pages of 50, and a per-worker-round target under 5k — and Phase 3's acceptance
 * criterion turns them into one: **Claude's context must grow by under 2k tokens
 * for a whole spawn→poll→result interaction.** That is roughly 8,000 characters
 * for every tool result in the round trip put together, which is not much, and
 * it is why nothing here is JSON.
 *
 * Plain text, deliberately. A status line as JSON spends a third of its
 * characters on braces, quotes and key names that a model reading a tool result
 * does not need. `renderResult` in the manager made the same choice for §4.3 and
 * this module keeps the two consistent rather than inventing a second style.
 *
 * The other rule here is DD-8. Worker output — summaries, questions, risks,
 * follow-ups — is text a model wrote after reading a repository that may contain
 * anything. Every one of those fields is capped by *this* module rather than
 * trusted to be reasonable, and where one is rendered it is marked as the
 * worker's own words so that Claude can tell a claim from a measurement.
 */

import type { StoredEvent } from "../store/index.js";
import type { WorkerRecord } from "../manager/index.js";

// ---------------------------------------------------------------------------
// Caps (§8). Every one of these bounds a field a worker can influence.
// ---------------------------------------------------------------------------

/** One event page. §8's number; `worker_output` may not be asked for more. */
export const EVENTS_PAGE_DEFAULT = 50;
export const EVENTS_PAGE_MAX = 200;
/** A single event's rendered detail. Enough to identify it, never enough to flood. */
export const EVENT_DETAIL_CHARS = 180;
/** A task line, echoed in every status row and every list row. */
export const TASK_CHARS = 160;
/** One escalated question. Worker-authored, so capped hard. */
export const QUESTION_CHARS = 400;
export const MAX_QUESTIONS = 6;
/** A `worker_list` page. Beyond this, filter by state or run. */
export const LIST_ROWS_MAX = 100;
/** Claude's own message to a blocked worker. Generous — it is not worker output. */
export const MESSAGE_CHARS_MAX = 8_000;

/**
 * Marks text the *worker* wrote, as opposed to the orchestrator's own findings.
 *
 * DD-8 in one character. A question arrives as a quoted line; a discrepancy
 * never does, because a discrepancy is what `git` said.
 */
const QUOTE = "» ";

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

function clampChars(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

function duration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/** Tokens unless a provider actually reported money; free tiers report `0`. */
function spend(totalTokens: number, cost: number): string {
  return cost > 0 ? `~$${cost.toFixed(2)}` : `~${totalTokens.toLocaleString("en-US")} tok`;
}

/** How long this worker has been alive, excluding nothing. */
function elapsedMs(r: WorkerRecord, now: number): number {
  const from = r.startedAt ?? r.createdAt;
  return (r.endedAt ?? now) - from;
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/**
 * One line per worker: §7's "state, elapsed, last-activity age, revision count,
 * ~cost", plus what the next call should be.
 *
 * The `next:` hint is not decoration. The whole surface is spawn-and-poll, and a
 * state whose follow-up is obvious to whoever wrote the state machine is not
 * obvious to a model three tool calls into a task it is also reasoning about.
 */
export function statusLine(r: WorkerRecord, now: number): string {
  const idle = duration(Math.max(0, now - r.updatedAt));
  const rev = r.resumes > 0 ? ` · revisions: ${r.resumes}` : "";
  return (
    `${r.workerID} [${r.state}${r.reason ? `: ${r.reason}` : ""}] ${duration(elapsedMs(r, now))} elapsed · ` +
    `${idle} since last activity${rev} · ${spend(r.totalTokens, r.cost)} · next: ${nextStep(r)}\n` +
    `  task: ${clampChars(r.task, TASK_CHARS)}`
  );
}

/** A compact `worker_list` row — no task echo, because the ids are the point. */
export function listRow(r: WorkerRecord, now: number): string {
  return (
    `${r.workerID}  ${r.state}${r.reason ? `(${r.reason})` : ""}  ${duration(elapsedMs(r, now))}  ` +
    `${spend(r.totalTokens, r.cost)}  ${r.mode}  run=${r.runID}\n` +
    `  ${clampChars(r.task, TASK_CHARS)}`
  );
}

/** What a caller should do next, given where the worker is. */
function nextStep(r: WorkerRecord): string {
  switch (r.state) {
    case "spawned":
    case "preparing":
    case "running":
      return "worker_wait, or worker_status again";
    case "blocked":
      return "worker_result to read the questions, then worker_message to answer";
    case "completed":
    case "merged":
      return "worker_result";
    case "interrupted":
      return "worker_result — the manager restarted; the worktree is intact";
    case "failed":
    case "timed_out":
    case "over_budget":
    case "cancelled":
      return "worker_result, then worker_output if you need the trail";
  }
}

/**
 * A blocked worker rendered from its *record*.
 *
 * There is no {@link WorkerResult} here and there is not going to be one: the
 * result is built when a worker settles, and `blocked` is a worker that stopped
 * to ask something, not one that finished. Dereferencing `.result` on this state
 * is the null-dereference this whole function exists to prevent — and the empty
 * summary it would print instead reads exactly like a worker that did nothing.
 */
export function renderBlocked(r: WorkerRecord, now: number): string {
  const questions = r.questions.slice(0, MAX_QUESTIONS).map((q) => `${QUOTE}${clampChars(q, QUESTION_CHARS)}`);
  const more = r.questions.length > MAX_QUESTIONS ? `\n  …and ${r.questions.length - MAX_QUESTIONS} more` : "";
  return [
    `Worker: ${r.workerID} · model: ${r.model} · mode: ${r.mode} · status: blocked` +
      `${r.reason ? ` (${r.reason})` : ""} · ${duration(elapsedMs(r, now))} · ${spend(r.totalTokens, r.cost)}`,
    `Task: ${clampChars(r.task, TASK_CHARS)}`,
    "",
    "The worker stopped to ask. It has no result yet — it is waiting, not finished,",
    "and it will be timed out if nothing answers it. Its questions, in its own words:",
    questions.length > 0 ? questions.join("\n") + more : `${QUOTE}(the worker blocked without saying why)`,
    "",
    `Answer with worker_message({id: "${r.workerID}", message: "…"}). The same session is`,
    "reused, so the worker keeps everything it has already read and worked out.",
  ].join("\n");
}

/**
 * A record that has neither settled nor blocked — still working.
 *
 * `worker_result` lands here when Claude asks too early, and the answer is a
 * status line rather than an error: "not yet" is information, and an error would
 * teach Claude to avoid a tool that was working correctly.
 */
export function renderPending(r: WorkerRecord, now: number): string {
  return [
    `Worker ${r.workerID} is ${r.state} — no result yet.`,
    statusLine(r, now),
    "",
    "A result exists only once a worker settles. Use worker_wait to block until it does.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Event pages
// ---------------------------------------------------------------------------

/**
 * The lifecycle trail, paginated (§8's "event log pages of 50").
 *
 * Lifecycle-grained, not stream-grained — the store never held the transcript,
 * which is the context firewall working as designed. This is a debugging tool
 * and its description says so: the trail says *what the manager did*, and it is
 * the wrong place to look for what the worker produced.
 */
export function renderEvents(workerID: string, events: readonly StoredEvent[], hasMore: boolean): string {
  if (events.length === 0) return `No events for ${workerID} after this cursor. The trail is complete.`;
  const base = events[0]!.at;
  const lines = events.map((e) => {
    const detail = renderDetail(e.detail);
    return `${String(e.id).padStart(4)} +${duration(e.at - base).padStart(6)} ${e.kind}${detail ? ` ${detail}` : ""}`;
  });
  const last = events[events.length - 1]!;
  const footer = hasMore
    ? `\n(${events.length} events; more remain — call again with cursor: ${last.id})`
    : `\n(${events.length} events; end of the trail)`;
  return `Events for ${workerID}, oldest first. Times are relative to the first event on this page.\n${lines.join("\n")}${footer}`;
}

/**
 * An event's detail, flattened and capped.
 *
 * Some of these carry worker-authored strings — an escalation's questions, an
 * error's message — so the cap is a boundary, not a nicety.
 */
function renderDetail(detail: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(detail)) {
    if (v === undefined || v === null || v === "") continue;
    const rendered = typeof v === "object" ? JSON.stringify(v) : String(v);
    parts.push(`${k}=${clampChars(rendered, 80)}`);
  }
  return parts.length === 0 ? "" : clampChars(parts.join(" "), EVENT_DETAIL_CHARS);
}

/**
 * A settled worker that has no result — `interrupted`, or a row read back from
 * the index after a restart.
 *
 * Same hazard as {@link renderBlocked}: the result is built at settle, so a
 * worker whose manager died before it settled never got one. Saying that is
 * strictly better than rendering an empty result, which would read as a worker
 * that ran and achieved nothing.
 */
export function renderNoResult(r: WorkerRecord, now: number): string {
  const why =
    r.state === "interrupted"
      ? "The manager restarted while this worker was mid-flight (§9). Its worktree is untouched:\n" +
        `  ${r.worktree || "(never created)"}\n` +
        "Nothing was lost but the run loop. Inspect the branch, or spawn a fresh worker for the same task."
      : "It settled without one — most likely the manager was restarted, or the index was\n" +
        "rebuilt from the worktree manifests after the database was lost (DD-7).";
  return [
    `Worker ${r.workerID} is ${r.state}${r.reason ? ` (${r.reason})` : ""} and has no stored result.`,
    why,
    "",
    statusLine(r, now),
    `Branch: ${r.branch}`,
  ].join("\n");
}
