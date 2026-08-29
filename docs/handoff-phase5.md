# Handoff: implement Phase 5 — parallelism — then Phase 6 — the review loop

You are picking up the **Claude → OpenCode Subagent Orchestrator** at
`chonkylord/Opencodeorchestrator`. Phases 0 through 4 are complete and pushed to
`main`.

**You are doing two phases, in this order, and the order is not negotiable:**

1. **Phase 5 — parallelism.** The semaphore, the queue, `dependsOn`, batched
   waits. Build it, test it, push it.
2. **Then stop and check what you have.** §9 of this document tells you exactly
   what "check" means. It is not a formality: Phase 5 is the first phase that
   makes several workers touch one backend at once, and the failures it
   introduces are the kind that pass a unit test and hang in production.
3. **Then write `docs/handoff-phase6.md` yourself**, in the shape of this
   document, from what you have just learned. §10 says why you are writing a
   handoff to yourself and what has to be in it.
4. **Then implement Phase 6 — the review loop**, following the handoff you just
   wrote.

Work on `main` and push there when done — push after Phase 5, and again after
Phase 6, rather than saving one enormous commit for the end. (If your session
designates a feature branch instead, that wins; say which you used.)

Phase 4 made the work *takeable*: a worktree full of good work becomes a commit
on an integration branch, or is rejected cleanly with the tree exactly as it was.
What the system still cannot do is run more than one worker at a time on
purpose, or tell a worker it got something wrong. Those are the two phases in
front of you, and together they are **the project's definition of done for v1**
(`projectplan.md` §11, Phase 5's AC).

---

## 1. Read these first, in this order

Do not start coding until you have read all six.

| File | Why |
|---|---|
| `projectplan.md` §11 Phases 5 and 6, §8, §13 | Your specification and your acceptance criteria. **§11's Phase 5 AC contains a scoping error you must correct** — see §3, trap 1. §13's "infinite fix loops" row is Phase 6's whole risk model. |
| `src/manager/worker.ts` — `spawn()`, `drive()`, `prepareAndRun()`, `checkWatchdogs()` | The run loop you are about to make concurrent and, in Phase 6, re-entrant. `spawn()` starts `drive()` immediately; that is the line the semaphore goes in front of. `checkWatchdogs()` computes the wall-clock deadline from `runningSince`, not from `createdAt` — see §3, trap 2. |
| `src/manager/state.ts` §"Transitions" | Phase 5 adds **no states and no edges** — a queued worker sits in `spawned`, which already exists and already renders correctly. Phase 6 adds exactly one edge and you should know which before you start: `completed` is *settled but not final*, and its only outgoing trigger today is `merge`. |
| `src/mcp/tools.ts` — `worker_spawn`'s `dependsOn` block, `worker_wait` | `dependsOn` is currently **rejected by name** with a message that says "Phase 5". You are Phase 5. Deleting that block is part of the job; leaving it while implementing the queue elsewhere is the worst of both. `worker_wait` takes one id and is capped at 30,000 ms against a measured 60 s host ceiling — the cap does not move. |
| `docs/adr/0003-integration-worktree.md` §"Decision 3" | The merge is already async, already polls, and already merges **branch tips rather than recorded shas**. That last detail is why Phase 6's revisions merge correctly without touching the merge pipeline at all. Do not rediscover it the hard way. |
| `docs/phase0-facts.md` §7 and "Unresolved" 2 and 4 | The 60 s host ceiling every async decision is calibrated against, and the concurrency measurement that is the *only* evidence behind Phase 5's default. Read what it does and does not say. |

Verified against **OpenCode 1.18.25** and **Claude Code 2.1.251**. If
`opencode --version` differs materially, run `bun run spike` first — it is the
drift canary, and it is green today.

---

## 2. Your task, Phase 5

From `projectplan.md` §11:

> **Phase 5 — Parallelism (2–3 days)**
> - Concurrency semaphore (default max 3–4), queue, `dependsOn`, batched
>   `worker_wait`.

Concretely, deliver:

1. **A concurrency semaphore in the manager.** A cap on how many workers may be
   in `preparing`/`running`/`blocked` at once, configurable, defaulting to **3**
   (see §3, trap 3 for why 3 and not 4). `spawn()` must still return in under a
   second with an id — a queued worker is *accepted*, not rejected — so the gate
   goes between `spawn()` returning and `prepareAndRun()` starting.
2. **A queue with a defined order.** FIFO by spawn time, and say so; anything
   cleverer needs a reason. The queue is in-process, and what happens to it
   across a restart is a decision you must make explicitly and record —
   `recover()` already turns mid-flight rows into `interrupted`, and a *queued*
   worker is not mid-flight.
3. **`dependsOn`, actually working.** A worker whose dependencies have not
   completed does not start. Three things this needs that the plan does not
   mention and you must not skip: **cycle detection at spawn** (reject, do not
   deadlock), **a rule for what happens to dependents when a dependency does not
   complete**, and **a guarantee that a dependency can never be queued behind
   its own dependent** — see §3, trap 4.
4. **Batched `worker_wait`.** §7's row says batched waits are Phase 5. Decide
   between "wait for any" and "wait for all" — you probably need both — and keep
   the 30,000 ms cap, which is half a *measured* ceiling and not a guess.
5. **`worker_status` and `worker_list` telling the truth about the queue.** A
   worker that is `spawned` because three others are running looks identical
   today to a worker that is `spawned` because it is about to start. Claude
   needs to tell those apart, and "next: worker_wait" is the wrong advice for
   one of them.
6. **A run report** (§8: "every run emits a markdown audit trail — timeline,
   workers, models, costs, test results, merge outcomes, discrepancies"). The
   Phase 5 AC names it. Build the minimum the demo needs and no more; §11 lists
   run *reports* under Phase 7's hardening, so the metrics log, the retention
   policy and the per-run cost accounting are not yours.
7. **Tests**: `test/manager/` for the semaphore, the queue and `dependsOn`
   (including the cycle rejection and the failed-dependency rule), and
   `test/mcp/` for the batched wait and the queue-aware status, over real
   JSON-RPC like every other tool. `test/ocmock/` is a scriptable fake server
   and you extend it rather than reaching for real OpenCode.
8. **An ADR** if — and only if — you make a decision the next phase would
   otherwise have to reverse-engineer. The restart semantics of the queue and
   the failed-dependency rule are both candidates. `docs/adr/0004-*.md`.

---

## 3. Facts you must not re-derive — and the ones that will silently break you

**The four that will cost you hours:**

> **1. Phase 5's stated AC cannot be met by Phase 5, and pretending otherwise
> will waste your time.** §11 reads: *"AC — v1 demo: 'Add a settings page' — 3
> concurrent workers (UI / API / tests, mixed models), review, **revisions**,
> gated merges, final validation, run report."* Revisions are `worker_revise`,
> which is **Phase 6**. The AC as written spans both phases. Correct it in place
> — §11 has a house style for this, and four §7 rows and three §6 lines were
> already corrected the same way — by splitting it: Phase 5's own AC is *three
> workers run concurrently under the cap, a dependent worker waits for its
> dependency, and the wave reaches a gated merge and a run report*; the full v1
> demo including revisions is Phase 6's, and you run it at the end of Phase 6.
> Do not skip the v1 demo. Do not run it twice.

> **2. Queue time is not work time, and one line already guarantees that.**
> `checkWatchdogs()` computes the hard deadline as
> `now - runningSince - blockedTotalMs`, and `runningSince` is set in
> `prepareAndRun()` *after* the subscription is live — not at spawn. So a worker
> that sits in the queue for ten minutes still gets its full fifteen-minute wall
> clock. **Your semaphore must not break this**, and the way it gets broken is
> starting the clock when the worker is accepted rather than when it is
> prompted. There is a second, subtler half: `render.ts`'s `elapsedMs` uses
> `startedAt ?? createdAt`, so a *queued* worker's status line will show queue
> time as elapsed. That is correct and desirable — a human wants to know a
> worker has been waiting eight minutes — but it means elapsed-on-the-status-line
> and elapsed-against-the-budget are deliberately different numbers, and a test
> that assumes they agree will fail for the wrong reason.

> **3. The concurrency evidence is one run, four sessions, one free-tier model.**
> `docs/phase0-facts.md` "Unresolved" 2 records it honestly: four sessions in
> four worktrees on one server completed, no stream carried another session's
> events, and wall clock went from ~11 s to 15–20 s — sublinear, no failures.
> It says nothing about eight, about paid providers under rate limits, or about
> long-running workers, and it says so itself. **You will be running on
> `opencode/muse-spark-1.2-contributor-free` (see §7), whose rate-limit behaviour
> under sustained concurrency has never been measured.** Default the semaphore
> to **3**, not 4: the measured number is the ceiling that worked once, not the
> number to ship. Make it configurable (`ORCHESTRATOR_MAX_CONCURRENT`), and if a
> provider starts refusing prompts under load, that is a *finding* to record in
> the fact sheet — retries with backoff are Phase 7's and you must not build
> them.

> **4. `dependsOn` plus a semaphore is a deadlock generator, and the deadlock is
> silent.** Three ways it happens, all of which you must close: a **cycle**
> (`a` depends on `b` depends on `a`) — detect at spawn and reject with the cycle
> named, exactly as `dependsOn` is rejected today, because a rejected spawn is
> legible and a wedged run is not; a **dependency that is itself queued behind
> its dependent**, which a naive FIFO scheduler that counts a waiting-for-deps
> worker against the semaphore will produce every time (a worker waiting on a
> dependency must not hold a slot); and a **dependency on a worker that will
> never complete** — one that failed, timed out, or does not exist. That last is
> a policy decision, not a bug: pick one (cancel the dependents with a reason
> that names the dependency is the defensible default), implement it, test it,
> and write it down. A run that hangs forever because a dependency failed is the
> worst outcome available, because nothing in the system reports it.

The rest:

- **A queued worker needs no new state.** `spawned` is documented as "accepted,
  nothing allocated yet", which is exactly what a queued worker is. The machine
  already has `spawned → prepare → preparing`, and `render.ts`'s `nextStep()`
  already handles `spawned`. Adding a `queued` state means touching the state
  machine, the store, every render path and the recovery logic to express
  something the existing state already expresses. Add a *reason* if you need to
  distinguish "queued behind the semaphore" from "queued behind a dependency" —
  the record has a `reason` field and status lines already render it.
- **`spawn()` must keep returning in under a second (DD-1).** It currently
  creates the run row, the worker row, the `ManagedWorker`, and kicks off
  `drive()` without awaiting it. The semaphore goes inside that detached path,
  not in front of `spawn()`. If `worker_spawn` starts blocking until a slot is
  free, you have converted the orchestrator's whole async contract into a
  synchronous one, and the symptom is a host that times out at 60 s.
- **`w.done` is the promise everything else awaits.** `dispose()` awaits every
  worker's `done`; `cancel()` awaits it too. A worker sitting in the queue must
  have a `done` that resolves when it is *cancelled while queued*, or
  `dispose()` will hang forever on shutdown and every test will time out at
  once. Cancelling a queued worker is `spawned → cancel → cancelled`, an edge
  that already exists.
- **The backend is shared and pre-warmed.** One `ServeBackend` per server
  process, started before any tool is served, because the first prompt against a
  cold server pays for ~45 start-up events. Concurrency does not change that:
  do not start a server per worker.
- **`events()` hands back a shared, explicitly-closed subscription, scoped per
  directory.** Phase 1 verified that four concurrent sessions in four worktrees
  do not see each other's events. That isolation is *why* the per-worker
  subscription model survives concurrency, and it is a property of the
  directory scoping, not luck — so do not "optimize" toward one shared stream.
- **The run loop was starving its own watchdogs once already**, because text
  deltas arrive faster than the tick. Fixed in Phase 3 with a deterministic
  regression test (`docs/phase3-notes.md` §5). Three concurrent chatty workers
  is the same pressure multiplied; if you touch `pump()`, re-read that note
  first, and keep the regression test green.
- **Budgets are per worker and on tokens.** §8's "global run cap" is Phase 7's
  budget enforcement, not yours. `cost` is `0` on every provider exercised so
  far and will stay `0` on the free tier, so a dollar-denominated anything is
  dead code.
- **The DD-2 boundary test polices `src/` and that includes everything you
  write.** Do not name an OpenCode endpoint, a raw event type, or the phrase for
  starting the server process — in code *or in comments*.
  `test/opencode/boundary.test.ts` fails the build the moment you do.
- **stdout is the JSON-RPC channel.** Every diagnostic goes to stderr. One stray
  `console.log` corrupts the protocol and the symptom is a host that says
  nothing is wrong.
- **Worker output is untrusted (DD-8).** A run report renders worker summaries.
  Cap them, mark them as the worker's own words, and keep the orchestrator's
  measurements — the changed-file list, the diff stat, the discrepancies, the
  merge outcomes — visibly separate from the claims. `src/mcp/render.ts` is the
  precedent and it is the only house style that exists.

---

## 4. Definition of done, Phase 5

- [ ] `npx tsc --noEmit` clean.
- [ ] `bun test` green, **including the existing 220** — you must not regress
      them. (220 pass, 4 skip today.)
- [ ] `bun run spike` still green.
- [ ] Every tool returns in under two seconds, asserted in a test,
      `worker_wait` excepted and still capped at 30,000 ms.
- [ ] **Never more than `maxConcurrent` workers past `spawned` at once**,
      asserted by observation rather than by inspecting the semaphore's own
      counter — spawn six against a cap of three and assert on how many reach
      `preparing`.
- [ ] **A queued worker starts when a slot frees**, and its wall-clock budget is
      not consumed by the wait. Assert the second part explicitly; it is the one
      that silently regresses.
- [ ] **`dependsOn` works**: a dependent does not start until its dependency
      completes, a cycle is rejected at spawn with the cycle named, a dependency
      never queues behind its dependent, and a failed dependency produces the
      documented outcome rather than a hang.
- [ ] **Cancelling and disposing work with a full queue** — no hang, no orphaned
      worktree, and `dispose()` returns.
- [ ] Batched `worker_wait` works over real JSON-RPC and respects its cap.
- [ ] **Three concurrent workers on the golden repo reach a gated merge and a
      run report**, over real JSON-RPC. This is Phase 5's half of the v1 demo.
- [ ] `projectplan.md` §11 Phase 5 marked complete in the same style as Phases 0
      through 4, linking to what you produced — **with its AC corrected per §3,
      trap 1** rather than quietly reinterpreted.
- [ ] Anything you discovered that contradicts `docs/phase0-facts.md`,
      `projectplan.md` or the ADRs is **corrected there, in place, not
      appended**. If you measure the free tier's behaviour under concurrency,
      that is a new fact and it belongs in the fact sheet with the date, the
      version and the method — the way §7's host-timeout row is written.
- [ ] Committed and pushed.

---

## 5. Scope boundaries, Phase 5

**Do not build**, however tempting:

- **`worker_revise` or anything that re-prompts a settled worker.** That is
  Phase 6 and it is the next thing you will do. Building half of it now, without
  the revision caps, is precisely how infinite fix loops get shipped (§13).
- **Retries with backoff, global run budgets, metrics, orphan TTL pruning**
  (Phase 7). If the free tier rate-limits you under concurrency, *record the
  fact* and lower the default; do not build a retry policy.
- **Model-routing presets with automatic selection, worker priorities,
  shared-workspace mode** (Phase 8). `models` per mode already exists as a
  config option; leave it as a config option.
- **A smarter scheduler.** FIFO with a dependency check is the whole of it.
  Critical-path scheduling, priority queues and work stealing are three
  different ways to make a two-day phase into a two-week one, and the merge
  ordering that actually matters is already computed by
  `suggestMergeOrder()` in `src/workspace/overlap.ts`.

If Phase 5 turns out to be blocked on something, finish every unblocked part,
push it, and say plainly what is left and why. Do not quietly narrow the scope.

---

## 6. Environment notes

```bash
npm install                     # project deps — a fresh clone has no node_modules
npm install -g opencode-ai      # installs cleanly; verified 1.18.25
bun test                        # 224 tests (220 pass, 4 skip), no OpenCode needed
bun run spike                   # confirm the baseline is green before you start
OC_E2E=1 bun test test/e2e      # the real-OpenCode tests, if you want the baseline
```

- Wire the server into a host with
  `claude mcp add orchestrator -- bun run "$PWD/src/mcp/server.ts"`, or configure
  it with `ORCHESTRATOR_REPO` / `_DB` / `_MODEL` / `_BASE_URL` / `_VERIFY_TESTS`
  (README → Configuration). Your new concurrency cap belongs in the same family
  and the same README table.
- **You can drive a live Claude Code session from inside this container**, which
  is how Phase 3 took its measurements:
  `claude -p --strict-mcp-config --mcp-config mcp.json --allowedTools "mcp__orchestrator__…" --output-format stream-json --verbose "…"`.
  The `tool_result` blocks in that stream are the evidence; the model's prose
  about what happened is not. **The v1 demo should be run this way** — a demo
  Claude drives is the thing §11 is actually asking for.
- `test/ocmock/` is a scriptable fake server. Phase 3 added `abortDelayMs` so
  "the tool returned before the operation finished" could be asserted rather
  than raced; Phase 4 added `perWorktreeFileName` and `perWorktreeFileContent`
  so two workers could produce genuinely disjoint sets or a genuine conflict on
  demand. **Extend it the same way** — a semaphore test wants a worker that
  takes a controllable amount of time, and racing real latency is how a suite
  becomes flaky.
- `test/fixtures/golden.ts` materializes the golden repo into a temp git
  repository, and `breakGoldenRepo()` makes its suite fail on a real assertion.
  Never point a test at this repository itself.
- **Do not run `pkill -f 'opencode serve'`.** `pkill -f` matches full command
  lines including your own shell's; Phase 3 did it anyway and killed its own
  session. Match on a PID you captured.
- `NO_PROXY` must include `127.0.0.1,localhost`. The adapter handles this itself.

---

## 7. The model you are actually running on

**This project runs on `opencode/muse-spark-1.2-contributor-free` — the free
Muse Spark on OpenCode Zen — and that is the intended production configuration,
not a testing shortcut.** It is `DEFAULT_MODEL_ENV` in `src/mcp/config.ts` and
`DEFAULT_MODEL` in `src/manager/worker.ts`. Four consequences, all of which are
already true and none of which you should be surprised by:

- **It rejects schema-constrained output.** The manager attempts
  `format: json_schema`, drops it on the first rejection and stops asking on
  that backend; the report contract lives in the brief's words either way
  (ADR-0002). Do not reintroduce a dependency on structured output — in Phase 6
  a reviewer's critique is going to want a shape, and the shape has to come from
  the brief, not from the provider.
- **`cost` is always `0`.** Budgets are on `totalTokens` and `cost` is advisory.
  This is `docs/phase0-facts.md` "Unresolved" 4 and it stays open: it needs a
  paid key nobody here has. Do not build dollar budgets. Do not "fix" the zero.
- **It is the only model in play.** DD-9 routes research/implement/review to
  different models and §11 Phase 8 wants cross-model review diversity; in
  practice every worker, including Phase 6's reviewer, will be Muse Spark
  reviewing Muse Spark. Keep `models` per-mode as configuration so a second
  model is a config change, and do not build selection logic around models that
  are not there. **Say this out loud in Phase 6's design:** a reviewer that
  shares the author's blind spots is a weaker check than the diff-versus-report
  reconciliation the orchestrator already does itself, and the tool descriptions
  should not oversell it.
- **Its throughput under sustained concurrency is unmeasured.** See §3, trap 3.
  Three concurrent free-tier sessions is your default and your first real
  measurement. If you get rate-limited, the honest response is a fact-sheet row
  and a lower default.

---

## 8. A note on model routing

If you are orchestrating this across models: the **deadlock analysis in
`dependsOn`** and the **budget-clock interaction with the queue** are the least
delegable parts — they are the ones where being wrong produces a run that hangs
or a worker killed for time it spent waiting, and both fail silently. The
**batched `worker_wait` and the queue-aware status rendering** are
well-specified and independently testable; `src/mcp/render.ts` is a working
precedent for every cap and every "next:" hint. The **run report** is a
rendering problem over data that already exists in the store, and is a good
candidate to build last, because it is the one deliverable whose shape is
clearest once everything else works.

---

## 9. When Phase 5 is done: check what you have

Push Phase 5 first. Then, before you write a line of Phase 6, do this — properly,
not as a formality. Phase 5 is the first phase where several workers share one
backend on purpose, and the bugs it introduces are the kind that pass a unit
test and hang a real run.

1. **Run the whole suite three times.** A concurrency bug that shows up one run
   in five is still a concurrency bug, and it will show up in front of a user
   instead. If anything is flaky, fix the flake or explain it in writing; do not
   re-run until it is green.
2. **Run the v1-demo-so-far from a live Claude Code session**, per §6 — three
   concurrent workers on the golden repo, through to a gated merge and a run
   report. Read the `tool_result` blocks, not the model's prose about them.
3. **Check the four properties that are easy to break and hard to notice:** no
   worker exceeded the cap; no worker's wall-clock budget was consumed by queue
   time; `dispose()` returned with a full queue; and no worker's event stream
   carried another worker's events. The last one is the property all of
   concurrency rests on and the only one Phase 1 measured rather than assumed.
4. **Re-read your own diff adversarially.** What happens if a dependency is
   cancelled while a dependent is queued? If two workers finish in the same
   tick? If the manager is disposed while a worker is between the semaphore and
   `prepareAndRun()`? Write the test for whichever of those you cannot answer
   from the code.
5. **Confirm the documentation is true.** §11 Phase 5 marked complete in the
   house style, the AC corrected rather than reinterpreted, the README's tool
   table and configuration section current, and every fact you measured written
   into `docs/phase0-facts.md` in place.

---

## 10. Then write `docs/handoff-phase6.md`, and implement it

**Write the Phase 6 handoff before you write Phase 6.** Not because a document
is owed to anyone — you are the one who will read it — but because the exercise
is the design review. Every handoff in `docs/` exists because writing down
"here is the trap that will cost you hours" *before* implementing is what turned
each of the previous four phases from a guess into a plan. Phase 6 is the phase
with the most ways to be subtly wrong, and you will have just spent two days
learning things about the run loop that nobody has written down yet.

Follow the shape of this document: what to read first; the task, concretely; the
facts that will silently break you, with the two or three worst called out; a
definition of done as a checklist; explicit scope boundaries; environment notes.
Be specific about file names and function names. Cite the plan sections you are
implementing. Where you found something that contradicts a document, say so.

Here is what you already know that belongs in it — this is a starting point, not
the whole list, and the things you learn in Phase 5 matter more than the things
below:

**Phase 6's task** (`projectplan.md` §11): *`worker_revise` with session reuse,
revision caps, optional read-only reviewer worker critiquing another worker's
diff.* **AC:** *seeded failing worker receives feedback, fixes, passes; loop
terminates at cap with an actionable report to Claude.* §7's table has a
`worker_revise` row (`id`, `feedback` → revision number) still marked Phase 6.

**Facts about this codebase that Phase 6 turns on:**

- **`completed` is settled but not final**, and its only outgoing trigger today
  is `merge`. A revision needs a new edge — most plausibly
  `completed --revise--> running`. Whether `failed`, `timed_out` and
  `over_budget` also get one is a real decision with real consequences: a
  timed-out worker's session may still be alive and revising it is cheap; a
  worker that failed on a content filter will fail again. `merged` should
  almost certainly *not* be revisable — respawn instead — but say why in the
  ADR rather than leaving it as an omission.
- **The run loop is one-shot and Phase 6 must make it re-entrant.** `drive()`
  closes the event subscription in a `finally` ("the subscription outlives every
  loop over it, so this is the one place it is closed") and then settles. A
  revision therefore needs a *new* subscription, a *new* prompt and a *new*
  `pump()`, plus a fresh `w.done` — and every waiter that already resolved on
  `completed` has to be re-armed, or a caller that revises a worker and then
  waits will get an instant stale answer.
- **The session survives, and can be rebuilt after a restart.**
  `events()` and `prompt()` take a `SessionRef`, which is exactly
  `{sessionID, directory}` — and both are already on `WorkerRecord` as
  `sessionID` and `worktree`. So revising a worker whose manager has restarted
  is possible without reopening a session, and that is worth verifying on the
  wire before you rely on it.
- **Session reuse is what makes revision cheap**, and it is already proven:
  `manager.answer()` re-prompts the same session on the blocked path, and Phase
  2's e2e test showed the worker keeps everything it had read and worked out.
  The `resumes` counter counts those unblock-resumes. A *revision* is a
  different thing being counted for a different reason (§13's cap), so decide
  deliberately whether it shares that counter or gets its own — and note that
  `render.ts` currently prints `resumes` as "revisions" in status lines, which
  will become a lie the moment the two diverge.
- **Phase 4 already accommodates revisions and you get this for free.**
  `runMerge()` resolves each candidate's **branch tip**, not the snapshot sha
  recorded in the worker's result, so a worker that is revised after settling
  produces another commit on the same branch and the merge picks it up. The
  reconciliation is likewise computed against `baseSha`, which does not move.
  Verify it with a test rather than trusting this paragraph, but do not redesign
  the merge pipeline for revisions — it was built for them.
- **The revision loop is the answer to a red merge gate**, which is where
  ADR-0003 deliberately left a hole: §6.3 step 2's option (a) — "send the worker
  a 'rebase onto new base, resolve, re-test' message" — was explicitly deferred
  to Phase 6 with its revision caps. Closing that loop is the most valuable
  thing Phase 6 does, and `workspace_merge_status` already reports precisely
  which worker broke the gate and how.
- **A `review` worker needs a diff, and `worker_diff` now produces one.**
  `readCommitDiff()` diffs a branch against its base without needing a worktree
  at all. §6.1 says review workers get "no worktree, or a read-only mount of the
  target worktree", and today `createWorktree()` runs unconditionally for every
  mode — a decision point you must resolve rather than inherit.
- **A reviewer's critique is worker output and is untrusted (DD-8).** It is a
  claim about a claim. The tool descriptions must not let it read as a finding,
  and — per §7 above — a Muse Spark reviewing Muse Spark shares the author's
  blind spots. The orchestrator's own diff-versus-report reconciliation is the
  stronger check and should stay the headline.
- **§13's risk row is the whole design constraint:** *"Infinite fix loops →
  revision caps with terminal actionable reports."* A cap that stops the loop
  and produces nothing Claude can act on has converted a runaway into a dead
  end. "Actionable" is the load-bearing word in the AC.

**Phase 6's definition of done** should end where §11 says v1 does: the full
demo — *"Add a settings page", three concurrent workers, mixed modes, review,
revisions, gated merges, final validation, run report* — driven by Claude from a
live session, with the `tool_result` blocks as the evidence. That is the
project's definition of done for v1, and Phase 6 is the phase that reaches it.

Then implement it, test it, correct whatever documents it proves wrong, mark
§11 Phase 6 complete in the house style, and push.

---

## 11. Still open across the earlier phases

Three items are carried, and **one of them is Phase 6's to close if you touch
the adapter anyway:**

1. **Replying to a permission or question request in band.**
   `docs/phase0-facts.md` "Unresolved" 5. The adapter surfaces
   `permission`/`question` asks as normalized events but exposes no way to
   answer them, so the manager converts a mid-run ask into an escalation by
   aborting the turn and delivering the answer as the next prompt to the same
   session. It works and it costs a partial turn — **and Phase 6 pays that cost
   on every revision round**, which is the phase where it finally becomes worth
   fixing. The endpoint shapes are schema-verified only; verify them on the wire
   before relying on them, and add `respond()` to the adapter rather than
   reaching around it.
2. **`cost` on paid providers.** Still open, still blocked on not having one.
   Budgets are on tokens; `WorkerResult.usage.cost` is advisory and is `0` on
   every provider exercised so far, the free Muse Spark included. If a paid key
   ever appears, one worker run settles it.
3. **`RunBackend` parity.** `opencode run` exposes `--session`, `--format json`,
   `--agent`, `--model`, `--variant`, `--attach`, `--auto`. The flags exist; the
   fallback path was never built or exercised. ADR-0001 accepted `ServeBackend`
   with that as the known cost, and nothing in Phase 5 or 6 requires closing it.
