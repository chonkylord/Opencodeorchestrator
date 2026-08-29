# Handoff: implement Phase 6 — the review loop, and reach v1

You are picking up the **Claude → OpenCode Subagent Orchestrator** at
`chonkylord/Opencodeorchestrator`. Phases 0 through 5 are complete and pushed.

**Phase 6 is the last phase of v1.** Everything before it made work *happen*
(Phase 2), *visible* (Phase 3), *takeable* (Phase 4) and *parallel* (Phase 5).
What the system still cannot do is tell a worker it got something wrong. That is
this phase, and finishing it means running the full v1 demo — which is the
project's definition of done (`projectplan.md` §11, Phase 6's AC).

Work on the branch your session designates; if it designates none, `main`. Push
after the implementation and again after the demo, rather than saving one
enormous commit for the end.

This document was written by the agent that finished Phase 5, before writing a
line of Phase 6, because the exercise *is* the design review. Section 3 is the
part that will save you time; read it even if you skim the rest.

---

## 1. Read these first, in this order

Do not start coding until you have read all seven.

| File | Why |
|---|---|
| `projectplan.md` §11 Phase 6, §7's `worker_revise` row, §5's "Revision path", §13 | Your specification. §5 already says `maxRevisions` defaults to 3 and that the manager "refuses and reports" at the cap — that line predates every phase and is still the design. §13's *"infinite fix loops → revision caps with terminal actionable reports"* is the whole risk model, and **"actionable" is the load-bearing word.** |
| `src/manager/worker.ts` — `drive()`, `prepareAndRun()`, `pump()`, `enterBlocked()`, `settle()`, and the `ManagedWorker` class | The run loop you are about to make **re-entrant**. Read `ManagedWorker`'s fields as a list of things that survive settling and will be wrong on a second turn — see §3, trap 2. `drive()` now begins with an `await` on a concurrency admission; that is trap 1. |
| `src/manager/scheduler.ts` and `docs/adr/0004-queue-and-dependencies.md` | Phase 5's admission gate. A revision that skips it silently un-caps the whole system. ADR-0004 also records the failed-dependency rule and the restart semantics you inherit. |
| `src/manager/state.ts` §"Transitions" | Phase 6 adds edges — at least `completed --revise--> running`. Which of `failed`, `timed_out` and `over_budget` also get one is a real decision with real consequences; `merged` almost certainly should not. §3, trap 5. |
| `docs/adr/0003-integration-worktree.md` §"Decision 3" and `src/workspace/merge.ts` — `mergeOne()` | The merge resolves each candidate's **branch tip**, not the snapshot sha in its result, so a revised worker's new commit is merged without touching the pipeline. Verified by reading it, not assumed. But the §6.2 *overlap check* reads `result.changes.paths` — see §3, trap 6. |
| `docs/adr/0002-worker-contract-channel.md` and `src/briefs/` | Where the report contract lives, and why it lives in the brief's words rather than in `format: json_schema`. Phase 6's critique wants a shape; the shape has to come from the brief. |
| `docs/phase0-facts.md` §5, §7, and "Unresolved" 2 and 5 | The permission rows (including the Phase 5 observation that `external_directory` fires non-deterministically), the 60 s host ceiling, and the in-band-reply gap that **Phase 6 pays for on every revision round** — unresolved 5 is finally worth closing and it is yours if you touch the adapter. |

Verified against **OpenCode 1.18.25** and **Claude Code 2.1.251** on 2026-08-29.
If `opencode --version` differs materially, run `bun run spike` first — it is the
drift canary and it is green today.

---

## 2. Your task, Phase 6

From `projectplan.md` §11:

> **Phase 6 — Review loop (3–4 days)**
> - `worker_revise` with session reuse, revision caps, optional read-only
>   reviewer worker critiquing another worker's diff.
>
> **AC:** seeded failing worker receives feedback, fixes, passes; loop terminates
> at cap with an actionable report to Claude.
> **Plus the v1 demo** (moved here from Phase 5, whose AC could not contain it).

Concretely, deliver:

1. **`worker_revise(id, feedback)`.** Re-prompt a *settled* worker's existing
   session with Claude's feedback, and drive it to a new settled state. Session
   reuse is the point: the worker keeps everything it read and worked out, which
   Phase 2's e2e test already proved and `manager.answer()` already does on the
   blocked path. Returns the revision number, and returns **immediately** — the
   revision runs in the background like everything else (DD-1).
2. **A revision cap, with its own counter.** Default 3 (§5). At the cap,
   `worker_revise` refuses — and the refusal is a *terminal actionable report*,
   not an error string: what was tried each round, what changed, what is still
   failing, and what Claude's options are. A cap that stops the loop and produces
   nothing Claude can act on has converted a runaway into a dead end.
3. **New state-machine edges, enumerated.** At minimum
   `completed --revise--> running`. Decide deliberately about `failed`,
   `timed_out` and `over_budget`; decide deliberately about `merged` (§3, trap 5).
4. **A `review` worker that actually reviews.** Mode `review` exists and is
   read-only. What it does not have is a way to be pointed at *another worker's
   diff*. `readCommitDiff()` produces one without a worktree at all, and §6.1
   says a review worker gets "no worktree, or a read-only mount of the target
   worktree" — while `createWorktree()` today runs unconditionally for every
   mode. That is a decision point you must resolve rather than inherit.
5. **The revision rounds in the run report and the status line.** The report
   (`src/manager/runreport.ts`) has a per-worker section; a worker that was
   revised twice should say so, with what each round changed. `render.ts` prints
   `resumes` as "revisions" today, which becomes a lie the moment the two
   counters diverge — §3, trap 4.
6. **Tests**: `test/manager/` for the re-entrant run loop, the cap, the edges and
   the re-armed waiters; `test/mcp/` for `worker_revise` over real JSON-RPC and
   for the terminal report at the cap. `test/ocmock/` is a scriptable fake server
   and you extend it rather than reaching for real OpenCode — it already has
   `setReport(sessionID, …)` for "says one thing, then having been told
   otherwise, says another", which is exactly a revision.
7. **An ADR** if — and only if — you make a decision the next phase would have to
   reverse-engineer. Which failure states are revisable, and whether a revision
   re-enters the concurrency queue, are both candidates. `docs/adr/0005-*.md`.
8. **The v1 demo**, driven by Claude from a live session (§6 has the recipe that
   works, including the mistake I made the first time).

---

## 3. Facts you must not re-derive — and the ones that will silently break you

**The five that will cost you hours. The first is new, and it is the one Phase 5
created.**

> **1. A revision must go back through the concurrency queue, or the cap stops
> meaning anything at all.** Phase 5 put an admission gate at the top of
> `drive()` and releases the slot in its `finally`, *after* `settle()`. So a
> settled worker holds no slot. A `worker_revise` that re-enters the run loop
> without calling `scheduler.enqueue()` again puts a session on the shared
> backend that nothing is counting: revise three completed workers while three
> others are running and you have six concurrent sessions under a cap of three,
> with no error and no log line. The symptom is a provider that starts refusing
> prompts under a cap that was supposed to prevent exactly that.
> Concretely: a revision is a spawn-shaped thing. It should acquire, run,
> settle, release — and while it waits for a slot the record should say so, the
> way a queued spawn does (`reason: "queued"`, `manager.queueHint()`).
> `Scheduler.release()` is `occupied.delete()` plus a pump, so a stray second
> release is harmless; a *missing acquire* is not.
> Two consequences fall straight out and both are decisions: **does a queued
> revision count against the worker's revision cap before it runs?** (it should
> not — the cap counts rounds the worker actually took), and **what does
> `dependsOn` mean when a dependency goes back to `running`?** `outcomeOf()`
> reads live state, so a completed dependency that starts revising flips from
> `satisfied` back to `waiting` — which is arguably right, and means a dependent
> still in the queue will wait for the revision while one already admitted will
> not. Pick one, write it down, test it.

> **2. `ManagedWorker` is full of fields that survive settling, and half of them
> are wrong on a second turn.** The run loop was written once, for one turn, and
> it says so. Before a revision re-enters `pump()`, every one of these has to be
> deliberately handled — not "probably fine":
> - `cancelRequested` — **sticky, and Phase 5 made it load-bearing.**
>   `prepareAndRun()` returns `{kind:"cancelled"}` at four step boundaries when
>   it is set. A worker that was stopped, then revised, bails instantly with a
>   reason from the previous life. Clear it, or refuse to revise a cancelled
>   worker, but decide.
> - `replyText` / `replyTruncated` — the report channel. Not cleared means the
>   new report is the old one with the new one concatenated, and `parseReport`
>   will find the *first* JSON object. `enterBlocked()` clears both before it
>   re-prompts; copy that, do not invent a second way.
> - `turnStarted`, `sawAbort`, `abortIntent`, `retryAt` — the terminal-event
>   discrimination from Phase 2's facts (1) and (3). A stale `sawAbort` turns the
>   revision's clean finish into `aborted_externally`.
> - `lastTerminalAt` — **keep it.** It is what makes `promptTurn()` wait out the
>   settle guard, and OpenCode 1.18.25 *silently drops* a prompt sent within tens
>   of milliseconds of a session's terminal event: 204, then nothing, for 57
>   seconds. A revision prompts a session that just went terminal, so this is the
>   single most likely way to get a revision that does nothing at all.
> - `runningSince`, `blockedTotalMs` — the wall-clock budget's origin. Does a
>   revision get a fresh budget or continue the old one? A fresh one is the
>   defensible default (it is a new turn with a new instruction) and it must be
>   set at the *prompt*, not at the revise call, for the same reason Phase 5's
>   queue time is free.
> - `formatRetried` / the manager's `structuredOutputOK` — leave latched. The
>   provider has not changed its mind.
> - `stream` — **`drive()` closed it in a `finally` and it is gone.** A revision
>   needs a *new* subscription, awaited before the prompt goes out, for the same
>   reason `prepareAndRun()` subscribes before prompting: a trivial turn can
>   finish in ~11 s and a late subscriber misses the completion entirely.
> - `done` — see trap 3.

> **3. `w.done` is a single field, and `dispose()` awaits it.** `dispose()` and
> `cancel()` both `await w.done`, and a settled worker's `done` is already
> resolved. If `worker_revise` starts a new loop without installing a new `done`
> *before it returns*, a `dispose()` that lands in between awaits a promise that
> resolved five minutes ago and returns while a revision is still prompting a
> session — the process exits with work in flight. Install the new `done`
> synchronously in the same tick as the state change, the way `spawn()` does.
> And the mirror of it: `cancel()` on a revising worker must find something to
> abort. It checks `scheduler.reject()`, then `w.answer`, then `w.session` — a
> revising worker has a session, so that path works, but only if `machine.final`
> is false, which it will be in `running`.

> **4. The waiters are already resolved, and `resumes` is already printed as
> "revisions".** Two separate problems with the same shape:
> `wait()` resolves on any settled state and deletes its callback; `waitMany()`
> re-checks `isSettled(machine.state)` on every notify, so a *new* batched wait
> after a revision behaves correctly — but every caller who already got their
> answer has gone. That is fine and expected; what is not fine is
> `worker_revise` followed by `worker_wait` on the same worker returning
> instantly with the pre-revision record. The revision must move the machine out
> of `completed` **before** `worker_revise` returns, so the next `worker_wait`
> has something to wait for. Assert exactly that; it is one line of test and it
> is the difference between a revision loop and a caller that never notices.
> Separately: `render.ts`'s `statusLine` prints `· revisions: ${r.resumes}`, and
> `resumes` counts *unblock-resumes* (§5's blocked→answer→resume). §13's cap
> counts something else for a different reason. Give revisions their own counter
> on `WorkerRecord`, fix the label, and note that the `workers` table needs a
> column — `src/store/schema.ts` is additive with `IF NOT EXISTS`, so bump
> `SCHEMA_VERSION` and add the column the way Phase 4 added `merges`.

> **5. `completed` is settled but not final, and that is the *only* state where
> this is obviously true.** The machine's `FINAL` set is
> `{merged, failed, timed_out, over_budget, cancelled}` and `apply()` **throws**
> on an illegal move, loudly, before anything else happens. So:
> - `completed --revise--> running` is the edge you certainly need.
> - `timed_out --revise--> running` is *tempting and defensible*: the session may
>   well still be alive and revising it is cheap. But a worker that timed out
>   because it was wedged will wedge again, and you have just spent another
>   fifteen minutes finding out.
> - `failed --revise--> running` is usually not worth it — a content filter or a
>   provider error will reproduce — but `failed` covers `stream_error` and
>   `server_gone` too, which are not the worker's fault at all.
> - `over_budget --revise--> running` hands more budget to the worker that
>   already ran away with it. If you allow it, the fresh budget from trap 2 is
>   the thing that makes it survivable.
> - **`merged` should not be revisable.** Its commits are on an integration
>   branch; a revision produces a commit that branch does not have, and the run
>   report would show a merged worker whose branch tip is not what was merged.
>   Respawn instead — and say *why* in the ADR rather than leaving it as an
>   omission, because "we forgot" and "we decided" look identical in a
>   transition table.

**The rest, in rough order of how much they will cost you:**

- **The merge already handles revisions; the overlap check does not.**
  `mergeOne()` resolves `candidate.branch`'s tip with `rev-parse`, explicitly
  *not* `result.snapshot.sha` — the comment says so — so a revised worker's new
  commit merges without any change to the pipeline. But `MergeCoordinator.start()`
  builds the §6.2 overlap warning from `r.result?.changes.paths`, which is the
  measurement taken at the *previous* settle. A revision that touches a new file
  produces an overlap warning that is quietly out of date. Since a revision
  re-runs `settle()` and rebuilds the result, this fixes itself **provided the
  revision settles before the merge starts** — which is exactly the ordering a
  test should pin rather than assume.
- **A `review` worker needs no worktree, and Phase 5 already made that
  survivable.** `settle()` skips the snapshot when `worktree === ""`, and
  `buildResult()` short-circuits when `startedAt === undefined`. The second one
  does **not** apply to a reviewer — a reviewer does start — so if you give it no
  worktree, `changedFiles()`/`diffStat()` on `""` is the path to check. Reading
  the code is cheaper than discovering it: they are guarded by a `try` that
  produces an `unparseable_report` discrepancy, which for a reviewer would be a
  discrepancy about a diff it was never supposed to have.
- **The reviewer's critique is worker output and is untrusted (DD-8) — and it is
  a claim about a claim.** Everything in `src/mcp/render.ts` and
  `src/manager/runreport.ts` marks worker-authored text and caps it; follow that,
  do not invent a second house style. `runreport.ts`'s `cell()` exists because a
  worker's summary containing a backtick can open a code span that swallows the
  orchestrator's own lines — a reviewer writing about code will contain
  backticks constantly.
- **A reviewer that shares the author's blind spots is a weaker check than the
  reconciliation the orchestrator already does itself.** Every worker here is
  Muse Spark (see §7), so Phase 6's reviewer is Muse Spark reviewing Muse Spark.
  The tool descriptions must not let a critique read as a finding: the
  orchestrator's diff-versus-report reconciliation and its independent test run
  are the stronger evidence and should stay the headline. Say this out loud in
  the design; it is the honest framing and §11 Phase 8 (cross-model review
  diversity) is where it stops being true.
- **Do not reintroduce a dependency on structured output.** A critique wants a
  shape, and `format: json_schema` is right there. It does not work on this
  project's default model: the manager attempts it, drops it on the first
  rejection and latches it off for the backend (ADR-0002). The shape has to come
  from the brief's words, and `parseReport` was written to be lied to.
- **One writer per transition.** Phase 5 found `markMerged` appending
  `state:merged` beside the transition that already appends it — two identical
  rows in the run report's timeline. The state machine's `onChange` hook
  installed in `spawn()` is the only writer of `state:*`; extra context rides on
  `apply()`'s `detail`. A new `revise` edge must not repeat that.
- **`recover()` will meet a revising worker.** A revision leaves the row in
  `running`, so a manager that dies mid-revision produces `interrupted` with a
  worktree intact — correct, and worth one test rather than one assumption.
  Whether `interrupted --recover--> running` should be able to resume a
  *revision* is a question §9 left open and Phase 6 does not have to answer.
- **The queue is in-process and does not survive a restart** (ADR-0004). If a
  revision queues, that is one more thing in it; `manager_restart_while_queued`
  is the reason a queued row carries.
- **`spawn()` returns in under a second and so must `worker_revise` (DD-1).**
  `manager.answer()` is the precedent for what *not* to do at the tool layer: it
  resolves only once the follow-up prompt is away, which waits out
  `retrySettleMs`, so `worker_message` starts it and returns. `worker_revise`
  has the same shape and needs the same treatment — including catching the
  detached promise's rejection so a failure downstream cannot take the server
  down as an unhandled rejection.
- **The DD-2 boundary test polices `src/` and that includes everything you
  write.** Do not name an OpenCode endpoint, a raw event type, or the phrase for
  starting the server process — in code *or in comments*.
  `test/opencode/boundary.test.ts` fails the build the moment you do.
- **stdout is the JSON-RPC channel.** Every diagnostic goes to stderr.
- **Budgets are per worker and on tokens.** `cost` is `0` on the free tier and
  will stay `0`; a dollar-denominated anything is dead code. §8's global run cap
  is Phase 7's.

---

## 4. Definition of done, Phase 6

- [ ] `npx tsc --noEmit` clean.
- [ ] `bun test` green, **including the existing 259** — you must not regress
      them. (259 pass, 4 skip today.)
- [ ] `bun run spike` still green.
- [ ] Every tool returns in under two seconds, asserted in a test,
      `worker_wait` excepted and still capped at 30,000 ms.
- [ ] **A seeded failing worker receives feedback, fixes it, and passes** — the
      §11 AC, over real JSON-RPC against `ocmock`. `breakGoldenRepo()` makes a
      suite fail on a real assertion rather than a stubbed exit code.
- [ ] **The loop terminates at the cap with a report Claude can act on.** Assert
      on the *content*: it names what was tried, what changed between rounds, and
      what is still failing. A test that only checks the refusal happened has
      tested the half that was never the risk.
- [ ] **The session is reused, and provably.** Same `sessionID` across rounds,
      and the worker demonstrably still has its context.
- [ ] **A revision never exceeds the concurrency cap** — asserted by observation,
      the way Phase 5's is: with the cap full, a revision waits, and the record
      says why.
- [ ] **`worker_revise` then `worker_wait` waits**, rather than returning the
      pre-revision record instantly.
- [ ] **`dispose()` and `cancel()` work on a revising worker** — no hang, and
      `dispose()` does not return while a revision is still prompting.
- [ ] **A revised worker merges its new commit**, and the overlap warning
      reflects the post-revision diff. Test it rather than trusting §3.
- [ ] **A `review` worker critiques another worker's diff**, read-only,
      producing something Claude can use — with the diff-versus-report
      reconciliation still presented as the stronger evidence.
- [ ] **The v1 demo**, driven by Claude from a live session per §6: *"Add a
      settings page" — 3 concurrent workers (UI / API / tests), review,
      revisions, gated merges, final validation, run report.* The `tool_result`
      blocks are the evidence; the model's prose about them is not.
- [ ] `projectplan.md` §11 Phase 6 marked complete in the same style as Phases 0
      through 5, linking to what you produced, **and §11's Phase 6 AC updated to
      say the v1 demo was run** rather than that it will be.
- [ ] Anything you discovered that contradicts `docs/phase0-facts.md`,
      `projectplan.md` or the ADRs is **corrected there, in place, not
      appended.** New measurements get the date, the version and the method, the
      way §7's host-timeout row and "Unresolved" 2's Phase 5 re-measurement are
      written.
- [ ] The README's Status, tool table and any claim about what is missing are
      current. It currently says the review loop is what is missing.
- [ ] Committed and pushed.

---

## 5. Scope boundaries, Phase 6

**Do not build**, however tempting:

- **Retries with backoff, global run budgets, metrics, orphan TTL pruning,
  crash-recovery flows beyond what exists** (Phase 7). A revision is not a retry:
  a retry re-runs the same instruction, a revision sends a new one. If you find
  yourself writing exponential backoff, you have crossed into Phase 7.
- **Automatic revision.** Nothing should decide on its own that a worker needs
  revising — not a red merge gate, not a discrepancy, not a reviewer's critique.
  Claude decides; the tools report. An orchestrator that revises workers by
  itself is an infinite fix loop with extra steps, and §13's cap is a backstop,
  not a licence.
- **Model-routing presets with automatic selection, worker priorities,
  cross-model review diversity, shared-workspace mode** (Phase 8). `models` per
  mode already exists as a config option; leave it as one.
- **A smarter scheduler.** FIFO with a dependency check is the whole of it
  (ADR-0004).
- **Redesigning the merge pipeline for revisions.** It was built for them; see
  §3. Add a test, not a redesign.

If Phase 6 turns out to be blocked on something, finish every unblocked part,
push it, and say plainly what is left and why. Do not quietly narrow the scope.

---

## 6. Environment notes

```bash
npm install                     # project deps — a fresh clone has no node_modules
npm install -g opencode-ai      # installs cleanly; verified 1.18.25
bun test                        # 263 tests (259 pass, 4 skip), no OpenCode needed
bun run spike                   # the drift canary; green today, takes ~1-2 min
npx tsc --noEmit
OC_E2E=1 bun test test/e2e      # the real-OpenCode tests
OC_E2E=1 OC_E2E_CONCURRENCY=1 bun test test/e2e   # + the four-session isolation probe
```

- Configure the server with `ORCHESTRATOR_REPO` / `_DB` / `_MODEL` / `_BASE_URL`
  / `_VERIFY_TESTS` / `_MAX_CONCURRENT` (README → Configuration). Anything new
  belongs in the same family and the same table.
- **Driving a live Claude Code session from inside this container works, and is
  how Phase 5 took its measurements.** The recipe, verbatim:

  ```bash
  # 1. a throwaway golden repo — never point a test or a demo at this repository
  bun -e 'import {makeGoldenRepo} from "./test/fixtures/golden.js";
          const r = makeGoldenRepo("demo"); console.log(r.path)'

  # 2. an mcp.json pointing the server at it
  #    {"mcpServers":{"orchestrator":{"command":"bun",
  #      "args":["run","/abs/path/src/mcp/server.ts"],
  #      "env":{"ORCHESTRATOR_REPO":"<the path from step 1>"}}}}

  # 3. drive it, with ONLY orchestrator tools allowed
  claude -p --strict-mcp-config --mcp-config ./mcp.json \
    --allowedTools "mcp__orchestrator__worker_spawn,mcp__orchestrator__worker_status,…" \
    --output-format stream-json --verbose "…" > demo.jsonl
  ```

  **Allowlist every tool the demo could need, including `worker_message` and
  `worker_stop`.** Phase 5's first attempt omitted `worker_message`, two workers
  blocked on a permission ask, and the whole run ended with Claude asking for
  permission to unblock them — a wasted run for a one-word omission. For Phase 6
  that list must include `worker_revise`.
  Read the `tool_result` blocks out of the JSONL; the model's prose about what
  happened is not the evidence. The store is at
  `<repo>/.orchestrator/orchestrator.db` and its `events` table is the trail —
  Phase 5's cap and dependency claims were checked against it directly, and that
  is a good habit.
- `test/ocmock/` is a scriptable fake server, and Phase 6 should extend it the
  way each phase before did: Phase 3 added `abortDelayMs`, Phase 4 added
  `perWorktreeFileName` / `perWorktreeFileContent`, Phase 5 added `workMsFor`
  (per-worker work time, keyed by the worker id in the session's directory —
  which is how "worker A is still running when C is admitted" became a fact
  rather than a race). `setReport(sessionID, …)` already lets a session say one
  thing and then, having been told otherwise, say another. **A revision that
  fixes something is exactly two scripted reports and a real file write**, and
  building that on real latency is how a suite becomes flaky.
- `test/fixtures/golden.ts` materializes the golden repo into a temp git
  repository; `breakGoldenRepo()` makes its suite fail on a real assertion.
  **Never point a test at this repository itself.**
- **Do not run `pkill -f 'opencode serve'`.** `pkill -f` matches full command
  lines including your own shell's; Phase 3 did it anyway and killed its own
  session. Match on a PID you captured.
- `NO_PROXY` must include `127.0.0.1,localhost`. The adapter handles this itself.

---

## 7. The model you are actually running on

**This project runs on `opencode/muse-spark-1.2-contributor-free` — the free Muse
Spark on OpenCode Zen — and that is the intended production configuration, not a
testing shortcut.** It is `DEFAULT_MODEL_ENV` in `src/mcp/config.ts` and
`DEFAULT_MODEL` in `src/manager/worker.ts`. Four consequences:

- **It rejects schema-constrained output.** See §3. The contract lives in the
  brief's words.
- **`cost` is always `0`.** Budgets are on `totalTokens`; `cost` is advisory.
  `docs/phase0-facts.md` "Unresolved" 4, still open, still blocked on a paid key
  nobody here has. Do not build dollar budgets. Do not "fix" the zero.
- **It is the only model in play**, so Phase 6's reviewer is it reviewing itself.
  Keep `models` per mode as configuration so a second model is a config change,
  and do not build selection logic around models that are not there.
- **Three concurrent free-tier workers is now measured and comfortable**
  (Phase 5, 2026-08-29: three workers plus a queued dependent, all completing,
  23.8–48.7 s each at 6.2k–17.0k tokens, no rate limiting, no refused prompt).
  More than four is still unmeasured. Revisions make waves *longer*, not wider,
  so this phase should not move the cap — but if a provider starts refusing
  prompts under load, that is a **finding** for the fact sheet and a lower
  default, not a reason to build a retry policy.

---

## 8. A note on model routing

If you are orchestrating this across models: the **re-entrancy of the run loop**
is the least delegable part. Trap 1 (the concurrency slot), trap 2 (the fields
that survive settling) and trap 3 (`w.done`) are all failures that produce a
green test suite and a wrong production run, and none of them announces itself.
The **revision cap and its terminal report**, the **`review` worker's brief**,
and the **run-report and status-line rendering** are well specified and
independently testable; `src/mcp/render.ts` and `src/manager/runreport.ts` are
working precedents for every cap and every "next:" hint. The **ocmock scripting**
for a two-round revision is a good first task, because everything else needs it.

---

## 9. When Phase 6 is done: check what you have

Push the implementation first. Then, before you call v1 done:

1. **Run the whole suite three times.** Phase 6 makes the run loop re-entrant,
   which is the second-best way after concurrency to introduce a bug that shows
   up one run in five. If anything is flaky, fix the flake or explain it in
   writing; do not re-run until it is green.
2. **Run the full v1 demo from a live Claude Code session** (§6). Three
   concurrent workers, a review, at least one real revision, a gated merge, and a
   run report. Read the `tool_result` blocks.
3. **Check the properties that are easy to break and hard to notice:** no
   revision ran outside the cap; the same session id carried every round; a
   `worker_wait` after a `worker_revise` actually waited; `dispose()` returned
   without leaving a prompt in flight; and the merged commit is the *post*-
   revision one.
4. **Re-read your own diff adversarially.** What happens if a worker is revised
   while it is queued for a previous revision? If two revisions are requested in
   the same tick? If a revision is cancelled between the queue and the prompt?
   If the cap is reached *during* a revision rather than before it? Write the
   test for whichever you cannot answer from the code.
5. **Confirm the documentation is true.** §11 Phase 6 complete in the house
   style, the AC updated to record the demo rather than promise it, the README's
   Status and tool table current, and every fact you measured written into
   `docs/phase0-facts.md` in place.
6. **Then say v1 is done, and say what v1 is not.** Phase 7 (hardening: budget
   enforcement, retries, orphan pruning, metrics) and Phase 8 (optimization) are
   real work that is not in v1, and the three carried items below are still
   open. A "done" that does not say what it excludes is the one kind of report
   this project has spent six phases not writing.

---

## 10. Still open across the earlier phases

Four items are carried, and **the first is Phase 6's to close if you touch the
adapter at all:**

1. **Replying to a permission or question request in band.**
   `docs/phase0-facts.md` "Unresolved" 5. The adapter surfaces
   `permission`/`question` asks as normalized events but exposes no way to answer
   them, so the manager converts a mid-run ask into an escalation: it aborts the
   turn and delivers the answer as the next prompt to the same session. It works
   and it costs a partial turn — **and Phase 6 pays that cost on every revision
   round that trips a permission.** Phase 5 measured that this is not
   hypothetical: on one live run, two of three concurrent workers blocked on
   `external_directory` for the directory their own worktrees live in, and on an
   otherwise identical second run none did. The endpoint shapes are
   schema-verified only; verify them on the wire before relying on them, and add
   `respond()` to the adapter rather than reaching around it.
2. **`cost` on paid providers.** Still open, still blocked on not having one. One
   worker run on a paid key settles it.
3. **`RunBackend` parity.** `opencode run` exposes `--session`, `--format json`,
   `--agent`, `--model`, `--variant`, `--attach`, `--auto`. The flags exist; the
   fallback path was never built or exercised. ADR-0001 accepted `ServeBackend`
   with that as the known cost, and nothing in Phase 6 requires closing it.
4. **`.orchestrator/` is git-excluded by `createWorktree()`, which only runs when
   a worker prepares.** The database and now `run_report`'s output are written
   there by the server regardless. A run in which no worker ever reached
   `preparing` therefore leaves `.orchestrator/` visible in the user's
   `git status`. Pre-existing, one line to fix in `createOrchestrator()`, and not
   worth widening Phase 6 for — but somebody should, and Phase 7's hardening is
   the natural home.
