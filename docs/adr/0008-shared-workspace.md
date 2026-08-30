# ADR-0008: workers share your checkout by default, and what that costs

**Status:** accepted (Phase 8)
**Date:** 2026-08-30
**Amends [ADR-0003](0003-integration-worktree.md)**, which said the orchestrator
never writes to the user's working tree. In `shared` mode it does — deliberately,
by request, and with the one genuinely destructive operation still forbidden.

---

## Context

Every phase up to here isolated workers: one git worktree each, one branch each,
invisible to one another until a gated merge took the work. That was the right
default for a system whose value is evidence, and §15 deferred shared workspaces
out of v1 on exactly those grounds. Phase 8 declined them again for the same
reason.

The counter-argument is short and correct: **Claude's own subagents do not work
this way.** They run in the user's directory, together, seeing each other's
files. Anyone who has used them expects that, and a worker that cannot see what
its siblings just wrote is a worse collaborator for it — a test-writing worker
that cannot read the module a sibling is building has to be told about it in
prose instead.

So the default is inverted: **`shared` is now the product default, `isolated` is
the option.**

---

## Decision 1: `shared` workers work in the repository itself

No worktree, no branch. `WorkerSpec.workspace` chooses per worker;
`ORCHESTRATOR_WORKSPACE` sets the default and only an exact `isolated` opts out,
because a typo should not silently move somebody to the slower mode.

What follows from having no branch:

- **Nothing is merged.** `workspace_merge` refuses a shared worker and says why.
  The work is already in the tree; there is nothing for a gate to stand between.
- **Nothing is committed.** DD-5 has the manager snapshot so the worker does not
  have to, which is right in a worktree the orchestrator owns. In the user's
  checkout `git add -A` would sweep up whatever else they had in progress, onto
  whatever branch they happen to be on, and call it one worker's snapshot. So the
  changes are left uncommitted, for a human to read and commit — which is also
  precisely what a native subagent leaves behind.
- **No manifest is written.** `writeManifest` writes one file per *worktree*, and
  in a shared tree every worker would overwrite the last, turning DD-7's
  rebuild-from-disk into a rebuild of whoever finished most recently.

## Decision 2: the one thing shared mode may never do is `git reset --hard`

ADR-0003's rule existed for a specific operation, not a general squeamishness:
the merge pipeline's rollback is `git reset --hard`, and run in the user's
checkout it destroys work the orchestrator never created and cannot restore.

That rule is **unchanged**. Shared mode does not merge, so it never rolls back,
and the refusal in `requireMergeable()` is structural rather than advisory — a
worker with no branch cannot enter the pipeline at all. `workspace_cleanup` has
the mirror guard: anything at or above the repository root is not ours to remove,
whatever a candidate row claims.

The honest summary of the trade: **the orchestrator will now write files into
your tree. It will still never commit, reset, checkout or delete there.**

## Decision 3: attribution is best-effort, and says so

This is the real cost, and the reason shared mode was declined twice before.

DD-4 — the diff-versus-report reconciliation that turns a worker's claims into
findings — rests on a property that shared mode removes: *the diff in a worker's
directory is that worker's diff.* With several workers in one tree, git records
who changed a file exactly as well as a shared folder does, which is not at all.

There is no clever recovery, and pretending otherwise would be worse than the
gap. So a shared worker's result carries an `attribution` block with three parts:

- **`preexisting`** — dirty before the worker started, subtracted outright.
  Measured at its first prompt. Without this, a user with a half-finished feature
  in their tree has it credited to whichever worker settles first, which is a lie
  in the one channel this system keeps honest.
- **`owned`** — changed files the worker's `ownedPaths` cover. The only positive
  evidence available, and it is *a claim the brief made* rather than a
  measurement: a worker that ignored its own path list gets attributed work it
  did not do. This is why `ownedPaths` matters far more in shared mode than in an
  isolated one, and why the tool description now says so.
- **`unattributed`** — everything else that changed while it ran. Named rather
  than hidden, and never quietly credited to whoever settled first.

`concurrent` lists who else was in the tree, because **a shared worker that
happened to run alone is measured exactly** — as precisely as an isolated one —
and should not be discounted for the mode. `renderResult` prints the distinction
in words rather than leaving Claude to infer it from a field name.

Verified live on 2026-08-30: two concurrent workers in one checkout with a
pre-existing `NOTES.md` in the tree. Each attributed its own file, reported the
other's as unattributed, listed `NOTES.md` as pre-existing, named the other
worker as concurrent, and `HEAD` did not move.

## Decision 4: the brief tells a shared worker it is not alone

An isolated worker never needed to hear this; a shared one fails without it. The
brief now states that other workers are editing the same tree, that files will
appear and change underneath it, and — the instruction that matters most — that
it must not revert, reformat or tidy anything outside its own paths. One worker
"cleaning up" what looks like half-finished code is destroying a sibling's turn
as surely as deleting it would.

It is also told not to run `git` commands that change state. In its own worktree
that was merely unnecessary; here a stray `git checkout` or `git stash` reaches
the user's work.

---

## Decision 5: §6.2's overlap question is asked at spawn, because there is no merge to ask it at

`detectOverlap` runs inside the merge pipeline, from *measured* diffs, and warns
before workers are merged one at a time. A shared worker never reaches it: no
branch, no merge, no gate.

That would have left the question unasked in the mode where it matters **more**.
Two isolated workers editing one file produce a merge conflict the gate catches
and rolls back. Two shared workers editing one file produce a last-write-wins
race in the user's tree, with nothing watching and nothing to roll back to.

So the question is asked at spawn instead, from what has been *declared* rather
than measured, and answered in the reply that hands back the worker id — while
the plan can still change. Two warnings:

- **A collision:** another shared worker, still live, has claimed paths this one
  declares. The reply names the worker, the patterns, and the three ways out:
  narrow a path list, sequence them with `dependsOn`, or move one to `isolated`.
- **No claim at all:** `ownedPaths` is the only boundary a shared worker has and
  the only evidence its changes can be attributed by. Without it the worker is
  unbounded and everything it touches is reported unattributable.

Comparing two arbitrary globs for intersection is not decidable without walking
the filesystem, and `declaredOverlap` does not pretend otherwise: a pattern with
no wildcard is tested directly, and two wildcard patterns are compared on their
literal prefixes. It is biased toward reporting a possible collision rather than
missing one — a false warning costs a sentence, a missed one costs a file.

Settled workers are not counted: a worker that has finished writing is not
contesting anything, and a warning that fires on every wave is a warning nobody
reads.

**And one bug this found in Decision 3's own attribution.** `matchesPath` takes
`(pattern, file)`; the first version of `attribute()` called it with the
arguments reversed. An exact path still matched — both sides equal — and every
*glob* silently matched nothing, so a worker owning `src/**` was credited with
none of its own work and all of it landed in `unattributed`. Wrong in the
direction that looks like caution, which is why it survived a live run against
exact filenames. The regression test uses a glob.

## Consequences

- **§8's jail signal is weaker.** An isolated worker reaching outside its worktree
  raises `external_directory`, which the orchestrator surfaces. A shared worker's
  worktree *is* the repository, so anything inside the repo is in bounds and
  `ownedPaths` becomes the only boundary — enforced by reporting rather than by
  the sandbox. Anyone who wants the wall back should use `isolated`.
- **Workers can clobber each other**, exactly as native subagents can. Two workers
  told to edit the same file will interleave writes and the last one wins. The
  §6.2 overlap check runs before a merge, and shared mode has no merge, so the
  mitigation is `ownedPaths` and task design rather than the pipeline.
- **The existing test suites now say `isolated` explicitly.** They were written
  about worktrees, branches and the merge gate, and they still test those; what
  changed is that they no longer depend on a default that moved.
- **`isolated` remains fully supported and is not deprecated.** It is the mode
  with the stronger evidence, and the tool description says when to reach for it:
  workers that would collide, or work you want a test gate to stand in front of.
