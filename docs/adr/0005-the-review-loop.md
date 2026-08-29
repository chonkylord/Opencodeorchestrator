# ADR-0005: a revision re-enters the queue, and four failure states may be revised

**Status:** accepted (Phase 6)
**Date:** 2026-08-29
**Supersedes nothing.** Records the Phase 6 decisions a later phase would otherwise
have to reverse-engineer from the run loop, plus the smaller ones that fall out of
them.

---

## Context

Phase 6 builds `projectplan.md` §11's review loop: `worker_revise` with session
reuse, a revision cap, and a read-only reviewer pointed at another worker's diff.
The feature is small. What it does to the rest of the system is not: it makes the
run loop **re-entrant**, and every previous phase wrote that loop for exactly one
turn.

Three questions sit in the middle of it. All three have a wrong answer that
produces a green test suite and a wrong production run, which is the specific
reason they are recorded here rather than left in the code.

1. **Does a revision re-acquire a concurrency slot?**
2. **Which settled states may be revised at all?**
3. **What is a reviewer actually pointed at** — §6.1 offered "no worktree, or a
   read-only mount of the target worktree" and never chose.

---

## Decision 1: a revision goes back through the queue, so its `revise` edges land in `spawned`

`worker_revise` calls `Scheduler.enqueue()` again and the run loop waits for an
admission exactly as a spawn does: acquire, run, settle, release.

**Why this is not optional.** ADR-0004 put the admission gate at the top of
`drive()` and releases the slot in its `finally`, *after* `settle()`. So a settled
worker holds no slot. A revision that re-entered the run loop without re-acquiring
one would open a subscription and prompt a session that nothing was counting:
revise three completed workers while three others are running and there are six
concurrent sessions under a cap of three — with no error, no log line and nothing
in the run report. The symptom would surface much later, as a provider refusing
prompts under a cap that existed to prevent exactly that.

**The consequence is the shape of the state machine.** The gate sits between
`spawned` and `preparing`, so a revision has to re-enter the lifecycle at
`spawned` to pass through it. Every `revise` edge therefore lands in `spawned`
rather than in `running`, and the round then reuses the existing `prepare` and
`start` edges. §11's Phase 6 line says "at minimum `completed --revise--> running`";
that is the right edge and the wrong destination, and the queue is why.

A queued revision needed **no new state**, for the same reasons ADR-0004 gave: it
is `spawned` with a `reason` of `queued`, and its position stays in process. A
revising worker's row is therefore indistinguishable from a queued spawn's, which
is correct — both are workers that have been accepted and are waiting for a slot.

**Consequences accepted deliberately:**

- **The cap counts rounds taken, not rounds asked for.** `revisions` is
  incremented when the round is genuinely prompted. A revision that sits in the
  queue and is cancelled there cost nothing and does not count.
- **A revision that is refused at the queue does not rebuild the worker's
  result.** No prompt went out and the worktree is exactly as the previous round
  left it, so re-running the reconciliation would overwrite a real result
  describing real work with one describing a round that never happened. The
  worker settles as `cancelled` with the previous round's result intact.
- **A revision re-enqueues with no `dependsOn`.** Its dependencies were satisfied
  before its first round and their output is already in its session; re-declaring
  them would make a revision wait on a dependency that has since been revised
  itself, for output the worker already has.
- **A refusal at the queue must be cleared when the worker is enqueued again.**
  The scheduler remembers refusals so a dependency cascade resolves in one pump.
  That was sound while a refusal was permanent — only a spawn could be refused,
  and a refused spawn stays `cancelled`. It is not sound now, because `cancelled`
  is revisable: a worker can be refused at the queue, revised again and complete,
  and a stale refusal would have the scheduler answering "failed" about a
  `completed` worker. This was found by re-reading the diff, not by a failing
  test, and it has one now.

## Decision 2: `dependsOn` follows a revising dependency back to `waiting`

`Scheduler.outcomeOf()` reads live state, so a `completed` dependency that starts
revising flips from `satisfied` back to `waiting`. That behaviour is inherited
rather than written, and Phase 6 **keeps it deliberately**.

**Why.** The whole content of `dependsOn` is that this worker's premise is another
worker's output. A dependency that is being revised is one whose output is about
to change, and starting the dependent against the pre-revision version is
precisely what the edge exists to prevent.

**The asymmetry is accepted and is not a bug.** A dependent still in the queue
waits for the revision; one already admitted keeps running, because there is no
way to un-admit a worker that has a session open and work in flight. Claude can
see both — the queued one says `waiting_on_dependencies` and names the
dependency — and the alternative (cancelling an admitted dependent because its
dependency is being revised) would throw away real work to enforce an ordering
nobody asked for.

## Decision 3: four failure states are revisable; `merged` is not

`revise` is legal from `completed`, `failed`, `timed_out`, `over_budget` and
`cancelled`. It is not legal from `merged`, `blocked`, `interrupted` or any active
state.

| From | Revisable | Why |
|---|---|---|
| `completed` | yes | The case the phase exists for. |
| `timed_out` | yes | The session usually outlived the deadline, and a revision carries a *narrower instruction*, which is the thing most likely to stop a wedge repeating. The fresh wall clock bounds the retry; the cap bounds the sequence. |
| `failed` | yes | `failed` covers `stream_error` and `server_gone`, which are not the worker's fault at all. A content filter will reproduce and a provider error may not, and the tool's description says so rather than the state machine guessing. |
| `over_budget` | yes | Only just. The fresh wall clock is what makes it survivable — but the tokens do **not** reset, so in practice such a worker is refused by the token guard below rather than by the transition table. Both checks exist because they answer different questions. |
| `cancelled` | yes | A worker stopped for going the wrong way is exactly the worker worth redirecting while it still has its context. Requires clearing `cancelRequested`, which is sticky and which Phase 5 made load-bearing. |
| `merged` | **no** | Its commits are already on an integration branch. A revision would produce a commit that branch does not have, and the run report would name a merged worker whose branch tip is not what was merged. Respawn instead. |
| `blocked` | no | It is waiting for an *answer*, not for feedback. `worker_message` is that channel and it is the same session; two ways in would race each other over one `w.answer` callback. |
| `interrupted` | no | Its session belonged to a process that is gone. There is nothing to reuse, and §9 left "should recovery be able to resume a *revision*" open on purpose. |

**What this does to `final`.** `FINAL` used to mean "nothing further can happen".
It now means **nothing further happens *of its own accord*** — no watchdog armed,
no loop turning, no event pending — and only an explicit instruction from outside
moves the worker on. That was already true of `completed --merge--> merged`;
Phase 6 makes it true of four more states. The property that still holds, and that
the state tests pin, is that `revise` is the *only* trigger any final state
accepts: a `complete` or `timeout` edge out of one would mean a settled worker
could be re-settled by an event arriving late.

**Every refusal names the way forward.** A worker that cannot be revised produces
a message saying what to do instead — `worker_message` for a blocked one, a
respawn for a merged or interrupted one, `worker_wait` for one still running.
A refusal that only says no makes Claude guess.

## Decision 4: the wall clock resets per round; the tokens do not

A revision gets a fresh `wallClockMs`, set at the prompt rather than at the
`worker_revise` call — the same rule that makes queue time free for a spawn. The
wall clock is a **hang detector** and belongs to the turn.

Tokens are **not** reset. They accumulate in the session, because every round
re-sends the whole context, and the cumulative figure is the honest measure of
what this worker has cost. §8 budgets on tokens precisely because they are the
number that means something.

Two things follow. `worker_revise` refuses a worker already at its token ceiling
*before* prompting it — otherwise the round is admitted, prompted and killed by
the first budget poll, which reads as a revision that silently did nothing. And
the token budget becomes a second, independent backstop on the loop: a worker
cannot be revised forever even under a raised revision cap.

`startedAt` is deliberately **not** reset, so elapsed time in the run report spans
the worker's whole life rather than its last turn. The budget clock is
`runningSince` and is a different number on purpose — as ADR-0004 already noted
for queue time, elapsed-on-the-status-line and elapsed-against-the-budget are two
different numbers here by design.

## Decision 5: a reviewer gets its own worktree at the target's base, not a mount of the target's

§6.1 offered two shapes and this is a third.

**Why not a mount of the target's worktree.** `buildResult()` measures a worker's
own directory against its own base. A reviewer sitting in the author's worktree
would therefore measure the *author's* changes as its own: a read-only worker
would settle with a `changed_not_claimed` discrepancy for every file the author
touched. The reviewer's own diff being genuinely empty is what makes a reviewer
that somehow writes something **visible** rather than camouflaged inside the
author's changes.

**Why not "no worktree at all".** `settle()` skips the snapshot when `worktree` is
empty, but `buildResult()`'s `not_started` short-circuit keys off `startedAt`, and
a reviewer *does* start — so `changedFiles("")` would run and produce an
`unparseable_report` discrepancy about a diff the reviewer was never supposed to
have. A worker with no worktree also has nowhere to read the surrounding code
from, and a reviewer that can only see a diff cannot check it against anything.

So the reviewer branches from the **target's** `baseSha` and gets the target's
diff quoted in its brief: it sees the code as it was before the change, plus the
change. That is how a human reads a pull request, and it makes the reviewer's own
measurements mean what they say.

The reviewer is also handed the discrepancies the orchestrator **already**
measured, so it does not spend its one round re-deriving findings that are already
facts.

## Decision 6: the cap's refusal is a report, and the reviewer's critique is an opinion

Two decisions about what Claude is told, both of which are about honesty rather
than mechanism.

**At the cap, `worker_revise` returns a terminal report rather than an error.**
§13's mitigation for infinite fix loops is "revision caps with terminal actionable
reports", and *actionable* is the load-bearing word: a cap that stops the loop and
returns "limit reached" has converted a runaway into a dead end. The refusal names
what was tried each round, what changed between rounds (measured — file counts,
diff size, failing tests, discrepancies), what is still failing, and four options
with the tool calls that take them. When the diff did not move between the first
and last round it says so explicitly, because that is the single most useful fact
available at the cap: the feedback and the worker disagree about what the problem
is, and a fourth round will not fix that.

The rounds are reconstructed from the **event trail** rather than kept in a
column, per DD-7: the trail is already the durable record of what happened, and a
report that derives its story from the same rows a debugger reads cannot drift
away from them.

**The reviewer's critique is presented as one more model's opinion.** Every worker
in this system runs on the same model (`docs/phase0-facts.md`, §7 of the Phase 6
handoff), so Phase 6's reviewer is Muse Spark reviewing Muse Spark, and it shares
the author's blind spots by construction. The orchestrator's own evidence — the
diff-versus-report reconciliation and the test command it re-ran itself — is
stronger, and `worker_spawn`'s description says this in those words rather than
letting a critique read as a finding. §11 Phase 8's cross-model review diversity
is where that stops being true; until then, `models` per mode stays a
configuration option and nothing selects between models automatically.

---

## Consequences

- **`workers` gained its first new column since Phase 2**, and with it the
  project's first real migration. `CREATE TABLE IF NOT EXISTS` adds a *table* to
  an existing database — which is why Phase 4's `merges` needed nothing — and
  adds *nothing* to an existing table, so a column declared in `SCHEMA_SQL`
  reaches fresh databases only. `MIGRATIONS` in `src/store/schema.ts` runs the
  `ALTER TABLE` on every open and swallows only "duplicate column name".
- **`revisions` is its own counter.** `render.ts` printed `resumes` under the
  label "revisions", which was harmless only while nothing could make the two
  disagree; `worker_revise` makes them disagree on its first call. `resumes`
  counts §5's blocked→answer→resume — the worker asking a question — and
  `revisions` counts §13's rounds, which is the one with the cap on it.
- **`worker_revise` is synchronous by construction**, unlike `worker_message`.
  `manager.answer()` resolves only once the follow-up prompt is away, so the tool
  has to start it and return; `manager.revise()` does all of its work — the state
  change, the enqueue and the new `done` — before its first `await`, and the round
  itself runs detached. That is not a style choice: the state must leave
  `completed` before the call returns or the caller's next `worker_wait` comes
  straight back with the pre-revision record, and `w.done` must be replaced in the
  same tick or a `dispose()` landing in between awaits a promise that resolved
  five minutes ago.
- **One revision per worker at a time**, guarded explicitly. Two `worker_revise`
  calls in the same tick would otherwise both find a settled worker, both pass the
  cap check, and both start a run loop over one session.
- **Nothing revises a worker automatically**, and §11 Phase 6 is explicit about
  it: not a red merge gate, not a discrepancy, not a reviewer's critique. Claude
  decides and the tools report. An orchestrator that revises workers by itself is
  an infinite fix loop with extra steps, and the cap is a backstop rather than a
  licence.
- **Retries with backoff are still not here** (Phase 7). A revision is not a
  retry: a retry re-runs the same instruction and a revision sends a new one.
