# ADR-0007: a reviewer is a different model, and reads the code as the author left it

**Status:** accepted (Phase 8)
**Date:** 2026-08-30
**Amends [ADR-0005](0005-the-review-loop.md), Decisions 5 and 6.** Records what
Phase 8 changed about routing and review, and the two defects that running a real
cross-model review found in Phase 6's design.

---

## Context

`projectplan.md` §11 Phase 8 is "optimization (ongoing)": model-routing presets
with automatic selection, worker priorities, smarter summarization,
shared-workspace mode, container sandboxing, cross-model review diversity. §15
had already deferred two of those out of v1 by name — *automatic model selection
based on task classification*, and *cross-model adversarial review as default
rather than option*.

**One measurement unblocked both, and it should have been taken four phases
ago.** ADR-0005 states, as a fact about this project, that "every worker in this
system runs on the same model, so Phase 6's reviewer is Muse Spark reviewing Muse
Spark, and it shares the author's blind spots by construction". That was true of
the *configuration*. It was never true of the provider: `GET /provider` lists six
models on `opencode`, and on 2026-08-30 all six completed a turn on this key in
1.0–5.8 s. Nobody had looked.

---

## Decision 1: a review worker is routed away from the model that wrote the code

`src/manager/routing.ts` decides one thing — which model runs a worker — with
this precedence:

1. **`spec.model`.** Claude naming a model is not a hint, and this holds even
   against diversity: reviewing with the author's own model is a legitimate
   experiment, and silently overriding an explicit parameter would make it a
   suggestion. The route still records that such a review is not independent.
2. **Review diversity.** A reviewer with a known author model takes the first
   candidate that differs from it, from `ORCHESTRATOR_REVIEW_POOL`, then the
   `review` preset, then the default.
3. **The mode preset**, then **the default**.

**Deterministic, not random.** A system whose whole value is evidence should
answer "which model reviewed this?" the same way whenever it is asked.

**When every candidate is the author's own model, the review still happens and
says so.** `WorkerResult.review.crossModel` is `false` and `renderResult` prints
the caveat ADR-0005 had to state as permanent — a second opinion from the same
mind, not independent evidence. That is the honest default for anyone with one
model configured, which is everyone until they set a pool.

**What this deliberately is not: a task-text classifier.** §15 says "automatic
model selection based on task classification", and the only honest classifier
available is the *mode*, which Claude states explicitly. Guessing a category out
of a one-line task would route work to the wrong model silently, and doing it
properly needs a model call — a dependency the orchestrator has never taken and
should not take for a routing hint.

## Decision 2: the reviewer's worktree is the author's snapshot, not its base

**This corrects ADR-0005 Decision 5, and the correction came from running it.**

Phase 6 branched the reviewer from the target's *base* commit, reasoning that
"it sees the code as it was before the change, plus the change — that is how a
human reads a pull request". That is not how anyone reads a pull request, and the
first live cross-model review demonstrated the cost inside two minutes:

> "Worker w-001 claimed to add clamp() to src/stats.js but the function does not
> exist in the worktree. The file has 25 lines and ends at median(); no clamp
> function is present. The reported diff was not applied."

Every word of that is accurate about the file the reviewer could read, and the
conclusion is false. The reviewer opened `src/stats.js` in *its own* worktree —
the version from before the change — and reported the author's work as never
applied, as a `risk`, with confidence.

Phase 6 had written a warning for this and attached it to the wrong condition: it
was emitted only when the diff was *truncated*, which is the uncommon case. A
reviewer whose diff fit was never told which version it was holding.

So the reviewer now branches from the target's **snapshot commit**: the files it
can read are the code as that worker left it, and the diff shows what changed to
get there. The brief states which of the two it has, unconditionally and before
the diff. When the target committed nothing there is no snapshot, the checkout is
the base, and the brief says *that* instead.

**The property that made a separate checkout worth having is untouched.** The
reviewer's own diff is still measured against its own base, so a read-only worker
still measures as having changed nothing — and one that writes is still visible
rather than camouflaged inside the author's changes.

## Decision 3: a read-only worker's `changes` list is not reconciled against its diff

Three of four models, told plainly to leave `changes` empty because they edit
nothing, listed the file they had reviewed anyway. Reconciliation then reported
`claimed_not_changed` — *a false finding in the one channel this system relies on
for true ones.*

Adding words to the brief fixed one model and not the others, which is ADR-0002's
lesson arriving from a new direction: **the contract cannot depend on
instruction-following the models do not reliably have.** So the rule is structural
now. For a worker that cannot write at all (`research`, `review` — DD-10), the
`claimed_not_changed` check is off: its `changes` list is not a claim about what
it wrote, because it wrote nothing and could not have.

**The rule in the other direction is kept, and matters more.** A read-only worker
whose diff is *not* empty has done something it could not do, and that is a
finding about the sandbox rather than about the report. `changed_not_claimed`
stays on for every mode.

## Decision 4: priorities reorder the queue and nothing else

ADR-0004 deferred priorities here by name. `WorkerSpec.priority` (default 0,
higher first) picks among entries that could **all start right now**; ties keep
spawn order, so the whole thing stays deterministic.

The property ADR-0004 was careful about is untouched, and it is the one a priority
scheme is most likely to break: the queue is scanned for entries that are
*runnable*, not stopped at the head, so a dependency can never be stuck behind its
own dependent whatever the priorities say. Priority reorders within the runnable
set; it cannot promote a worker past its own dependency.

It does not preempt a running worker, does not raise a budget, and does not affect
merge order (`suggestMergeOrder()` still owns that). `queueHint().position` is now
computed in *admission* order rather than array order, because "3rd of 5" is a
promise about when this worker runs and would otherwise quietly mean something
else the moment anything jumped the queue.

**Starvation is possible and is accepted.** A stream of high-priority spawns can
hold a low-priority worker in the queue indefinitely. FIFO within a priority
bounds it in practice — waves here are finite and small (§7 recommends 2–5) — and
the alternative, ageing, is a scheduler with a tuning parameter, which ADR-0004
declined for good reasons that have not changed.

---

## What Phase 8 did not build, and why

`projectplan.md` §11 Phase 8 is explicitly *ongoing*. Three of its six items are
not here:

- **Container sandboxing.** Blocked in this environment, not deferred by choice:
  the Docker client is installed and there is no daemon (`/var/run/docker.sock`
  does not exist), so nothing written for it could be run even once. Building an
  isolation mechanism that has never executed would be the opposite of what §8's
  security section is for.
- **Shared-workspace mode for trivially-parallel tasks.** Declined for this phase
  on design grounds. Every measurement in this system attributes a diff to a
  worker by taking `git diff` in *that worker's* worktree against *its* base
  (DD-4, §6.1). Two workers in one directory makes that attribution ambiguous
  exactly when it matters — a discrepancy could belong to either — and the honest
  version needs a different attribution model (per-path ownership enforced at
  measurement time, not just stated in a brief). That is its own design with its
  own ADR, not a flag.
- **Smarter summarization.** §8's context targets were measured as met in Phase 3
  and nothing since has moved them; the render layer's caps are doing their job.
  Rewriting them without a measurement saying they are wrong would be changing
  the one part of the system whose budget is already verified.

## Consequences

- **ADR-0005's caveat is now a configuration choice rather than a property.** The
  tool descriptions and `renderResult` say which kind of review Claude got. With
  no pool configured, nothing changes and the same-model caveat is printed — the
  honest default for a single-model install.
- **A cross-model review earns its keep, measured.** On the same diff, the
  same-model reviewer approved it; the cross-model reviewer approved it *and*
  noticed that no test had been added for the new function. That is the blind-spot
  argument, demonstrated rather than asserted.
- **`nemotron-3-ultra-free` is a poor pool member**, and the reason closes a Phase
  7 open item: a review worker that "wedged and nobody root-caused why" is
  model-specific, not review-mode-specific. It generated 39,004 tokens over 6.5
  minutes without a terminal event where three other models finished in 24–33 s.
  The general lesson is that a free model can generate indefinitely without
  terminating, and the **wall-clock** budget rather than the idle watchdog is what
  catches that.
