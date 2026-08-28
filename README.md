# Claude → OpenCode Subagent Orchestrator

An MCP server that lets Claude delegate implementation work to parallel OpenCode
workers, each isolated in its own git worktree, and see back only structured
results — never worker transcripts.

The full design is in [`projectplan.md`](projectplan.md).

## Status

**Phases 0 and 1 complete.** The architecture's OpenCode assumptions are verified
against a live server, the backend decision is recorded, and the adapter that
isolates every one of those assumptions is built and tested.

- [`docs/adr/0001-serve-vs-run-backend.md`](docs/adr/0001-serve-vs-run-backend.md) — ServeBackend accepted, with costs
- [`docs/phase0-facts.md`](docs/phase0-facts.md) — verified API facts, and what is still unresolved
- [`src/opencode/`](src/opencode/) — the adapter. **The only code that knows OpenCode exists** (DD-2)

**Phase 2 (the worker manager) is next** — see [`projectplan.md`](projectplan.md) §11.

## Requirements

- [Bun](https://bun.sh) (the spike and MCP server run under it)
- [OpenCode](https://opencode.ai) on `PATH` — verified against **1.18.23** and **1.18.25**
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

## Run the tests

```bash
bun test                 # unit + adapter tests against `ocmock`; no OpenCode needed
npx tsc --noEmit         # typecheck
```

`test/ocmock/` is a scriptable fake OpenCode server covering the five scenarios in
[`projectplan.md`](projectplan.md) §12 — success, hang, blocked, over-budget, crash —
plus the lying-report hook Phase 2 will reconcile against. It deliberately reproduces
OpenCode's directory-scoped event streams, so an adapter that forgets to scope a
subscription hangs in a three-second unit test instead of in production.

One integration test runs against a real `opencode serve`. It is gated because it
spends real tokens:

```bash
OC_E2E=1 bun test test/e2e                        # one worker, end to end
OC_E2E=1 OC_E2E_CONCURRENCY=1 bun test test/e2e   # + four concurrent worktrees (§14 Q5)
```

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
spike/          Phase 0 verification script — the reference for adapter behavior
src/opencode/   The OpenCode adapter: interface, ServeBackend, RunBackend stub
src/mcp/        MCP server (Phase 0 scaffolding; Phase 3 builds this out)
test/ocmock/    Scriptable fake OpenCode server
docs/adr/       Decision records
```

Nothing outside `src/opencode/` may name an OpenCode endpoint, parse an OpenCode
event, or import past [`src/opencode/index.ts`](src/opencode/index.ts). That is what
keeps ADR-0001's backend choice reversible and confines API drift to one directory —
and `test/opencode/boundary.test.ts` fails the build if it stops being true.
