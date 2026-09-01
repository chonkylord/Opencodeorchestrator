/**
 * The worker contract, both directions: brief out, report back (§4.1, §4.2).
 *
 * The parser tests are mostly about the ugly cases, because the pretty case is
 * already handled by the provider's schema enforcement. What gets here is what
 * survived that — the truncated reply, the reply with a paragraph in front of
 * the JSON, the reply that is valid JSON and completely false.
 */

import { describe, expect, test } from "bun:test";

import { buildAnswerPrompt, buildBrief, findJsonObject, parseReport, REPORT_SCHEMA } from "../../src/briefs/index.js";
import { DEFAULT_BUDGET } from "../../src/manager/worker.js";
import type { WorkerSpec } from "../../src/manager/types.js";

const spec: WorkerSpec = {
  task: "Implement the settings API",
  scope: "Expose GET and PUT for user settings, backed by the existing store.",
  ownedPaths: ["src/settings/api.ts", "src/settings/store.ts"],
  acceptance: ["GET returns the stored document", "PUT validates before writing"],
  testCommand: "npm test",
};

const ctx = {
  workerID: "w-003",
  spec,
  mode: "implement" as const,
  budget: DEFAULT_BUDGET,
  baseSha: "abc1234",
  worktree: "/tmp/wt/w-003",
};

describe("the brief", () => {
  test("carries every §4.1 section, in the system channel", () => {
    const brief = buildBrief(ctx);
    for (const section of ["## You own these paths", "## Constraints", "## Definition of done", "## Required output", "## Budget"]) {
      expect(brief.system).toContain(section);
    }
    expect(brief.system).toContain("w-003");
    expect(brief.system).toContain("abc1234");
    expect(brief.system).toContain("/tmp/wt/w-003");
    for (const p of spec.ownedPaths!) expect(brief.system).toContain(p);
    expect(brief.system).toContain("npm test");
    // The turn's instruction stays short: the contract is not repeated into it.
    expect(brief.text).toContain("Implement the settings API");
    expect(brief.text).toContain("Expose GET and PUT");
    expect(brief.text).not.toContain("## Constraints");
  });

  test("tells the worker not to commit, and tells it who does", () => {
    // DD-5: the manager snapshots. A worker that commits its own work makes the
    // snapshot ambiguous and the diff stat wrong.
    expect(buildBrief(ctx).system).toContain("Do not commit");
  });

  test("read-only modes say so in the contract, not just in the permissions", () => {
    // The ruleset and the tools map are the enforcement; this is the part the
    // model actually reads, and a research worker that thinks it may edit will
    // spend its budget discovering that it cannot.
    const research = buildBrief({ ...ctx, mode: "research" });
    expect(research.system).toContain("read-only");
    expect(research.system).not.toContain("Do not commit");
    expect(buildBrief({ ...ctx, mode: "review" }).system).toContain("read-only");
  });

  test("embeds the report schema it is going to be judged against", () => {
    const brief = buildBrief(ctx);
    expect(brief.system).toContain('"status"');
    expect(brief.system).toContain('"changes"');
    expect(brief.system).toContain("claiming a file you did not touch");
  });

  test("the answer prompt quotes the answer rather than adopting it", () => {
    // The answer comes from outside the manager. DD-8 applies to it as much as
    // it applies to the worker's own output.
    const prompt = buildAnswerPrompt(["May I edit src/router.ts?"], "Yes, but only the route table.");
    expect(prompt).toContain("> May I edit src/router.ts?");
    expect(prompt).toContain("> Yes, but only the route table.");
    expect(prompt).toContain("The same contract still applies");
  });
});

describe("the report parser", () => {
  const good = {
    workerId: "w-003",
    status: "completed",
    summary: "Added the settings endpoints.",
    changes: [{ file: "src/settings/api.ts", action: "modified", rationale: "added handlers" }],
    tests: { command: "npm test", passed: 24, failed: 0, skipped: 2 },
    risks: ["no rate limiting yet"],
    questions: [],
    followUps: ["extract the validator"],
  };

  test("round-trips a well-formed report", () => {
    const { report, issues } = parseReport(JSON.stringify(good));
    expect(issues).toEqual([]);
    expect(report).toMatchObject({
      status: "completed",
      summary: "Added the settings endpoints.",
      changes: [{ file: "src/settings/api.ts", action: "modified" }],
      tests: { passed: 24, failed: 0, skipped: 2 },
      risks: ["no rate limiting yet"],
      followUps: ["extract the validator"],
    });
  });

  test("digs the JSON out of a chatty reply", () => {
    const text = `Here is what I did — it took a couple of tries.\n\n\`\`\`json\n${JSON.stringify(good)}\n\`\`\`\n\nLet me know!`;
    expect(parseReport(text).report?.status).toBe("completed");
  });

  test("takes the last object when a reply contains several", () => {
    // Models narrate with examples. The answer is the one at the end.
    const text = `First I considered {"status":"failed","summary":"nope","changes":[]}. Final: ${JSON.stringify(good)}`;
    expect(parseReport(text).report?.summary).toBe("Added the settings endpoints.");
  });

  test("a truncated reply is a null report, not a half-believed one", () => {
    const { report, issues } = parseReport('{"status":"completed","summary":"I did some of it","changes":[');
    expect(report).toBeNull();
    expect(issues.join(" ")).toContain("no JSON object found");
  });

  test("empty output is reported as such rather than as an empty success", () => {
    const { report, issues } = parseReport("");
    expect(report).toBeNull();
    expect(issues).toHaveLength(1);
  });

  test("every repair is recorded as an issue", () => {
    const { report, issues } = parseReport(
      JSON.stringify({ status: "done", summary: "", changes: [{ action: "modified" }, "nonsense"] }),
    );
    expect(report!.status).toBe("completed");
    expect(report!.changes).toEqual([]);
    expect(issues.join(" | ")).toContain('"done" is not one of');
    expect(issues.join(" | ")).toContain("no summary");
    expect(issues.join(" | ")).toContain("changes[0] has no file");
    expect(issues.join(" | ")).toContain("changes[1] is not an object");
  });

  test("a blocked report with no question is called out", () => {
    // Otherwise the worker parks in `blocked` with nothing for Claude to answer,
    // which is a deadlock dressed up as an escalation.
    const { report, issues } = parseReport(JSON.stringify({ status: "blocked", summary: "stuck", changes: [] }));
    expect(report!.status).toBe("blocked");
    expect(issues.join(" ")).toContain("asks nothing");
  });

  test("finds a balanced object even with braces inside strings", () => {
    const text = 'noise {"summary":"a } brace in a string","status":"completed","changes":[]} tail';
    expect(JSON.parse(findJsonObject(text)!)).toMatchObject({ status: "completed" });
  });

  test("the schema requires the three fields Dispatched Code reads", () => {
    expect(REPORT_SCHEMA.required).toEqual(["status", "summary", "changes"]);
  });
});
