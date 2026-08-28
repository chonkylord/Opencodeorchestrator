# Handoff: implement Phase 1 — the OpenCode adapter

You are picking up the **Claude → OpenCode Subagent Orchestrator** at
`chonkylord/Opencodeorchestrator`. Phase 0 is complete and pushed. Your job is
Phase 1, and only Phase 1.

Work on `main` and push there when done.

---

## 1. Read these first, in this order

Do not start coding until you have read all four. They contain facts that were
expensive to establish and will cost you hours if you re-derive them badly.

| File | Why |
|---|---|
| `docs/phase0-facts.md` | Every verified fact about OpenCode's API, and the five that are still unresolved. **This is the most important file in the repo for your task.** |
| `docs/adr/0001-serve-vs-run-backend.md` | Why `ServeBackend` is the default, and the costs that decision accepted. |
| `spike/spike.ts` | A working, green reference implementation of everything the adapter must do. Your `ServeBackend` is essentially this, refactored behind an interface. |
| `projectplan.md` §2, §3.1, §11 | The design decisions (DD-1..DD-10) and the phase definition. |

Verified against **OpenCode 1.18.23**. If `opencode --version` differs
materially, run `bun run spike` first — it is the drift canary, and a red spike
means the fact sheet needs updating before you build on it.

---

## 2. Your task

From `projectplan.md` §11:

> **Phase 1 — OpenCode adapter (3–4 days)**
> - Implement `OpenCodeBackend` + `ServeBackend` (+ `RunBackend` stub if time).
> - Config injection: model, agent, permissions, cwd.
>
> **AC:** adapter unit tests pass against `ocmock`; one integration test passes
> against real OpenCode.

Concretely, deliver:

1. **`src/opencode/types.ts`** — the `OpenCodeBackend` interface and its data
   types (`SessionHandle`, `RunHandle`, `OCEvent`, `Usage`). The interface shape
   is sketched in `projectplan.md` §3.1; adjust it where Phase 0's facts show the
   sketch was wrong, and say so in your commit message.
2. **`src/opencode/serve.ts`** — `ServeBackend`, the real implementation.
3. **`src/opencode/run.ts`** — `RunBackend` as a stub that satisfies the
   interface and throws `NotImplemented`. Do not build it out; the ADR explains
   why it is a fallback, not a deliverable.
4. **`test/ocmock/`** — a scriptable fake OpenCode server implementing the subset
   of the HTTP + SSE surface the adapter uses. Per `projectplan.md` §12 it must
   support these scenarios: **success, hang, blocked, over-budget, crash**. (The
   "lying report" scenario belongs to Phase 2's reconciliation logic — build the
   hook for it, but the assertion is not yours.)
5. **`test/`** — unit tests driving the adapter against `ocmock`, plus **one**
   integration test against real OpenCode, gated behind an env flag
   (e.g. `OC_E2E=1`) because it spends real tokens.

Everything OpenCode-shaped must live behind this interface. That boundary is the
entire point of DD-2 — no other module may import an OpenCode type, know an
endpoint path, or parse an OpenCode event.

---

## 3. Facts you must not re-derive — and one that will silently break you

These are verified. Build on them; do not spend a day rediscovering them.

**The one that will cost you hours if you ignore it:**

> **SSE streams are scoped by directory.** `GET /event` delivers **nothing** for
> a session opened in another directory. You must subscribe to
> `GET /event?directory=<the same absolute path passed at session create>`.
> There is no error and no warning — the stream simply stays quiet and your wait
> hangs forever. Measured: unscoped saw no `session.idle` in 90 s; scoped saw it
> at 10.9 s. The adapter therefore owns a map of *directory → subscription*, not
> one global stream.

The rest:

- **Port.** `opencode serve --port 0` picks a free port and announces
  `listening on http://HOST:PORT` on stdout. Parse it. Never hardcode 4096, even
  though it usually picks 4096.
- **Session create.** `POST /session?directory=<abs path>` — `directory` is a
  **query param**, not a body field. The body takes `title`, `agent`, `model`,
  `permission`, `parentID`.
- **Permissions.** Passed inline on create as
  `permission: [{permission, pattern, action}]`. There is no `opencode.json` to
  write. A ruleset of `edit/bash: allow` produced a full headless run with zero
  pending permission requests.
- **Prompting.** `POST /session/{id}/prompt_async` returns **HTTP 204** in ~30 ms
  and runs in the background. Body: `{model: {providerID, modelID}, parts: [{type: "text", text}]}`.
  Split a `"provider/model"` string on the **first** `/` only.
- **Completion.** `session.idle`, shaped `{id, type, properties: {sessionID}}`.
- **Subscribe before you prompt.** A trivial task completes in ~11 s; establish
  the stream first or you will miss the event.
- **Cold start.** The first prompt on a fresh server emits ~45 `plugin.added`
  events plus `catalog.updated` before generation starts. Pre-warm; do not
  charge that latency to the worker.
- **Custom agents are discovered only at server start, from the server's own
  cwd.** `GET /agent?directory=…` accepts the param and ignores it. So "config
  injection: agent" in the phase description means **the per-prompt `system`
  field**, not a `.opencode/agent/*.md` file. Design the interface accordingly.
- **Usage.** `Session.cost` and `Session.tokens{input,output,reasoning,cache}`
  via `GET /session/{id}`. `cost` is `0` on free-tier models — expose both, but
  make token counts the primary signal.
- **Errors.** `session.error` carries a discriminated union: `ProviderAuthError`,
  `MessageOutputLengthError`, `MessageAbortedError`, `StructuredOutputError`,
  `ContextOverflowError`, `ContentFilterError`, `APIError`. Map these to typed
  adapter errors — do not string-match.
- **Liveness.** `server.heartbeat` arrives during long runs. A heartbeat with no
  worker events means the *worker* is stuck; no heartbeat means the *server* is
  gone. Two different failures — expose enough for Phase 2's watchdog to tell
  them apart.
- **Contract source.** The full OpenAPI spec is served at `GET /doc` (~479 KB,
  162 paths). Use it rather than guessing shapes.

---

## 4. Definition of done

- [ ] `npx tsc --noEmit` clean.
- [ ] Unit tests green against `ocmock`, covering all five scenarios.
- [ ] Integration test green against real OpenCode (`OC_E2E=1`).
- [ ] `bun run spike` still green — you must not regress it.
- [ ] No module outside `src/opencode/` imports an OpenCode type or endpoint.
- [ ] Committed and pushed to `main`.
- [ ] `projectplan.md` §11 Phase 1 marked complete, in the same style as Phase 0,
      linking to whatever you produced.
- [ ] Anything you discovered that contradicts `docs/phase0-facts.md` is
      **corrected there**, not left for the next agent to trip over.

---

## 5. Scope boundaries

**Do not build**, however tempting: the worker manager or its state machine
(Phase 2), the MCP tool surface beyond what already exists (Phase 3), worktree
management or the merge gate (Phase 4), concurrency or queueing (Phase 5).

`src/mcp/server.ts` currently holds Phase 0 scaffolding — a `hello` tool and a
timeout probe. **Leave it alone.** It is not yours to extend.

If Phase 1 turns out to be blocked on something, finish every unblocked part,
push it, and say plainly what is left and why. Do not quietly narrow the scope.

---

## 6. Environment notes

```bash
npm install -g opencode-ai      # installs cleanly; verified 1.18.23
npm install                     # project deps
bun run spike                   # confirm the baseline is green before you start
```

- A provider key is needed for real runs. `opencode/muse-spark-1.2-contributor-free`
  worked with no configured credentials and is a good default for tests.
- **Do not run `pkill -f 'opencode serve'`.** `pkill -f` matches full command
  lines, including your own shell's, so it kills the shell running it. Match on
  a PID you captured, or use a non-self-matching pattern.
- `NO_PROXY` must include `127.0.0.1,localhost` or `fetch()` will try to tunnel
  localhost through the outbound proxy. `spike.ts` already does this — copy the
  pattern.

---

## 7. A note on model routing

If you are orchestrating this across models: the `OpenCodeBackend` interface is
the highest-drift-risk boundary in the system and deserves the stronger
generalist. `ServeBackend` and `ocmock` are well-specified, parallelizable, and
test-verifiable — good candidates to delegate. `ocmock` in particular is the
single best parallel task in this phase and does not depend on the adapter being
finished, only on the interface being fixed.

---

## 8. Before you finish

Two Phase 0 items are still unresolved and adjacent to your work. You are not
required to close them, but if the opportunity arises, do — and record the
result in `docs/phase0-facts.md`:

1. **Concurrency.** Can one serve process handle 4+ simultaneous sessions without
   degradation? (`projectplan.md` §14 Q5.) Your integration test harness is the
   natural place to find out.
2. **`RunBackend` parity.** The flags exist (`--session`, `--format json`,
   `--agent`, `--model`, `--variant`, `--attach`, `--auto`) but nothing has been
   exercised.
