# ADR-0004: the queue is in-process, and a failed dependency cancels its dependents

**Status:** accepted (Phase 5)
**Date:** 2026-08-29
**Supersedes nothing.** Records the two Phase 5 decisions that a later phase would
otherwise have to reverse-engineer from the scheduler, plus the three smaller
ones that fall out of them.

---

## Context

Phase 5 builds `projectplan.md` §11's parallelism: a concurrency semaphore, a
queue, `dependsOn`, and a batched `worker_wait`. The mechanics are small. Two
questions in the middle of them are not, and both are the kind whose wrong answer
produces a run that hangs with nothing in the system reporting it:

1. **What happens to the queue across a restart?** `recover()` already turns
   rows a dead process left mid-flight into `interrupted`. A *queued* worker is
   not mid-flight — it has no worktree, no session and no spend — so the existing
   rule does not obviously apply to it.
2. **What happens to a worker whose dependency will never complete?** The plan
   does not say, and the failure mode of not deciding is a worker that waits
   forever for a dependency that failed ten minutes ago.

A third question was answered by the code before it was asked, and is recorded
here because it is load-bearing and invisible: **where the gate goes relative to
the wall-clock budget.**

---

## Decision 1: the queue is in-process, and a queued worker does not survive a restart

The queue lives in `src/manager/scheduler.ts`, in memory, and is gone when the
process is. A row left in `spawned` by a dead manager becomes `interrupted` like
every other unfinished row — but with the reason
`manager_restart_while_queued` rather than `manager_restart`, because the two
want different responses from Claude.

**Why not persist it.** DD-7's rule is that *the worktrees are the durable state
and SQLite is an index*: every column is either reconstructible from a worktree
manifest or cheap to lose. A queue position is neither reconstructible nor
meaningful after a restart — the workers that were ahead of it are gone too, the
cap may have changed, and a resumed queue would start prompting workers a human
did not ask it to resume. A queued worker has spent nothing: no worktree, no
session, no tokens. Respawning it is free, and the only thing lost is an id.

**Consequences accepted deliberately:**

- `worker_result` on such a worker renders the record rather than a result, and
  says the manager restarted. That is true and it is the whole story.
- A wave of six spawned against a cap of three, interrupted by a restart, comes
  back as three `interrupted` workers with worktrees to inspect and three with
  the reason that says there is nothing to inspect. Claude can tell them apart
  from the reason alone, which is why the reason is distinct.
- Nothing auto-resumes. §9's recovery is a *decision point*, and Phase 5 does not
  turn it into an automatic one.

## Decision 2: a dependency that will never complete cancels its dependents, naming it

`dependsOn` is satisfied by `completed` and `merged`. It is *failed* by every
final state — `failed`, `timed_out`, `over_budget`, `cancelled` — and by
`interrupted`. Everything else (`spawned`, `preparing`, `running`, **`blocked`**)
is still in flight and the dependent keeps waiting.

When a dependency fails, its dependents are **cancelled**, with the reason
`dependency_failed:<id>`, and the cancellation cascades: a worker cancelled this
way fails *its* dependents in the same pump, so a chain resolves in one pass
rather than one link per event.

**Why cancel rather than run anyway, or wait.** Running anyway is the worst of
the three: the whole content of `dependsOn` is that this worker's premise is
another worker's output, and starting it without that output produces work built
on something that does not exist. Waiting forever is worse than it sounds,
because nothing reports it — a queued worker is quiet by design, and the run
simply never finishes. Cancelling produces a settled worker, a reason that names
the cause, and a `worker_status` line Claude can act on.

**`blocked` is deliberately not a failure.** A blocked worker has stopped, but it
stopped to ask a question, and answering it is the ordinary route back to
`completed`. Failing its dependents the moment it asks would turn every
escalation into a cascade of cancellations that a single `worker_message` should
have avoided.

**A cancelled-while-queued worker never started**, and its result says so:
`reportSource: "not_started"`, zero everywhere, no discrepancies. The alternative
— running the reconciliation machinery over a worktree that does not exist —
manufactures a report-parse discrepancy about a report nobody was ever asked for,
and renders as a worker that ran and achieved nothing.

## Decision 3: the gate sits between `spawn()` returning and `prepareAndRun()` starting

Not in front of `spawn()`, and not inside the run loop's watchdogs. Three things
follow, and all three are properties somebody could break without noticing:

- **`spawn()` still returns in under a second (DD-1).** A queued worker is
  *accepted*, not rejected, and sits in `spawned` — the state already documented
  as "accepted, nothing allocated yet". A `worker_spawn` that blocked until a
  slot was free would convert this system's whole async contract into a
  synchronous one, and the symptom would be a host giving up at sixty seconds.
- **Queue time is not work time.** `runningSince` — the origin of the wall-clock
  budget — is set in `prepareAndRun()` after the subscription is live, which is
  strictly after admission. A worker that waits ten minutes for a slot still gets
  its full fifteen minutes of work. The way this gets broken is starting the
  clock when the worker is accepted, which passes every test about semaphores and
  kills the second worker of every wave.
  There is a second, deliberate half: `render.ts`'s `elapsedMs` uses
  `startedAt ?? createdAt`, so a queued worker's *status line* does show queue
  time. That is wanted — a human wants to know a worker has been waiting eight
  minutes — and it means elapsed-on-the-status-line and elapsed-against-the-budget
  are two different numbers on purpose.
- **The slot is released after `settle()`, not when the stream closes.** A
  dependent may only start once its dependency is `completed`, and `completed` is
  a fact only after the snapshot, the independent test re-run and the
  reconciliation. One release point keeps the slot and the dependency edge from
  disagreeing about when a worker finished. The cost is that a worker's
  verification time counts against concurrency, which is honest: that work is
  real and it is running.

## Three smaller decisions

- **No new state.** A queued worker is `spawned`, with a `reason` of `queued` or
  `waiting_on_dependencies`. Adding a `queued` state would mean touching the
  state machine, the store, every render path and the recovery logic to express
  something an existing state already expresses. The *position* in the queue and
  the *outstanding dependencies* are in-process only (`manager.queueHint()`),
  because a queue position written to the index is a number that lies after a
  restart.
- **FIFO by spawn time, scanned for the first runnable entry — not blocked at the
  head.** That single word is what guarantees a dependency is never queued behind
  its own dependent, and it is why a worker waiting on a dependency holds no
  slot. Anything cleverer (critical path, priorities, work stealing) is Phase 8;
  the merge ordering that actually matters is already computed by
  `suggestMergeOrder()`.
- **A `dependsOn` that names a worker which does not exist is rejected at spawn**,
  before any row is written, because ids are minted by `spawn()` and an id nobody
  has been handed is a typo. This makes the dependency graph acyclic by
  construction — every edge points backwards in spawn order — so the cycle
  detector cannot fire through the ordinary path. It is kept anyway, and tested
  directly against a graph built by hand, because acyclicity is a property of the
  existence rule rather than of the queue, and the day that rule is relaxed the
  deadlock it prevents is silent.

---

## Consequences

- `dispose()` must be able to refuse a queued worker, because a queued worker's
  `done` is parked on the admission promise and `dispose()` awaits every `done`.
  This is tested (`test/manager/scheduler.test.ts`), and it is the failure that
  would otherwise hang the whole suite at once.
- `cancel()` now distinguishes four places a worker can be — queued, blocked,
  running with a session, and admitted-but-still-preparing — and only one of them
  has anything to abort. The last of those closes a window that predates the
  queue: a cancel before the session existed used to be recorded and then
  ignored, and the worker ran to completion anyway.
- The default cap is **3**, not the 4 Phase 1 measured. That measurement is one
  run, four sessions, one free-tier model (`docs/phase0-facts.md` "Unresolved" 2),
  and it says so itself. `DISPATCHED_CODE_MAX_CONCURRENT` moves it for anyone who
  has measured their own provider.
- Retries with backoff are **not** here. If a provider rate-limits under
  concurrency, the honest response is a row in the fact sheet and a lower
  default; a retry policy is Phase 7's (§11).
