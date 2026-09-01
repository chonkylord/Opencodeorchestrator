# ADR-0002 — How the worker contract and the worker report travel

- **Status:** Accepted
- **Date:** 2026-08-28
- **Phase:** 2 (worker manager core)
- **Evidence:** `test/manager/lifecycle.test.ts`, `test/e2e/manager.e2e.test.ts`
  (green against OpenCode 1.18.25), `docs/phase0-facts.md` §3–§5
- **Amends:** `projectplan.md` §4.1 and §4.2, which describe channels that were
  drawn before any of this was verified

## Context

§4.1 says the task brief is "injected as the worker's prompt **and written to the
worktree (as `AGENTS.md`, which OpenCode auto-loads)**". §4.2 says the worker
"writes `report.json` to the worktree root" and the manager parses it. Phase 0
left both unverified and found two alternatives on the way past: the per-prompt
`system` field, and `format: {type: "json_schema", schema, retryCount}`, which
constrains the reply *and retries it server-side on violation*.

Phase 2 has to pick, because the state machine, the parser and the
reconciliation all hang off the answer.

## Decision

**Out: the brief goes in the per-prompt `system` field.**
**Back: the report is the worker's own final message, parsed leniently.**
**Schema enforcement is requested where the provider supports it, and abandoned
automatically where it does not.**
**`report.json` in the worktree remains a fallback, read only when the reply
yields nothing usable.**

## Why the brief goes in `system`

`AGENTS.md` pickup turned out to work — this phase closed Phase 0's unresolved
item 3 and the fact sheet now records it as verified. So this is a choice, not a
forced move, and there are three reasons to make it anyway:

1. **The brief must not be in the diff we reconcile against.** DD-4 checks the
   worker's claims against `git diff --name-only`. A file the manager writes into
   the worktree is a change the manager then has to remember to exclude from
   every comparison, forever. Dispatched Code already carries one such
   exception (`.dispatched-code/`); adding the contract itself to that list means
   the thing being enforced lives inside the thing being measured.
2. **The worker can edit a file. It cannot edit its own system prompt.** An
   `implement` worker has `edit: allow` over its whole tree. A contract it can
   rewrite mid-run — accidentally, in the course of a refactor — is not a
   contract.
3. **It is re-sent on every turn.** §5's blocked→resume path and Phase 6's
   revisions prompt the same session again. The system field goes with each
   prompt, so a resumed worker cannot drift off its constraints; a file read once
   at the start can fall out of a compacted context without anything noticing.

The per-prompt channel also sidesteps what ADR-0001 already established: custom
agents are discovered only at server start, from the server's own cwd, so
`.opencode/agent/worker.md` per worktree was never available under DD-2 anyway.

## Why the report is the reply, and why the schema is optional

`format: json_schema` looked like the answer — validation and retries handled by
OpenCode itself, which is strictly better than asking for a file and hoping. The
fact sheet marked it **verified (schema)**, meaning it was read from the OpenAPI
document and never sent.

Sending it fails:

```
Error from provider (Console): Upstream request failed: [invalid_request_error]
only `"auto"` is supported for `tool_choice`. `"none"`, `"required"`, and named
function choices are not currently supported
```

OpenCode implements schema-constrained output as a forced tool call, and the
free-tier model this project defaults to — `opencode/muse-spark-1.2-contributor-free`,
the one the fact sheet recommends for tests — does not accept a forced
`tool_choice`. A design that depends on the constraint does not run on the
model we develop against.

So the constraint is treated as an optimization, not a contract:

- The brief states the contract in words and embeds the schema, so the model
  knows exactly what to produce whether or not anything enforces it.
- The manager asks for `format` on the first turn. If the provider rejects it,
  the manager re-sends that turn once without it and **latches structured output
  off for every later worker on that backend** — one worker pays for the
  discovery instead of all of them.
- `parseReport` is written to be lied to and to be disappointed: it digs the JSON
  out of prose, takes the last complete object when a model narrates before
  answering, coerces missing fields, and records every repair as an issue that
  travels into the result. Nothing is silently fixed.

Against real OpenCode with the constraint dropped, the free-tier model returned a
clean, complete report anyway. The schema was never the contract; it was the
enforcement, and losing the enforcement must not lose the worker.

**`report.json` stays as §5's "belt and suspenders" secondary**, read only when
the reply parses to nothing. It costs about fifteen lines and it covers the case
where a model writes the file and then says something conversational. It is
excluded from the snapshot commit and filtered out of every changed-file list, so
keeping it does not compromise reason (1) above.

## Why the diff comes from local git, not from the backend

`docs/phase0-facts.md` §6 notes that OpenCode exposes `POST /experimental/worktree`
and `GET /session/{id}/diff`, neither evaluated, and warns against building git
plumbing by hand without looking. Phase 2 uses local git anyway, for one reason
that is not about convenience:

**The diff is the evidence we check the worker's claims against.** Asking the
worker's own server for it makes the witness and the accused the same process. A
reconciliation whose ground truth arrives over the same connection as the claim
is not independent, and DD-4 exists precisely because workers misreport.

Two lesser reasons: DD-5 requires the manager to run `git commit` regardless, so
git is already in the loop; and worktree lifecycle behind the adapter would
couple workspace management to the backend choice that ADR-0001 wants to keep
reversible. Phase 4 should revisit `/experimental/worktree` for creation and
cleanup, where neither objection applies.

## Costs accepted

- **Text deltas are on for every worker.** The reply is the report, so the
  manager subscribes with `deltas: true` and accumulates the token stream. That
  is the majority of event volume, capped here at 512KB per turn. It costs the
  *manager* memory, not Claude context — the firewall in §1 is unaffected — but
  it is the one place Phase 2 spends volume it could avoid. The alternative is an
  adapter method to fetch a session's final message, which would put a new
  OpenCode endpoint behind the boundary. Worth doing if the delta volume ever
  bites; not worth an unverified endpoint today.
- **The first worker against a new provider may spend a wasted turn** discovering
  that structured output is unavailable. Bounded to one per manager.
- **A mid-run permission or question ask cannot be answered in band.** The
  adapter exposes no reply method — Phase 1 did not build one, and the endpoint
  shapes are schema-verified only. The manager converts such an ask into an
  escalation: it aborts the turn, surfaces the question, and delivers the answer
  as the next prompt to the same session, which keeps its context. Nothing hangs
  and nothing is lost but a partial turn. Recorded as an open item in the fact
  sheet.

## When to revisit

- A paid provider that accepts forced `tool_choice`: turn structured output back
  on by default and consider making a rejection fatal rather than adaptive.
- Delta volume becoming a memory or latency problem: add a "fetch final message"
  method to the adapter and read the report from it.
- Phase 4 evaluating `/experimental/worktree`: creation and cleanup may well move
  behind the adapter. The *diff used for reconciliation* should not.
