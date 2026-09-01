# ADR-0006: what a crash costs, what a budget buys, and who decides a retry

**Status:** accepted (Phase 7)
**Date:** 2026-08-29
**Supersedes nothing.** Records the Phase 7 decisions a later phase would otherwise
have to reverse-engineer, and one correction to `docs/phase0-facts.md` that came
from putting a probe on the wire.

---

## Context

Phase 7 is `projectplan.md` §11's hardening: budget enforcement, retries with
backoff, orphan cleanup, crash-recovery flows and a metrics log, against an AC of
*"`kill -9` the manager mid-run → restart → clean recovery; budget-exceeded worker
pauses and surfaces; orphans pruned."*

Most of it is small. Four questions in the middle of it are not, and each has an
answer that looks obviously right and is wrong.

---

## Decision 1: `resume` is one action, and the backend decides which thing it does

§9 says a restart should "offer Claude: resume monitoring, retry, or
fail-and-cleanup". `worker_recover(id, action)` offers `resume`, `fail` and
`discard` — the three edges out of `interrupted` the state machine has enumerated
since Phase 2 and which nothing had ever fired.

**`resume` deliberately does not ask Claude which kind of resume it wants**,
because the answer is not Claude's to know. It turns on whether the worker's
session still exists, which only the backend can say:

- **The session is alive** — an OpenCode server outlived the manager, which is
  what `DISPATCHED_CODE_BASE_URL` produces. The turn may still be running, so the
  manager re-subscribes and monitors it.
- **The session is gone** — the ordinary case, because a restarted manager spawns
  a fresh server that has never heard of it. There is nothing to monitor, but the
  worktree is intact and is the durable half (DD-7), so the worker is **salvaged
  from disk**: snapshot, measured diff, the brief's test command re-run
  independently, reconciliation, a real result on a mergeable branch.

Asking Claude to choose would be asking it to guess at a fact one HTTP request
settles. `usage()` is that request — it answers `null` for a session the backend
does not know — and deliberately no new backend method was added for it: DD-2's
surface is small on purpose and a question the existing one already answers does
not earn a new one.

**What is lost in a crash is the worker's own report**, which lived in the dead
process's memory. The measurements survive, and §4.3 has always held that they
are the stronger half. Verified on 2026-08-29 with a real `SIGKILL` against real
OpenCode 1.18.25: a worker killed 20 seconds into its task came back
`completed` with 205 insertions across two files committed as its snapshot, its
`npm test` re-run green by Dispatched Code, and `reportSource: "none"` — an
honest record of exactly what died with the process.

## Decision 2: a recovered worker gets a *grace window*, not the idle watchdog

The case neither reasoning nor the first draft caught: **a session that survived
whose turn ended while the manager was dead.**

Subscriptions are not replayed. The terminal event that ended that turn was
delivered to a process that no longer exists and is simply gone. A recovered
worker that re-attached and waited for one would sit through the entire idle
watchdog — three minutes by default — and then be recorded as *wedged*, with its
finished work sitting on disk the whole time.

So a recovered worker carries `recoverGraceMs` (8 s): if nothing arrives in that
window, it stops waiting and salvages instead. That is a different question from
the one the idle watchdog asks. The watchdog asks *"has this worker hung?"* about
a turn we know started, and answers in minutes because a real turn can be quiet
for a long time. This asks *"is anything there at all?"* about a turn that may
already be over, and eight seconds is generous for it — a live turn emits
something, a text delta or a tool part, well inside that.

The window is checked **before** every other watchdog, because to all of them a
finished turn and a wedged one look identical: no events.

## Decision 3: a budget grant does not resume the worker

§8 says a worker that exceeds its cap should *"pause + surface to Claude"*. Until
Phase 7 only the surfacing was true: the worker stopped and said so, and there was
no way to say *carry on, you may have more*.

`worker_budget(id, {tokens, wallClockMs})` is that way, and it deliberately stops
there. Raising a ceiling and deciding to continue are two decisions, and a tool
that took both would take the second one on Claude's behalf. The flow is
`worker_budget` then `worker_revise`, and the refusal an over-budget worker gets
from `worker_revise` names the first — so the dead end §8 warned about is a route
with signposts rather than a wall.

Three smaller things fall out:

- **The grant is written to the worker's spec**, not held in memory, so it
  survives a restart. A grant forgotten by the next process would be forgotten
  exactly when it was most needed.
- **It applies to a running worker at once**, because the watchdogs read the
  budget fresh on every tick. A worker about to be killed for its tokens can be
  rescued mid-turn rather than only mourned afterwards.
- **It is additive**, so "give it another 100k" is the thing you say, rather than
  a new absolute anyone has to compute from the old one.

## Decision 4: retries are the provider's judgement, and they come first

A retry re-runs the *same* instruction; a revision sends a new one (§5). So
retries have their own counter, no revision cap to interact with, and no round to
report — they belong to the turn, not to the loop above it.

**What is retried is decided by `OpenCodeError.retryable`**, which the adapter
reads from `APIError.data.isRetryable` — the provider's own judgement, never a
guess from the message text. A content filter reproduces exactly and retrying it
spends the budget three times to reach the same answer.

**The retry check runs *before* the structured-output branch**, and that ordering
is load-bearing rather than incidental. A schema rejection arrives as an `api`
error too. With the format branch first, every transient provider hiccup was
diagnosed as a schema rejection: it burned the one-shot format retry *and*
latched structured output off for the whole backend's life (ADR-0002), over
something that had nothing to do with schemas. Retryability is exactly the field
that tells them apart — the real rejection is measured as `isRetryable: false` —
so the format branch now also requires `!retryable`.

The backoff is exponential from 1 s, capped at 30 s, and is a real wait: a
provider that rate-limited us will do it again if we come straight back, and a
retry that arrives 30 ms later is indistinguishable from the request that caused
the problem.

## Decision 5: the run cap is checked twice, and the orphan TTL protects the living

**§8's global run cap** is enforced at `spawn()`, where a refusal is legible and
no row is written, **and again before a queued worker opens a session**. Both,
because the spend that matters accrues *while a worker waits*: two workers can be
accepted under the cap and the second admitted long after the first has blown it.
A cap that binds when the work was requested rather than when the money would be
spent is not a cap.

**§9's orphan TTL** is 24 hours and refuses to prune anything younger — or of
unknown age. The failure it exists for is not deleting stale scratch; it is
deleting *another Dispatched Code's live worktree*, or this one's before its index
caught up. Both look exactly like an orphan to a scan and neither is one. A TTL
that pruned what it could not date would delete the thing it was least sure
about, so a missing age counts as *too young*.

## Decision 6: metrics are a file, and never reach Claude

JSONL under `.dispatched-code/metrics/`, one file per UTC day, and **no tool returns
it**. Three reasons, and the third is the one that matters:

- DD-7 makes the database an index and the worktrees the durable state; metrics
  are neither. They want to be greppable without a SQLite client and to survive
  the index being deleted, which is exactly when somebody is asking what happened.
- A file per day rather than per run, so "what happened last Tuesday" is a `grep`
  rather than a directory listing.
- **§8's context budget is the whole architecture**, and a metrics feed is
  precisely the sort of thing that would quietly eat it. `run_report` remains what
  Claude reads.

Every call site is wrapped so a sink that throws cannot fail a worker. That is not
defensive habit: the natural place to record a worker metric is `settle()`, the
one place every worker passes through, and an exception there is a worker that
never settles. The first version had it unwrapped and a test written to break it
deliberately found it.

## Decision 7: permissions are answered in band; questions are not

`docs/phase0-facts.md` "Unresolved" 5 carried from Phase 1 to Phase 7: the adapter
could surface a permission ask and not reply to one, so the manager converted
every mid-run ask into an escalation — abort the turn, surface it, deliver the
answer as the next prompt. It worked and cost a partial turn every time. Phase 6's
v1 demo priced it: three asks in one four-worker run, and the worker that
escalated twice finished on 47,531 tokens against 7,715 for the one that never
did.

**The fact sheet named the wrong endpoint**, which is the whole distinction
between *verified (schema)* — somebody read the OpenAPI document — and *verified*.
Measured on the wire, 2026-08-29, OpenCode 1.18.25:

```
POST /api/session/{id}/permission/{requestID}/reply  {reply}     -> 404 PermissionNotFoundError
POST /session/{id}/permissions/{permissionID}        {response}  -> 200 true
```

A request raised as `permission.asked` lives in a different registry from the one
the documented v2 endpoint serves. The v1 session-scoped endpoint answers it,
emits `permission.replied`, and lets the tool call proceed — the probe's file was
written and the turn finished normally.

So the manager leaves the turn running and answers in band. Two consequences
worth stating:

- **The decision is explicit** (`worker_message`'s `decision: "allow" | "deny"`,
  defaulting to allow). Free text cannot be turned into `once`/`reject` reliably,
  and guessing wrong in the *permissive* direction defeats precisely the jail
  signal §8 keeps `external_directory` at `ask` for.
- **Questions still escalate the old way.** Their reply is a selection from labels
  the worker offered (`{answers: string[][]}`), not free text, so forcing Claude's
  prose into one would answer something nobody asked. That half of the item stays
  open, and it is the smaller half: every ask in the v1 demo was a permission.

The fallback, when a reply fails, deliberately does **not** abort before
re-prompting. `respond()` answering `false` means the backend has lost the
request, which is what it says when the turn is already over — and the pump is
paused while blocked, so an abort's own error and idle arrive *after* the
re-prompt has reset `sawAbort` and are read as an abort nobody asked for. The
first version did exactly that and failed the worker `aborted_externally`.

---

## Consequences

- **`interrupted` finally has exits that fire.** Three edges enumerated in Phase 2
  and unused through four phases now have a tool behind them, which also means
  `interrupted` has stopped being a state Claude can only look at.
- **`preparing --exhaust_budget--> over_budget` is a new edge**, and it exists
  because the run cap stops a worker that never reached `running`. `settle()` uses
  `tryApply`, so the missing edge was a silent no-op that left the worker in
  `preparing` forever — a hang rather than an error, which is the failure mode the
  machine exists to prevent. Worth remembering that `tryApply` converts a design
  gap into a wedge.
- **A restarted manager mints ids from `w-001` again**, so anything it spawns
  collides with the rows the dead one left. Phase 7 did not fix this — the tests
  give their second manager a distinct prefix — and it is a real sharp edge for
  anyone running a long-lived instance over one database. A durable id
  sequence is Phase 8's, or the first bug report's.
- **Nothing here retries a *worker*.** Retries are per turn and inside the run
  loop. Re-running a whole worker is a new `worker_spawn`, and it is deliberately
  Claude's call, exactly as revisions are (ADR-0005).
