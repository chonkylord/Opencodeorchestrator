/**
 * The live worker transcript, bounded (§11 Phase 9).
 *
 * `worker_output` says it plainly: *"this is not the worker's transcript and
 * there is no tool that returns one. The transcript is what the context firewall
 * keeps out."* That stays true — nothing in this file is reachable from a tool.
 * What Phase 9 noticed is that the firewall was never about the information
 * being unsafe. It is about **cost**: a hundred thousand characters of a
 * worker's stream, per worker, per wave, through a model's context window. A
 * human watching a browser tab pays none of that, and is the reader the
 * transcript was always for.
 *
 * So the stream takes the other exit. It goes into this ring, out over a
 * loopback socket, and nowhere else.
 *
 * **Bounded twice, on purpose.** A worker that generates 39,004 tokens with no
 * terminal event is not hypothetical here — Phase 8 measured one — and an
 * unbounded buffer behind an event stream is how a long-running Dispatched Code
 * process turns somebody's laptop into swap. Every worker's ring is capped by entry
 * count *and* by total characters, and the two catch different failures: a
 * chatty tool-calling worker hits the first, a worker emitting one enormous
 * reply hits the second.
 */

import type { ActivityInput } from "../manager/types.js";

/** One entry as the dashboard receives it. */
export interface ActivityEntry {
  /** Monotonic per worker. The cursor a reconnecting client resumes from. */
  readonly seq: number;
  readonly workerID: string;
  readonly kind: ActivityInput["kind"];
  readonly at: number;
  /** Untrusted worker text (DD-8). Rendered as data by the UI, never as markup. */
  readonly text: string;
  readonly tool?: string;
  readonly file?: string;
  /** True when this entry is still being appended to. Only ever a `text` entry. */
  readonly open?: boolean;
}

export interface ActivityOptions {
  /** Entries kept per worker. Older ones are dropped, oldest first. */
  readonly maxEntries?: number;
  /** Characters kept per worker across all of its entries. */
  readonly maxChars?: number;
  /** How long one coalesced text burst may grow before it is closed off. */
  readonly maxBurstChars?: number;
}

export const DEFAULT_MAX_ENTRIES = 400;
export const DEFAULT_MAX_CHARS = 96_000;
export const DEFAULT_MAX_BURST_CHARS = 4_000;

interface Ring {
  entries: ActivityEntry[];
  chars: number;
  seq: number;
}

/**
 * Per-worker rings, plus the coalescing that makes a token stream readable.
 *
 * Text arrives one delta at a time — often a few characters — and one entry per
 * delta would be thousands of rows describing one paragraph. Consecutive `text`
 * deltas are therefore appended to the open entry at the tail, and any other
 * kind closes it. That is what makes the dashboard look like a terminal someone
 * is typing into rather than a log of keystrokes.
 */
export class ActivityLog {
  private readonly rings = new Map<string, Ring>();
  private readonly maxEntries: number;
  private readonly maxChars: number;
  private readonly maxBurstChars: number;
  private readonly subscribers = new Set<(e: ActivityEntry) => void>();

  constructor(opts: ActivityOptions = {}) {
    this.maxEntries = Math.max(1, opts.maxEntries ?? DEFAULT_MAX_ENTRIES);
    this.maxChars = Math.max(1_000, opts.maxChars ?? DEFAULT_MAX_CHARS);
    this.maxBurstChars = Math.max(200, opts.maxBurstChars ?? DEFAULT_MAX_BURST_CHARS);
  }

  /** Fan out to live dashboard connections. Returns the unsubscribe. */
  subscribe(fn: (e: ActivityEntry) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  /** Everything still held for one worker, oldest first. */
  entries(workerID: string, afterSeq = 0): ActivityEntry[] {
    const ring = this.rings.get(workerID);
    if (!ring) return [];
    return afterSeq <= 0 ? [...ring.entries] : ring.entries.filter((e) => e.seq > afterSeq);
  }

  /** What the worker list shows without loading a whole ring. */
  summary(workerID: string): { count: number; chars: number; last?: ActivityEntry } {
    const ring = this.rings.get(workerID);
    if (!ring) return { count: 0, chars: 0 };
    const last = ring.entries[ring.entries.length - 1];
    return { count: ring.entries.length, chars: ring.chars, ...(last ? { last } : {}) };
  }

  /** Drop a worker's ring. Called when its worktree is cleaned up. */
  forget(workerID: string): void {
    this.rings.delete(workerID);
  }

  /** Every worker with a ring. */
  workers(): string[] {
    return [...this.rings.keys()];
  }

  append(workerID: string, input: ActivityInput): ActivityEntry {
    const ring = this.rings.get(workerID) ?? { entries: [], chars: 0, seq: 0 };
    if (!this.rings.has(workerID)) this.rings.set(workerID, ring);

    const text = input.text ?? "";
    const tail = ring.entries[ring.entries.length - 1];
    // Coalesce, unless the burst has grown past what one entry should carry.
    // Splitting a long generation into several entries is not cosmetic: it is
    // what lets the UI drop the head of a runaway reply without dropping the
    // structure around it.
    if (
      input.kind === "text" &&
      tail !== undefined &&
      tail.open === true &&
      tail.kind === "text" &&
      tail.text.length + text.length <= this.maxBurstChars
    ) {
      const merged: ActivityEntry = { ...tail, text: tail.text + text, at: input.at };
      ring.entries[ring.entries.length - 1] = merged;
      ring.chars += text.length;
      this.trim(ring);
      this.emit(merged);
      return merged;
    }

    // Anything that is not more text closes the burst before it. A closed entry
    // is never appended to again, so the client can render it as final.
    if (tail?.open === true) ring.entries[ring.entries.length - 1] = { ...tail, open: false };

    ring.seq += 1;
    const entry: ActivityEntry = {
      seq: ring.seq,
      workerID,
      kind: input.kind,
      at: input.at,
      text,
      ...(input.tool === undefined ? {} : { tool: input.tool }),
      ...(input.file === undefined ? {} : { file: input.file }),
      ...(input.kind === "text" ? { open: true } : {}),
    };
    ring.entries.push(entry);
    ring.chars += text.length;
    this.trim(ring);
    this.emit(entry);
    return entry;
  }

  /**
   * Enforce both caps, oldest first.
   *
   * The character cap is checked after the entry cap because dropping by count
   * usually satisfies it, and dropping the newest entry to satisfy a character
   * cap would be exactly backwards — the newest entry is the one somebody is
   * watching.
   */
  private trim(ring: Ring): void {
    while (ring.entries.length > this.maxEntries) {
      const dropped = ring.entries.shift();
      if (dropped) ring.chars -= dropped.text.length;
    }
    while (ring.chars > this.maxChars && ring.entries.length > 1) {
      const dropped = ring.entries.shift();
      if (dropped) ring.chars -= dropped.text.length;
    }
    if (ring.chars < 0) ring.chars = 0;
  }

  private emit(entry: ActivityEntry): void {
    for (const fn of [...this.subscribers]) {
      try {
        fn(entry);
      } catch {
        /* one broken connection does not stop the others */
      }
    }
  }
}
