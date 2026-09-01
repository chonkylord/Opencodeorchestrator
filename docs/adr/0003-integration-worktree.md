# ADR-0003: The merge happens in a dedicated integration worktree, and worktree lifecycle stays on local git

**Status:** accepted (Phase 4)
**Amended by [ADR-0008](0008-shared-workspace.md) (Phase 8).** The rule below —
that Dispatched Code never writes to the user's working tree — held for every
phase up to 8 and still holds for `isolated` workers. Phase 8's `shared` mode, now
the default, does write files there by request. What ADR-0003 was actually
protecting is unchanged and unchangeable: **`git reset --hard` never runs in the
user's checkout.** Shared workers have no branch, so they cannot enter the merge
pipeline that owns that command.
**Date:** 2026-08-28
**Supersedes nothing. Closes:** `docs/phase0-facts.md` §6's standing warning about
`/experimental/worktree`, and ADR-0002's "Phase 4 should revisit it for creation
and cleanup".

---

## Context

Phase 4 builds §6.3's gated merge: merge each worker's branch one at a time,
run the repository's test command after every merge, and `git reset --hard` back
to the pre-merge sha when the gate goes red. Two questions had to be settled
before any of it could be written, and both are the kind that are expensive to
reverse.

**1. Where does the merge run?** §6.3 does not say. It was drawn before there
was a real repository to be careful about.

**2. Does OpenCode's own worktree API replace `git worktree add`?** Phase 0
flagged it twice, ADR-0002 drew a line through the middle of it — the *diff* must
not come from the worker's own server, because that makes the witness and the
accused the same process, but *creation and cleanup* carry no such objection —
and explicitly deferred the rest to this phase. "We did not look" was not an
available answer.

---

## Decision 1: every merge operation runs in a dedicated integration worktree

`git worktree add .dispatched-code/integration/<mergeID> -b integration/<mergeID>
<base-sha>`, created at the start of a merge and removed at the end. The merge,
the test gate and — above all — the rollback all run with that directory as
their cwd. `config.repoRoot` is read from, never written to.

**Why this is the most important line in the phase.** `config.repoRoot` is a
real repository. A human may have it open, on a branch of their choosing, with
uncommitted work in the tree. `git merge` there is rude. `git reset --hard`
there — which *is* the rollback, on the failure path, which is the path a merge
pipeline exists for — destroys work Dispatched Code never created and cannot
restore. There is no undo, no reflog entry for an uncommitted file, and no way
to tell the user what they lost. It is the single most dangerous thing in the
phase and it is entirely preventable by choosing the right cwd once.

Consequences we accepted deliberately:

- **`.dispatched-code/` is already in `.git/info/exclude`** (written by
  `createWorktree` since Phase 2), so the integration worktree is invisible to
  the user's `git status` without touching their `.gitignore`.
- **The branch is the deliverable; the worktree is scaffolding.** The
  integration worktree is removed when the merge finishes, success or failure.
  Everything worth keeping is a commit on `integration/<mergeID>`, which
  survives, and which `workspace_cleanup` can then treat as a container that
  makes worker branches safe to prune.
- **Dispatched Code never lands anything on the user's branch.** A green merge
  ends with a branch and a sentence saying where it is. Fast-forwarding the
  user's own branch is a separate, explicit act, and Phase 4 does not do it at
  all — not even offered behind a flag. A tool that can write to the user's
  checkout is a tool that can be called by accident.
- **Rollback is asserted on a sha, not on the absence of an exception.** Every
  step records the branch's sha before it runs; the tests assert the branch is
  bit-identical to it afterwards. A rollback that throws nothing and restores
  nothing is invisible to any weaker assertion.

---

## Decision 2: worktree creation and cleanup stay on local git

We evaluated OpenCode's native worktree endpoints **on the wire**, against
OpenCode 1.18.25, in a scratch git repository, rather than from the schema. What
they actually do:

| Probe | Result |
|---|---|
| `POST` with `{"id":"probe-1","title":"probe"}` | `{"name":"misty-cactus","branch":"opencode/misty-cactus","directory":"/root/.local/share/opencode/worktree/<repo-head-sha>/misty-cactus"}` — it named itself |
| `POST` with `{"name":"chosen","branch":"worker/w-001","ref":"HEAD"}` | `{"name":"chosen","branch":"opencode/chosen", …}` — `name` is honoured, **`branch` is silently overridden**, `ref` is ignored |
| `git rev-parse HEAD` in the created worktree | the repository's current HEAD; **no way to pin a base sha** |
| `GET` | a list of directory paths |
| `DELETE` | `true` — and the branch is gone from `git branch -a` too |
| `POST …/reset` | `true` |

They work. They are also the wrong tool here, for four measured reasons:

1. **No control over the branch name.** Every worktree gets `opencode/<name>`.
   `worker/<id>` is not available, and that name is load-bearing in three
   places: §9's orphan scan globs `worker/*`, DD-7's manifest correlates a
   worktree to a worker id, and `workspace_cleanup` distinguishes the
   Dispatched Code's branches from the user's by prefix.

2. **No base ref.** The worktree branches from whatever HEAD happens to be at
   the moment of the call. Phase 2 made `createWorktree` resolve a ref to a
   **sha** on purpose: a run that takes twenty minutes must not have its workers
   based on different commits because something moved `main` underneath them —
   and *that invariant is what makes §6.2's set intersection a valid overlap
   test at all.* Adopting an endpoint that cannot pin a base would quietly
   invalidate overlap detection, which is a wrong answer rather than an error.

3. **The worktrees live outside the repository**, under
   `~/.local/share/opencode/worktree/<sha>/<name>`. `.dispatched-code/` and its
   `info/exclude` entry do not reach there; neither does "delete the temp repo
   and the run is gone", which is what makes the test fixtures safe.

4. **`DELETE` removes the branch along with the worktree, unconditionally.**
   There is no merged check and no force flag to withhold. That is precisely
   what Phase 4's cleanup is built to refuse: DD-7 says the worktrees are the
   durable state and the database is an index, so deleting an unmerged
   `worker/*` branch deletes the only copy of what a worker produced. An
   endpoint whose only cleanup mode is the dangerous one cannot be the cleanup.

And one architectural reason that would hold even if the four above did not:
moving worktree lifecycle behind the adapter boundary (DD-2) would make
ADR-0001's Serve-vs-Run choice materially less reversible — `RunBackend` has no
such endpoints, so a backend swap would take the worktrees with it. Local git
is the same on every backend, and DD-5's snapshot commit means git is in the
loop regardless.

**This closes the item rather than deferring it again.** If a future OpenCode
adds a base ref and a branch name to worktree creation, and a cleanup that can
decline to delete an unmerged branch, the decision is worth revisiting; nothing
else about it is.

---

## Decision 3: a merge is a first-class entity, and `workspace_merge` is async

§7's table said `workspace_merge` returns a "merge + test-gate result". That
reads synchronous and cannot be: the gate runs the repository's own test suite
after **every** merge — minutes, plausibly tens of minutes — and Phase 3
measured the host's ceiling at **60 seconds per tool call**
(`docs/phase0-facts.md` §7). So the merge is spawn-and-poll like everything
else: `workspace_merge` validates, warns and returns a handle;
`workspace_merge_status` is the poll. §7's row is corrected in place.

The handle is a row in a new `merges` table rather than a field on `workers`,
because a merge is not a property of a worker. It has its own lifecycle, it can
fail without any worker failing, and it is about a *set* — "which worker broke
it" is only an answerable question when the others are named alongside. The
alternative (reuse the worker row) would have forced a merge of three workers to
pick one of them to be the merge, which is a lie the run report would inherit.

Three smaller decisions fall out of it, recorded here because the next phase
should not have to re-derive them:

- **The `completed → merged` transition fires after the pipeline, never
  before.** A worker marked `merged` optimistically keeps that state through the
  rollback that took its commits back out.
- **A worker that merged nothing stays `completed`.** `nothing_to_merge` is an
  outcome, not a failure — a `completed` worker may genuinely have no commit,
  because `snapshotCommit` returns `{committed: false}` when it changed nothing.
  Marking it `merged` would put a false row in every run report.
- **The gate's command comes from the brief (`WorkerSpec.testCommand`) or from
  Claude's explicit argument, never from a worker's report (DD-8).** Where two
  workers were briefed with different commands, there is no single command that
  gates their merge, and the merge says it is ungated rather than running half a
  check and reporting a whole one.

---

## Consequences

- The user's repository is read-only to this system. That is now a tested
  property, not a convention: a suite dirties the fixture's working tree, runs a
  full merge-and-rollback cycle, and asserts `git status`, HEAD and the dirt are
  all unchanged.
- Every merge leaves exactly one artifact — a branch — which makes cleanup a
  containment check (`merge-base --is-ancestor`) rather than a policy.
- `docs/phase0-facts.md` §6's list keeps `GET /session/{id}/diff` and the revert
  endpoints as unevaluated, and they stay that way for a reason ADR-0002 already
  gave: local git is the independent witness. Only the worktree row is closed.
