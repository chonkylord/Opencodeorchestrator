# ADR-0011: workers get full permissions, and nothing stops to ask

**Status:** accepted (Phase 10)
**Date:** 2026-08-31
**Reverses** a Phase 0 decision recorded in `IMPLEMENT_PERMISSIONS`: that
`external_directory` is "deliberately *not* widened" because it is "a useful jail
signal for §8".

---

## Context

Every permission a worker could hit was already granted except one.
`IMPLEMENT_PERMISSIONS` allowed `edit` and `bash` across `**` and turned off the
`doom_loop` guard; what it left alone was `external_directory`, so a worker
reaching outside its own tree stopped and asked.

Phase 0 called that a useful signal and it was one. [ADR-0009](0009-the-orchestration-loop-defects.md)
then measured what it cost in practice: a worker told to write a verification
script reached for `/tmp`, hit the wall, and blocked — doing exactly what it had
been asked to do. Phase 9's answer was to remove the *reason* to reach outside,
by giving every worker a scratch directory inside its jail. That fixed the common
case and left the mechanism intact.

This decision goes further, at the operator's request: **grant everything.**

## Decision 1: `full` is the default permission mode

`FULL_PERMISSIONS` grants `edit`, `bash`, `webfetch`, `external_directory` and
`doom_loop` across `**`, and then `*` across `**`.

The wildcard is the load-bearing entry rather than a flourish.
`HEADLESS_PERMISSIONS` names two permissions because those are the two Phase 0
measured; a provider that introduces a third gets the default action for it, and
in a headless run that default is a deadlock — `ask` is not a safeguard when
there is nobody to ask, it is a worker waiting until a watchdog kills it. `*`
means a permission nobody in this repository has heard of cannot become an
outage.

`ORCHESTRATOR_PERMISSIONS=jailed` restores the previous set. Anything but an
exact `jailed` means `full`, mirroring `ORCHESTRATOR_WORKSPACE`: a typo should
not silently move somebody to the mode that stops and asks.

## Decision 2: a permission request that arrives anyway is granted in band

Granting at the session is not sufficient on its own. A provider can still raise
a request — a permission the ruleset does not cover, a version that evaluates
rules differently — and in `full` mode the honest response to that is not to wake
Claude up about it. The manager answers `once` itself, the worker carries on
mid-turn, and the trail records `permission_auto_granted`.

**It is not recorded as an `escalation`.** Claude was not asked anything, and a
trail row claiming otherwise is a lie the dashboard would then draw as a blocked
worker.

If `respond()` reports the backend does not know the request — the ordinary
outcome when the turn that raised it has already moved on — the code falls
through to the existing escalation path rather than leaving the worker waiting on
a grant that went nowhere. There is deliberately no abort before that fallthrough,
for the reason `enterBlocked` documents at length: the abort's own terminal events
arrive after the re-prompt and get read as an abort nobody asked for.

A `question.asked` is untouched. That is the worker asking Claude something
substantive, and no permission setting makes "should I use approach A or B?"
answerable by a rule.

## Decision 3: read-only modes are not part of this

`research` and `review` workers keep `edit` and `bash` denied, in both modes.

This looks like an inconsistency and is not, because DD-10 is not a safety
setting. Reconciliation *depends* on it: for a worker that cannot write,
`claimed_not_changed` is switched off (Phase 8 found three of four models listing
the file they had reviewed, producing false findings), and the reverse check —
**a read-only worker whose diff is not empty has done something it could not
do** — is one of the strongest signals this system produces. Granting reviewers
write access would not make them more useful. It would delete a check.

---

## Consequences

**What is given up, stated plainly.** `external_directory` was the last thing
standing between a worker and the rest of the filesystem, and §13 lists "prompt
injection via repo content → hijacked worker" as a live risk whose mitigations
are "workers sandboxed to worktree; output treated as untrusted; manager never
executes report content; optional container mode later". The first of those four
is now gone in the default mode. A worker that is talked into it by something it
reads can write anywhere the orchestrator's own process can.

The remaining mitigations are real but weaker: worker output is still untrusted
(DD-8), the manager still never executes report content, and the diff still
records what was touched. The difference is that reaching outside the tree used
to be a *question asked before the fact* and is now a *finding available after
it*.

Two things make that trade less bad than it sounds, and neither makes it
disappear:

- **§11 Phase 8 already put workers in the user's checkout by default.** In
  `shared` mode there is no worktree boundary to protect — the "jail" is the
  repository the user pointed the orchestrator at, and a worker was always able
  to write anywhere inside it.
- **Container sandboxing is the mitigation §13 actually wanted**, and it is the
  one Phase 8 could not build because there is no Docker daemon in this
  environment. It remains the right answer and remains unbuilt.

**What is gained.** No worker ever spends a turn on a wall. Phase 6's demo
measured the cost of the alternative: three asks in one four-worker run, and the
worker that escalated twice ended on 47,531 tokens against 7,715 for the one that
never did.

**`worker_message({decision})` still exists and now only bites in `jailed` mode.**
It is left in place rather than removed: the mode it serves is one environment
variable away, and a tool that silently ignores a parameter is worse than one
that documents when the parameter applies.
