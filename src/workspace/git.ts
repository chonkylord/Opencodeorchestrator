/**
 * Running git, and nothing more.
 *
 * Kept separate from `worktree.ts` so the plumbing has one place to be careful
 * in: no shell (argv only, so a branch name can never become a command), a
 * timeout on every call, and identity supplied per-invocation rather than read
 * from whatever global config the container happens to have.
 */

import { execFile } from "node:child_process";

export class WorkspaceError extends Error {
  readonly code: "git" | "config" | "timeout";
  readonly detail: Readonly<Record<string, unknown>>;

  constructor(code: WorkspaceError["code"], message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = "WorkspaceError";
    this.code = code;
    this.detail = Object.freeze({ ...detail });
  }
}

export interface GitOutcome {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface GitOptions {
  /** Return the failure instead of throwing. For probes with a known failure. */
  readonly allowFailure?: boolean;
  readonly timeoutMs?: number;
  readonly env?: NodeJS.ProcessEnv;
}

/**
 * Identity for the snapshot commits (DD-5).
 *
 * The manager commits on the worker's behalf, so the commits are the manager's:
 * attributing them to whatever `user.email` the host has configured would put a
 * human's name on a machine's work.
 */
export const COMMIT_IDENTITY = Object.freeze({
  name: "opencode-orchestrator",
  email: "orchestrator@localhost",
});

const IDENTITY_ARGS: readonly string[] = Object.freeze([
  "-c",
  `user.name=${COMMIT_IDENTITY.name}`,
  "-c",
  `user.email=${COMMIT_IDENTITY.email}`,
  "-c",
  "commit.gpgsign=false",
  // The repository under a worker's control may carry hooks. A snapshot commit
  // must not be a way for repo content to run code in the manager's process
  // tree (DD-8); `core.hooksPath` to nowhere is belt to `--no-verify`'s braces.
  "-c",
  "core.hooksPath=/dev/null",
]);

const DEFAULT_TIMEOUT_MS = 60_000;

export async function git(cwd: string, args: readonly string[], opts: GitOptions = {}): Promise<GitOutcome> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return new Promise<GitOutcome>((resolve, reject) => {
    execFile(
      "git",
      [...IDENTITY_ARGS, ...args],
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", ...opts.env },
      },
      (err, stdout, stderr) => {
        const outcome: GitOutcome = {
          code: err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : err ? 1 : 0,
          stdout: stdout.toString(),
          stderr: stderr.toString(),
        };
        if (!err || opts.allowFailure) return resolve(outcome);
        const killed = (err as { killed?: boolean }).killed === true;
        reject(
          new WorkspaceError(killed ? "timeout" : "git", `git ${args.join(" ")} failed: ${outcome.stderr.trim() || err.message}`, {
            cwd,
            args,
            code: outcome.code,
            stderr: outcome.stderr.slice(-2000),
          }),
        );
      },
    );
  });
}

/** Convenience for the many calls whose whole answer is one trimmed line. */
export async function gitLine(cwd: string, args: readonly string[], opts: GitOptions = {}): Promise<string> {
  return (await git(cwd, args, opts)).stdout.trim();
}
