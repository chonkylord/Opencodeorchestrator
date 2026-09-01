/**
 * The worker report (`projectplan.md` §4.2) — schema, and a parser that expects
 * to be lied to.
 *
 * The schema is handed to the backend as a structured-output constraint, so the
 * provider validates and retries on violation before we ever see the reply. That
 * removes most of the failure modes; it does not remove all of them, because a
 * model that cannot satisfy a schema after its retries still returns *something*
 * and a worker that dies mid-sentence returns half of something. So the parser
 * is deliberately forgiving about shape and deliberately unforgiving about
 * content: it will dig a JSON object out of prose and coerce missing fields to
 * empty, but every repair it performs is recorded as an issue and travels with
 * the result. A silent repair is how a lying report becomes a trusted one.
 *
 * Nothing here executes, resolves, or dereferences anything the worker wrote
 * (DD-8). It is text until the reconciliation in `reconcile.ts` says otherwise.
 */

import type { WorkerReport } from "../manager/types.js";

/**
 * The JSON schema the worker's reply is constrained to.
 *
 * Kept minimal on purpose: every required field is one more thing a small model
 * can fail, and the fields that matter (`status`, `summary`, `changes`) are the
 * ones Dispatched Code actually reads.
 */
export const REPORT_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  required: ["status", "summary", "changes"],
  properties: {
    workerId: { type: "string" },
    status: { type: "string", enum: ["completed", "blocked", "failed"] },
    summary: { type: "string", description: "At most 10 sentences: what was done and why." },
    changes: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["file", "action"],
        properties: {
          file: { type: "string", description: "Path relative to the worktree root." },
          action: { type: "string", enum: ["added", "modified", "deleted"] },
          rationale: { type: "string" },
        },
      },
    },
    tests: {
      type: "object",
      additionalProperties: false,
      properties: {
        command: { type: "string" },
        passed: { type: "number" },
        failed: { type: "number" },
        skipped: { type: "number" },
      },
    },
    risks: { type: "array", items: { type: "string" } },
    questions: {
      type: "array",
      items: { type: "string" },
      description: 'Required when status is "blocked": what Dispatched Code must answer.',
    },
    followUps: { type: "array", items: { type: "string" } },
  },
} as const);

/** How many retries the provider gets to satisfy the schema before we see it. */
export const REPORT_RETRY_COUNT = 2;

export interface ParsedReport {
  /** `null` when nothing JSON-shaped could be found at all. */
  readonly report: WorkerReport | null;
  /** Every repair or omission, in the order noticed. Surfaced, never swallowed. */
  readonly issues: readonly string[];
  /** What was parsed, truncated. Diagnostics only. */
  readonly raw: string;
}

const MAX_RAW = 8_000;

/**
 * Pull a report out of whatever the worker actually said.
 *
 * Tries, in order: the whole text as JSON; the contents of a fenced block; the
 * last balanced `{…}` in the text. The last one matters more than it looks —
 * chatty models put the JSON at the end, after a paragraph explaining it.
 */
export function parseReport(text: string): ParsedReport {
  const raw = text.length > MAX_RAW ? `${text.slice(0, MAX_RAW)}…[truncated]` : text;
  const issues: string[] = [];

  const candidate = findJsonObject(text);
  if (candidate === undefined) {
    return { report: null, issues: ["no JSON object found in the worker's reply"], raw };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (e) {
    return { report: null, issues: [`the worker's reply is not valid JSON: ${(e as Error).message}`], raw };
  }
  if (!isRecord(parsed)) {
    return { report: null, issues: ["the worker's reply parsed to a non-object"], raw };
  }

  return { report: coerce(parsed, issues), issues, raw };
}

/**
 * Normalize a parsed object into a {@link WorkerReport}.
 *
 * Every coercion is logged. `status` defaults to `completed` because by the time
 * a report is parsed the run has already reached a clean terminal event — the
 * question the report answers is *what happened*, not *whether it ended*. A
 * worker that meant "blocked" and failed to say so is caught by the empty diff,
 * not by guessing here.
 */
function coerce(obj: Record<string, unknown>, issues: string[]): WorkerReport {
  const status = obj["status"];
  let normalized: WorkerReport["status"];
  if (status === "completed" || status === "blocked" || status === "failed") {
    normalized = status;
  } else {
    issues.push(`report status ${JSON.stringify(status)} is not one of completed/blocked/failed; read as completed`);
    normalized = "completed";
  }

  const summary = typeof obj["summary"] === "string" ? obj["summary"] : "";
  if (!summary) issues.push("report has no summary");

  const changes = asArray(obj["changes"]).flatMap((c, i) => {
    if (!isRecord(c)) {
      issues.push(`changes[${i}] is not an object; dropped`);
      return [];
    }
    const file = typeof c["file"] === "string" ? c["file"].trim() : "";
    if (!file) {
      issues.push(`changes[${i}] has no file; dropped`);
      return [];
    }
    const action = typeof c["action"] === "string" ? c["action"] : "modified";
    const rationale = typeof c["rationale"] === "string" ? c["rationale"] : undefined;
    return [{ file, action, ...(rationale === undefined ? {} : { rationale }) }];
  });
  if (obj["changes"] !== undefined && !Array.isArray(obj["changes"])) issues.push("changes is not an array");

  const tests = isRecord(obj["tests"]) ? coerceTests(obj["tests"]) : undefined;

  const report: WorkerReport = {
    ...(typeof obj["workerId"] === "string" ? { workerId: obj["workerId"] } : {}),
    status: normalized,
    summary,
    changes,
    ...(tests === undefined ? {} : { tests }),
    risks: asStrings(obj["risks"]),
    questions: asStrings(obj["questions"]),
    followUps: asStrings(obj["followUps"]),
  };

  if (report.status === "blocked" && report.questions.length === 0) {
    issues.push("report says blocked but asks nothing; there is no question to put to Claude");
  }
  return report;
}

function coerceTests(t: Record<string, unknown>): WorkerReport["tests"] {
  const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
  const command = typeof t["command"] === "string" ? t["command"] : undefined;
  const passed = num(t["passed"]);
  const failed = num(t["failed"]);
  const skipped = num(t["skipped"]);
  return {
    ...(command === undefined ? {} : { command }),
    ...(passed === undefined ? {} : { passed }),
    ...(failed === undefined ? {} : { failed }),
    ...(skipped === undefined ? {} : { skipped }),
  };
}

/**
 * Find the JSON object in a reply.
 *
 * Scans for balanced braces outside of string literals, and returns the *last*
 * complete top-level object — a model that explains itself first and answers
 * last is the common case, and the answer is what we want.
 */
export function findJsonObject(text: string): string | undefined {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n?```/g;
  const blocks: string[] = [];
  for (const m of text.matchAll(fenced)) if (m[1]) blocks.push(m[1]);
  for (const block of blocks.reverse()) {
    const found = lastBalancedObject(block);
    if (found) return found;
  }
  return lastBalancedObject(text);
}

function lastBalancedObject(text: string): string | undefined {
  let best: string | undefined;
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start >= 0) best = text.slice(start, i + 1);
      if (depth < 0) depth = 0;
    }
  }
  return best;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function asStrings(v: unknown): string[] {
  return asArray(v).filter((x): x is string => typeof x === "string");
}
