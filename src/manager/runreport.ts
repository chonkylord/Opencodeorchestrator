/**
 * The run report (`projectplan.md` §8): "every run emits a markdown audit trail
 * — timeline, workers, models, costs, test results, merge outcomes,
 * discrepancies. This is also the demo artifact and debugging tool."
 *
 * It is a rendering over data the index already holds. Nothing is measured here
 * and nothing is inferred: every number comes from a `WorkerResult` the manager
 * built at settle, a `MergeRecord` the coordinator wrote, or the event trail.
 * That is deliberate — a report that computes its own version of what happened
 * is a second source of truth, and the first thing it will do is disagree with
 * the first one.
 *
 * **DD-8 is the layout.** A worker's summary, risks and follow-ups are text a
 * model wrote after reading a repository that may contain anything, and they sit
 * in their own quoted block, capped, marked as the worker's own words. The
 * orchestrator's measurements — the changed-file counts, the independent test
 * run, the discrepancies, the merge outcomes — are in the table and the
 * discrepancy section, unquoted, because those are findings. When the two
 * disagree, the layout should make it obvious which one is evidence.
 *
 * Scope: §11 lists run *reports* under Phase 7's hardening alongside the metrics
 * log and per-run cost accounting. This is the minimum Phase 5's demo needs —
 * one document per run, on demand — and none of Phase 7's.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { StoredEvent, Store } from "../store/index.js";
import type { MergeRecord, WorkerRecord } from "./types.js";
import { isFinal, isSettled } from "./state.js";

/** Where `run_report` writes, under the directory git already ignores. */
export const RUN_REPORT_DIR = join(".orchestrator", "runs");

/** Caps (§8). Every one of these bounds a field a worker can influence. */
const SUMMARY_CHARS = 400;
const ITEM_CHARS = 200;
const MAX_ITEMS = 4;
const MAX_FILES = 8;
const MAX_DISCREPANCIES = 20;
const MAX_TIMELINE = 60;
const EVENTS_PER_WORKER = 400;

/**
 * Lifecycle events worth a timeline row.
 *
 * An allowlist rather than a denylist: the trail gains entries every phase, and
 * a timeline that renders whatever is new is a timeline that grows without
 * anyone deciding it should.
 */
const TIMELINE_KINDS = new Set([
  "spawned",
  "queued",
  "admitted",
  "dependency_failed",
  "escalation",
  "answered",
  "abort_requested",
  "budget_exceeded",
  "server_gone",
  "tests_verified",
  "settled",
]);

export interface RunReport {
  readonly runID: string;
  readonly markdown: string;
  readonly workers: number;
  readonly merges: number;
  /** Where it was written, when it was. */
  readonly path?: string;
}

export interface RunReportOptions {
  readonly store: Store;
  readonly runID: string;
  readonly now?: number;
  /** Named in the header so a report says which cap produced this shape of run. */
  readonly maxConcurrent?: number;
  readonly maxTimeline?: number;
}

/**
 * Build one run's markdown.
 *
 * Total: a run with no workers, a worker with no result and a merge with no
 * outcome all render as themselves rather than as a crash, because the most
 * likely time to want this document is after something went wrong.
 */
export function buildRunReport(opts: RunReportOptions): RunReport {
  const { store, runID } = opts;
  const now = opts.now ?? Date.now();
  const maxTimeline = opts.maxTimeline ?? MAX_TIMELINE;

  const run = store.getRun(runID);
  const workers = store.listWorkers({ runID });
  const merges = store.listMerges({ runID });

  const out: string[] = [];
  out.push(`# Run report — ${runID}`);
  out.push("");
  out.push(...headerLines(run, workers, merges, now, opts.maxConcurrent));
  out.push("");
  out.push(...workerSection(workers));
  out.push("");
  out.push(...discrepancySection(workers));
  out.push("");
  out.push(...mergeSection(merges));
  out.push("");
  out.push(...timelineSection(store, workers, maxTimeline));
  out.push("");
  out.push(
    "---",
    "",
    "Every line beginning with `>` is the worker's own words — a claim by a model that read",
    "a repository which may contain anything. Everything else is the orchestrator's own",
    "measurement, taken from git and from re-running the tests itself. Where the two",
    "disagree, the Discrepancies section is the finding.",
  );

  return {
    runID,
    markdown: `${out.join("\n").replace(/\n{3,}/g, "\n\n")}\n`,
    workers: workers.length,
    merges: merges.length,
  };
}

/** Build it and put it on disk, where §8 says the audit trail lives. */
export function writeRunReport(repoRoot: string, opts: RunReportOptions): RunReport {
  const report = buildRunReport(opts);
  const path = join(repoRoot, RUN_REPORT_DIR, `${safeFileName(opts.runID)}.md`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, report.markdown);
  return { ...report, path };
}

// ---------------------------------------------------------------------------

function headerLines(
  run: { repoRoot: string; createdAt: number } | undefined,
  workers: readonly WorkerRecord[],
  merges: readonly MergeRecord[],
  now: number,
  maxConcurrent: number | undefined,
): string[] {
  const byState = new Map<string, number>();
  for (const w of workers) byState.set(w.state, (byState.get(w.state) ?? 0) + 1);
  const tokens = workers.reduce((n, w) => n + w.totalTokens, 0);
  const cost = workers.reduce((n, w) => n + w.cost, 0);
  const first = workers.reduce((t, w) => Math.min(t, w.createdAt), run?.createdAt ?? now);
  const last = workers.reduce((t, w) => Math.max(t, w.endedAt ?? w.updatedAt), first);
  const outstanding = workers.filter((w) => !isSettled(w.state)).length;

  return [
    `- **Repository:** ${run?.repoRoot ?? "(unknown — no run row)"}`,
    `- **Started:** ${iso(first)} · **last activity:** ${iso(last)} · **span:** ${duration(last - first)}`,
    `- **Workers:** ${workers.length}` +
      (workers.length === 0 ? "" : ` (${[...byState].map(([s, n]) => `${n} ${s}`).join(", ")})`) +
      (outstanding > 0 ? ` — **${outstanding} still working**` : ""),
    `- **Spend:** ${tokens.toLocaleString("en-US")} tokens` +
      (cost > 0 ? ` · $${cost.toFixed(2)}` : " · $0.00 reported (free-tier providers report no cost; budgets are on tokens)"),
    `- **Merges:** ${merges.length}`,
    ...(maxConcurrent === undefined ? [] : [`- **Concurrency cap:** ${maxConcurrent} workers past \`spawned\` at once`]),
    `- **Generated:** ${iso(now)}`,
  ];
}

function workerSection(workers: readonly WorkerRecord[]): string[] {
  if (workers.length === 0) return ["## Workers", "", "No workers were spawned for this run."];

  const rows = workers.map((w) => {
    const r = w.result;
    const changes = r ? (r.changes.files === 0 ? "—" : `${r.changes.files}f +${r.changes.additions}/−${r.changes.deletions}`) : "—";
    const tests = r?.tests
      ? [r.tests.passed !== undefined ? `${r.tests.passed}P` : "", r.tests.failed ? `${r.tests.failed}F` : ""]
          .filter(Boolean)
          .join("/") || "claimed"
      : "—";
    return (
      `| ${w.workerID} | ${w.mode} | ${cell(w.model)} | ${w.state}${w.reason ? `<br>${cell(w.reason)}` : ""} | ` +
      `${duration((w.endedAt ?? w.updatedAt) - (w.startedAt ?? w.createdAt))} | ${w.totalTokens.toLocaleString("en-US")} | ` +
      `${changes} | ${tests} | ${r ? r.discrepancies.length : "—"} |`
    );
  });

  const detail: string[] = [];
  for (const w of workers) {
    detail.push("", `### ${w.workerID} — ${cell(clamp(w.task, ITEM_CHARS))}`, "");
    detail.push(`- **Branch:** \`${w.branch}\`${w.result?.snapshot?.sha ? ` at \`${w.result.snapshot.sha.slice(0, 10)}\`` : ""}`);
    detail.push(`- **State:** ${w.state}${w.reason ? ` (${cell(w.reason)})` : ""}`);
    const r = w.result;
    if (!r) {
      detail.push(
        `- **Result:** none recorded — ${
          isFinal(w.state) || w.state === "interrupted"
            ? "the manager was restarted, or the index was rebuilt from the worktree manifests"
            : "it has not settled yet"
        }`,
      );
      continue;
    }
    if (r.reportSource === "not_started") {
      detail.push("- **Result:** it never started, so nothing was allocated and nothing was spent.");
      continue;
    }
    detail.push(
      `- **Changed files (measured by git):** ${
        r.changes.files === 0 ? "none — the worktree is unmodified" : listOf(r.changes.paths, MAX_FILES)
      }`,
    );
    if (r.tests) {
      const parts = [
        r.tests.command ? `\`${cell(r.tests.command)}\`` : "",
        r.tests.passed !== undefined ? `${r.tests.passed} passed` : "",
        r.tests.failed !== undefined ? `${r.tests.failed} failed` : "",
        r.tests.skipped !== undefined ? `${r.tests.skipped} skipped` : "",
      ].filter(Boolean);
      detail.push(`- **Tests:** ${parts.join(" · ")}`);
    }
    if (r.error) detail.push(`- **Error:** \`${r.error.code}\` — ${cell(clamp(r.error.message, ITEM_CHARS))}`);
    detail.push(`- **Discrepancies:** ${r.discrepancies.length === 0 ? "none" : String(r.discrepancies.length)}`);
    const said = quoted(r.summary, r.risks, r.questions, r.followUps);
    if (said.length > 0) detail.push("", "The worker's own words:", "", ...said);
  }

  return [
    "## Workers",
    "",
    "| id | mode | model | state | elapsed | tokens | changes | tests | discrepancies |",
    "|---|---|---|---|---|---|---|---|---|",
    ...rows,
    ...detail,
  ];
}

/** The worker's claims, quoted and capped, never mixed into the measurements. */
function quoted(
  summary: string,
  risks: readonly string[],
  questions: readonly string[],
  followUps: readonly string[],
): string[] {
  const lines: string[] = [];
  if (summary) lines.push(`> ${cell(clamp(summary, SUMMARY_CHARS))}`);
  for (const [label, items] of [
    ["Risks", risks],
    ["Questions", questions],
    ["Follow-ups", followUps],
  ] as const) {
    if (items.length === 0) continue;
    lines.push(`> **${label}:** ${listOf(items.map((i) => clamp(i, ITEM_CHARS)), MAX_ITEMS)}`);
  }
  return lines;
}

function discrepancySection(workers: readonly WorkerRecord[]): string[] {
  const all = workers.flatMap((w) => (w.result?.discrepancies ?? []).map((d) => ({ workerID: w.workerID, ...d })));
  if (all.length === 0) {
    return ["## Discrepancies", "", "None. Every worker's report agreed with what git actually shows."];
  }
  const shown = all.slice(0, MAX_DISCREPANCIES);
  return [
    "## Discrepancies",
    "",
    "The orchestrator's own findings: where a worker's report and the repository disagreed.",
    "",
    ...shown.map((d) => `- **${d.workerID}** · \`${d.kind}\`${d.file ? ` · \`${cell(d.file)}\`` : ""} — ${cell(clamp(d.detail, ITEM_CHARS))}`),
    ...(all.length > shown.length ? [`- …and ${all.length - shown.length} more`] : []),
  ];
}

function mergeSection(merges: readonly MergeRecord[]): string[] {
  if (merges.length === 0) return ["## Merges", "", "No merge was started for this run."];
  const lines: string[] = ["## Merges"];
  for (const m of merges) {
    lines.push("", `### ${m.mergeID} → \`${m.integrationBranch}\``, "");
    lines.push(`- **State:** ${m.state}${m.error ? ` — ${cell(clamp(m.error, ITEM_CHARS))}` : ""}`);
    lines.push(`- **Gate:** ${m.testCommand ? `\`${cell(m.testCommand)}\`, run after every single merge` : "**none ran**"}`);
    lines.push(`- **Workers offered:** ${m.workers.join(", ")}`);
    lines.push(`- **Base:** \`${m.baseSha.slice(0, 10) || "(unset)"}\` → **head:** \`${m.headSha.slice(0, 10) || "(unset)"}\``);
    const o = m.outcome;
    if (!o) {
      lines.push("- **Steps:** none recorded — the merge is still running, or the process was restarted mid-merge.");
      continue;
    }
    if (o.rolledBack) lines.push("- **Rolled back:** yes — the integration branch was reset to the sha before the failing step.");
    lines.push("", "| worker | outcome | sha after | tests |", "|---|---|---|---|");
    for (const s of o.steps) {
      const tests = s.tests ? `${s.tests.passed ? "green" : "RED"}${s.tests.reran ? " (re-run once)" : ""}` : "—";
      lines.push(`| ${s.workerID} | ${s.outcome}${s.detail ? `<br>${cell(clamp(s.detail, ITEM_CHARS))}` : ""} | \`${s.shaAfter.slice(0, 10)}\` | ${tests} |`);
    }
  }
  return lines;
}

function timelineSection(store: Store, workers: readonly WorkerRecord[], max: number): string[] {
  const events: Array<StoredEvent> = [];
  for (const w of workers) {
    for (const e of store.listEvents(w.workerID, { limit: EVENTS_PER_WORKER })) {
      if (TIMELINE_KINDS.has(e.kind) || e.kind.startsWith("state:")) events.push(e);
    }
  }
  if (events.length === 0) return ["## Timeline", "", "No lifecycle events were recorded."];
  events.sort((a, b) => a.at - b.at || a.id - b.id);
  const base = events[0]!.at;
  const shown = events.slice(0, max);
  return [
    "## Timeline",
    "",
    "Lifecycle-grained, oldest first. Times are relative to the first event. This is what the",
    "orchestrator did — it is not, and there is no tool that returns, a worker's transcript.",
    "",
    "```",
    ...shown.map((e) => `${`+${duration(e.at - base)}`.padStart(9)}  ${e.workerID.padEnd(7)} ${e.kind}${detailOf(e)}`),
    ...(events.length > shown.length ? [`… and ${events.length - shown.length} more events (worker_output pages them)`] : []),
    "```",
  ];
}

function detailOf(e: StoredEvent): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(e.detail)) {
    if (v === undefined || v === null || v === "" || k === "task") continue;
    parts.push(`${k}=${clamp(typeof v === "object" ? JSON.stringify(v) : String(v), 60)}`);
  }
  return parts.length === 0 ? "" : ` ${clamp(parts.join(" "), 160)}`;
}

// ---------------------------------------------------------------------------

function clamp(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

/** Keep worker-authored text from breaking out of a table cell or a code span. */
function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/`/g, "'").replace(/\r?\n/g, " ");
}

function listOf(items: readonly string[], max: number): string {
  if (items.length === 0) return "none";
  const shown = items.slice(0, max).map(cell).join(", ");
  return items.length > max ? `${shown}, …and ${items.length - max} more` : shown;
}

function duration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

function iso(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").replace(/\.\d+Z$/, "Z");
}

/** A runID is Claude's string, so it reaches the filesystem sanitized. */
function safeFileName(runID: string): string {
  const safe = runID.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^[.-]+/, "").slice(0, 100);
  return safe || "run";
}
