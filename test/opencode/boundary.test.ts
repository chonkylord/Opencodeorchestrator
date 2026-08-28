/**
 * DD-2, enforced rather than asserted in a review comment.
 *
 * "Everything OpenCode-shaped must live behind this interface. No other module
 * may import an OpenCode type, know an endpoint path, or parse an OpenCode
 * event." That property is only worth stating if something checks it, because it
 * is broken by a single convenient import six months from now.
 */

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = new URL("../../", import.meta.url).pathname;
const ADAPTER = join(ROOT, "src", "opencode");

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

/** Everything under src/ that is not the adapter itself. */
const outside = tsFiles(join(ROOT, "src")).filter((f) => !f.startsWith(ADAPTER));

describe("adapter boundary (DD-2)", () => {
  test("there is code outside the adapter to check", () => {
    // Guards against this suite silently passing because the glob broke.
    expect(outside.length).toBeGreaterThan(0);
  });

  test("no module outside src/opencode/ names an OpenCode endpoint", () => {
    // Endpoint paths are the most tempting shortcut: one `fetch` in the manager
    // to "just check the session" and the backend choice stops being reversible.
    const forbidden = [/prompt_async/, /\/session\/\$\{/, /["'`]\/event\b/, /opencode\s+serve/, /\/global\/health/];
    const offenders = outside.filter((f) => {
      const src = readFileSync(f, "utf8");
      return forbidden.some((re) => re.test(src));
    });
    expect(offenders.map((f) => f.slice(ROOT.length))).toEqual([]);
  });

  test("no module outside src/opencode/ parses a raw OpenCode event", () => {
    const forbidden = [/session\.idle/, /session\.error/, /message\.part\./, /server\.heartbeat/, /permission\.asked/];
    const offenders = outside.filter((f) => {
      const src = readFileSync(f, "utf8");
      return forbidden.some((re) => re.test(src));
    });
    expect(offenders.map((f) => f.slice(ROOT.length))).toEqual([]);
  });

  test("adapter imports, when they come, go through the barrel", () => {
    // Reaching into ./opencode/serve.js binds a caller to ServeBackend's
    // concrete type, which is exactly what ADR-0001 needs to stay free of.
    const offenders = outside.filter((f) => /from\s+["'][^"']*opencode\/(serve|run|types)/.test(readFileSync(f, "utf8")));
    expect(offenders.map((f) => f.slice(ROOT.length))).toEqual([]);
  });
});
