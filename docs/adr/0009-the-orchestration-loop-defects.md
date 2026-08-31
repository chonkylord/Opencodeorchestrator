# ADR-0009: five defects a real run found, and what each one cost

**Status:** accepted (Phase 9)
**Date:** 2026-08-31

---

## Context

Every phase before this one was verified the same way: build the mechanism, then
run it against `ocmock` and, at the phase boundaries, against a live provider.
That found a great deal. It did not find any of the five things below, because
none of them is a mechanism failing. They are **a correct mechanism reporting
itself incorrectly**, or a correct mechanism whose boundary was drawn one state
too narrow — the class of defect a passing test suite is exactly the wrong
instrument for.

What found them was one orchestration, driven by a Claude Code session against a
real repository, on the free-tier default. The session that ran it wrote up what
went wrong afterwards. Every heading below is one of its findings, restated as
the property that was violated, and the ordering is its own ranking of what the
run actually cost.

Two of the five are the same shape and it is worth naming: **a tool that returns
a success string for something that failed, and a tool that refuses a recovery it
could perform, will between them strand a worker permanently while both tools
report normal operation.** That is precisely what happened, and it is the reason
this ADR exists rather than five separate commits.

---

## Decision 1: `worker_wait` heartbeats, and its cap becomes measurable

**The finding.** A six-minute task cost roughly eight `worker_wait` calls, seven
of which returned "still running". The cap is 30,000 ms — half the 60-second host
ceiling Phase 3 measured — and the tool description accepts the consequence in
writing: *"a wave that needs fifteen minutes needs several of these calls."*

**The suggestion, and why it does not work as stated.** The session proposed
hooking Claude Code's background-task notification path, so eight calls become
one. There is no such path available to an MCP server. A server cannot start a
turn on its host; it answers requests. Stating that plainly matters more than
working around it, because the same suggestion will otherwise be made again.

**What the protocol does provide** is progress notifications. A tool call may
emit `notifications/progress` against the request's own progress token while it
is in flight, and the MCP specification permits a host to reset its tool-call
timeout when one arrives (and permits it to cap that too). If Claude Code does
reset, a single `worker_wait` can cover the whole six minutes. So:

- `worker_wait` emits a progress frame every 10 seconds while it blocks, when the
  client supplied a progress token. Costs one tiny frame per tick; silent when no
  token was sent, because a progress notification nothing can correlate is noise
  the host discards.
- The cap moves out of the source and into `ORCHESTRATOR_WAIT_MAX_MS`, clamped to
  1 s – 600 s.
- **The default does not move.** 30,000 ms is still half of the one ceiling
  anybody has measured, and a cap past what a host will actually wait for does
  not produce longer waits — it produces failed tool calls, and a failed wait
  leaves a worker running with nobody watching it.
- `orchestrator_timeout_probe` gains `progressEveryMs`, so the ceiling *with*
  heartbeats can be measured on a real host rather than assumed. That instrument
  was kept in Phase 0 for exactly this: "a host upgrade can move that ceiling".

The honest summary is that this decision **halves the number of calls at best and
does nothing at worst**, and which one it is, is a measurement nobody has taken
yet. The procedure to take it is in the README.

## Decision 2: a write that did not land must not return a success string

**The finding, verbatim from the audit trail:** `worker_message` answered
`Answer delivered to w-001. It is resuming its existing session` — twice — while
the trail recorded `answer_failed message=unknown worker w-001`. Two round trips
were spent on a worker that could not receive them, and the truth was visible
only to somebody who thought to call `worker_output`.

**Why it happened.** DD-1 requires every tool to return in under two seconds.
`manager.answer()` resolves only once the follow-up prompt is away, which means
waiting out the session's settle guard — seconds. So the tool starts the
operation and returns, catching the rejection so it cannot become an unhandled
one. That is the right shape. What was wrong is that the *knowable* failures were
being deferred along with the unknowable ones.

**The decision.** Split the two:

- `WorkerManager.answerability()` answers, synchronously, whether an answer can
  land: `unknown`, `orphaned`, `not_blocked`, or ok. The tool asks first and
  refuses before starting anything.
- Everything not knowable up front — a backend that rejects the prompt, a session
  the provider has dropped — is caught by racing the started promise against
  1,200 ms. Those reject in tens of milliseconds; a *successful* answer takes
  seconds, so the two are never confused, and the tool still returns an order of
  magnitude inside its budget.
- Every refusal says `NOTHING WAS DELIVERED` and names the recovery.

## Decision 3: recovery keys off session reachability, not one state name

**The finding.** A worker went `running` → `interrupted` (manager restart) →
`blocked` (`permission_required`). `worker_recover` accepted only `interrupted`,
so it refused: *"this one has settled, read worker_result."* `worker_result`
correctly reported a worker waiting for an answer. Both tools were right and the
worker was stranded between them until its blocked deadline killed it.

**The decision.** The gate was asking the wrong question. A row's *state*
describes what the worker was doing; what decides whether anything can still be
done to it is whether **this process holds its session**. So:

- `WorkerManager.isOrphaned()` — a row in `spawned`, `preparing`, `running` or
  `blocked` with no live worker in this process.
- `recoverWorker()` accepts `interrupted` **or** orphaned, moving the latter
  through `interrupt` with reason `session_unreachable` so the trail distinguishes
  it from the startup sweep. A worker genuinely live in this process is still
  refused, with the same message as before.
- `worker_result` on a blocked worker now checks reachability and names
  `worker_recover` instead of `worker_message` when nothing can answer it.

Keying off `interrupted` alone was also wrong for a reason the run did not hit:
`rebuildIndex()` (DD-7) can restore a row from a worktree manifest long after the
startup sweep has run, and a session can be lost without the process restarting.

## Decision 4: every implement worker gets scratch space inside its jail

**The finding.** A worker asked to write a verification script hit the
`external_directory` permission wall doing exactly what it was told, because it
reached for `/tmp`.

**Why both available answers were wrong.** `/tmp` is outside the worker's tree
and trips the wall — deliberately; `IMPLEMENT_PERMISSIONS` explains at length why
that wall is not widened, and widening it for scratch files would give up a
useful jail signal for the sake of a temp file. The worktree itself is the thing
being reconciled, so a scratch file dropped there appears in the diff as
unclaimed work and reads as a discrepancy — a false finding in the one channel
DD-4 depends on for true ones.

**The decision.** A third place, which is both inside the jail and outside the
measurement: `<tree>/.orchestrator/scratch/<workerID>`. `.orchestrator/` is
already git-excluded and already filtered out of every changed-file list, so
nothing written there can reach a diff, a snapshot or a reconciliation, and no
permission is needed to write it. The brief names the directory and says not to
use `/tmp`, before the ownership rules, since it is the exception to them.

Per worker rather than per tree, because in `shared` mode the tree is the user's
whole checkout with several workers in it. `implement` only: the read-only modes
have `edit` denied at the session, so offering them a writable directory would be
an invitation to a refused tool call.

## Decision 5: structured-output support is a per-model fact, and it is durable

**The finding.** `structured_output_unsupported` at +1 s into the run, recorded
as an audit event nobody read, and the likeliest reason no final report ever
existed.

**The deeper defect.** The latch was a single manager-wide boolean. One model's
refusal turned structured output off for **every** model the router might pick
next — including the ones Phase 8 confirmed can do it — and it lived only in
memory, so every new process re-bought the same failed turn. That was harmless
while every worker ran the same model. Phase 8's model routing made it wrong.

**The decision.** Capability is recorded per `provider/model` in the index
(`meta`, keyed `model_cap:<model>`), seeded into the manager at construction and
written back on discovery. `worker_spawn` prints one line when the chosen model is
known to refuse the schema, saying what follows from it — the report will come
over the report file, `reportSource` may be `report_file` or `none`, the
measurements are unaffected — so a result with no report is explained at the point
the decision is still cheap to change.

It lives in `meta` rather than a table of its own because DD-7 still holds: this
is an observation that can be re-made by running a worker, so losing it costs one
turn, not a run.

---

## Consequences

- Four of the five are strictly better error paths; none changes a happy path.
  The scratch directory is the one that changes what a worker is told, and it
  removes a failure class rather than adding a capability.
- `worker_wait`'s improvement is **conditional on a measurement nobody has taken**
  and is documented as such. If Claude Code ignores progress notifications, the
  frames are wasted bytes and the polling cost is unchanged.
- The per-model capability table is new persisted state. It is reconstructible by
  running a worker, so DD-7 is intact.
- `answerability()` and `isOrphaned()` are public on the manager because the tool
  layer needs them; they are also exactly what the dashboard needs to tell a
  blocked worker from an unreachable one, which is [ADR-0010](0010-the-dashboard.md).

## What this ADR does not fix

The session's own closing note is worth recording, because it is the finding with
the widest reach and no code in it: **worker quality tracked brief specificity
far more than model choice.** A constraint list — footprint, exports, rotation,
determinism, fixed palette — is what made a weak free model produce usable
output. Nothing here improves that, and no tool can: it is a property of what
Claude writes into `worker_spawn`. The tool descriptions push toward specificity
and always have; whether that is enough is unmeasured.

The related note — ship a worker a ready-made verification harness rather than
asking it to write one — is now at least *possible* to act on cheaply, because
Decision 4 gives the worker somewhere to put one.
