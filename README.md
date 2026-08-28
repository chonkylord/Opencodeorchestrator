# Claude → OpenCode Subagent Orchestrator

An MCP server that lets Claude delegate implementation work to parallel OpenCode
workers, each isolated in its own git worktree, and see back only structured
results — never worker transcripts.

The full design is in [`projectplan.md`](projectplan.md).

## Status

**Phases 0, 1 and 2 complete.** The architecture's OpenCode assumptions are
verified against a live server, the backend decision is recorded, the adapter that
isolates those assumptions is built, and a worker now goes from a one-line task to
a committed worktree and a structured result without a human in the loop.

- [`docs/adr/0001-serve-vs-run-backend.md`](docs/adr/0001-serve-vs-run-backend.md) — ServeBackend accepted, with costs
- [`docs/adr/0002-worker-contract-channel.md`](docs/adr/0002-worker-contract-channel.md) — how the brief goes out and the report comes back
- [`docs/phase0-facts.md`](docs/phase0-facts.md) — verified API facts, and what is still unresolved
- [`src/opencode/`](src/opencode/) — the adapter. **The only code that knows OpenCode exists** (DD-2)
- [`src/manager/`](src/manager/) — the lifecycle: state machine, run loop, watchdogs, budgets, recovery

What a worker's life looks like now: a worktree branched from a resolved sha, a
contract sent in the prompt's system field, an event stream watched by three
watchdogs, a snapshot commit the worker never makes itself, the repository's own
test suite re-run by the manager, and every claim in the worker's report checked
against `git diff` before Claude is told anything.

```
Worker: w-001 · model: opencode/muse-spark-1.2-contributor-free · mode: implement · status: completed · 15s · ~12,985 tok
Task: Add a `range` function to src/stats.js that returns the largest value minus the smallest.

Summary: Added `range(values)` to src/stats.js returning max-min with RangeError on empty input, and added
corresponding tests to test/checks.mjs. Verified range([3,1,4])===3 and range([]) throws RangeError, and npm test passes.
Changes (2 files, +18/−1): src/stats.js, test/checks.mjs
Tests: 4 passed / 0 failed / 0 skipped
Discrepancies: none
Snapshot: a7c6376179 on the worker's branch
```

**Phase 3 (the MCP tool surface) is next** — see [`projectplan.md`](projectplan.md) §11.

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
plus the lying-report hook Phase 2 reconciles against and a `format_unsupported`
scenario for providers that refuse schema-constrained output. It deliberately
reproduces the behaviours that are silent hangs against the real server:
directory-scoped event streams, a failed turn emitting two terminal events, and a
prompt sent too soon after one being accepted and dropped. Each of those hangs in a
three-second unit test here instead of for two minutes in production.

`test/fixtures/golden/` is the golden repo from §12: a dependency-free npm project
whose `npm test` really passes, materialized into a temp git repo per test, with a
switch that makes its suite fail on demand.

One integration test runs against a real `opencode serve`. It is gated because it
spends real tokens:

```bash
OC_E2E=1 bun test test/e2e                        # adapter and manager, end to end
OC_E2E=1 OC_E2E_CONCURRENCY=1 bun test test/e2e   # + four concurrent worktrees (§14 Q5)
OC_E2E=1 OC_E2E_AGENTS=1 bun test test/e2e        # + the AGENTS.md pickup probe
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
src/manager/    Worker lifecycle: state machine, run loop, watchdogs, results
src/briefs/     Task brief out, report in, and the reconciliation between them
src/workspace/  Worktrees, snapshot commits, diff stats, independent test runs
src/store/      SQLite — an index over worktrees that carry their own manifests
src/mcp/        MCP server (Phase 0 scaffolding; Phase 3 builds this out)
test/ocmock/    Scriptable fake OpenCode server
test/fixtures/  The golden repo
docs/adr/       Decision records
```

Nothing outside `src/opencode/` may name an OpenCode endpoint, parse an OpenCode
event, or import past [`src/opencode/index.ts`](src/opencode/index.ts). That is what
keeps ADR-0001's backend choice reversible and confines API drift to one directory —
and `test/opencode/boundary.test.ts` fails the build if it stops being true.
