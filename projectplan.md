# Claude → OpenCode Subagent Orchestrator

**Detailed Implementation Plan (v2)**

---

## 0. What this revision changes from the v1 draft

The concept is solid. The gaps were mostly engineering mechanics, not vision. Key improvements:

- **Async MCP pattern** — The draft implied Claude calls a tool and gets the worker's result back. MCP tool calls have host-side timeouts (tens of seconds). All long-running work must be spawn-and-poll, not blocking. This changes the tool surface design fundamentally.
- **Adapter layer around OpenCode** — OpenCode iterates fast and its API surface shifts. Every OpenCode-specific detail lives behind one interface so drift is a one-file fix, not a rewrite.
- **Self-report contract** — "Return structured results, not transcripts" becomes mechanical: workers write a report file to a known path, the manager parses it, and verifies claims against the actual git diff (trust but verify).
- **Session reuse for revisions** — When Claude says "fix these issues," the worker keeps its own context of what it built. Reusing the OpenCode session instead of spawning fresh is a major quality/cost win the draft missed.
- **Merge pipeline with test gates** — Parallel workers merging naively produces broken main branches. This plan defines a sequential merge with a test gate and auto-rollback after each merge.
- **Persistence and crash recovery** — A manager that dies mid-run leaves orphaned worktrees and half-merged state. SQLite-backed state from day one.
- **Phase 0 spike + acceptance criteria per phase** — Several OpenCode facts need verification before architecture locks in.
- **Explicit cost/context budgets and a security model** (prompt injection, permission scoping, untrusted output).

---

## 1. System Overview

The core economy of this system is **context**. Claude's context window is the scarcest resource; the whole architecture is a **context firewall** — Claude sees briefs, summaries, and diffs, never worker transcripts.

```
 User
  │
  ▼
Claude (Claude Code / Desktop — MCP host)
  │  sees only: tool results, structured reports, diff stats
  ▼
MCP Server (the orchestrator — this product)
  │
  ├─► Worker Manager ──► state machine, queue, budgets, persistence
  ├─► OpenCode Adapter ──► one `opencode serve` process, N sessions
  └─► Workspace Manager ──► git worktrees, diffs, gated merges
```

> **Note:** because the orchestrator is exposed via MCP, any MCP client can drive it — but tool descriptions and defaults are tuned for Claude.

---

## 2. Key Design Decisions

| # | Decision | Rationale |
|---|----------|-----------|
| DD-1 | All MCP tools return in <2s, except `worker_wait` (bounded ≤30s) | MCP hosts time out long calls; background execution + polling is the only workable pattern |
| DD-2 | Single `opencode serve` process hosting many sessions (default); one-process-per-worker as a config option | Sessions are cheap; enables session reuse for revisions; per-process isolation available when needed |
| DD-3 | TypeScript monorepo | MCP SDK and OpenCode SDK (`@opencode-ai/sdk`) are both first-class TS; one language for server, tests, fixtures |
| DD-4 | Workers report in their **final reply**; manager parses it and cross-checks against `git status`/`diff` | Structured results enforced by contract, not by hoping the model summarizes well. **Corrected in Phase 4:** this row still described the `report.json` channel that [ADR-0002](docs/adr/0002-worker-contract-channel.md) replaced in Phase 2 — the reply is the contract channel and `report.json` in the worktree is only a fallback, read when the reply is unusable. The cross-check against git is unchanged and is the half that matters. |
| DD-5 | Manager runs `git add -A && git commit` after every worker completion | Workers can't be trusted to commit; snapshotting makes diff/merge reliable |
| DD-6 | Sequential merge with per-merge test gate + auto-rollback | Prevents broken main from parallel merges |
| DD-7 | SQLite persistence from Phase 2 | Crash recovery and audit trails; worktrees are the durable state, DB is the index |
| DD-8 | Worker output treated as untrusted data; orchestrator never executes commands found in reports | Prompt-injection defense (repo content can hijack a worker; a hijacked worker must not hijack the orchestrator) |
| DD-9 | Task-type presets route to different models (research → cheap/fast, implement → mid, review → strong, ideally a different model family for diversity) | Cost economy is a core value prop: expensive Claude orchestrates, cheaper models execute |
| DD-10 | Support three worker modes: `implement`, `research` (read-only), `review` (read-only, critiques another worker's diff) | Not every subtask should produce edits |

---

## 3. Component Architecture

### 3.1 OpenCode Adapter

The only code that knows OpenCode exists. Two backends behind one interface:

**Built in Phase 1** — `src/opencode/`. The shipped interface, with the six places
the original sketch could not survive contact with OpenCode marked; each deviation
is argued at its definition in [`src/opencode/types.ts`](src/opencode/types.ts).

```ts
interface OpenCodeBackend {
  readonly kind: "serve" | "run"
  start(): Promise<void>
  health(): Promise<BackendHealth>                                  // [5] added
  createSession(opts: CreateSessionOptions): Promise<SessionHandle> // [3] agent != custom agent file
  prompt(session: SessionRef, req: PromptRequest): Promise<RunHandle>
  events(session: SessionRef, opts?): Promise<EventStream>          // [1] dir-scoped [4] eager
  abort(target: SessionRef): Promise<boolean>                       // [6] session-, not run-scoped
  usage(session: SessionRef): Promise<Usage | null>
  dispose(): Promise<void>
}
```

1. **Sessions are addressed by `{sessionID, directory}`, not a bare id.** SSE streams
   are directory-scoped; a subscription on the wrong directory delivers nothing, with
   no error. Carrying the directory in the type makes that structural.
2. **`RunHandle.runID` is minted by the adapter.** `prompt_async` answers `204` with an
   empty body — OpenCode never issues a run id.
3. **`agent` means a *built-in* agent.** The worker contract goes in `PromptRequest.system`;
   custom agent files are discovered only at server start, from the server's own cwd.
4. **`events()` returns a promise of an *open* stream**, not a lazy `AsyncIterable`, so
   "subscribe before you prompt" is what the natural code does.
5. **`health()` is new.** The §5 watchdog cannot tell a stuck worker from a dead server
   by stream silence alone; this plus `isWorkerEvent()` is how it does.
6. **`abort` is session-scoped.** OpenCode has no per-run abort.

- **`ServeBackend`** (default): starts/connects `opencode serve` (**`--port` defaults to `0` = random; parse the port from stdout — never assume 4096**), and subscribes to the SSE event stream **per worktree** (`GET /event?directory=…`) for completion detection.
- **`RunBackend`** (fallback): spawns `opencode run` subprocesses per prompt; more isolation, simpler, but weaker eventing.

### 3.2 Worker Manager

State machine, registry, task queue with concurrency semaphore, timeout/idle watchdogs, budget enforcement, report parsing, retry policy.

### 3.3 Workspace Manager

Git worktree lifecycle: create, snapshot-commit, diff (stat + paginated full), overlap detection between workers, gated sequential merge, cleanup/orphan pruning.

### 3.4 Store

SQLite: `workers`, `events`, `runs`, `merges` tables. Enables restart recovery and run reports.

### 3.5 MCP Server

Thin layer over the manager. Tool schemas, pagination, truncation defaults. **This is Claude's entire view of the system.**

---

## 4. Data Contracts

### 4.1 Task Brief

> **Corrected in Phase 2 ([ADR-0002](docs/adr/0002-worker-contract-channel.md)).** The brief
> is **not** written to the worktree. It splits in two and both halves go over the wire: the
> standing contract (everything below except the `Task:`/`Scope` lines) travels in the
> per-prompt **`system`** field and is re-sent on every turn, so a resumed worker cannot drift
> off it; the turn's instruction is the prompt text. `AGENTS.md` pickup *does* work — Phase 2
> settled that with a marker string and `docs/phase0-facts.md` §5 records it — but a brief
> written into the worktree is a file the worker can edit mid-run and a file the DD-4
> reconciliation then has to exclude from every diff it measures. Built by `src/briefs/brief.ts`.

```
Task: <one-line objective, from Claude's worker_spawn call>
Mode: implement | research | review
Worker ID: w-003
Base commit: <sha>

## Scope
<expanded task description>

## You own these paths
- src/settings/api.ts
- src/settings/store.ts

Do not edit files outside this list. If the task cannot be completed
without touching another file, stop and report status "blocked" with
the question — do not edit it anyway.

## Constraints
- Work only inside this worktree; never write outside it.
- Do not commit. The manager snapshots your work when you finish.
- Do not modify integration points (package.json, router indexes)
  unless explicitly listed above as yours.
- Follow existing conventions in the surrounding code.

## Definition of done
- <acceptance criteria>
- Test command `npm test` passes (run it yourself before reporting).

## Required output
When finished, reply with a single JSON object matching the schema in
§4.2 and nothing else. This is the only channel by which your work is
read — anything not in the report is invisible to the orchestrator.
(`report.json` in the worktree root is still read as a fallback if the
reply carries no usable report.)

Budget: ~$2.00 / 15 min wall clock. If you approach either, stop and
report what you have.
```

### 4.2 Worker Report

> **Corrected in Phase 2 ([ADR-0002](docs/adr/0002-worker-contract-channel.md)).** The report
> is the worker's **final message**, not a file. The manager asks OpenCode to constrain the
> reply to this schema (`format: {type: "json_schema", …}`), but that is an optimization, not
> the contract: it is implemented as a forced tool call and the free-tier model this project
> defaults to rejects it outright, so the manager drops the constraint and re-sends the turn,
> then stops asking for it on that backend. The brief states the contract in words either way,
> and `src/briefs/report.ts` parses leniently and records every repair it makes. A
> `report.json` at the worktree root is still read as §5's secondary signal when the reply
> yields nothing usable, and is excluded from the diff.

```json
{
  "workerId": "w-003",
  "status": "completed",
  "summary": "≤ 10 sentences, what was done and why",
  "changes": [
    { "file": "src/auth/login.ts", "action": "modified", "rationale": "..." }
  ],
  "tests": { "command": "npm test", "passed": 24, "failed": 0, "skipped": 2 },
  "risks": ["JWT expiry not configurable yet"],
  "questions": [],
  "followUps": ["suggest extracting JWT helpers into shared module"]
}
```

`status` is one of `completed` | `blocked` | `failed`. A `blocked` report is §5's escalation
channel: the worker stops, the manager surfaces `questions` to Claude, and the answer resumes
the same session.

**Verification step (critical):** the manager reconciles `changes[]` against the actual `git diff --name-only` and flags discrepancies in the result it returns to Claude. Workers will sometimes misreport. Implemented in `src/briefs/reconcile.ts`; the diff comes from **local git, not from the backend** — asking the worker's own server for the evidence would make the witness and the accused the same process.

### 4.3 Worker Result (what Claude actually sees)

```
Worker: w-003 · model: openai/gpt-4.1 · status: completed · 8m 12s · ~$0.31
Task: Implement settings API

Summary: <from report.json, capped at ~200 words>
Changes (5 files, +212/−38): src/settings/api.ts, src/settings/store.ts, ...
Tests: 24 passed / 0 failed   [manager re-ran independently ✓]
Discrepancies: none
Risks: JWT expiry not configurable yet
```

**Target: < 1,500 tokens per worker interaction.** Full diffs and logs available on demand via pagination.

---

## 5. Worker Lifecycle

```
            ┌───────────┐
 spawned ──▶│ preparing │──▶ running ──┬──▶ completed ──▶ merged
            │(worktree, │              ├──▶ blocked ──(Claude answers)──▶ running
            │  brief)   │              ├──▶ failed
            └─────┬─────┘              ├──▶ timed_out
                  ▼                    ├──▶ over_budget
               failed                  └──▶ cancelled
```

**Completion detection (belt and suspenders):**

1. **Primary:** SSE event stream indicates run finished.
2. **Secondary:** `report.json` appears in worktree.
3. **Watchdog:** no events for `idleTimeout` (default 3 min) → mark stuck, surface to Claude.
4. **Hard timeout** (default 15 min) → abort.

> **Phase 2, the hard way.** Two things about (1) that are not obvious and cost a
> two-minute silent hang each before they were found (`docs/phase0-facts.md` §4):
>
> - **A terminal event is scoped to the session, not to your prompt.** A failed turn emits
>   `session.idle` *twice*, ~30ms apart. Treat a turn as finished only once something proved
>   it started — `session.status {type:"busy"}` is that signal.
> - **A session silently drops a prompt sent immediately after a terminal event.** HTTP 204,
>   then nothing at all. Let it settle (~2s) before re-prompting. This applies to the
>   blocked→resume path below as much as to any retry.
>
> Also: the watchdog in (3) keys off *worker* events, not stream silence — liveness ticks
> arrive every 10s regardless, so a watchdog that resets on any frame never fires. Heartbeats
> with no worker events means the worker wedged; no heartbeats means the server died, which
> `health()` confirms. They are different failures and only one of them is `timed_out`.

**Blocked path:** worker stops and writes a `blocked` report → manager sets `blocked` → Claude sees `questions` → `worker_message(id, answer)` → same session resumes. This is the escalation channel — the only way a worker asks for help.

**Revision path:** `worker_revise(id, feedback)` sends feedback to the same session (worker retains full context of its own work). Revision counter per worker; at `maxRevisions` (default 3) the manager refuses and reports — prevents infinite fix loops.

> **Phase 6, as built.** This line predates every phase and survived all of them;
> what it could not say is where a revision *re-enters* the lifecycle. Since
> Phase 5, the concurrency gate sits between `spawned` and `preparing`, and a
> settled worker holds no slot — so a revision has to go back through the queue
> or it silently un-caps the whole system. The `revise` edges therefore land in
> **`spawned`**, not in `running`, and a revision that has to wait says `queued`
> on its record exactly as a queued spawn does.
>
> Two more things the line implies and does not state. **"Refuses and reports" is
> one act, not two:** at the cap the refusal *is* the report — what was tried each
> round, what changed between rounds, what is still failing, and Claude's options
> — because a cap that stops the loop and produces nothing to act on has converted
> a runaway into a dead end (§13). And **the revision counter is not `resumes`**:
> `resumes` counts the blocked→answer→resume path above, which is the worker
> asking a question, and until Phase 6 the status line rendered one under the
> other's name. They are separate counters now.
>
> `completed`, `failed`, `timed_out`, `over_budget` and `cancelled` may all be
> revised; `merged` may not, and neither may `blocked` (that is what the path
> above is for). See [ADR-0005](docs/adr/0005-the-review-loop.md).

---

## 6. Workspace Isolation & Merge Pipeline

### 6.1 Worktree operations

```
git worktree add .orchestrator/worktrees/w-003 -b worker/w-003 <base-sha>
```

Worker `cwd` = worktree root, set via `POST /session?directory=<worktree>`.

> **Phase 8: this is now the `isolated` mode, not the only mode.** The default is
> `shared` — the worker's `cwd` is the repository itself, alongside every other
> shared worker, with no worktree and no branch of its own. The `git worktree add`
> above still happens for `workspace: "isolated"`. See
> [ADR-0008](docs/adr/0008-shared-workspace.md), which also records the one rule
> that does not move: `git reset --hard` never runs in the user's checkout.

**Revised after Phase 0** — per-worktree file injection largely does not work under DD-2, and is not needed:

- **Permissions** — passed inline on session create (`permission: [{permission, pattern, action}]`). No `opencode.json` file. Verified.
- **Worker contract** — carried in the per-prompt `system` field on `prompt_async`, not `.opencode/agent/worker.md`. Custom agent files are only discovered at *server start from the server's own cwd*, so a running shared server will not see them. Verified.
- **Task brief** — delivered as the prompt itself. `AGENTS.md` in the worktree remains an option and is **verified** — Phase 2 confirmed OpenCode auto-loads it (`docs/phase0-facts.md` §5, probe in `test/e2e/manager.e2e.test.ts` behind `OC_E2E_AGENTS=1`). The brief still travels in the per-prompt `system` field, by choice rather than by necessity. *(Corrected in Phase 4: this line said "unverified" long after Phase 2 verified it.)*
- **Report contract** — carried in the brief's words, and read from the worker's final reply. *(Corrected in Phase 4: this line said to prefer `format: {type: "json_schema", …}`, which was written as "verified (schema)" and had never been sent. Phase 2 sent it: the free-tier model this project defaults to **rejects** schema-constrained output. The manager attempts it, drops it on rejection and stops asking on that backend — see [ADR-0002](docs/adr/0002-worker-contract-channel.md). The contract cannot depend on a feature the default model does not have.)*

On completion the manager runs `git add -A && git commit` to snapshot everything, then computes diffs. *(Phase 8: for `isolated` workers only. A `shared` worker's changes are left **uncommitted** in the user's tree — `git add -A` there would sweep up whatever else they had in progress, onto whatever branch they were on. The diffs are computed the same way either way.)*

Research/review workers: no worktree, or a read-only mount of the target worktree.

*(Resolved in Phase 6, and it is neither of those two.* A `review` worker gets its
**own** worktree at the target's base commit, with the target's diff quoted in its
brief. A mount of the target's worktree would make `buildResult()` measure the
*author's* changes as the reviewer's, so a read-only worker would settle with a
discrepancy for every file the author touched; no worktree at all would leave
`changedFiles("")` to manufacture a discrepancy about a diff the reviewer was
never supposed to have, and would give it nowhere to read the surrounding code
from. With its own checkout the reviewer's measured diff is genuinely empty, which
is what makes a reviewer that somehow writes something visible rather than
camouflaged. See [ADR-0005](docs/adr/0005-the-review-loop.md).)

### 6.2 Overlap detection (before merge)

After all workers in a wave finish, the manager computes intersections of changed-file sets:

- **Disjoint files** → merge in any order.
- **Shared files, different regions** → merge sequentially, test gate catches issues.
- **Shared integration files** (`package.json`, router indexes) → warn Claude up front; better: task planning assigns one worker ownership of integration points, or Claude does the wiring itself post-merge.

### 6.3 Gated merge pipeline

**Corrected in Phase 4 — where the merge runs.** The steps below were drawn
before there was a real repository to be careful about, and they do not say. They
must: `config.repoRoot` is a repository a human may have open, on a branch of
their choosing, with uncommitted work in it. Step 2's `git reset --hard` run
there destroys work the orchestrator never created and cannot restore. So every
step below runs in a **dedicated integration worktree**
(`.orchestrator/integration/<mergeID>` on branch `integration/<mergeID>`),
created for the merge and removed after it; the user's branch, index and working
tree are never written to, and landing the integration branch is a separate,
explicit, human act. See [ADR-0003](docs/adr/0003-integration-worktree.md).

**Also corrected: step 2's option (a) is not Phase 4's.** "Send the worker a
'rebase onto new base, resolve, re-test' message" is a revision, and the revision
loop is Phase 6's, with its caps. In Phase 4 a red gate rolls back and *reports*;
Claude may then answer or respawn.

1. Claude reviews each worker (report + diff), runs revision loops until satisfied or capped.
2. Merge **one at a time** into the integration branch. After each merge: run the test command.
   - **Green** → continue to next worker.
   - **Red** → `git reset --hard` to pre-merge SHA; surface to Claude with options: (a) send the worker a "rebase onto new base, resolve, re-test" message, (b) resolve manually, (c) reject.
3. Final full validation run on the integrated result.
4. Claude reports to user; manager cleans up worktrees/branches, writes the run report.

---

## 7. MCP Tool Surface

**Phase 3 corrections.** The rows below were drawn before anything was built.
Four of them were wrong about shapes that only became visible once the tools
existed, and are corrected **in place** rather than appended to; each says what
it used to claim. Rows marked ✅ are built and tested
([`src/mcp/tools.ts`](src/mcp/tools.ts), [`test/mcp/`](test/mcp/)).

| Tool | Params | Returns | Notes |
|------|--------|---------|-------|
| `worker_spawn` ✅ | `task`, `scope?`, `mode` (implement/research/review), `model?`, `ownedPaths?` (file paths/globs), `acceptance?`, `testCommand?`, `baseRef?`, `runID?`, `notes?`, `budget?`, `dependsOn?`, `reviewOf?`, `priority?` | `{workerID, branch, runID}` + whether it started or QUEUED | Returns in <2s; runs in background. **Corrected:** the param was `owns?` (renamed to match `WorkerSpec.ownedPaths`), and the return used to promise `worktree` — which DD-1 makes impossible, because the worktree is created in the background *after* spawn returns. It appears in `worker_status` once it exists. **Phase 5:** `dependsOn` is implemented, and the reply says whether the worker started or is queued — behind the cap, or behind a dependency — because "spawned" alone cannot tell those apart. A `dependsOn` that names an id nobody was handed is rejected at spawn, before a row is written. **Phase 6:** `reviewOf` points a `review` worker at another worker's diff — it gets its own worktree at that worker's base plus the diff quoted in its brief, and is rejected at spawn under the same rule as `dependsOn` if it names a worker nobody was handed or is passed without `mode: "review"`. There is no separate `worker_review` tool: a reviewer is a worker. **Phase 8:** a `review` worker is routed to a *different model* from the one that wrote the code where one is configured (`ORCHESTRATOR_REVIEW_POOL`), and `worker_result` says whether the review was independent; `priority` reorders the queue among workers that could all start now, and cannot promote a worker past its own dependency. **`workspace`** chooses where it works: `shared` (the default) is the user's own repository alongside every other shared worker — no branch, no snapshot commit, no merge — and `isolated` is the pre-Phase-8 worktree behind the gated merge. |
| `worker_status` ✅ | `ids?` | state, elapsed, last-activity age, revision count, ~cost, and the suggested next call | Cheap; safe to poll. With no `ids`, reports what is still active or blocked. |
| `worker_wait` ✅ | `id` **or** `ids`, `mode?` (any/all), `timeoutMs?` (≤30,000) | same as status, one line per worker | Bounded block; reduces polling chatter. Resolves on any settled state, `blocked` included. A timeout is not an error. **Corrected twice:** the param was `ids`, and Phase 3 narrowed it to one id because batched waits were Phase 5; **Phase 5 restored `ids`** — with a `mode`, because "wait for any" and "wait for all" are different questions and a wave needs both. It is one tool rather than two: a `worker_wait_all` beside it would differ only by a suffix. The 30,000 cap was a guess when written, is now half a measured host ceiling, and **does not move for a batch**; see [`docs/phase3-notes.md`](docs/phase3-notes.md). |
| `worker_result` ✅ | `id` | structured result (§4.3) | The default thing Claude reads. On a `blocked` worker it renders the *record* — there is no result until a worker settles, and blocking is not settling. |
| `worker_diff` ✅ | `id`, `paths?`, `cursor?`, `maxLines?` (default 400) | paginated unified diff | On-demand detail; **built in Phase 4** ([`src/workspace/diff.ts`](src/workspace/diff.ts)), where Phase 3 said the reader belonged. Pages by **line**, not by file — a cap that rounds up to whole files is not a cap. Untracked files are included, so a worker's diff does not go empty just because DD-5's snapshot has not run yet; a worker whose worktree has been cleaned up is diffed from its snapshot commit instead. |
| `worker_output` ✅ | `id`, `cursor?`, `limit?` (default 50 events) | paginated event log tail | Debugging only. Lifecycle-grained, never the transcript — that is what the firewall keeps out. |
| `worker_message` ✅ | `id`, `message`, `decision?` (allow/deny) | confirmation; poll `worker_status` | Answers a blocked worker; session reused. **Phase 7:** a worker stopped by a *permission* wall is answered **in band** — its turn is never aborted, it waits at the tool call and carries straight on — which is what `decision` is for, because free text cannot be turned into allow/deny reliably and guessing permissively defeats §8's jail signal. A worker that stopped to *ask* still has its turn ended and gets the answer as its next prompt. **Corrected:** it does not return a "new run id" — no run is created, because the point is that the *same* session continues. It also returns before the worker has resumed (DD-1): `manager.answer()` waits out the session settle guard, which is seconds. |
| `worker_revise` ✅ | `id`, `feedback` | revision number, or the terminal report at the cap | Review-loop entry point; session reused; capped (`ORCHESTRATOR_MAX_REVISIONS`, default 3). **Built in Phase 6.** **Corrected:** it does not simply return "a revision number" — at the cap it returns §13's *terminal actionable report* instead, which is the half that mattered, and the row as written made the refusal sound like an error. Two other things this row could not have known: a revision **re-enters the concurrency queue** (a settled worker holds no slot, so a revision that skipped the gate would silently un-cap the system), so a revised worker goes back to `spawned` before it runs and the reply says whether it started or queued, exactly as `worker_spawn`'s does; and the worker leaves its settled state *before the call returns*, so a following `worker_wait` waits for the new round rather than returning the pre-revision record. See [ADR-0005](docs/adr/0005-the-review-loop.md). |
| `run_report` ✅ | `runID?`, `write?` | markdown audit trail — workers, models, spend, tests, discrepancies, merge outcomes, timeline | **Added in Phase 5**, and required by §8's "every run emits a markdown audit trail". §7 never listed it because §8 described it as a by-product rather than a tool; it is a tool, because a run has to be *asked* for its report. Written to `.orchestrator/runs/<runID>.md` and excerpted on the wire — a full report over six workers is the largest thing this surface produces. Worker claims are quoted and capped; the measurements are not. |
| `worker_recover` ✅ | `id`, `action` (resume/fail/discard) | confirmation; poll `worker_status` | **Added in Phase 7**, and required by §9: `recover()` has turned a dead process's rows into `interrupted` since Phase 2 — "a decision point, not a verdict" — and nothing could take the decision. Fires the three edges out of `interrupted` the state machine enumerated and never used. `resume` re-attaches when the session survived and **salvages from the worktree** when it did not, which is the ordinary case; either way the worker ends settled with a measured result on a mergeable branch. `fail` and `discard` settle it and keep the worktree — nothing here deletes work. There is no `retry` action: re-running the same instruction is a new `worker_spawn`. |
| `worker_budget` ✅ | `id`, `tokens?`, `wallClockMs?` | the new ceilings | **Added in Phase 7**, and required by §8's *"on exceed: pause + surface to Claude"* — until now only the surfacing was true. Additive, written to the spec so it survives a restart, and effective immediately on a running worker. It deliberately does **not** resume: `worker_revise` does that, and the refusal an over-budget worker gets from it names this tool. |
| `worker_stop` ✅ | `id`, `reason?` | confirmation; poll `worker_status` | Graceful abort + snapshot. Returns before the worker has stopped, for the same DD-1 reason as `worker_message`. |
| `worker_list` ✅ | `state?`, `runID?` | worker summaries | |
| `workspace_merge` ✅ | `workerIDs`, `testCommand?`, `runTests?` (default true), `integrationBranch?`, `continueOnFailure?`, `runID?` | `{mergeID, integrationBranch}` + the §6.2 overlap warning, immediately | Sequential merge, test gate after **each**, `git reset --hard` on red, in a dedicated integration worktree. **Corrected:** the params were `id`, `strategy?` and the return was a "merge + test-gate result" — three things this row got wrong. It takes a *set* of workers, because a merge is about a wave; `strategy` was never meaningful (git's own merge is the merge, per §5's scope); and it **cannot be synchronous** — the gate runs the test suite after every merge and the host abandons a tool call at 60 s, so it returns a handle. See [ADR-0003](docs/adr/0003-integration-worktree.md). |
| `workspace_merge_status` ✅ | `mergeID?`, `runID?` | merge + test-gate result, per step | **Added in Phase 4**, and required by the row above: an async merge needs a poll. Names which worker broke it, how, and the sha the branch was rolled back to. With no `mergeID` it lists. |
| `workspace_cleanup` ✅ | `ids?`, `force?`, `scan?`, `pruneOrphans?` | what was pruned, what was **kept** and why, plus the §9 orphan scan | Prunes worktrees/branches. A branch is deleted only if its commits are already contained in HEAD or an integration branch; an unmerged branch is kept with the reason, because it is the only copy of what its worker produced (DD-7). `force` deletes those commits and the description says so in those words. Orphans are reported, never pruned, unless asked. **Phase 7** added §9's `orphanTtlMs`: an orphan carries an age and pruning refuses anything younger than 24h, or of unknown age — the orphan a scan most often meets on a busy machine is another orchestrator's live worktree. |

**Delegation heuristics live in the tool descriptions** so Claude self-calibrates:

- **Delegate:** multi-file implementation, test authorship, mechanical refactors, parallelizable chunks, anything where executing (edit-run-debug cycles) dominates.
- **Don't delegate:** single-file small edits, codebase questions (read directly), architectural decisions.
- **Batch** related work per worker (amortize session warm-up); prefer **2–5 parallel workers** — merge pain grows superlinearly beyond that.

---

## 8. Context, Cost & Security Policies

**Context budget** (defaults, all configurable): result summaries <1.5k tokens; diff stat always / full diff on demand with 400-line cap; event log pages of 50; per-run Claude-side target <5k tokens per worker round.

**Cost controls:** per-worker cap (~$2 or token-equivalent if usage isn't exposed — verify in Phase 0) → on exceed: pause + surface to Claude; global run cap; model presets per task type; usage logged per worker in the run report.

> **Built in Phase 7, and the dollars are still not real.** The per-worker cap is on **tokens**, because Phase 0 verified `cost` is `0` on free-tier providers and a dollar cap silently never fires ("Unresolved" 4 is still open, still blocked on a paid key). "Pause + surface" is `worker_budget`: an over-budget worker keeps its session and its work, and a grant plus a `worker_revise` carries it on — before Phase 7 the surfacing happened and the pause was a dead end. The **global run cap** is `ORCHESTRATOR_RUN_BUDGET_TOKENS`, per `runID`, checked at spawn *and* before a queued worker opens a session, because the spend that matters accrues while a worker waits. Model presets per task type remain configuration (`models` per mode) and nothing selects between them automatically; that is §11 Phase 8. See [ADR-0006](docs/adr/0006-hardening.md).

**Security:**

- Permissions per worker type (implement: edit+bash; research/review: read-only).
- Workers jailed to worktree `cwd`; manager detects out-of-tree writes via `git status` and flags them.
- Worker output = **untrusted text**. The manager never executes anything from reports. Tool descriptions tell Claude to treat worker summaries as *claims*, backed by verified diffs.
- Optional later: container/direnv sandboxing per worktree for stronger isolation.
- **Secrets:** workers inherit env — consider a per-worker env allowlist if this runs anywhere sensitive.

**Run reports:** every run emits a markdown audit trail — timeline, workers, models, costs, test results, merge outcomes, discrepancies. This is also the demo artifact and debugging tool.

---

## 9. Persistence & Recovery

- SQLite is the source of truth for worker/merge state; worktrees hold the actual work.
- On manager restart: scan DB → `running` workers become `interrupted` → check worktree + session liveness → offer Claude: resume monitoring, retry, or fail-and-cleanup.
- Orphan scan: `worker/*` branches and worktrees with no DB row older than TTL → report or prune.

> **Built in Phase 7.** `worker_recover(id, action)` is the offer, with one
> correction to the line above: the three actions are **resume / fail / discard**,
> not "retry" — re-running the same instruction is a new `worker_spawn`, and a
> retry inside the run loop is a different thing entirely (a turn re-sent after a
> provider error). Session liveness is checked with `usage()`, which answers
> `null` for a session the backend does not know; when it is gone, `resume`
> **salvages from the worktree** rather than refusing, which is what makes a
> `kill -9` cost a turn rather than the work. The orphan TTL is 24 h and treats an
> orphan whose age cannot be determined as too young to touch. See
> [ADR-0006](docs/adr/0006-hardening.md).

---

## 10. Repository Layout

```
orchestrator/
  src/
    mcp/            # MCP server, tool schemas, truncation
    manager/        # state machine, queue, watchdogs, budgets
    opencode/       # adapter: ServeBackend, RunBackend
    workspace/      # worktree ops, overlap detection, merge gate
    store/          # SQLite
    briefs/         # task brief + report templates
  test/
    ocmock/         # scriptable fake OpenCode server
    fixtures/       # golden repo (small npm project with tests)
    e2e/
  docs/adr/         # decision records (DD-1..10)
```

---

## 11. Implementation Phases

Each phase ends at a testable state. Estimates assume a single experienced dev.

### Phase 0 — Spike & verification ✅ COMPLETE

> Outcome: [`docs/adr/0001-serve-vs-run-backend.md`](docs/adr/0001-serve-vs-run-backend.md) (ServeBackend accepted) and [`docs/phase0-facts.md`](docs/phase0-facts.md). AC met by `spike/spike.ts`, green against OpenCode 1.18.23. Five items remain unresolved and are listed at the end of the fact sheet.

Validate every uncertain OpenCode fact before committing to architecture:

- `opencode serve` + SDK: create session, send prompt, receive SSE events, abort; event shapes.
- **Session resume:** does prompting an existing session keep context? (Critical for `worker_revise`.)
- **Headless permissions:** does `opencode.json` permission config auto-approve edits/bash? Any prompts that block headless runs?
- Usage/cost data availability per session.
- Exact flags for `opencode run` (`--session`, model, agent, JSON output).
- Custom agent files (`.opencode/agent/*.md`) and `AGENTS.md` pickup.
- MCP hello-world tool wired into Claude Code; measure the host's tool-call timeout.

**Deliverable:** decision record choosing Serve vs Run backend; documented API facts; MCP scaffolding works.
**AC:** a script creates a session, prompts it to create a file, verifies the file, and captures the completion event.

### Phase 1 — OpenCode adapter ✅ COMPLETE

> Outcome: [`src/opencode/`](src/opencode/) — [`types.ts`](src/opencode/types.ts) (the interface and its six documented deviations from the §3.1 sketch), [`serve.ts`](src/opencode/serve.ts) (`ServeBackend`), [`run.ts`](src/opencode/run.ts) (`RunBackend`, a deliberate stub per ADR-0001), [`index.ts`](src/opencode/index.ts) (the barrel — the only import path anything else may use). Tests: [`test/ocmock/`](test/ocmock/) (scriptable fake server, all five §12 scenarios plus the lying-report hook) and [`test/`](test/) — 56 unit tests green, plus one integration test green against real OpenCode 1.18.25 behind `OC_E2E=1`. `bun run spike` still green. §14 Q5 (concurrency) is resolved on the way past; see the fact sheet.

- Implement `OpenCodeBackend` + `ServeBackend` (+ `RunBackend` stub if time).
- Config injection: model, agent, permissions, cwd.

**AC met:** `bun test` (56 pass) against `ocmock`; `OC_E2E=1 bun test test/e2e` passes against a real `opencode serve`.

Two things worth knowing before Phase 2 builds on this:

- **`events()` hands back a shared, explicitly-closed subscription.** Breaking out of a
  `for await` does *not* end it — that is what makes the blocked→answer→resume path in §5
  a single stream rather than three. Call `close()`, or let `dispose()` do it.
- **The boundary is enforced, not just asserted.** `test/opencode/boundary.test.ts` fails
  if anything outside `src/opencode/` names an endpoint, parses an OpenCode event type, or
  imports past the barrel.

### Phase 2 — Worker manager core ✅ COMPLETE

> Outcome: [`src/manager/`](src/manager/) — [`state.ts`](src/manager/state.ts) (§5 enumerated as data; illegal transitions throw), [`worker.ts`](src/manager/worker.ts) (registry, run loop, watchdogs, budgets, recovery), [`result.ts`](src/manager/result.ts) (§4.3, under the 1.5k-token cap), [`types.ts`](src/manager/types.ts). Plus [`src/briefs/`](src/briefs/) (brief builder, report parser, and the DD-4 reconciliation), [`src/workspace/`](src/workspace/) (worktree, DD-5 snapshot commit, diff stat, independent test re-run), and [`src/store/`](src/store/) (SQLite over worktrees that carry their own manifests). Channel decisions recorded in [ADR-0002](docs/adr/0002-worker-contract-channel.md); §4.1, §4.2 and §5 above are corrected where they were stale. Tests: 90 new, 146 total green, plus [`test/fixtures/`](test/fixtures/) (the golden repo §12 asked for) and [`test/e2e/manager.e2e.test.ts`](test/e2e/manager.e2e.test.ts) green against real OpenCode 1.18.25.

- State machine, registry, SQLite store, task-brief builder, report parser + diff reconciliation, timeout/idle watchdogs.

**AC met**, each with the test that shows it (`test/manager/lifecycle.test.ts` unless noted):

- **Full spawn→running→completed on the golden repo** — `test/e2e/manager.e2e.test.ts`: a real worker adds `range()` to the fixture, the manager snapshots the worktree, re-runs `npm test` itself, and reconciliation finds nothing to disagree with. 15s, ~13k tokens, result rendered in under 500 characters.
- **Blocked path works** — the worker reports `blocked`, the manager surfaces the questions, `answer()` resumes **the same session on the same subscription**, and the run completes. A mid-run permission wall becomes the same escalation rather than a hang.
- **Timeout aborts** — and lands in `timed_out`, not `failed`. An abort emits an error *then* idle; the manager records why it aborted before asking, so the intent decides the state. Hard deadline and idle watchdog are distinguished, as are a wedged worker and a dead server.
- **Manager restart recovers state** — `halt()` kills the manager the way a crash does, writing nothing; a second manager on the same database turns the stale `running` rows into `interrupted` with their worktrees untouched. A *lost* database is rebuilt from the worktree manifests (DD-7).
- **Reconciliation catches a lying report** — `ocmock`'s `lying_report` claims two files and touches none; both are in the result, and the run still completes, because the discrepancies are the finding.

Three things worth knowing before Phase 3 builds on this:

- **`format: json_schema` does not work on the default free-tier model.** It was "verified (schema)" and had never been sent. The manager attempts it, drops it on rejection and stops asking on that backend; the report contract lives in the brief's words either way. See ADR-0002.
- **A terminal event does not mean *your* turn ended, and a session drops a prompt sent right after one.** Both are in §5 above and in the fact sheet. They are the two bugs most likely to be reintroduced by anyone touching the run loop.
- **Phase 0's `AGENTS.md` question is closed** (it is auto-loaded), and one new open item is recorded: the adapter still has no way to *answer* a permission or question request in band.

### Phase 3 — MCP server ✅ COMPLETE

> Outcome: [`src/mcp/`](src/mcp/) — [`server.ts`](src/mcp/server.ts) (one pre-warmed backend, one index, one manager; `recover()` and `rebuildIndex()` run before the transport is connected, so no `worker_spawn` can race them), [`tools.ts`](src/mcp/tools.ts) (the eight tools, and the descriptions that are the actual product), [`render.ts`](src/mcp/render.ts) (§8's caps, and the plain-text rendering that keeps a round trip under 2k tokens), [`config.ts`](src/mcp/config.ts) (`ORCHESTRATOR_REPO` / `_DB` / `_MODEL` / `_BASE_URL` / `_VERIFY_TESTS`, all defaulted — documented in the [README](README.md#configuration)). §7's table is corrected in place above: four rows described shapes that turned out to be impossible or renamed. Measurements and method in [`docs/phase3-notes.md`](docs/phase3-notes.md). Tests: [`test/mcp/`](test/mcp/) — 24 new, 171 total green, every one driven over real JSON-RPC through the SDK's `InMemoryTransport` rather than by calling handlers.

- Tools: spawn, status, wait, result, output, stop, list — plus `worker_message`, which §11 did not name and the blocked path is useless without: a worker that asks a question nobody can answer is a worker that times out. Async pattern + pagination.

**AC met:**

- **Claude drove a worker to completion from a live Claude Code session** — the golden repo, the orchestrator registered over `--mcp-config`, and **only** orchestrator tools allowed, so Claude could not have touched the repository itself. Four tool calls: spawn (with `scope`, `ownedPaths`, `acceptance` and `testCommand` it was never told to fill in), wait, result. The worker added `range()` and its tests on `worker/w-001`; Claude reported back that "the orchestrator independently re-ran the test suite itself" and agreed with the worker — the DD-8 distinction, arrived at from the tool descriptions alone.
- **Context grew by ~278 tokens, against a budget of 2,000.** 1,112 characters of tool results over the whole interaction, ÷4. The worker spent ~15,800 tokens doing the work, so the §1 firewall passes through about 1.8%. The same measurement runs in the suite as an assertion, so a rendering change that inflates it fails the build.
- **Every tool returns in under two seconds**, `worker_wait` excepted and capped at 30,000 ms — now **half a measured ceiling** rather than a guess. Phase 0's unresolved item 1 is closed: Claude Code 2.1.251's MCP tool-call timeout is **60 s**, and the host names it in the error.
- **The full loop works over JSON-RPC against `ocmock`:** spawn → poll → result, blocked → message → completed, stop. `worker_stop` and `worker_message` start their operation and return, because `cancel()` and `answer()` deliberately do not resolve until the worker has genuinely moved; `ocmock` gained an `abortDelayMs` knob so that "returned while the worker was still running" is asserted rather than raced.

Three things worth knowing before Phase 4 builds on this:

- **`worker_diff` is not built.** §7 lists it, §11 does not, and the workspace layer has `diffStat` but no paginated unified diff. It belongs in `src/workspace/`, under §8's 400-line cap, and Phase 4 needs it anyway for overlap detection.
- **The run loop was starving its own watchdogs**, and a chatty worker was the case that broke it — text deltas arrive faster than the tick, and the watchdogs only ran when the tick won the race. The token budget therefore never fired for the runaway workers it exists to stop. Fixed, with a deterministic regression test. See [`docs/phase3-notes.md`](docs/phase3-notes.md) §5.
- **A completed worker used to keep a stale `reason`**, so a worker that blocked, was answered and then finished read `completed: reported_blocked` on every status line. `WorkerResult` was always right; the record was not.

### Phase 4 — Isolation & merge ✅ COMPLETE

> Outcome: [`src/workspace/`](src/workspace/) gained its second half — [`diff.ts`](src/workspace/diff.ts) (the paginated unified diff, §8's 400-line cap, line-cursored), [`overlap.ts`](src/workspace/overlap.ts) (§6.2's intersection and, the actual product, its classification), [`merge.ts`](src/workspace/merge.ts) (§6.3's sequential gated pipeline with auto-rollback, run in a dedicated integration worktree) and [`cleanup.ts`](src/workspace/cleanup.ts) (pruning that cannot destroy unmerged work, plus §9's orphan scan). [`src/manager/merges.ts`](src/manager/merges.ts) makes a merge a first-class, pollable entity and fires the `completed → merged` edge Phase 2 enumerated and never used; [`src/store/schema.ts`](src/store/schema.ts) gained the `merges` table it had deliberately held back. Four tools in [`src/mcp/tools.ts`](src/mcp/tools.ts): `worker_diff`, `workspace_merge`, `workspace_merge_status`, `workspace_cleanup`. Decisions in [ADR-0003](docs/adr/0003-integration-worktree.md). §2's DD-4 row, §6.1, §6.3 and four §7 rows are corrected in place above. Tests: 49 new, **220 total green** (4 skipped), the merge suites against real git repositories and the tool suites over real JSON-RPC. `bun run spike` still green against OpenCode 1.18.25.

- WorktreeManager, per-worker config injection, snapshot commits, diff tooling, overlap detection, gated merge with auto-rollback, cleanup.

**AC met**, each with the test that shows it:

- **Two workers on disjoint files merge green** — over real JSON-RPC in [`test/mcp/workspace.test.ts`](test/mcp/workspace.test.ts): two real workers, two worktrees, two snapshot commits, `npm test` as the gate after *each* merge, and both files on the integration branch afterwards according to `git ls-tree`. Both workers land in `merged`.
- **A seeded conflicting merge is detected and rolled back** — [`test/workspace/merge.test.ts`](test/workspace/merge.test.ts) asserts the integration branch is **bit-identical** to its pre-merge sha, not that nothing threw. A rollback that throws nothing and restores nothing is invisible to any weaker assertion.
- **A failed test gate restores pre-merge state** — using `breakGoldenRepo()`, so the suite fails on an assertion rather than a stubbed exit code. §13's flaky-test mitigation is in: a red suite is re-run **once** before it is believed, and the result says it was.
- **The user's checkout is untouched** — tested rather than asserted in prose: the fixture's working tree is dirtied (a modified tracked file and an untracked one), a full merge-and-rollback cycle runs, and `git status`, HEAD, the current branch and both files are unchanged. This is the property ADR-0003 exists for.
- **Every tool returns in under two seconds**, `workspace_merge` included — it validates, computes the overlap warning and returns a handle before the gate has run.

Four things worth knowing before Phase 5 builds on this:

- **`workspace_merge` cannot be synchronous, and a merge is its own entity.** §7's row promised a "merge + test-gate result"; the gate runs a test suite and the host abandons a tool call at 60 s. The handle is a row in the new `merges` table rather than a field on a worker, because a merge is about a *set* — "which worker broke it" is only answerable when the others are named alongside. ADR-0003 has the reasoning.
- **OpenCode's native worktree endpoints were evaluated on the wire and declined.** Not on principle: they name their own branches (`opencode/<name>`, the requested name is silently overridden), take no base ref, put worktrees in OpenCode's data directory rather than the repository, and their delete removes the branch with the worktree and no merged check. The second of those would quietly invalidate §6.2's overlap test, which is only valid because every worker in a run branches from one resolved sha. `docs/phase0-facts.md` §6's warning is closed rather than deferred again.
- **A `completed` worker may have nothing to merge, and that is an outcome.** `snapshotCommit` returns `{committed: false}` when a worker changed nothing, so `result.snapshot.sha` is absent on exactly the workers most worth being suspicious of. `nothing_to_merge` is reported and the worker stays `completed` — marking it `merged` would put a false row in the run report.
- **Cleanup's default is the safe half.** An unmerged branch is kept with its reason; `force` deletes commits that exist nowhere else and says so in those words; orphans are reported, not pruned. DD-7 means a worker's branch is the only copy of what it produced.

### Phase 5 — Parallelism ✅ COMPLETE

> Outcome: [`src/manager/scheduler.ts`](src/manager/scheduler.ts) — the admission gate: the cap, the FIFO queue, `dependsOn` with cycle detection and a failed-dependency rule; [`src/manager/runreport.ts`](src/manager/runreport.ts) — §8's markdown audit trail; `worker_wait` in [`src/mcp/tools.ts`](src/mcp/tools.ts) gained `ids` + `mode`, `worker_spawn` gained a working `dependsOn`, `worker_status` learned to tell a queued worker from one about to start, and `run_report` is new. `ORCHESTRATOR_MAX_CONCURRENT` joins the [README](README.md#configuration)'s table. Decisions in [ADR-0004](docs/adr/0004-queue-and-dependencies.md). §7's `worker_spawn` and `worker_wait` rows are corrected in place above and `run_report` is added to them; the AC below is corrected rather than reinterpreted. Tests: 39 new, **259 total green** (4 skipped) — [`test/manager/scheduler.test.ts`](test/manager/scheduler.test.ts), [`test/manager/runreport.test.ts`](test/manager/runreport.test.ts), [`test/mcp/parallel.test.ts`](test/mcp/parallel.test.ts). `bun run spike` still green against OpenCode 1.18.25.

- Concurrency semaphore (default max 3–4), queue, `dependsOn`, batched `worker_wait`.

**AC — corrected.** This row read: *"v1 demo: 'Add a settings page' — 3 concurrent workers (UI / API / tests, mixed models), review, **revisions**, gated merges, final validation, run report. This is the project's definition of done for v1."* Revisions are `worker_revise`, which is Phase 6 — the AC as written spanned both phases and could not be met by this one. It is split rather than reinterpreted, in the same house style as the four §7 rows and the §6 lines corrected before it:

- **Phase 5's AC** is *three workers run concurrently under the cap, a dependent worker waits for its dependency, and the wave reaches a gated merge and a run report.*
- **The full v1 demo, revisions included, is Phase 6's**, and is run once, at the end of Phase 6. It remains the project's definition of done for v1. *(Run on 2026-08-29 — see Phase 6 below.)*

**Phase 5's AC met**, each with the test that shows it:

- **Three workers run concurrently under the cap, and a dependent waits** — [`test/mcp/parallel.test.ts`](test/mcp/parallel.test.ts), over real JSON-RPC: four workers against a cap of three, sampled on their *records* while the wave runs, so a semaphore that counts correctly and gates nothing fails. Peak admitted is exactly 3, never 4; the fourth depends on the API worker and is not prompted until that worker has settled. The wave then reaches `MERGED GREEN` through `workspace_merge` and a `run_report` naming every worker and the merge.
- **…and the same thing driven by Claude from a live session**, against real OpenCode 1.18.25 on the free tier (2026-08-29, `claude -p --strict-mcp-config` with only orchestrator tools allowed, so Claude could not have touched the repository itself). The `tool_result` blocks are the evidence: `worker_status` returned three `[running]` workers and `w-004 [spawned: waiting_on_dependencies] · waiting for w-001 · next: worker_wait({ids: ["w-001"], mode: "all"})`, with the trailer `(1 of these have not started: 3/3 slots busy, 1 queued)`; the event trail records `admitted running=1/2/3` and never 4, and `w-004 admitted` in the same second as `w-001 settled`. One batched `worker_wait({mode: "all"})` covered the wave, `workspace_merge` came back `MERGED GREEN` with `npm test` green after each of the four steps, and the run report landed on disk. **Queue time cost the dependent nothing:** it sat in the queue for 15,853 ms and its `result.durationMs` is 48,688 ms against 64,541 ms since spawn — the budget clock starts at the first prompt, measured, not asserted.
- **Never more than `maxConcurrent` past `spawned`** — asserted by observation rather than by reading the semaphore's own counter: six workers, cap three, states sampled throughout ([`test/manager/scheduler.test.ts`](test/manager/scheduler.test.ts)).
- **Queue time is not work time** — a worker queued behind a 600 ms worker with a 250 ms wall-clock budget still completes. The regression this exists for — starting the budget clock at *accept* rather than at *prompt* — passes every semaphore test and kills the second worker of every wave.
- **`dependsOn` cannot deadlock** — a worker waiting on a dependency holds no slot and does not block the queue behind it (a later-spawned independent worker runs and finishes first); a dependency that is cancelled or times out cancels its dependents with `dependency_failed:<id>`, cascading down a chain; a `blocked` dependency is neither satisfied nor failed; an unknown dependency — or one that has already failed — is rejected at spawn with the id named and no row written; and the cycle detector is exercised directly against a graph built by hand, because the existence rule makes cycles unreachable through the ordinary path.
- **Cancelling and disposing with a full queue** — `dispose()` returns with three workers queued and no worktree behind them. A queued worker's `done` is parked on the admission promise, so this is the failure that would otherwise hang the whole suite at once.
- **Batched `worker_wait` over real JSON-RPC** — `mode: "any"` returns on the first to settle rather than after the slowest; `mode: "all"` names who is still working on a timeout; the 30,000 ms cap does not move for a batch.
- **Every tool returns in under two seconds**, `worker_wait` excepted, `run_report` included.

Four things worth knowing before Phase 6 builds on this:

- **A queued worker is `spawned`, and needed no new state.** What it needed was a *reason* (`queued` / `waiting_on_dependencies`) on the record, and a position and dependency list that stay in process — a queue position written to the index is a number that lies after a restart. The queue does not survive a restart at all; ADR-0004 says why, and `recover()` now distinguishes `manager_restart_while_queued` from `manager_restart` so Claude can tell "nothing was spent, respawn it" from "inspect the worktree".
- **The slot is released after `settle()`, not when the stream closes.** A dependent may only start once its dependency is genuinely `completed`, which is a fact only after the snapshot, the independent test re-run and the reconciliation. One release point for the slot and for dependency satisfaction is what keeps the two from disagreeing.
- **`cancel()` had a window that predated the queue, and the queue widened it.** Between `spawn()` and the session existing there is nothing to abort, so a cancel in that window was recorded and then ignored — the worker ran to completion anyway. `prepareAndRun()` now checks a `cancelRequested` flag at every step boundary. Phase 6's revisions re-enter that same path and will need the same care.
- **The run report caught a defect nothing else had.** `markMerged` wrote `state:merged` twice per worker — once from the state machine's own hook and once beside it, with different detail — and every previous rendering was paginated or filtered enough to hide it. The trail now has one writer per transition, and extra context rides on the transition's `detail`. A run report is a debugging tool for the orchestrator as much as for a run.
- **A worker that never started must not render as one that achieved nothing.** `WorkerResult.reportSource` gained `not_started` for exactly this: zeroes everywhere, no discrepancies, and a line saying no prompt was ever sent. Running the reconciliation machinery over a worktree that does not exist manufactures a report-parse discrepancy about a report nobody asked for.

### Phase 6 — Review loop ✅ COMPLETE

> Outcome: `worker_revise` in [`src/mcp/tools.ts`](src/mcp/tools.ts) and `WorkerManager.revise()` in [`src/manager/worker.ts`](src/manager/worker.ts) — session reuse, a revision cap with §13's terminal actionable report, and a re-entrant run loop that re-acquires a concurrency slot; the `revise` edges in [`src/manager/state.ts`](src/manager/state.ts); `reviewOf` on `worker_spawn`, pointing a read-only `review` worker at another worker's diff; [`src/manager/revisions.ts`](src/manager/revisions.ts) — the rounds, reconstructed from the event trail for both the cap report and the run report. `revisions` is a new column with the project's first real migration ([`src/store/schema.ts`](src/store/schema.ts)), and `render.ts`'s status line stopped printing `resumes` under the label "revisions". `ORCHESTRATOR_MAX_REVISIONS` joins the [README](README.md#configuration)'s table. Decisions in [ADR-0005](docs/adr/0005-the-review-loop.md). §7's `worker_revise` and `worker_spawn` rows, §5's revision path and §6.1's review-worker line are all corrected in place above. Tests: 43 new, **302 total green** (4 skipped) — [`test/manager/revise.test.ts`](test/manager/revise.test.ts), [`test/mcp/revise.test.ts`](test/mcp/revise.test.ts). `bun run spike` still green against OpenCode 1.18.25.

- `worker_revise` with session reuse, revision caps, optional read-only reviewer worker critiquing another worker's diff.

**AC met:** *seeded failing worker receives feedback, fixes, passes; loop terminates at cap with an actionable report to Claude.*

- **The seeded failing worker** — [`test/mcp/revise.test.ts`](test/mcp/revise.test.ts), over real JSON-RPC. The golden repo is seeded so `npm test` fails on a real assertion (`breakGoldenRepo`), the worker "fixes" it wrongly on round 0 and correctly on round 1, and **it claims success both times** — so the only thing that can tell the rounds apart is the orchestrator re-running the suite itself (§4.3). Round 0 settles with a `test_claim_unverified` discrepancy; round 1 settles clean, and the fix is on disk in the worktree rather than in the report.
- **The cap's report is asserted on its content, not on the refusal** — it names every round and the feedback actually sent, what changed between rounds (files, diff size, failing tests, discrepancies, all measured), what is still failing, and four options with the calls that take them. A test that only checked that the refusal happened would have tested the half that was never the risk.
- **The session is reused, provably** — one `POST /session` per worker and N prompts, same `sessionID` across every round, asserted directly against the mock's request log.
- **A revision never exceeds the concurrency cap** — asserted by observation, the way Phase 5's is: with the cap full a revision sits in `spawned` with `reason: "queued"`, `queueHint` says `2/2 slots busy`, and its round counter is still 0 because the cap counts rounds *taken*.
- **`worker_revise` then `worker_wait` waits** — the state leaves `completed` synchronously, before the call returns.
- **`dispose()` and `cancel()` work on a revising worker** — no hang, and `dispose()` does not return with a prompt in flight.
- **A revised worker merges its new commit** — the branch tip, so the merged tree carries the post-revision content — **and the §6.2 overlap warning is computed from the post-revision diff**: two workers that were disjoint stop being disjoint the moment a revision makes one of them touch the other's file. That second half is the one that does not come for free (the check reads `result.changes.paths`, the measurement taken at the *previous* settle), and it holds only because a revision re-runs `settle()` before the merge starts — an ordering the test pins rather than assumes. A revision cancelled in the queue keeps the result of the round that did run rather than rebuilding one for a round that never happened.
- **One defect found by re-reading the diff rather than by a failing test:** the scheduler's `refused` set was sticky, which was sound only while a refusal was permanent. A revision can be refused at the queue and the worker revised again to `completed`, after which the scheduler went on answering "failed" about it — and the next dependent was rejected with "will never complete: w-001 (completed)". Fixed in `enqueue()`, with the old message reproduced in the test before the new behaviour is asserted.

**The v1 demo was run** on **2026-08-29**, once, at the end — driven by Claude from a live `claude -p --strict-mcp-config` session with only orchestrator tools allowed, against real OpenCode 1.18.25 on the free `opencode/muse-spark-1.2-contributor-free`, on a throwaway golden repo. **This is the project's definition of done for v1, and it is met.** The `tool_result` blocks and the store's `events` table are the evidence:

- **Three workers, one wave, under the cap.** `worker_status` returned `w-001 [running]`, `w-002 [running]` and `w-003 [spawned: waiting_on_dependencies] · waiting for w-001, w-002`, with the trailer `(1 of these have not started: 2/3 slots busy, 1 queued)`. The event trail records `admitted running=1` and `running=2` and never 3 concurrent past the cap.
- **A review worker critiqued another worker's diff.** `w-004` (mode `review`, `reviewOf: w-001`) got `review_target {"target":"w-001","diffLines":13,"source":"worktree"}` and returned three concrete defects naming the file — including that `w-001`'s claim of "npm test (3 pass)" does not validate the new module at all, because the suite only covers `src/stats.js`. It changed **0 files** and produced **0 discrepancies**: read-only held, measured rather than asserted.
- **Four revision rounds across three workers, and Claude chose every one.** `w-003` produced no changes at all with an unparseable report and was revised twice; `w-001` was revised once **on the reviewer's findings**; `w-004` — the reviewer — wedged on its first attempt and was revised out of `timed_out`, whose reply read *"it has left `timed_out` already"*. Nothing revised anything automatically.
- **A revision really does re-enter the queue.** `w-001`'s trail: `state:spawned {from: completed, trigger: revise}` → `admitted` → `state:preparing {reason: revising}` → `state:running` → `revision_started`. The second `admitted` row per revised worker is the property trap 1 exists for, in production rather than in a test.
- **`revisions` and `resumes` diverged on the same worker, live.** `w-003` finished with `revisions: 2, resumes: 2` — two rounds of feedback and two permission escalations answered. Before Phase 6 the status line would have printed one under the other's name.
- **The gated merge took the post-revision commit.** `Merge m-001 — MERGED GREEN`, `npm test` green after each step, `w-001: merged → 7d74c2ce · tests green`. `w-001`'s branch carries two snapshot commits and the merge resolved its **tip**: `integration/m-001:src/settings.js` contains `...(overrides ?? {})` and `settings?.[key]` — the exact fixes the reviewer asked for. `w-003` came through as `nothing_to_merge — the worker committed nothing`, which is the honest answer and not an error.
- **The run report** landed at `.orchestrator/runs/v1-demo.md` (15 KB), with a per-worker **Revision rounds** block showing round 0's outcome, the feedback each later round was given, and what each round measured.

Three observations from the run, recorded rather than smoothed over:

- **The reviewer wedged once.** `w-004` hit the idle watchdog on its first attempt and timed out at ~14k tokens; a revision recovered it and it produced its critique. That is `timed_out --revise--> spawned` earning its place on its first live outing — but it is also one more data point that a read-only worker handed a diff can stall, and nobody has root-caused why. Phase 7's.
- **`external_directory` escalated three times**, on `<repo>/.orchestrator/*` twice and `/tmp/*` once, costing a partial turn and a `worker_message` round trip each. `w-003` ended on 47,531 tokens against 7,715 for the worker that never escalated. The fact sheet's "Unresolved" 5 now carries that measurement.
- **A second merge failed, correctly.** Claude asked for `m-002` on the same `integrationBranch` name as `m-001`; the pipeline refused with `fatal: a branch named 'integration/m-001' already exists` and rolled nothing. Claude retried as `m-003` and it merged green. Not a Phase 6 regression — but re-using an integration branch name is a sharp edge a friendlier error could blunt, and §5 explicitly kept merge-pipeline redesign out of this phase.

### Phase 7 — Hardening ✅ COMPLETE

> Outcome: `worker_recover` and `worker_budget` in [`src/mcp/tools.ts`](src/mcp/tools.ts), backed by `recoverWorker()` / `grantBudget()` in [`src/manager/worker.ts`](src/manager/worker.ts) — the three edges out of `interrupted` that Phase 2 enumerated and nothing had ever fired, and §8's "pause + surface" made true. Retries with backoff on errors the provider itself marks retryable; §8's global run cap (`ORCHESTRATOR_RUN_BUDGET_TOKENS`), enforced at spawn and again before a queued worker opens a session; §9's orphan **TTL** in [`src/workspace/cleanup.ts`](src/workspace/cleanup.ts); and a metrics log in [`src/manager/metrics.ts`](src/manager/metrics.ts) — JSONL on disk, never on the wire. `OpenCodeBackend.respond()` closes the in-band-reply gap the fact sheet has carried since Phase 1, **and corrects the endpoint it named**. `ORCHESTRATOR_MAX_RETRIES` and `ORCHESTRATOR_RUN_BUDGET_TOKENS` join the [README](README.md#configuration)'s table. Decisions in [ADR-0006](docs/adr/0006-hardening.md). Tests: 37 new, **338 total green** (5 skipped) — [`test/manager/hardening.test.ts`](test/manager/hardening.test.ts), plus the orphan-TTL cases in [`test/workspace/cleanup.test.ts`](test/workspace/cleanup.test.ts) and the Phase 7 tool cases in [`test/mcp/revise.test.ts`](test/mcp/revise.test.ts). `bun run spike` still green against OpenCode 1.18.25.

- Budget enforcement, retries with backoff, orphan cleanup, crash recovery flows, run reports, metrics log.

**AC met**, each with what shows it:

- **`kill -9` the manager mid-run → restart → clean recovery** — done literally, against real OpenCode 1.18.25 on **2026-08-29**, not simulated. A worker was spawned on a golden repo, allowed to work for 20 s until `git status` in its worktree showed real uncommitted changes, and its orchestrator was killed with `SIGKILL`. The row it left said `running`, which is the lie a crash leaves. A second orchestrator over the same database logged `recovered 1 interrupted worker(s) from a previous process`; the row came back `interrupted` / `manager_restart` with its worktree intact; `worker_recover(resume)` found the session gone (the restart spawns a fresh server) and **salvaged from disk**. Final state `completed`, **2 files and 205 insertions** committed as snapshot `4e1e2718`, `npm test` re-run green by the orchestrator itself, and `worker/w-001` mergeable. `reportSource` is `none` — the worker's own report died with the process, which is the honest record and exactly what §4.3 says is the weaker half anyway. In tests the same path is covered three ways, because `resume` has three outcomes: session gone (salvage), session alive and still running (re-attach), and session alive with its turn already over (salvage, via the grace window below).
- **A budget-exceeded worker pauses and surfaces** — `worker_budget` raises the ceiling additively, onto the spec so it survives a restart, and applies to a running worker at the next tick. The test measures "pauses" the only honest way — by carrying the work on afterwards: an over-budget worker is refused a revision *for its tokens*, granted more, revised, and completes **on the same session id**. The refusal itself now names `worker_budget`, so §8's dead end is a route.
- **Orphans pruned** — with §9's TTL, which had never been built. An orphan carries an age (a worktree's directory mtime, a branch's commit date) and pruning refuses anything younger than 24 h *or of unknown age*, because the orphan a scan is most likely to meet on a busy machine is another orchestrator's live worktree.

Also delivered from the bullet list: **retries with backoff** (provider-judged via `isRetryable`, exponential from 1 s, capped, `0` disables); the **global run cap**; and the **metrics log**. "Run reports" were already built in Phase 5.

**And the carried item Phase 6 could not close.** `docs/phase0-facts.md` "Unresolved" 5 — replying to a permission request in band — is resolved for permissions, and **the endpoint the fact sheet named was wrong**: a request raised as `permission.asked` returns `404 PermissionNotFoundError` from the documented v2 path and is answered by `POST /session/{id}/permissions/{permissionID}`. Measured on the wire, with the probe kept as a test behind `OC_E2E=1 OC_E2E_PERMISSION=1`. A permission ask no longer aborts the turn: the worker waits at its tool call and carries straight on when answered. Questions still escalate the old way, deliberately — their reply is a selection from offered labels, not free text.

Four defects found on the way, each by a test written to catch it rather than by a run that went wrong:

- **The structured-output retry claimed every `api` error.** A transient provider hiccup was therefore diagnosed as a schema rejection: it burned the one-shot format retry *and* latched structured output off for the whole backend (ADR-0002), over something that had nothing to do with schemas. Retryability is the field that tells them apart.
- **`preparing --exhaust_budget-->` did not exist**, and the run cap stops a worker that never reached `running`. `settle()` uses `tryApply`, so the illegal move was a silent no-op and the worker sat in `preparing` forever — a hang rather than an error.
- **The metrics call at `settle()` was unwrapped**, which made a throwing sink a worker that never settles. `settle()` is the one place every worker passes through, which is what makes it both the right place for the metric and the worst place for an exception.
- **The permission fallback aborted before re-prompting.** The pump is paused while blocked, so the abort's own error and idle arrived *after* the re-prompt had reset `sawAbort`, and the run loop read them as an abort nobody asked for and failed the worker `aborted_externally`.

One sharp edge found and **not** fixed, recorded rather than left for someone to trip over: a restarted manager mints worker ids from `w-001` again, so anything it spawns collides with the rows the dead one left. The tests give their second manager a distinct prefix. A durable id sequence belongs to Phase 8 or to the first bug report.

### Phase 8 — Optimization (ongoing) · **four of six done**

Model-routing presets with automatic selection, worker priorities, smarter summarization, shared-workspace mode for trivially-parallel tasks, container sandboxing, cross-model review diversity.

> Outcome: [`src/manager/routing.ts`](src/manager/routing.ts) — the one place that decides which model runs a worker, with **cross-model review** as the default rather than an option; worker **priorities** in [`src/manager/scheduler.ts`](src/manager/scheduler.ts), which ADR-0004 deferred here by name. `ORCHESTRATOR_MODEL_IMPLEMENT` / `_RESEARCH` / `_REVIEW` and `ORCHESTRATOR_REVIEW_POOL` join the [README](README.md#configuration)'s table. Decisions and the two corrections in [ADR-0007](docs/adr/0007-model-routing-and-review-diversity.md). Tests: 16 new, **352 total green** (5 skipped) — [`test/manager/routing.test.ts`](test/manager/routing.test.ts).

**The measurement that unblocked this, and that should have been taken four phases ago.** §11 Phase 6's handoff and [ADR-0005](docs/adr/0005-the-review-loop.md) both state that every worker here runs the same model, so a reviewer shares the author's blind spots *by construction*. That was true of the **configuration** and never of the provider: `GET /provider` lists **six** models on `opencode`, and on **2026-08-30** all six completed a turn on this key in 1.0–5.8 s. Nobody had looked. See `docs/phase0-facts.md` §3.

**Done:**

- **Cross-model review diversity, as the default.** A `review` worker is routed away from the model that wrote the code it is reading, from a configured pool. When nothing else is available the review still happens and `worker_result` **says it is not independent** — the caveat ADR-0005 had to state as permanent is now printed only when it is actually true. Measured live on the same diff: the same-model reviewer approved it; the cross-model reviewer approved it *and* noticed no test had been added for the new function.
- **Model-routing presets with automatic selection.** Precedence is `spec.model` → review diversity → per-mode preset → default, deterministic so that "which model reviewed this?" has a stable answer. **Not** a task-text classifier: the honest classifier available is the *mode*, which Claude states explicitly, and guessing a category from a one-line task would route work to the wrong model silently.
- **Worker priorities.** Higher goes first among entries that could all start *right now*; ties keep spawn order. The property ADR-0004 was careful about is untouched — the queue is scanned for *runnable* entries, so a dependency can never be stuck behind its own dependent whatever the priorities say. Starvation is possible and accepted; ageing would be a scheduler with a tuning parameter, which ADR-0004 declined for reasons that have not changed.

**Two defects in Phase 6's review design, both found by running a real cross-model review rather than by reasoning:**

- **The reviewer was reading the code from *before* the change.** Phase 6 branched it from the target's base commit ("that is how a human reads a pull request" — it is not). The first live reviewer opened the file, could not find the function the diff said had been added, and reported the author's work as never applied — accurately about the file it could read, and false. Phase 6 had written the warning for exactly this and attached it to the wrong condition: emitted only when the diff was *truncated*, which is the uncommon case. The reviewer now branches from the target's **snapshot**, so the files it reads are the code as the author left it, and the brief says which version it holds unconditionally.
- **Reviewers were being accused of lying about files they never wrote.** Three of four models, told plainly to leave `changes` empty, listed the file they had reviewed — and reconciliation reported `claimed_not_changed`, a false finding in the one channel this system relies on for true ones. Adding words to the brief fixed one model and not the others, which is [ADR-0002](docs/adr/0002-worker-contract-channel.md)'s lesson from a new direction. The rule is structural now: for a worker that *cannot write* (DD-10), `claimed_not_changed` is off. The reverse check stays on for every mode, and matters more — a read-only worker whose diff is not empty has done something it could not do.

**And a Phase 7 open item closed.** The review worker that "wedged once and nobody root-caused why" is **model-specific, not review-mode-specific**: on one review task, three models finished in 24–33 s at ~12–14k tokens while `nemotron-3-ultra-free` generated **39,004 tokens over 6.5 minutes with no terminal event**. The general lesson is that a free model can generate indefinitely without terminating, and the **wall-clock** budget rather than the idle watchdog is what catches it.

**Shared-workspace mode — built, and it changed the default.** Every worker now works in **your repository**, together, the way Claude's own subagents do: they see each other's edits as they happen, nothing is committed for you, and there is no merge because the work is simply in your tree when it finishes. `workspace: "isolated"` (or `ORCHESTRATOR_WORKSPACE=isolated`) restores the previous behaviour per worker or per server.

This is the item [ADR-0007](docs/adr/0007-model-routing-and-review-diversity.md) declined on design grounds, and the objection was real rather than wrong: DD-4's reconciliation rests on *the diff in a worker's directory is that worker's diff*, and a shared tree removes it. What Phase 8 built is that objection answered rather than ignored — see [ADR-0008](docs/adr/0008-shared-workspace.md):

- **`git reset --hard` still never runs in your checkout.** That, not general squeamishness, is what [ADR-0003](docs/adr/0003-integration-worktree.md) was protecting. Shared workers have no branch, so `workspace_merge` refuses them structurally and they cannot reach the pipeline that owns the command. `workspace_cleanup` has the mirror guard: anything at or above the repo root is not ours to remove.
- **Nothing is committed.** DD-5's snapshot is right in a worktree the orchestrator owns; in your checkout `git add -A` would sweep up whatever else you had in progress, onto whatever branch you were on. The changes are left uncommitted for you to read — which is also what a native subagent leaves.
- **Attribution is best-effort and says so.** A shared result carries `owned` (what its `ownedPaths` cover), `unattributed` (changed while it ran, owned by nobody, could be anyone's), `preexisting` (dirty before it started — *your* work, never credited to a worker) and `concurrent` (who else was in the tree). A shared worker that ran alone is measured exactly and is not discounted for the mode.
- **The brief tells it the tree is shared** — that files will change underneath it, that it must not tidy or revert anything outside its own paths, and that it must run no state-changing `git` command.

Verified live on **2026-08-30**: two concurrent workers in one checkout with a pre-existing `NOTES.md`. Each attributed its own file and reported the other's as unattributed rather than claiming it; both listed `NOTES.md` as pre-existing; both named the other as concurrent; `HEAD` did not move and the user's file was untouched.

**Not done, and why — this phase is `(ongoing)` and these are the remaining two:**

- **Container sandboxing** — *blocked here, not deferred by choice.* The Docker client is installed and there is no daemon (`/var/run/docker.sock` does not exist), so nothing written for it could be run even once. An isolation mechanism that has never executed is worse than none.
- **Smarter summarization** — *no measurement says it is needed.* §8's context targets were verified as met in Phase 3 and nothing since has moved them. Rewriting the render caps without evidence would change the one part of this system whose budget is already measured.

**Total: ~3.5–4.5 weeks solo to a hardened v1.**

---

## 12. Testing Strategy

- **`ocmock`** — a scriptable fake OpenCode server implementing the adapter's required subset, with scenarios: success, hang, blocked, over-budget, crash, **lying report** (claims changes that don't exist — tests reconciliation).
- **Golden repo fixture** — small npm project with real tests, used by integration/e2e.
- **Unit:** state machine transitions, worktree utilities (against temp repos), merge gate, brief/report round-trips.
- **E2E:** gated behind an env flag (uses real API spend); the Phase 5 demo script runs in CI nightly.
- **Chaos:** kill workers mid-run, corrupt worktrees, simulate SSE dropout.

---

## 13. Risks & Mitigations

| Risk | Mitigation |
|------|------------|
| OpenCode API drift | Adapter layer (DD-2); pin versions; Phase 0 fact sheet; contract tests against `ocmock` catch regressions |
| Claude context flooding despite everything | Hard truncation defaults; all detail behind paginated on-demand tools; per-interaction token targets measured in Phase 3 AC |
| Workers go off-script / scope creep | Ownership lists in briefs; diff-vs-report reconciliation; permission config |
| Runaway workers / cost blowout | Idle watchdog, hard timeout, per-worker + global budgets — **all built by Phase 7**; the global one is per `runID` and refuses a spawn rather than killing what is running |
| Merge hell on parallel waves | Overlap detection pre-merge; sequential gated merges; integration-point ownership rules; cap recommended parallelism |
| Infinite fix loops | Revision caps with terminal actionable reports |
| Prompt injection via repo content → hijacked worker | Workers sandboxed to worktree; output treated as untrusted; manager never executes report content; optional container mode later |
| MCP host timeouts | Async pattern (DD-1) is structural, not a patch |
| Flaky tests breaking merge gates | Gate re-runs failures once before declaring red; config to mark known-flaky suites |
| Manager crash orphans worktrees | SQLite recovery + orphan scan — **built in Phase 7**: a crashed worker is salvaged from its worktree into a real result, and the orphan scan prunes only past a TTL |

---

## 14. Open Questions (resolve in Phase 0)

1. ~~Does OpenCode expose per-session token/cost usage via API?~~ **Resolved:** yes — `Session.cost` and `Session.tokens{input,output,reasoning,cache}`. Caveat: `cost` is `0` on free-tier models, so budget on tokens.
2. ~~Exact SSE event shapes for run completion?~~ **Resolved:** `session.idle`, `{id, type, properties:{sessionID}}` — and the stream is **directory-scoped**. Serve-vs-run parity still unverified.
3. ~~Session resume semantics?~~ **Resolved:** yes, context is retained across prompts to the same session.
4. ~~Permission config granularity — sufficient for headless?~~ **Resolved:** yes — inline per-session ruleset, or CLI `--auto`. A full edit+bash run completed with zero pending permission requests.
5. ~~Can one serve instance handle 4+ concurrent sessions without degradation?~~ **Resolved in Phase 1:** yes at 4 — four worktree sessions on one server all completed with no cross-talk, at ~1.4–1.9× single-session latency. One run, one free-tier model; re-measure before going past 4. **Re-measured twice in Phase 5** (2026-08-29, OpenCode 1.18.25): the four-session probe again (11.4–15.3 s, zero foreign-session events), and the first end-to-end measurement *through the orchestrator* — three concurrent workers plus a queued dependent, driven by a live Claude Code session on the free tier, all four completing with no rate limiting and no cross-talk. The §11 Phase 5 default is **3**; more than four, paid providers under rate limits, and minutes-long workers are all still unmeasured. See `docs/phase0-facts.md`. **Phase 6's v1 demo closed the last of those three** (2026-08-29): a revision round ran 212 s to a clean completion, an order of magnitude past Phase 5's 23.8–48.7 s, with the watchdogs and the token polling holding throughout. More than four concurrent, and paid providers under rate limits, are still unmeasured; the default stays at 3.
6. ~~Claude Code's actual MCP tool timeout in the target environment?~~ **Resolved in Phase 3: 60 seconds.** Measured on Claude Code 2.1.251 with the orchestrator registered as a real MCP server — 55,000 ms returns, 60,000 ms fails, and the host states its own limit in the error. `worker_wait`'s 30,000 ms cap is now half a measured ceiling instead of a guess. See `docs/phase0-facts.md` §7.

Everything above is structured so that wrong answers to any of these change **one adapter file or one config default** — not the architecture.

---

## 15. Deferred Ideas (explicitly out of v1)

- ~~Shared workspaces for trivially parallel tasks~~ — **built in Phase 8, and now the default.** Workers share the user's own checkout, as Claude's native subagents do. The attribution cost this deferral was worried about is real and is reported rather than hidden ([ADR-0008](docs/adr/0008-shared-workspace.md)); `workspace: "isolated"` keeps the stronger evidence for the workers that need it.
- Arbitrary task DAGs (keep `dependsOn` flat for now)
- ~~Automatic model selection based on task classification~~ — **partly built in Phase 8.** Selection by *mode* and by review diversity is automatic and deterministic ([ADR-0007](docs/adr/0007-model-routing-and-review-diversity.md)). Classification of the **task text** is still deferred, and deliberately: the only way to do it properly is a model call, and a wrong classification routes work to the wrong model silently.
- ~~Cross-model adversarial review as default rather than option~~ — **built in Phase 8.** A reviewer is routed away from the author's model wherever another is configured; where none is, the review still happens and says it is not independent.
- Web dashboard for run telemetry
- Orchestrator-in-a-container for remote/CI execution

---

## Suggested first action

**Start Phase 0.** Write the ~150-line spike script against `opencode serve` first — every architectural assumption in this plan funnels through those API facts, and 2–3 days of verification will either validate the design or save two weeks of rework.
