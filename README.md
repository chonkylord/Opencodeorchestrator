# Claude → OpenCode Subagent Orchestrator

An MCP server that lets Claude delegate implementation work to parallel OpenCode
workers — by default in your own repository, together, the way Claude's native
subagents work — and see back only structured results, never worker transcripts.

The full design is in [`projectplan.md`](projectplan.md).

## Status

**v1 is complete, with Phase 7's hardening and part of Phase 8's optimization — phases 0 through 7, and three of Phase 8's six items.** The architecture's OpenCode assumptions
are verified against a live server, the backend decision is recorded, the adapter
that isolates those assumptions is built, a worker goes from a one-line task to a
committed worktree and a structured result without a human in the loop, Claude can
drive that from a Claude Code session over MCP, the work a worker produces can be
**taken** — merged one at a time into an integration branch behind a test gate,
and rolled back to the exact sha it started from when the gate goes red — several
workers run **at once**, under a cap, with a queue and dependencies between them,
and Claude can now tell a worker it got something wrong: `worker_revise` sends
feedback to a worker's existing session, capped, with a read-only reviewer that
can be pointed at another worker's diff.

Phase 7 added what a system that runs unattended needs: a `kill -9` mid-run is
recovered rather than mourned (the worker is salvaged from its worktree into a
real result on a mergeable branch), a worker that exhausts its budget can be given
more and carried on instead of being lost, a run has a global token cap as well as
its per-worker ones, transient provider errors are retried with backoff, orphan
pruning respects a TTL, and a permission request is answered **in band** — the
worker waits at its tool call and carries straight on, where before every ask cost
it a partial turn.

Phase 8 added **shared workspaces** — every worker in your own checkout, seeing
each other's edits, which is now the default — plus **cross-model review**, where
a reviewer is routed away from the model that wrote the code so its critique is an
independent read rather than the author marking its own homework, along with
model-routing presets and worker priorities.

**What this is not.** Phase 8 is `(ongoing)` and two of its six items are not
here: **container sandboxing** is blocked in this environment rather than deferred
(the Docker client is installed and there is no daemon, so nothing written for it
could be run even once), and **smarter summarization** has no measurement saying
it is needed, §8's context targets having been verified as met in Phase 3.

Three things are still open, listed under "Unresolved" in
[`docs/phase0-facts.md`](docs/phase0-facts.md): `cost` unverified on a paid
provider (every run here has been free-tier, where it is always `0`), `RunBackend`
never built or exercised, and in-band replies to *questions* — permissions are
answered in band now, but a question's reply is a selection from labels the worker
offered rather than free text, so that half still costs a turn. One sharp edge is
recorded rather than fixed: a restarted manager mints worker ids from `w-001`
again, so it can collide with rows a dead one left.

- [`docs/adr/0001-serve-vs-run-backend.md`](docs/adr/0001-serve-vs-run-backend.md) — ServeBackend accepted, with costs
- [`docs/adr/0002-worker-contract-channel.md`](docs/adr/0002-worker-contract-channel.md) — how the brief goes out and the report comes back
- [`docs/adr/0003-integration-worktree.md`](docs/adr/0003-integration-worktree.md) — where the merge runs, and why not OpenCode's own worktrees
- [`docs/adr/0004-queue-and-dependencies.md`](docs/adr/0004-queue-and-dependencies.md) — the queue across a restart, and what a failed dependency does to its dependents
- [`docs/adr/0005-the-review-loop.md`](docs/adr/0005-the-review-loop.md) — why a revision re-enters the queue, which failure states may be revised, and what a reviewer is pointed at
- [`docs/adr/0006-hardening.md`](docs/adr/0006-hardening.md) — what a crash costs, what a budget buys, who decides a retry, and the endpoint the fact sheet had wrong
- [`docs/adr/0007-model-routing-and-review-diversity.md`](docs/adr/0007-model-routing-and-review-diversity.md) — why a reviewer is a different model, why it reads the code as the author left it, and what priorities may not do
- [`docs/adr/0008-shared-workspace.md`](docs/adr/0008-shared-workspace.md) — why workers share your checkout by default, what that costs in evidence, and the one operation that is still forbidden there
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

### Where workers work

By default, **in your repository, together** — like native subagents. They see
each other's files, nothing is committed for you, and when they finish the work is
simply there, uncommitted, for you to read:

```
w-001: completed | changed: src/geometry.js
  Workspace: your repository (shared), alongside 1 other worker: w-002.
  Git does not record which of them changed a file, so the split below is best-effort.
    Its own paths: src/geometry.js
    COULD BE ANYONE'S: src/strings.js — changed while it ran, owned by nobody.
    Already modified before it started (not its doing): NOTES.md
```

That last line is the point: your own half-finished work is never credited to a
worker. Give each worker `ownedPaths` and the middle line shrinks to nothing.

The orchestrator will write files into your tree. It will **never** commit, reset,
checkout or delete there — `git reset --hard` in your checkout is the one thing
[ADR-0003](docs/adr/0003-integration-worktree.md) forbade and Phase 8 did not move.

Pass `workspace: "isolated"` for a worker that should get its own worktree and
branch behind the test gate instead — stronger evidence, at the cost of it not
seeing its siblings' work.

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

A worker that got something wrong goes back to the same session rather than being
replaced, so it keeps everything it read and worked out. The rounds are capped,
and the cap is where the interesting part is: at it, `worker_revise` refuses with
a report of what was tried, what changed between rounds and what is still failing,
because a cap that stops the loop and says only "limit reached" has turned a
runaway into a dead end.

```
Revision refused: w-002 has already taken 3 of 3 rounds.

## What was tried (4 rounds)

**Round 0** (the original attempt) — the task as briefed
  outcome: `completed` — 1 file changed (+22/−1), 2 tests failing, 1 discrepancy
**Round 1**
  asked: » npm test still fails: sum([1,2,3,4]) returns 11, not 10.
  outcome: `completed` — 1 file changed (+22/−1), 2 tests failing

## What changed across the rounds

- Files touched went from 1 to 1; the diff is now +22/−1 against its base.
- Failing tests went from 2 to 2.
- **The diff did not move between the first and last round.** Feedback is reaching
  the worker and not changing what it produces, which usually means the feedback
  and the worker disagree about what the problem is.
```

A manager that dies mid-run is the case everything else here is built to survive.
The worktrees are the durable state (DD-7), so a restart does not ask the worker
what it did — it reads the repository:

```
[orchestrator] recovered 1 interrupted worker(s) from a previous process
AFTER RECOVER: interrupted | manager_restart
RECOVER: resuming
FINAL: completed
FILES: 2  src/stats.js, test/checks.mjs
TESTS: npm test — re-run by the orchestrator, green
SNAPSHOT: 4e1e271884
REPORT SOURCE: none
```

That is a real `kill -9`, 20 seconds into a real task: 205 insertions recovered,
committed and mergeable. `reportSource: none` is the honest part — the worker's
own report died with the process. Every measurement survived, and §4.3 has always
held that the measurements are the stronger half.

A reviewer is not the model that wrote the code. On the same diff, the author's own
model approved it; a different model approved it **and** noticed something the
first had not:

```
opencode/muse-spark-1.2-contributor-free   completed  0 files changed, 0 discrepancies  (same model)
  » Implementation Math.min(Math.max(value, lo), hi) correctly bounds value to [lo, hi].

opencode/ling-3.0-flash-fin-free           completed  0 files changed, 0 discrepancies  (cross-model)
  » The math is correct for all cases. However, no automated tests were added.
  » risk: No tests for clamp in test/checks.mjs — the test file still imports only
  »       { mean, median, sum }, despite the repo being designed so `npm test` means something.
```

Where no second model is configured the review still happens, and `worker_result`
says in so many words that it is a second opinion from the same mind rather than
independent evidence.

**The rest of Phase 8 is next** — see [`projectplan.md`](projectplan.md) §11.

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
| `ORCHESTRATOR_MAX_REVISIONS` | `3` | How many rounds of feedback one worker may take through `worker_revise`. At the cap the tool refuses with a report of what was tried, what changed between rounds and what is still failing — the refusal is the deliverable, not an error. `0` turns revisions off entirely, which is a legitimate setting rather than a typo, so it is clamped to 1–20 only at the top. An unparseable value falls back to the default. |
| `ORCHESTRATOR_MAX_RETRIES` | `2` | How many times a turn is re-sent after a provider error **the provider itself marks retryable** (exponential backoff from 1s, capped at 30s). A content filter or a bad request reproduces exactly and is failed on the first try rather than three times. `0` turns retries off; clamped to 0–10. |
| `ORCHESTRATOR_RUN_BUDGET_TOKENS` | `2000000` | §8's global cap, in tokens across every worker sharing a `runID`. Per-worker budgets stop one worker running away; this stops a *wave* doing it — six workers each dutifully inside their own ceiling still spend six ceilings. Refuses a spawn rather than killing what is running, and is checked again before a queued worker opens a session. `0` disables it; there is no upper clamp, because a big number is somebody who has measured their own spend. |
| `ORCHESTRATOR_MODEL_IMPLEMENT`<br>`ORCHESTRATOR_MODEL_RESEARCH`<br>`ORCHESTRATOR_MODEL_REVIEW` | *(unset)* | DD-9's per-mode model presets. Unset means every worker takes `ORCHESTRATOR_MODEL`. |
| `ORCHESTRATOR_REVIEW_POOL` | *(unset)* | Comma-separated models a `review` worker may be routed to, in preference order — the first that is **not** the model which wrote the code under review. This is what makes a critique an independent read rather than the author marking its own homework. Unset means reviews fall back to the preset or the default, which may well be the author's own model; `worker_result` says which kind of review you got either way. |
| `ORCHESTRATOR_WORKSPACE` | `shared` | Where workers work. `shared` puts every worker in **your repository**, together, the way Claude's native subagents behave — no branch, nothing committed for you, no merge because the work is already in your tree. `isolated` gives each its own worktree and branch behind the gated merge: stronger evidence, at the cost of workers not seeing each other. Only an exact `isolated` opts out; a typo leaves you on the default. Per-worker override: `worker_spawn({workspace})`. |

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
| `worker_revise` | Send a settled worker back with feedback; same session, capped, with a terminal report at the cap. |
| `worker_recover` | Resolve a worker a crash left behind: resume (or salvage from its worktree), fail, or discard. |
| `worker_budget` | Give a worker more tokens or wall clock, so an exhausted one can be carried on rather than lost. |
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

There is no `worker_review` tool, deliberately: a reviewer *is* a worker, so it is
spawned by `worker_spawn({mode: "review", reviewOf: "w-001"})` like any other. A
second spawn tool differing only in its mode would be the mistake a
`worker_wait_all` beside `worker_wait` would have been.

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
