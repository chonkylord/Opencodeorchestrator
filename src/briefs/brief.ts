/**
 * The task brief (`projectplan.md` §4.1) — but delivered over the channel that
 * actually works. See `docs/adr/0002-worker-contract-channel.md`.
 *
 * §4.1 says the brief is "written to the worktree (as `AGENTS.md`, which
 * OpenCode auto-loads)". Phase 0 left that pickup unverified, and found a better
 * channel on the way past: the per-prompt system prompt is dynamic, needs no
 * file in the worker's tree, cannot be edited by the worker mid-run, and does
 * not show up in the diff we are about to reconcile against.
 *
 * So a brief splits in two:
 *
 * - {@link Brief.system} — the standing contract. Who the worker is, what it may
 *   touch, how it must report. Re-sent with every prompt in the session, so a
 *   resumed or revised worker cannot drift off it.
 * - {@link Brief.text} — this turn's instruction. The task on the first prompt,
 *   the answer to its question on a resume.
 */

import type { WorkerBudget, WorkerMode, WorkerSpec } from "../manager/types.js";
import { REPORT_SCHEMA } from "./report.js";

export interface Brief {
  /** The standing contract. Goes in the prompt's system field, every turn. */
  readonly system: string;
  /** This turn's instruction. */
  readonly text: string;
}

export interface BriefContext {
  readonly workerID: string;
  readonly spec: WorkerSpec;
  readonly mode: WorkerMode;
  readonly budget: WorkerBudget;
  readonly baseSha: string;
  /** Absolute path of the worktree the worker is jailed to. */
  readonly worktree: string;
}

const MODE_RULES: Readonly<Record<WorkerMode, readonly string[]>> = {
  implement: [
    "You may create, edit and delete files inside this worktree, and run shell commands.",
    "Do not commit. The orchestrator snapshots your work for you when you finish.",
  ],
  research: [
    "You are read-only. Do not create, edit or delete any file, and do not run commands that mutate state.",
    "Your entire deliverable is the report: findings go in `summary`, leads go in `followUps`.",
  ],
  review: [
    "You are read-only. Do not create, edit or delete any file.",
    "Critique the work you were pointed at. Concrete defects go in `risks`; put nits in `followUps`.",
  ],
};

/**
 * Build the two halves of a worker's brief.
 *
 * Deliberately mechanical: the same spec must produce the same brief every time,
 * because the brief is the only thing standing between a capable model and a
 * repository it can write to.
 */
export function buildBrief(ctx: BriefContext): Brief {
  const { spec, workerID, mode, budget, baseSha, worktree } = ctx;
  const owned = spec.ownedPaths ?? [];
  const lines: string[] = [];

  lines.push(`You are worker ${workerID}, an autonomous subagent in a multi-worker orchestration.`);
  lines.push("");
  lines.push(`Mode: ${mode}`);
  lines.push(`Worker ID: ${workerID}`);
  lines.push(`Base commit: ${baseSha}`);
  lines.push(`Worktree: ${worktree}`);
  lines.push("");

  lines.push("## You own these paths");
  if (owned.length > 0) {
    for (const p of owned) lines.push(`- ${p}`);
    lines.push("");
    lines.push(
      "Do not edit files outside this list. If the task cannot be completed without",
      'touching another file, stop and report status "blocked" with the question in',
      "`questions` — do not edit it anyway.",
    );
  } else {
    lines.push("- (no path restriction was given; stay inside the worktree)");
  }
  lines.push("");

  lines.push("## Constraints");
  lines.push(`- Work only inside ${worktree}. Never read or write outside it.`);
  for (const rule of MODE_RULES[mode]) lines.push(`- ${rule}`);
  lines.push("- Do not modify integration points (package manifests, router indexes, lockfiles) unless listed above as yours.");
  lines.push("- Follow the conventions of the surrounding code rather than importing your own.");
  for (const note of spec.notes ?? []) lines.push(`- ${note}`);
  lines.push("");

  lines.push("## Definition of done");
  for (const a of spec.acceptance ?? []) lines.push(`- ${a}`);
  if (spec.testCommand) {
    lines.push(`- \`${spec.testCommand}\` passes. Run it yourself before you report; do not report success you have not observed.`);
  }
  if ((spec.acceptance ?? []).length === 0 && !spec.testCommand) {
    lines.push("- The objective above is met and the repository is left in a working state.");
  }
  lines.push("");

  lines.push("## Required output");
  lines.push(
    "Your final message must be a single JSON object matching this schema, and nothing else —",
    "no prose before it, no code fence around it:",
    "",
    "```json",
    JSON.stringify(REPORT_SCHEMA, null, 2),
    "```",
    "",
    "This report is the only channel by which your work is read. Anything not in it is",
    "invisible to the orchestrator. `changes` is checked against the real git diff, so list",
    "exactly what you changed: claiming a file you did not touch is worse than claiming nothing.",
    'If you cannot finish, report status "blocked" with your question, or "failed" with what broke.',
  );
  lines.push("");

  lines.push("## Budget");
  lines.push(
    `- ~${budget.tokens.toLocaleString("en-US")} tokens and ~${Math.round(budget.wallClockMs / 60_000)} minutes of wall clock.`,
    "- If you approach either, stop and report what you have. A partial report beats a killed run.",
  );

  return { system: lines.join("\n"), text: buildTaskPrompt(spec) };
}

/** The first turn's instruction. Short by design: the contract is in `system`. */
export function buildTaskPrompt(spec: WorkerSpec): string {
  const lines = [`Task: ${spec.task}`];
  if (spec.scope) {
    lines.push("", "## Scope", spec.scope);
  }
  lines.push("", "Begin. When you are done, reply with the report JSON described in your instructions.");
  return lines.join("\n");
}

/**
 * The instruction that unblocks a `blocked` worker (§5's escalation channel).
 *
 * The session is reused, so the worker still has its own context — this only has
 * to carry the answer. The answer is quoted rather than interpolated as
 * instructions: it comes from outside, and DD-8 applies to it too.
 */
export function buildAnswerPrompt(questions: readonly string[], answer: string): string {
  const lines: string[] = [];
  if (questions.length > 0) {
    lines.push("You asked:");
    for (const q of questions) lines.push(`> ${q}`);
    lines.push("");
  }
  lines.push("The orchestrator answers:");
  lines.push(...answer.split("\n").map((l) => `> ${l}`));
  lines.push("");
  lines.push(
    "Continue the task with that answer. The same contract still applies, including the",
    "path restrictions and the report format. Reply with the report JSON when you are done.",
  );
  return lines.join("\n");
}
