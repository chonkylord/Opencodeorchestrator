# Handoff: implement Phase 2 — the worker manager

You are picking up the **Claude → OpenCode Subagent Orchestrator** at
`chonkylord/Opencodeorchestrator`. Phases 0 and 1 are complete and pushed. Your
job is Phase 2, and only Phase 2.

Work on `main` and push there when done. (If your session designates a feature
branch instead, that wins — push there and say which you used.)

---

## 1. Read these first, in this order

Do not start coding until you have read all five. They contain facts that were
expensive to establish and will cost you hours if you re-derive them badly.

| File | Why |
|---|---|
| `src/opencode/types.ts` | **The most important file in the repo for your task.** The adapter interface, the six places the original design sketch was wrong, and why. You will be writing against this all week. |
| `docs/phase0-facts.md` | Every verified fact about OpenCode, plus the four still unresolved. Two of them constrain your design. |
| `test/opencode/serve.test.ts` | Executable documentation of how the adapter behaves — including the blocked→resume path, the stuck-worker/dead-server distinction, and what an abort actually emits. |
| `projectplan.md` §4, §5, §8, §9, §11 | The data contracts, the lifecycle you are implementing, budget/security policy, and recovery semantics. |
| `docs/adr/0001-serve-vs-run-backend.md` | Why there is one server and N sessions, and what that costs you. |

Verified against **OpenCode 1.18.25**. If `opencode --version` differs
materially, run `bun run spike` first — it is the drift canary, and a red spike
means the fact sheet needs updating before you build on it.

---

## 2. Your task

From `projectplan.md` §11:

> **Phase 2 — Worker manager core (3–4 days)**
> - State machine, registry, SQLite store, task-brief builder, report parser +
>   diff reconciliation, timeout/idle watchdogs.
>
> **AC:** full spawn→running→completed lifecycle on the golden repo; blocked path
> works; timeout aborts; manager restart recovers state.

Concretely, deliver:

1. **`src/manager/state.ts`** — the state machine from §5, as data. Every
   transition in that diagram, explicitly enumerated, with illegal transitions
   rejected rather than silently allowed. This is the file the rest of the phase
   hangs off; get it right before anything else.
2. **`src/manager/worker.ts`** — the registry and the run loop: spawn a worker,
   drive it through the lifecycle, apply the watchdogs, produce a
   `WorkerResult` (§4.3).
3. **`src/store/`** — SQLite (`workers`, `events`, `runs`). Per DD-7 the
   worktrees are the durable state and the DB is the index — build it so a lost
   DB is recoverable, not catastrophic.
4. **`src/briefs/`** — the task-brief builder (§4.1) and the report parser
   (§4.2), including **the reconciliation in DD-4**: `changes[]` from the report
   cross-checked against real `git diff --name-only`, discrepancies surfaced in
   the result rather than swallowed. `ocmock`'s `lying_report` scenario exists
   for exactly this test and the assertion is yours.
5. **`src/workspace/`** — *only* what the lifecycle needs: create a worktree,
   snapshot-commit on completion (DD-5), compute a diff stat. Overlap detection,
   the merge gate and cleanup are Phase 4's. Before writing git plumbing by
   hand, read §6 of the fact sheet — OpenCode already exposes
   `POST /experimental/worktree` and `GET /session/{id}/diff`, and neither has
   been evaluated.
6. **`test/fixtures/`** — the golden repo (§12): a small npm project with real
   tests that pass, and a way to make them fail on demand. Your AC names it and
   it does not exist yet.
7. **`test/`** — unit tests for transitions, brief/report round-trips, and
   reconciliation; lifecycle tests against `ocmock`; one integration test on the
   golden repo behind `OC_E2E=1`.

---

## 3. Facts you must not re-derive — and the ones that will silently break you

These are verified. Build on them.

**The three that will cost you hours if you ignore them:**

> **1. An abort emits *two* terminal events, in order:** `session.error` carrying
> `MessageAbortedError`, and *then* `session.idle`. A state machine that treats
> the first terminal event as final will mark every timed-out and over-budget
> worker `failed` instead of `timed_out` / `over_budget`, and you will lose the
> distinction that tells Claude whether to retry. Decide explicitly what a
> deliberate abort looks like on the way in, and test it — `ocmock`'s
> `over_budget` scenario reproduces it.

> **2. Breaking out of a `for await` does not close an `EventStream`.** This is
> deliberate and it is what makes the blocked→answer→resume path in §5 a single
> subscription rather than three. The lifecycle is explicit: `close()`, or
> `dispose()`. If you write the run loop assuming the stream dies when you stop
> reading, you will leak subscriptions; if you assume it survives and never
> close it, same. See `EventStream` in `types.ts`.

> **3. `projectplan.md` §4.1 and §4.2 are stale where they describe channels.**
> §4.1 says the brief goes in `AGENTS.md`; §4.2 says the worker writes
> `report.json`. Phase 0 left `AGENTS.md` pickup **unverified** (unresolved #3)
> and found something better for both: the per-prompt `system` field carries the
> contract, and `format: {type: "json_schema", schema, retryCount}` on
> `prompt_async` constrains the reply *and retries it server-side on violation*.
> §6.1 already says to prefer these. Do not implement the file-based contract
> just because §4 draws it. **Pick a channel, write ADR-0002 recording why, and
> update §4** — the next agent should not have to rediscover this.

The rest:

- **Everything OpenCode-shaped is already behind an interface.** Import from
  `src/opencode/index.js` and nothing deeper. `test/opencode/boundary.test.ts`
  fails the build if any module outside `src/opencode/` names an endpoint,
  parses an OpenCode event type, or reaches past the barrel. It scans `src/`
  automatically, so it will start policing your new files the moment you add
  them. That is the point (DD-2) — do not weaken the test to get past it.
- **Subscribe before you prompt.** `await backend.events(session)` resolves only
  once the subscription is live; do that, *then* `prompt()`. A trivial task
  completes in ~11 s and a late subscriber misses the completion event entirely.
- **The idle watchdog keys off worker events, not stream silence.** Use
  `isWorkerEvent(e)`. `server.heartbeat` arrives every 10 s whether or not
  anything is running, so a watchdog that resets on any frame never fires. The
  discrimination you need: heartbeats arriving + no worker events = the *worker*
  is stuck; no heartbeats = the *server* is gone, confirmable with
  `backend.health()`. Two different failures, two different responses.
  `ocmock`'s `hang` and `crash` scenarios are built to tell them apart.
- **Budget on tokens, not dollars.** `Usage.cost` is `0` on free-tier providers
  even after real work; `totalTokens` is always populated. §8 says "~$2 or
  token-equivalent — verify in Phase 0": it was verified, and the answer is
  tokens. `cost` on paid providers is still unresolved (#4), so do not build
  dollar-denominated budgets on it yet.
- **Session reuse retains context**, verified. `worker_revise` and the
  blocked→resume path both just send another `prompt()` to the same session.
- **Worker modes (DD-10) are already expressible.** `research`/`review` are
  read-only via the `permissions` ruleset on create and the per-prompt `tools`
  map (`{bash: false}`); `implement` gets `HEADLESS_PERMISSIONS`. You do not
  need a new mechanism.
- **One server handles 4 concurrent worktree sessions** with no cross-talk, at
  ~1.4–1.9× single-session latency. Measured once, on one free-tier model.
  Enough to build on; not enough to raise a cap past 4.
- **Pre-warm the server.** The first prompt on a fresh server emits ~45
  `plugin.added` events before generation starts. Do not charge that latency to
  the worker's idle watchdog.
- **Worker output is untrusted (DD-8).** The manager never executes anything
  found in a report. The reconciliation exists because workers misreport — treat
  every claim as a claim until the diff agrees.

---

## 4. Definition of done

- [ ] `npx tsc --noEmit` clean.
- [ ] `bun test` green, including the existing 56 tests — you must not regress them.
- [ ] Full spawn→running→completed lifecycle passes on the golden repo.
- [ ] Blocked path works: worker asks, manager surfaces, answer resumes the same session.
- [ ] Timeout aborts, and the worker lands in `timed_out` — not `failed`.
- [ ] Manager restart recovers state: kill it mid-run, restart, `running` workers
      become `interrupted` with their worktrees intact.
- [ ] Reconciliation catches a lying report (`ocmock` scenario `lying_report`).
- [ ] `bun run spike` still green.
- [ ] No module outside `src/opencode/` imports an OpenCode type or endpoint.
- [ ] Committed and pushed.
- [ ] `projectplan.md` §11 Phase 2 marked complete, in the same style as Phases 0
      and 1, linking to what you produced.
- [ ] Anything you discovered that contradicts `docs/phase0-facts.md` is
      **corrected there**, and anything that contradicts `projectplan.md` §4/§5
      is **corrected there** — not left for the next agent to trip over.

---

## 5. Scope boundaries

**Do not build**, however tempting: the MCP tool surface (Phase 3 — `src/mcp/server.ts`
holds Phase 0 scaffolding, leave it alone), the merge gate, overlap detection or
worktree cleanup (Phase 4), the task queue and concurrency semaphore (Phase 5 —
`projectplan.md` §3.2 lists it under the manager, but §11 puts it in Phase 5;
§11 wins), the review loop (Phase 6).

Build the *minimum* worktree handling your lifecycle needs and no more. If you
find yourself designing merge conflict resolution, you have left Phase 2.

If Phase 2 turns out to be blocked on something, finish every unblocked part,
push it, and say plainly what is left and why. Do not quietly narrow the scope.

---

## 6. Environment notes

```bash
npm install -g opencode-ai      # installs cleanly; verified 1.18.25
npm install                     # project deps
bun test                        # 56 tests, no OpenCode needed
bun run spike                   # confirm the baseline is green before you start
```

- A provider key is needed for real runs. `opencode/muse-spark-1.2-contributor-free`
  worked with no configured credentials and is a good default for tests.
- `test/ocmock/` is a scriptable fake OpenCode server covering success, hang,
  blocked, over-budget, crash and the lying-report hook. **Extend it rather than
  reaching for real OpenCode** — it runs in milliseconds and it reproduces the
  directory-scoping hazard that makes real failures silent. Add scenarios there
  for anything new you need to test.
- **Do not run `pkill -f 'opencode serve'`.** `pkill -f` matches full command
  lines, including your own shell's, so it kills the shell running it. Match on
  a PID you captured, or use a non-self-matching pattern.
- `NO_PROXY` must include `127.0.0.1,localhost` or `fetch()` will try to tunnel
  localhost through the outbound proxy. The adapter handles this itself
  (`ensureLocalhostBypassesProxy`); anything you write that talks HTTP to
  localhost outside the adapter needs the same treatment.

---

## 7. A note on model routing

If you are orchestrating this across models: the **state machine and the
reconciliation logic** deserve the stronger generalist — the first because every
later phase inherits its mistakes, the second because it is the one place the
system decides whether to believe a worker. The **SQLite store** and the **golden
repo fixture** are well-specified, independently testable, and good candidates to
delegate; the fixture in particular depends on nothing else in this phase and can
be built first, in parallel.

---

## 8. Before you finish

Three Phase 0 items remain unresolved and two of them are adjacent to your work.
You are not required to close them, but if the opportunity arises, do — and
record the result in `docs/phase0-facts.md`:

1. **`AGENTS.md` pickup.** A file was placed in a worktree but the model was
   never asked to prove it read it. If you keep any file-based channel, verify it
   with a marker string first. Your brief builder is the natural place to settle
   this for good.
2. **`cost` on paid providers.** Only free-tier models have been exercised
   (`cost: 0` throughout). Your budget enforcement is the natural place to find
   out whether `cost` populates on a paid provider.
3. **Claude Code's MCP tool-call timeout.** Instrument built
   (`orchestrator_timeout_probe`), measurement requires a live Claude Code
   session. Not yours — but Phase 3's `worker_wait` cap depends on it, so if you
   happen to be running inside a session that can take the measurement, take it.
