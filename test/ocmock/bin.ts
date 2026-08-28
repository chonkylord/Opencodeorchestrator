#!/usr/bin/env bun
/**
 * `ocmock` as a spawnable process.
 *
 * Exists so `ServeBackend`'s spawn-and-parse path can be tested for real:
 * `--port 0`, a dynamically chosen port, and the `listening on http://HOST:PORT`
 * line parsed off stdout. That code has exactly one job and its failure mode
 * (hardcoding 4096) works locally and breaks under concurrency, so it is worth
 * exercising against a process rather than a URL.
 *
 * Configured by env, because the real `opencode serve` takes none of these:
 *   OCMOCK_SCENARIO, OCMOCK_LATENCY_MS, OCMOCK_WORK_MS, OCMOCK_HEARTBEAT_MS,
 *   OCMOCK_COLD_START, OCMOCK_STARTUP_DELAY_MS
 *
 * Usage: bun run test/ocmock/bin.ts serve --port 0
 */

import { OCMock, type Scenario } from "./server.js";

const num = (key: string): number | undefined => {
  const raw = process.env[key];
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
};

const startupDelay = num("OCMOCK_STARTUP_DELAY_MS") ?? 0;
if (startupDelay > 0) await new Promise((r) => setTimeout(r, startupDelay));

const mock = await OCMock.start({
  ...(process.env["OCMOCK_SCENARIO"] ? { scenario: process.env["OCMOCK_SCENARIO"] as Scenario } : {}),
  ...(num("OCMOCK_LATENCY_MS") === undefined ? {} : { latencyMs: num("OCMOCK_LATENCY_MS")! }),
  ...(num("OCMOCK_WORK_MS") === undefined ? {} : { workMs: num("OCMOCK_WORK_MS")! }),
  ...(num("OCMOCK_HEARTBEAT_MS") === undefined ? {} : { heartbeatMs: num("OCMOCK_HEARTBEAT_MS")! }),
  ...(num("OCMOCK_COLD_START") === undefined ? {} : { coldStartEvents: num("OCMOCK_COLD_START")! }),
});

// The exact line the adapter greps for. Real serve warns on stderr first, so do
// that too — a parser that only reads stdout, or that trips on the warning,
// should fail here rather than in production.
console.error("Warning: OPENCODE_SERVER_PASSWORD is not set; server is unsecured.");
console.log(mock.listeningLine);

const shutdown = () => {
  void mock.stop().then(() => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
