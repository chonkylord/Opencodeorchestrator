# Claude → OpenCode Subagent Orchestrator

An MCP server that lets Claude delegate implementation work to parallel OpenCode
workers, each isolated in its own git worktree, and see back only structured
results — never worker transcripts.

The full design is in [`projectplan.md`](projectplan.md).

## Status

**Phases 0 through 5 complete.** The architecture's OpenCode assumptions are
verified against a live server, the backend decision is recorded, the adapter that
isolates those assumptions is built, a worker goes from a one-line task to a
committed worktree and a structured result without a human in the loop, Claude can
drive that from a Claude Code session over MCP, the work a worker produces can be
**taken** — merged one at a time into an integration branch behind a test gate,
and rolled back to the exact sha it started from when the gate goes red — and
several workers now run **at once**, under a cap, with a queue, dependencies
between them, and a markdown run report at the end.

What is still missing is the review loop: nothing can yet tell a worker it got
something wrong. That is Phase 6.

- [`docs/adr/0001-serve-vs-run-backend.md`](docs/adr/0001-serve-vs-run-backend.md) — ServeBackend accepted, with costs
- [`docs/adr/0002-worker-contract-channel.md`](docs/adr/0002-worker-contract-channel.md) — how the brief goes out and the report comes back
- [`docs/adr/0003-integration-worktree.md`](docs/adr/0003-integration-worktree.md) — where the merge runs, and why not OpenCode's own worktrees
- [`docs/adr/0004-queue-and-dependencies.md`](docs/adr/0004-queue-and-dependencies.md) — the queue across a restart, and what a failed dependency does to its dependents
- [`docs/phase0-facts.md`](docs/phase0-facts.md) — verified API facts, and what is still unresolved
- [`src/opencode/`](src/opencode/) — the adapter. **The only code that knows OpenCode exists** (DD-2)
- [`src/manager/`](src/manager/) — the lifecycle: state machine, run loop, watchdogs, budgets, recovery, and the admission gate
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

The merge never runs in your checkout. It runs in an integration worktree the
orchestrator creates under `.orchestrator/` and removes afterwards, so
`git reset --hard` — which is the rollback, on the path a merge pipeline exists
for — can never reach a file you have not committed. A green merge leaves a
branch and tells you where it is; landing it is yours to do.

```
Merge m-001 — MERGED GREEN. 2 worker(s) are on integration/m-001 at 4f1c8ade.
Took 6s · gate: `npm test`
  w-001: merged → 9b23f1c0 · tests green
  w-002: merged → 4f1c8ade · tests green

The work is on integration/m-001. Review it (worker_diff per worker), then land it yourself —
the orchestrator never writes to your branch or your working tree.
```

**Phase 5 (parallelism: the concurrency semaphore, the queue, `dependsOn` and
batched waits) is next** — see [`projectplan.md`](projectplan.md) §11.

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
| `ORCHESTRATOR_MAX_CONCURRENT` | `3` | How many workers may run at once — counting `preparing`, `running` and `blocked`. Spawns past it are **queued**, not rejected. Phase 1 measured four concurrent sessions on one server completing with no cross-talk; that is one run on one free-tier model, so the default leaves headroom inside it. Raise it after measuring your own provider under load, not before. Clamped to 1–32; an unparseable value falls back to the default rather than refusing to start. |

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
| `worker_wait` | Block until one — or any, or all, of several — settles, capped. Cheaper than polling. |
| `worker_result` | The §4.3 result — the default thing to read. |
| `worker_output` | The lifecycle audit trail, paginated. Debugging only. |
| `worker_message` | Answer a blocked worker; the session is reused. |
| `worker_stop` | Graceful abort, with the worktree snapshotted. |
| `worker_list` | Inventory, filterable by state and run. |
| `worker_diff` | The unified diff a worker produced, paginated under a 400-line cap. |
| `workspace_merge` | Start a gated merge of completed workers into an integration branch. |
| `workspace_merge_status` | Poll it: which workers merged, which one broke it, where it rolled back to. |
| `workspace_cleanup` | Prune worktrees and branches — and refuse, by default, to delete unmerged work. |
| `run_report` | The run's markdown audit trail: workers, spend, tests, discrepancies, merges, timeline. Written to `.orchestrator/runs/`. |

Every one of them returns in under two seconds (DD-1); `worker_wait` is the
single bounded exception. `workspace_merge` is no exception either: it runs a
test suite after **every** merge, which is minutes, so it validates, warns about
overlapping files and returns a handle to poll — the same spawn-and-poll shape as
everything else, for the same reason (the host abandons a tool call at 60 s). The delegation heuristics from
[`projectplan.md`](projectplan.md) §7 and the DD-8 trust model — the worker's
summary is a *claim*, the discrepancies are the orchestrator's own finding —
live in the tool descriptions, because that is the only documentation a model
reliably reads.

`orchestrator_timeout_probe` is also registered and is **not** part of that
surface: it is the instrument that measured the host's tool-call ceiling
`worker_wait`'s cap sits under. See [`docs/phase3-notes.md`](docs/phase3-notes.md).

Phase 6's `worker_revise` is deliberately absent rather than half-built — a tool
that promises a review loop that does not exist is worse than no tool.

### Running several workers at once

`worker_spawn` accepts more workers than the cap and **queues** the extras, in
spawn order, in the `spawned` state: nothing is allocated, no session is opened,
and — the part that is easy to get wrong — a queued worker's time limits do not
start until it actually runs. `worker_status` says which of two `spawned` workers
is about to start and which is third in line, because "next: worker_wait" is the
wrong advice for one of them.

`dependsOn` holds a worker back until the workers it names reach `completed`, and
a worker waiting on a dependency holds **no** slot — so a dependency can never be
queued behind its own dependent. A dependency that ends any other way (failed,
timed out, over budget, cancelled) **cancels** its dependents with a reason naming
it, and the cancellation cascades down the chain: waiting forever for something
that will never finish is the one outcome nothing in the system would report.
[ADR-0004](docs/adr/0004-queue-and-dependencies.md) has the reasoning, including
what happens to the queue across a restart (it does not survive one, and says so).

## Layout

```
spike/          Phase 0 verification script — the reference for adapter behavior
src/opencode/   The OpenCode adapter: interface, ServeBackend, RunBackend stub
src/manager/    Worker lifecycle: state machine, run loop, watchdogs, results, the queue
src/briefs/     Task brief out, report in, and the reconciliation between them
src/workspace/  Worktrees, snapshot commits, diffs, overlap, the gated merge, cleanup
src/store/      SQLite — an index over worktrees that carry their own manifests
src/mcp/        The MCP server and its thirteen tools — what Claude sees
test/ocmock/    Scriptable fake OpenCode server
test/fixtures/  The golden repo
docs/adr/       Decision records
```

Nothing outside `src/opencode/` may name an OpenCode endpoint, parse an OpenCode
event, or import past [`src/opencode/index.ts`](src/opencode/index.ts). That is what
keeps ADR-0001's backend choice reversible and confines API drift to one directory —
and `test/opencode/boundary.test.ts` fails the build if it stops being true.
