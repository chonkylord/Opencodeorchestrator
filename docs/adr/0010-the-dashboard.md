# ADR-0010: the context firewall has two sides

**Status:** accepted (Phase 9)
**Date:** 2026-08-31
**Closes** §15's "web dashboard for run telemetry", deferred out of v1 and left
deferred by every phase since.

---

## Context

This system's central design decision is a context firewall. §8 budgets it, §11
Phase 3 measured it, and `src/mcp/render.ts` exists to enforce it: a whole
spawn→poll→result round trip must grow Claude's context by under 2,000 tokens,
where the raw worker stream would cost fifty times that. `worker_output`'s
description states the consequence in as many words:

> This is not the worker's transcript and there is no tool that returns one. The
> transcript is what the context firewall keeps out.

That is correct and should stay correct. It also produces an outcome nobody
designed: **the human ends up seeing less than Claude does.** Claude gets
structured results, discrepancies, queue positions and spend, on demand. The
person whose repository is being edited gets whatever Claude chooses to relay,
through a terminal, after the fact — and when a run goes wrong, the first
question is always some form of "what is it actually *doing*", which is exactly
the question the firewall is built to make unanswerable.

The firewall was never about the information being unsafe. It is about what the
information costs to move through a context window. **A human watching a browser
tab pays none of that.**

---

## Decision 1: the transcript takes the other exit

The manager gains one optional `observer`, handed a neutral `ActivityInput` — a
kind, a timestamp, and text/tool/file — translated from the backend's frames at
the single point in the run loop where they all pass. From there:

manager → `ActivityLog` (a bounded in-memory ring) → SSE → the browser.

It reaches no tool result, ever. The rule `worker_output` states is unchanged;
what changed is that the transcript now has a destination that is not Claude.

**Neutral by construction (DD-2).** The observer is handed Dispatched Code's own
vocabulary, never OpenCode's, so the adapter can be rewritten without the
dashboard noticing. The boundary test in `test/opencode/boundary.test.ts` caught
the first version of this doing it wrong — comparing against raw event names —
which is the test earning its keep.

**Bounded twice.** Per worker: 400 entries and 96,000 characters, and consecutive
text deltas coalesce into one growing entry rather than one row per token. Phase 8
measured a worker that generated 39,004 tokens with no terminal event; an
unbounded buffer behind a live stream turns that into somebody's laptop swapping.
The two caps catch different failures — a chatty tool-calling worker hits the
entry cap, a single enormous reply hits the character cap.

## Decision 2: the index is the only seam it needs

Every state change in this system already passes through `Store.putWorker`, and
every lifecycle event through `Store.appendEvent`. Two optional hooks there give
the dashboard everything a dozen call sites would have had to be taught to
publish. The manager was not modified for state at all — only for the live
transcript, which genuinely does not pass through the index.

Both hooks run after the row is committed and are wrapped: a subscriber that
throws must not fail an orchestration because a browser tab is in a bad state.

## Decision 3: loopback, and read-only

It binds `127.0.0.1` and serves `GET`. That is not configurable.

No endpoint stops a worker, answers one, or spawns one. **Control stays on the
MCP surface**, where it is Claude's, where it is audited, and where DD-8's trust
model already applies. A localhost page that can mutate a running orchestration
is a CSRF target reachable by any other tab in the same browser, and "it is only
on my machine" is the assumption that makes those work. The refusal is enforced
once, before routing, so a route added later cannot forget it; the static handler
refuses any path that resolves outside the UI directory. Both are asserted in
`test/observe/server.test.ts`, because both are one line away from being wrong
and neither is visible in ordinary use.

Failing to start is not failing to orchestrate: a port collision logs and returns
`undefined`. An MCP server that will not come up because a dashboard could not
bind a socket has its priorities backwards.

## Decision 4: no build step, no CDN, no framework

Three files served off disk: `index.html`, `app.css`, `app.js`. Vanilla.

A dashboard that needs `npm run build` before it shows anything is a dashboard
nobody runs. One that fetches a framework from a CDN does not work on the
aeroplane where you most want to know what your workers are doing. The whole
client is smaller than the dependency manifest it would otherwise need, and it
will still run in five years with no toolchain to rot.

## Decision 5: the two design rules are the same two rules

**DD-8 — worker output is data.** Every string a worker produced enters the
document through `textContent` or `createTextNode`. There is no `innerHTML`
assignment carrying data anywhere in `app.js`. A worker reads a repository that
may contain anything; a dashboard that renders that as markup is a stored-XSS
hole aimed at the one browser holding Dispatched Code's own origin.

**DD-4 — a claim is not a measurement.** The worker's own words get a light rule
and a proportional face; Dispatched Code's measurements get a heavy rule and a
monospace face; the discrepancy section says outright which one to believe. The
distinction the result renderer makes in prose, the dashboard makes in
typography.

**And one rule that is only the dashboard's: state is shape, never colour.** The
states rendered — running, queued, blocked, four kinds of failure — are exactly
the set a colour-coded board renders illegibly to the ~8% of men with a red/green
deficiency. A filled dot runs, a dashed ring waits, a half-filled dot is blocked
and wants you, a square is settled, a cross failed, a dashed square is
unreachable. The palette is black and white in both themes and carries no meaning
at all.

---

## Consequences

- The default is **on**, at `http://127.0.0.1:4180`, URL logged to stderr at
  startup. A feature you must know an environment variable to enable is one most
  people never learn exists; `DISPATCHED_CODE_DASHBOARD=0` opts out, and
  `DISPATCHED_CODE_DASHBOARD_PORT=0` takes any free port for running several
  instances at once.
- The ring is filled whether or not the dashboard bound a port. It costs a few
  hundred kilobytes at worst and it is what makes attaching later possible.
- **Nothing about Claude's token cost changes.** No tool result grew, no tool was
  added, no description got longer for this. That is the point: the human's view
  got dramatically wider and the model's context did not move.
- The dashboard shows a worker's *brief*, which is in memory only. A worker from
  a previous process shows its spec instead and says why — the brief is
  deterministic from the spec, so nothing is lost, but they are not the same
  artifact and the UI does not pretend otherwise.
- The read-only stance means the answer to "can I unblock a worker from the
  dashboard?" is no, and will stay no. Ask Claude; it has `worker_message`.
