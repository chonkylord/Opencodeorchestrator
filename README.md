# Claude → OpenCode Subagent Orchestrator

An MCP server that lets Claude delegate implementation work to parallel OpenCode
workers, each isolated in its own git worktree, and see back only structured
results — never worker transcripts.

The full design is in [`projectplan.md`](projectplan.md).

## Status

**Phase 0 complete.** The architecture's OpenCode assumptions have been verified
against a live server; the backend decision is recorded.

- [`docs/adr/0001-serve-vs-run-backend.md`](docs/adr/0001-serve-vs-run-backend.md) — ServeBackend accepted, with costs
- [`docs/phase0-facts.md`](docs/phase0-facts.md) — verified API facts, and what is still unresolved

**Phase 1 (the OpenCode adapter) is next** — the handoff prompt is
[`docs/handoff-phase1.md`](docs/handoff-phase1.md).

## Requirements

- [Bun](https://bun.sh) (the spike and MCP server run under it)
- [OpenCode](https://opencode.ai) on `PATH` — verified against **1.18.23**
- A configured model provider (`opencode auth login`, or provider env vars)

```bash
npm install
```

## Run the Phase 0 spike

Creates a throwaway repo and worktree, starts `opencode serve`, drives a real
worker through to completion, and asserts every fact the architecture relies on.

```bash
bun run spike           # or: bun run spike/spike.ts --model provider/model --keep
```

It prints a fact table and exits non-zero if any assumption regressed — so it
doubles as a canary for OpenCode version drift. Re-run it on every OpenCode bump.

## Run the MCP server

```bash
claude mcp add orchestrator -- bun run "$PWD/src/mcp/server.ts"
```

Two Phase 0 tools: `orchestrator_hello` (connectivity) and
`orchestrator_timeout_probe` (measures the host's tool-call timeout — call it
with increasing `delayMs` until the host gives up, then record the ceiling in the
fact sheet; DD-1's budget depends on it).

## Layout

```
spike/      Phase 0 verification script — the reference for adapter behavior
src/mcp/    MCP server (Phase 0 scaffolding; Phase 3 builds this out)
docs/adr/   Decision records
```
