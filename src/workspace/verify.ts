/**
 * Re-running the worker's tests, independently.
 *
 * §4.3's result line ends `Tests: 24 passed / 0 failed  [manager re-ran
 * independently ✓]`, and the parenthetical is the whole value: a worker's test
 * numbers are a claim like any other, and the cheapest way to check a claim
 * about a test suite is to run the test suite.
 *
 * **The command comes from the brief, never from the report.** DD-8 says
 * Dispatched Code never executes anything found in worker output; this is the one
 * place in the manager that runs a shell string, so where that string comes from
 * is load-bearing. `WorkerSpec.testCommand` is set by whoever spawned the worker.
 * `report.tests.command` is the worker talking, and is only ever *compared*
 * against the real one — a mismatch is a discrepancy, not a new command to run.
 */

import { execFile } from "node:child_process";

export interface TestRun {
  readonly command: string;
  readonly ran: boolean;
  readonly passed: boolean;
  readonly exitCode: number | null;
  /** Tail of combined output, bounded. Diagnostics only. */
  readonly output: string;
  readonly durationMs: number;
  /** Set when the command could not be run at all. */
  readonly error?: string;
}

const MAX_OUTPUT = 4_000;

/**
 * Run `command` in `cwd` and report whether it exited zero.
 *
 * No parsing of pass/fail counts: every framework prints them differently, and a
 * regex that guesses wrong is worse than an exit code that does not. The exit
 * code is what the merge gate in Phase 4 will key off too.
 */
export async function runTestCommand(cwd: string, command: string, timeoutMs = 10 * 60_000): Promise<TestRun> {
  const startedAt = Date.now();
  return new Promise<TestRun>((resolve) => {
    execFile(
      "/bin/sh",
      ["-c", command],
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process.env, CI: "1", NO_COLOR: "1" },
      },
      (err, stdout, stderr) => {
        const output = tail(`${stdout}${stderr}`);
        const durationMs = Date.now() - startedAt;
        if (!err) {
          return resolve({ command, ran: true, passed: true, exitCode: 0, output, durationMs });
        }
        const code = typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : null;
        const killed = (err as { killed?: boolean }).killed === true;
        resolve({
          command,
          ran: true,
          passed: false,
          exitCode: code,
          output,
          durationMs,
          error: killed ? `timed out after ${timeoutMs}ms` : err.message,
        });
      },
    );
  });
}

function tail(text: string): string {
  return text.length > MAX_OUTPUT ? `…[truncated]${text.slice(-MAX_OUTPUT)}` : text;
}
