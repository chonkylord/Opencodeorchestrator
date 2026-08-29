/**
 * The metrics log (`projectplan.md` §11 Phase 7).
 *
 * One JSON object per line, appended, under `.orchestrator/metrics/`. It is
 * deliberately the smallest thing that answers "what did this orchestrator
 * actually do, over time" — the questions the run report cannot, because a run
 * report is *per run* and these questions are across them: is the free tier
 * getting slower, how often does a worker need revising, how much does an
 * escalation really cost, is the concurrency cap ever the thing in the way.
 *
 * Three decisions worth stating, because each has an obvious wrong answer:
 *
 * - **JSONL on disk, not a table.** DD-7 says the database is an index and the
 *   worktrees are the durable state; metrics are neither. They are an operator's
 *   artifact, they want to be greppable and `jq`-able without a SQLite client,
 *   and they must survive the index being deleted — which is exactly when
 *   somebody is asking what happened.
 * - **Never on the wire.** No tool returns this. §8's context budget is the
 *   whole architecture and a metrics feed is precisely the sort of thing that
 *   would quietly eat it. `run_report` remains what Claude reads.
 * - **Best-effort, always.** A metrics write that throws must never fail a
 *   worker. Every call site is wrapped, and a full or read-only disk costs a
 *   line of telemetry rather than a run.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

import { ORCHESTRATOR_DIR } from "../workspace/index.js";

export const METRICS_DIR = `${ORCHESTRATOR_DIR}/metrics`;

/** What kind of thing happened. Closed set: a metrics file is only useful sorted. */
export type MetricKind = "worker_settled" | "merge_finished" | "revision_round" | "retry" | "recovery";

export interface Metric {
  readonly kind: MetricKind;
  /** Epoch ms. */
  readonly at: number;
  readonly runID: string;
  readonly workerID?: string;
  /** Flat, primitive-valued, and small — this is a log line, not a document. */
  readonly [key: string]: unknown;
}

export interface MetricsSink {
  record(metric: Metric): void;
}

/** A sink that writes nothing. The default, and what `:memory:` runs get. */
export const NULL_METRICS: MetricsSink = { record: () => {} };

/**
 * Append-only metrics, one file per UTC day.
 *
 * Per day rather than per run: a run is minutes and a file per run would make
 * "what happened last Tuesday" a directory listing rather than a `grep`. Per day
 * also means the file a long-running orchestrator is appending to stays a size
 * an editor will open.
 */
export function fileMetrics(repoRoot: string, now: () => number = Date.now): MetricsSink {
  return {
    record(metric: Metric): void {
      try {
        const at = metric.at || now();
        const day = new Date(at).toISOString().slice(0, 10);
        const path = join(repoRoot, METRICS_DIR, `${day}.jsonl`);
        mkdirSync(dirname(path), { recursive: true });
        appendFileSync(path, `${JSON.stringify({ ...metric, at })}\n`);
      } catch {
        // Telemetry is never worth a run. See the header.
      }
    },
  };
}
