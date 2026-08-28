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
| DD-4 | Workers write `report.json`; manager parses it and cross-checks against `git status`/`diff` | Structured results enforced by contract, not by hoping the model summarizes well |
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

```ts
interface OpenCodeBackend {
  start(): Promise<void>
  createSession(opts: { cwd: string; model?: string; agent?: string }): Promise<SessionHandle>
  prompt(sessionId: string, text: string): Promise<RunHandle>
  events(sessionId: string): AsyncIterable<OCEvent>   // SSE-backed
  abort(runId: string): Promise<void>
  usage(sessionId: string): Promise<Usage | null>     // tokens/cost if exposed
  dispose(): Promise<void>
}
```

- **`ServeBackend`** (default): starts/connects `opencode serve` (default port ~4096 — verify), uses the SDK + SSE event stream for completion detection.
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

Manager-generated, injected as the worker's prompt and written to the worktree (as `AGENTS.md`, which OpenCode auto-loads).

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
When finished, write `report.json` to the worktree root matching the
schema in §4.2. This is the only channel by which your work is read —
anything not in the report is invisible to the orchestrator.

Budget: ~$2.00 / 15 min wall clock. If you approach either, stop and
report what you have.
```

### 4.2 Worker Report (`report.json`)

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

`status` is one of `completed` | `blocked` | `failed`.

**Verification step (critical):** the manager reconciles `changes[]` against the actual `git diff --name-only` and flags discrepancies in the result it returns to Claude. Workers will sometimes misreport.

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

**Blocked path:** worker stops and writes a `blocked` report → manager sets `blocked` → Claude sees `questions` → `worker_message(id, answer)` → same session resumes. This is the escalation channel — the only way a worker asks for help.

**Revision path:** `worker_revise(id, feedback)` sends feedback to the same session (worker retains full context of its own work). Revision counter per worker; at `maxRevisions` (default 3) the manager refuses and reports — prevents infinite fix loops.

---

## 6. Workspace Isolation & Merge Pipeline

### 6.1 Worktree operations

```
git worktree add .orchestrator/worktrees/w-003 -b worker/w-003 <base-sha>
```

Worker `cwd` = worktree root. Per-worker config injected into the worktree:

- `AGENTS.md` — the task brief + constraints (OpenCode auto-loads it)
- `.opencode/agent/worker.md` — a custom "worker" agent definition enforcing the report contract (verify agent-file location against current docs)
- `opencode.json` — permissions: `edit: allow`, `bash: allow` (for tests), `webfetch: deny` for implement workers

On completion the manager runs `git add -A && git commit` to snapshot everything, then computes diffs.

Research/review workers: no worktree, or a read-only mount of the target worktree.

### 6.2 Overlap detection (before merge)

After all workers in a wave finish, the manager computes intersections of changed-file sets:

- **Disjoint files** → merge in any order.
- **Shared files, different regions** → merge sequentially, test gate catches issues.
- **Shared integration files** (`package.json`, router indexes) → warn Claude up front; better: task planning assigns one worker ownership of integration points, or Claude does the wiring itself post-merge.

### 6.3 Gated merge pipeline

1. Claude reviews each worker (report + diff), runs revision loops until satisfied or capped.
2. Merge **one at a time** into the integration branch. After each merge: run the test command.
   - **Green** → continue to next worker.
   - **Red** → `git reset --hard` to pre-merge SHA; surface to Claude with options: (a) send the worker a "rebase onto new base, resolve, re-test" message, (b) resolve manually, (c) reject.
3. Final full validation run on the integrated result.
4. Claude reports to user; manager cleans up worktrees/branches, writes the run report.

---

## 7. MCP Tool Surface

| Tool | Params | Returns | Notes |
|------|--------|---------|-------|
| `worker_spawn` | `task`, `mode` (implement/research/review), `model?`, `owns?` (file paths), `dependsOn?` (worker ids) | `{workerId, worktree, branch}` | Returns in <2s; runs in background |
| `worker_status` | `ids?` | state, elapsed, last-activity age, revision count, ~cost | Cheap; safe to poll |
| `worker_wait` | `ids`, `timeoutMs` (≤30,000) | same as status | Bounded block; reduces polling chatter |
| `worker_result` | `id` | structured result (§4.3) | The default thing Claude reads |
| `worker_diff` | `id`, `paths?`, `cursor?`, `maxLines?` (default 400) | paginated unified diff | On-demand detail |
| `worker_output` | `id`, `cursor?`, `limit?` (default 50 events) | paginated event log tail | Debugging only |
| `worker_message` | `id`, `message` | new run id | Answers a blocked worker; session reused |
| `worker_revise` | `id`, `feedback` | revision number | Review-loop entry point; session reused; capped |
| `worker_stop` | `id`, `reason?` | — | Graceful abort + snapshot |
| `worker_list` | `state?` | worker summaries | |
| `workspace_merge` | `id`, `strategy?`, `runTests?` (default true) | merge + test-gate result | Auto-rollback on red |
| `workspace_cleanup` | `ids?`, `force?` | — | Prunes worktrees/branches |

**Delegation heuristics live in the tool descriptions** so Claude self-calibrates:

- **Delegate:** multi-file implementation, test authorship, mechanical refactors, parallelizable chunks, anything where executing (edit-run-debug cycles) dominates.
- **Don't delegate:** single-file small edits, codebase questions (read directly), architectural decisions.
- **Batch** related work per worker (amortize session warm-up); prefer **2–5 parallel workers** — merge pain grows superlinearly beyond that.

---

## 8. Context, Cost & Security Policies

**Context budget** (defaults, all configurable): result summaries <1.5k tokens; diff stat always / full diff on demand with 400-line cap; event log pages of 50; per-run Claude-side target <5k tokens per worker round.

**Cost controls:** per-worker cap (~$2 or token-equivalent if usage isn't exposed — verify in Phase 0) → on exceed: pause + surface to Claude; global run cap; model presets per task type; usage logged per worker in the run report.

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

### Phase 0 — Spike & verification (2–3 days)

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

### Phase 1 — OpenCode adapter (3–4 days)

- Implement `OpenCodeBackend` + `ServeBackend` (+ `RunBackend` stub if time).
- Config injection: model, agent, permissions, cwd.

**AC:** adapter unit tests pass against `ocmock`; one integration test passes against real OpenCode.

### Phase 2 — Worker manager core (3–4 days)

- State machine, registry, SQLite store, task-brief builder, report parser + diff reconciliation, timeout/idle watchdogs.

**AC:** full spawn→running→completed lifecycle on the golden repo; blocked path works; timeout aborts; manager restart recovers state.

### Phase 3 — MCP server (2–3 days)

- Tools: spawn, status, wait, result, output, stop, list. Async pattern + pagination.

**AC:** from Claude Code, Claude drives a single worker to completion end-to-end. **Measure:** Claude's context grows by <2k tokens for the interaction.

### Phase 4 — Isolation & merge (4–5 days)

- WorktreeManager, per-worker config injection, snapshot commits, diff tooling, overlap detection, gated merge with auto-rollback, cleanup.

**AC:** two workers on disjoint files merge green; a seeded conflicting merge is detected and rolled back; failed test gate restores pre-merge state.

### Phase 5 — Parallelism (2–3 days)

- Concurrency semaphore (default max 3–4), queue, `dependsOn`, batched `worker_wait`.

**AC — v1 demo:** "Add a settings page" — 3 concurrent workers (UI / API / tests, mixed models), review, revisions, gated merges, final validation, run report. **This is the project's definition of done for v1.**

### Phase 6 — Review loop (3–4 days)

- `worker_revise` with session reuse, revision caps, optional read-only reviewer worker critiquing another worker's diff.

**AC:** seeded failing worker receives feedback, fixes, passes; loop terminates at cap with an actionable report to Claude.

### Phase 7 — Hardening (3–5 days)

- Budget enforcement, retries with backoff, orphan cleanup, crash recovery flows, run reports, metrics log.

**AC:** `kill -9` the manager mid-run → restart → clean recovery; budget-exceeded worker pauses and surfaces; orphans pruned.

### Phase 8 — Optimization (ongoing)

Model-routing presets with automatic selection, worker priorities, smarter summarization, shared-workspace mode for trivially-parallel tasks, container sandboxing, cross-model review diversity.

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
| Runaway workers / cost blowout | Idle watchdog, hard timeout, per-worker + global budgets |
| Merge hell on parallel waves | Overlap detection pre-merge; sequential gated merges; integration-point ownership rules; cap recommended parallelism |
| Infinite fix loops | Revision caps with terminal actionable reports |
| Prompt injection via repo content → hijacked worker | Workers sandboxed to worktree; output treated as untrusted; manager never executes report content; optional container mode later |
| MCP host timeouts | Async pattern (DD-1) is structural, not a patch |
| Flaky tests breaking merge gates | Gate re-runs failures once before declaring red; config to mark known-flaky suites |
| Manager crash orphans worktrees | SQLite recovery + orphan scan (Phase 7) |

---

## 14. Open Questions (resolve in Phase 0)

1. Does OpenCode expose per-session token/cost usage via API? (Determines budget enforcement mechanism.)
2. Exact SSE event shapes for run completion — and do they differ between serve and run modes?
3. Session resume semantics: full context retention across prompts to the same session?
4. Permission config granularity — per-agent? per-tool? Sufficient for fully headless runs?
5. Can one serve instance handle 4+ concurrent sessions without degradation?
6. Claude Code's actual MCP tool timeout default in the target environment?

Everything above is structured so that wrong answers to any of these change **one adapter file or one config default** — not the architecture.

---

## 15. Deferred Ideas (explicitly out of v1)

- Shared workspaces for trivially parallel tasks
- Arbitrary task DAGs (keep `dependsOn` flat for now)
- Automatic model selection based on task classification
- Cross-model adversarial review as default rather than option
- Web dashboard for run telemetry
- Orchestrator-in-a-container for remote/CI execution

---

## Suggested first action

**Start Phase 0.** Write the ~150-line spike script against `opencode serve` first — every architectural assumption in this plan funnels through those API facts, and 2–3 days of verification will either validate the design or save two weeks of rework.
