# ADR-0001 — Use `opencode serve` as the default backend

- **Status:** Accepted
- **Date:** 2026-08-28
- **Phase:** 0 (spike & verification)
- **Evidence:** `spike/spike.ts` (green), `docs/phase0-facts.md`
- **Supersedes:** the "verify" caveats on DD-2 in `projectplan.md` §3.1

## Context

`projectplan.md` proposed two backends behind one `OpenCodeBackend` interface:
`ServeBackend` (one long-lived `opencode serve`, N sessions) and `RunBackend`
(one `opencode run` subprocess per prompt). The plan defaulted to Serve but
flagged the assumption as unverified — specifically whether one server process
could host sessions rooted in different git worktrees, which the whole
worktree-isolation model in §6 depends on.

## Decision

**Default to `ServeBackend`.** Keep `RunBackend` as a documented fallback, but do
not build it in Phase 1 beyond the interface.

## Why

Four facts settle it, all verified live:

1. **Per-session working directory works.** `POST /session?directory=<abs path>`
   binds a session to an arbitrary directory, confirmed against a real
   `git worktree`. One process genuinely can host N isolated workers. This was
   the load-bearing unknown, and it holds.
2. **Async prompting is native.** `POST /session/{id}/prompt_async` returns HTTP
   204 in ~30 ms and runs in the background. DD-1's spawn-and-poll pattern is not
   something we impose on OpenCode — it is how OpenCode already works. `run`
   would force us to manage a subprocess per prompt to get the same shape.
3. **Session reuse retains context.** A second prompt to the same session
   recalled its own prior work unprompted. `worker_revise` and the
   blocked→answer→resume path both depend on this, and `serve` gives it for free
   via a session ID. `run --session` claims the same but adds process churn.
4. **Usage, diffs, and escalation are already exposed.** `Session.cost`,
   `Session.tokens`, `Session.summary`, `GET /session/{id}/diff`, and the
   `question`/`permission` endpoints cover budget enforcement (§8), the worker
   result's diff-stat line (§4.3), and the blocked state (§5) without extra
   machinery.

## Costs accepted

- **Custom agents are discovered only at server start, from the server's own
  cwd.** `GET /agent?directory=…` ignores the parameter on a running server. So
  §6.1's plan to drop a `.opencode/agent/worker.md` into each worktree does not
  work here. Mitigation: carry the worker contract in the per-prompt `system`
  field (fully dynamic, no files, no restart), and/or define one `worker` agent
  at the server's project root where all worktrees share a project. This is a
  simplification — one fewer file to inject per worktree.
- **SSE subscriptions are directory-scoped.** One stream per worktree
  (`GET /event?directory=…`), not one global stream. The adapter owns a small
  map of directory → subscription. Getting this wrong is a silent hang, not an
  error, so it is encoded in `spike.ts` with a comment explaining why.
- **A single point of failure.** If the server dies, every worker dies with it.
  Phase 7's crash recovery must treat server liveness as a first-class check, and
  worktrees (not sessions) remain the durable state, exactly as DD-7 says.

## When to revisit

Switch a worker to `RunBackend` if any of these turn up:

- One server degrades with 4+ concurrent sessions (§14 Q5, still unmeasured).
- A worker needs an agent definition that cannot be expressed per-prompt.
- Stronger isolation is required than a shared process gives — which is also the
  point at which the container sandboxing in §8 becomes the better answer.

The interface boundary is what makes this reversible; keep everything
OpenCode-shaped behind it, per DD-2.
