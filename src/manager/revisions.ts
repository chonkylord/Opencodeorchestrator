/**
 * The review loop's vocabulary (`projectplan.md` §5's revision path, §11 Phase 6).
 *
 * One worker can take several rounds, and two things need to read them back: the
 * terminal report `worker_revise` produces at the cap (§13), and the run report's
 * per-worker section. Both reconstruct the rounds from the **event trail** rather
 * than from a column, which is the DD-7 choice — the trail is already the durable
 * record of what happened, and a run report that derives its story from the same
 * rows a debugger reads cannot drift away from them.
 *
 * It lives in its own module so the manager and the run report share one
 * reconstruction instead of two that agree until they do not.
 */

import type { StoredEvent } from "../store/index.js";

/** One round of the loop, as the trail remembers it. */
export interface RevisionRound {
  /** 0 is the worker's original attempt; 1 and up are revisions. */
  readonly round: number;
  /** Claude's feedback for this round. Absent on round 0. */
  readonly feedback?: string;
  /** How the round ended. Absent while it is still running. */
  readonly state?: string;
  readonly files?: number;
  readonly additions?: number;
  readonly deletions?: number;
  readonly discrepancies?: number;
  readonly testsFailed?: number;
  /** The worker's own words, capped at the source. Untrusted (DD-8). */
  readonly summary?: string;
  readonly settled: boolean;
  readonly at: number;
}

interface Outcome {
  at: number;
  state?: string;
  files?: number;
  additions?: number;
  deletions?: number;
  discrepancies?: number;
  testsFailed?: number;
  summary?: string;
}

/**
 * Rebuild a worker's rounds from its events, oldest first.
 *
 * Round 0 always exists, even for a worker that was never revised: it is the
 * original attempt, and a report that started at round 1 would describe the
 * feedback without the thing the feedback was about.
 *
 * A `revision_requested` with no matching `settled` is a round still in flight —
 * or one that was abandoned in the queue, which is why `settled` is a field
 * rather than an assumption.
 */
export function revisionRounds(events: readonly StoredEvent[]): RevisionRound[] {
  const asked = new Map<number, { feedback: string; at: number }>();
  const got = new Map<number, Outcome>();

  for (const e of events) {
    if (e.kind === "revision_requested") {
      const round = numberOf(e.detail["round"]) ?? asked.size + 1;
      asked.set(round, { feedback: stringOf(e.detail["feedback"]) ?? "", at: e.at });
    } else if (e.kind === "settled") {
      // A settle with no `revision` is the original attempt. The field is only
      // written once a worker has actually taken a round, so its absence is the
      // signal rather than a default that could be confused with round 0.
      const round = numberOf(e.detail["revision"]) ?? 0;
      got.set(round, {
        at: e.at,
        state: stringOf(e.detail["state"]),
        files: numberOf(e.detail["files"]),
        additions: numberOf(e.detail["additions"]),
        deletions: numberOf(e.detail["deletions"]),
        discrepancies: numberOf(e.detail["discrepancies"]),
        testsFailed: numberOf(e.detail["testsFailed"]),
        summary: stringOf(e.detail["summary"]),
      });
    }
  }

  const numbers = [...new Set([0, ...asked.keys(), ...got.keys()])].sort((a, b) => a - b);
  return numbers.map((n) => {
    const q = asked.get(n);
    const o = got.get(n);
    return {
      round: n,
      ...(q === undefined ? {} : { feedback: q.feedback }),
      ...(o?.state === undefined ? {} : { state: o.state }),
      ...(o?.files === undefined ? {} : { files: o.files }),
      ...(o?.additions === undefined ? {} : { additions: o.additions }),
      ...(o?.deletions === undefined ? {} : { deletions: o.deletions }),
      ...(o?.discrepancies === undefined ? {} : { discrepancies: o.discrepancies }),
      ...(o?.testsFailed === undefined ? {} : { testsFailed: o.testsFailed }),
      ...(o?.summary === undefined ? {} : { summary: o.summary }),
      settled: o !== undefined,
      at: o?.at ?? q?.at ?? 0,
    };
  });
}

const numberOf = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);
const stringOf = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
