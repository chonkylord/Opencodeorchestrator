/**
 * Phase 0 MCP scaffolding.
 *
 * Two tools, both deliberately minimal:
 *
 *   orchestrator_hello          proves the server is wired into the host
 *   orchestrator_timeout_probe  measures the host's tool-call timeout
 *
 * The probe exists because DD-1 ("all tools return in <2s; long work is
 * spawn-and-poll") is only justified if we know the real ceiling. Call it with
 * increasing delayMs until the host gives up; the largest delay that still
 * returns is the usable budget. Record the result in docs/phase0-facts.md.
 *
 * Wire it into Claude Code with:
 *   claude mcp add orchestrator -- bun run <repo>/src/mcp/server.ts
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({
  name: "opencode-orchestrator",
  version: "0.0.0-phase0",
});

server.registerTool(
  "orchestrator_hello",
  {
    title: "Orchestrator hello",
    description:
      "Phase 0 connectivity check. Returns immediately with the server's runtime facts. " +
      "Does not touch OpenCode, git, or the filesystem.",
    inputSchema: { name: z.string().optional().describe("Optional name to greet") },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  async ({ name }) => ({
    content: [
      {
        type: "text",
        text: JSON.stringify(
          {
            ok: true,
            greeting: `hello, ${name ?? "claude"}`,
            server: "opencode-orchestrator@0.0.0-phase0",
            runtime: process.version,
            pid: process.pid,
            cwd: process.cwd(),
          },
          null,
          2,
        ),
      },
    ],
  }),
);

server.registerTool(
  "orchestrator_timeout_probe",
  {
    title: "Host tool-call timeout probe",
    description:
      "Sleeps for delayMs, then returns. Used ONCE, during Phase 0, to find the host's " +
      "tool-call timeout: call with increasing delays until the call fails. This is a " +
      "measurement instrument, not part of the orchestrator's real tool surface — every " +
      "production tool returns in under 2 seconds (DD-1).",
    inputSchema: {
      delayMs: z
        .number()
        .int()
        .min(0)
        .max(600_000)
        .describe("How long to sleep before returning, in milliseconds"),
    },
    annotations: { readOnlyHint: true, openWorldHint: false, idempotentHint: true },
  },
  async ({ delayMs }) => {
    const started = Date.now();
    await new Promise((r) => setTimeout(r, delayMs));
    const actual = Date.now() - started;
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ requestedMs: delayMs, actualMs: actual, returned: true }, null, 2),
        },
      ],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
// stderr only — stdout is the JSON-RPC channel and must carry nothing else.
console.error("[orchestrator] MCP server ready on stdio");
