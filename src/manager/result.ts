/**
 * The worker result (`projectplan.md` §4.3) — Claude's entire view of a worker.
 *
 * §1 calls this system a context firewall, and this file is the wall. Everything
 * a worker produced — the transcript, the tool calls, the file contents, the
 * model's own narration — stops here, and what passes through is a fixed-shape
 * summary with a hard budget: **under ~1,500 tokens per worker interaction**.
 *
 * So the rendering truncates aggressively and says so when it does. A result
 * that quietly drops the eleventh changed file teaches Claude to trust a list
 * that is not complete; one that prints `…and 6 more` does not.
 */

import type { WorkerResult } from "./types.js";

/** Roughly 200 words, per §4.3's cap on the summary line. */
const SUMMARY_WORDS = 200;
const MAX_LISTED_FILES = 12;
const MAX_LISTED_ITEMS = 6;

export interface RenderOptions {
  readonly maxFiles?: number;
  readonly maxItems?: number;
}

/**
 * Render a result as the §4.3 block.
 *
 * Plain text, not JSON: this is read by a model in a tool result, and the
 * shape in §4.3 was chosen to be skimmable. Discrepancies come *before* risks
 * because a discrepancy is the orchestrator's own finding and a risk is the
 * worker's opinion of itself.
 */
export function renderResult(r: WorkerResult, opts: RenderOptions = {}): string {
  const maxFiles = opts.maxFiles ?? MAX_LISTED_FILES;
  const maxItems = opts.maxItems ?? MAX_LISTED_ITEMS;
  const lines: string[] = [];

  const spend = r.usage.cost > 0 ? `~$${r.usage.cost.toFixed(2)}` : `~${r.usage.totalTokens.toLocaleString("en-US")} tok`;
  lines.push(
    `Worker: ${r.workerID} · model: ${r.model} · mode: ${r.mode} · status: ${r.state}` +
      `${r.reason ? ` (${r.reason})` : ""} · ${duration(r.durationMs)} · ${spend}`,
  );
  lines.push(`Task: ${r.task}`);
  lines.push("");

  if (r.summary) lines.push(`Summary: ${clampWords(r.summary, SUMMARY_WORDS)}`);
  else if (r.reportSource === "not_started") {
    // "The worker produced no usable report" would be true and misleading: it
    // was never asked for one. Everything below this line is zero because
    // nothing happened, not because a worker ran and achieved nothing.
    lines.push("Summary: (this worker never started — nothing was allocated and nothing was lost)");
  } else lines.push("Summary: (the worker produced no usable report)");

  const c = r.changes;
  const sign = `+${c.additions}/−${c.deletions}`;
  lines.push(
    c.files === 0
      ? "Changes: none — the worktree is unmodified"
      : `Changes (${c.files} file${c.files === 1 ? "" : "s"}, ${sign}): ${listOf(c.paths, maxFiles)}`,
  );

  if (r.tests) {
    const parts: string[] = [];
    if (r.tests.passed !== undefined) parts.push(`${r.tests.passed} passed`);
    if (r.tests.failed !== undefined) parts.push(`${r.tests.failed} failed`);
    if (r.tests.skipped !== undefined) parts.push(`${r.tests.skipped} skipped`);
    lines.push(`Tests: ${parts.length > 0 ? parts.join(" / ") : "claimed, no counts given"}`);
  }

  lines.push(
    r.discrepancies.length === 0
      ? "Discrepancies: none"
      : `Discrepancies (${r.discrepancies.length}): ${listOf(
          r.discrepancies.map((d) => `${d.kind}${d.file ? ` ${d.file}` : ""} — ${d.detail}`),
          maxItems,
        )}`,
  );

  if (r.error) lines.push(`Error: ${r.error.code} — ${clampWords(r.error.message, 40)}`);
  if (r.questions.length > 0) lines.push(`Questions: ${listOf(r.questions, maxItems)}`);
  if (r.risks.length > 0) lines.push(`Risks: ${listOf(r.risks, maxItems)}`);
  if (r.followUps.length > 0) lines.push(`Follow-ups: ${listOf(r.followUps, maxItems)}`);
  if (r.snapshot?.committed && r.snapshot.sha) lines.push(`Snapshot: ${r.snapshot.sha.slice(0, 10)} on the worker's branch`);
  if (r.reportSource === "none") lines.push("Report: the worker never produced one — every claim above is the orchestrator's own measurement");
  else if (r.reportSource === "report_file") lines.push("Report: recovered from the worktree, not from the reply");
  else if (r.reportSource === "not_started") {
    lines.push("Report: none, because no prompt was ever sent. Respawning this task costs nothing that was already spent.");
  }

  return lines.join("\n");
}

function duration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

function listOf(items: readonly string[], max: number): string {
  if (items.length === 0) return "none";
  const shown = items.slice(0, max).join(", ");
  return items.length > max ? `${shown}, …and ${items.length - max} more` : shown;
}

function clampWords(text: string, max: number): string {
  const words = text.trim().split(/\s+/);
  return words.length <= max ? text.trim() : `${words.slice(0, max).join(" ")}…`;
}
