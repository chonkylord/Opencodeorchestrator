/**
 * Shared test plumbing: collecting from an {@link EventStream} with a deadline,
 * so a test that would hang instead fails with the events it did see.
 */

import type { EventStream, OCEvent } from "../src/opencode/types.js";

export class CollectTimeout extends Error {
  constructor(
    readonly seen: OCEvent[],
    ms: number,
    what: string,
  ) {
    super(`timed out after ${ms}ms waiting for ${what}; saw: ${seen.map((e) => e.kind).join(", ") || "(nothing)"}`);
    this.name = "CollectTimeout";
  }
}

/** Collect events until `pred` matches, inclusive. Throws on deadline. */
export async function until(
  stream: EventStream,
  pred: (e: OCEvent) => boolean,
  ms = 3_000,
  what = "a matching event",
): Promise<OCEvent[]> {
  const seen: OCEvent[] = [];
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    stream.close();
  }, ms);
  try {
    for await (const e of stream) {
      seen.push(e);
      if (pred(e)) return seen;
    }
  } finally {
    clearTimeout(timer);
  }
  throw new CollectTimeout(seen, ms, timedOut ? what : `${what} (stream ended first)`);
}

/** Collect everything that arrives within `ms`. Never throws. */
export async function drain(stream: EventStream, ms: number): Promise<OCEvent[]> {
  const seen: OCEvent[] = [];
  const timer = setTimeout(() => stream.close(), ms);
  try {
    for await (const e of stream) seen.push(e);
  } catch {
    /* stream broke; the caller asserts on what arrived */
  } finally {
    clearTimeout(timer);
  }
  return seen;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
