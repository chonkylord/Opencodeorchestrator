# Claude → OpenCode Subagent Orchestrator

An MCP server that lets Claude delegate implementation work to parallel OpenCode
workers, each isolated in its own git worktree, and see back only structured
results — never worker transcripts.

The full design is in [`projectplan.md`](projectplan.md).

## Status

**Phases 0, 1, 2 and 3 complete.** The architecture's OpenCode assumptions are
verified against a live server, the backend decision is recorded, the adapter that
isolates those assumptions is built, a worker goes from a one-line task to a
committed worktree and a structured result without a human in the loop — and
Claude can now drive that from a Claude Code session over MCP.

- [`docs/adr/0001-serve-vs-run-backend.md`](docs/adr/0001-serve-vs-run-backend.md) — ServeBackend accepted, with costs
- [`docs/adr/0002-worker-contract-channel.md`](docs/adr/0002-worker-contract-channel.md) — how the brief goes out and the report comes back
- [`docs/phase0-facts.md`](docs/phase0-facts.md) — verified API facts, and what is still unresolved
- [`src/opencode/`](src/opencode/) — the adapter. **The only code that knows OpenCode exists** (DD-2)
- [`src/manager/`](src/manager/) — the lifecycle: state machine, run loop, watchdogs, budgets, recovery
- [`src/mcp/`](src/mcp/) — the tool surface. **The whole of what Claude ever sees**
- [`docs/phase3-notes.md`](docs/phase3-notes.md) — the measurements Phase 3 took, and how to repeat them

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

**Phase 4 (isolation and the gated merge) is next** — see [`projectplan.md`](projectplan.md) §11.

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

That is the whole setup: with no configuration the server orchestrates the
directory the host launched it in.

### Configuration

Environment variables, because an MCP server is launched from a command line the
user writes once — flags there are invisible six months later, and a config file
is one more thing to find.

| Variable | Default | What it does |
|---|---|---|
| `ORCHESTRATOR_REPO` | `process.cwd()` | The repository workers branch from. Worktrees are created under `<repo>/.orchestrator/worktrees/`. |
| `ORCHESTRATOR_DB` | `<repo>/.orchestrator/orchestrator.db` | The SQLite index. `:memory:` works and means the run is not restartable. |
| `ORCHESTRATOR_MODEL` | `opencode/muse-spark-1.2-contributor-free` | `provider/model` for workers that do not name one. The default is free-tier and needs no credentials. |
| `ORCHESTRATOR_BASE_URL` | *(unset — spawn a server)* | Attach to an OpenCode server something else already owns, instead of spawning one. |
| `ORCHESTRATOR_VERIFY_TESTS` | `1` | Re-run the brief's test command after a worker finishes. Set `0` to turn the independent verification off; DD-4 is worth less without it. |

```bash
claude mcp add orchestrator \
  --env ORCHESTRATOR_REPO=/path/to/repo \
  --env ORCHESTRATOR_MODEL=anthropic/claude-sonnet-4 \
  -- bun run "$PWD/src/mcp/server.ts"
```

`.orchestrator/` is added to the repository's `.git/info/exclude` — local and
uncommitted, because your `.gitignore` is yours.

### The tools

| Tool | What it is for |
|---|---|
| `worker_spawn` | Delegate a task. Returns an id immediately; the work runs in the background. |
| `worker_status` | Where workers are. Cheap, safe to poll. |
| `worker_wait` | Block until one settles, capped. Cheaper than polling. |
| `worker_result` | The §4.3 result — the default thing to read. |
| `worker_output` | The lifecycle audit trail, paginated. Debugging only. |
| `worker_message` | Answer a blocked worker; the session is reused. |
| `worker_stop` | Graceful abort, with the worktree snapshotted. |
| `worker_list` | Inventory, filterable by state and run. |

Every one of them returns in under two seconds (DD-1); `worker_wait` is the
single bounded exception. The delegation heuristics from
[`projectplan.md`](projectplan.md) §7 and the DD-8 trust model — the worker's
summary is a *claim*, the discrepancies are the orchestrator's own finding —
live in the tool descriptions, because that is the only documentation a model
reliably reads.

`orchestrator_timeout_probe` is also registered and is **not** part of that
surface: it is the instrument that measured the host's tool-call ceiling
`worker_wait`'s cap sits under. See [`docs/phase3-notes.md`](docs/phase3-notes.md).

Phase 4's `workspace_merge` / `workspace_cleanup`, Phase 5's `dependsOn` and
Phase 6's `worker_revise` are deliberately absent rather than half-built — a
tool that promises a merge gate that does not exist is worse than no tool.

## Layout

```
spike/          Phase 0 verification script — the reference for adapter behavior
src/opencode/   The OpenCode adapter: interface, ServeBackend, RunBackend stub
src/manager/    Worker lifecycle: state machine, run loop, watchdogs, results
src/briefs/     Task brief out, report in, and the reconciliation between them
src/workspace/  Worktrees, snapshot commits, diff stats, independent test runs
src/store/      SQLite — an index over worktrees that carry their own manifests
src/mcp/        The MCP server and its eight tools — what Claude sees
test/ocmock/    Scriptable fake OpenCode server
test/fixtures/  The golden repo
docs/adr/       Decision records
```

Nothing outside `src/opencode/` may name an OpenCode endpoint, parse an OpenCode
event, or import past [`src/opencode/index.ts`](src/opencode/index.ts). That is what
keeps ADR-0001's backend choice reversible and confines API drift to one directory —
and `test/opencode/boundary.test.ts` fails the build if it stops being true.
