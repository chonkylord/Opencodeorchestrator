# Phase 0 — OpenCode fact sheet

**OpenCode version:** `1.18.23`, re-verified green on `1.18.25` · **Verified:** 2026-08-28 · **Reproduce:** `bun run spike/spike.ts`

**Phase 1 additions.** Rows marked **verified (phase 1)** were established while building the
adapter (`src/opencode/`), either from the OpenAPI document or on the wire. Two Phase 0
rows were wrong or incomplete and have been corrected in place rather than appended to —
see `Corrected in Phase 1` in the detail column.

**Phase 3 additions.** §7 is new and holds one fact about the *host* rather than
about OpenCode: Claude Code's MCP tool-call timeout, measured at last, which
closes unresolved item 1 and is what DD-1's "every tool returns in under two
seconds" is calibrated against. Nothing in §1–§6 needed correcting this phase.

**Phase 2 additions.** Rows marked **verified (phase 2)** were established while building the
worker manager (`src/manager/`), on the wire against 1.18.25. **One earlier row was wrong**
and is corrected in place: structured output was marked "verified (schema)" and does not
work on the model this project defaults to. Two new rows record behaviour nothing had
looked for — a failed turn emits *two* terminal events, and a session silently drops a
prompt sent immediately after one. Both were found the expensive way, by a worker that
appeared to do nothing for two minutes.

Every row marked **verified** was observed on a live `opencode serve` process in this
repository, not read from documentation. Rows marked **unresolved** are still open —
they are listed in full at the bottom rather than quietly omitted.

---

## 1. Process & transport

| Fact | Status | Detail |
|---|---|---|
| Serve port | **verified** | `--port` defaults to `0` = "pick a free port". It happened to choose `4096` on every run here, but the adapter **must** parse `listening on http://HOST:PORT` from stdout. Hardcoding 4096 will work locally and fail under concurrency. |
| Startup time | **verified** | ~1.3 s to "listening". |
| First-prompt cold start | **verified** | The first prompt on a fresh server triggers a burst of ~45 `plugin.added` events plus `catalog.updated` before generation begins. Pre-warm the server; don't attribute this latency to the worker. |
| Auth | **verified** | Server warns `OPENCODE_SERVER_PASSWORD is not set; server is unsecured`. Set it (with `OPENCODE_SERVER_USERNAME`) before binding anything but loopback. |
| OpenAPI spec | **verified** | Served at `GET /doc` (~479 KB, 162 paths, 472 schemas). Treat it as the contract source and diff it on version bumps to catch drift. **Not exhaustive** — see the `server.heartbeat` row in §4. |
| **Several workers can share one checkout, and Dispatched Code's own files stay out of the way** | **verified (phase 8)** | Measured **2026-08-30**: two concurrent `implement` workers with `workspace: "shared"` in one golden repo, with an unrelated `NOTES.md` already dirty before either started. Both wrote their own file; both correctly reported the *other's* file as unattributed rather than claiming it; both listed `NOTES.md` as pre-existing; `HEAD` did not move and the user's file was untouched. The property that makes this survivable is that `.orchestrator/` is excluded from every diff and every dirty scan (`EXCLUDE_PATHSPECS` plus the `info/exclude` entry Phase 7 moved to server start), so Dispatched Code's own database sitting inside the repository is never attributed to a worker. |
| **A `SIGKILL`ed manager leaves its worker's work intact and recoverable** | **verified (phase 7)** | Measured **2026-08-29**, OpenCode **1.18.25**: Dispatched Code was killed with `kill -9` 20 s into a real worker's task, with `git status` in the worktree already showing uncommitted changes. The orphaned `opencode serve` child keeps running but the *session* is unreachable to the next manager, which spawns its own server — so recovery is a read of the worktree, not a re-attach. A second process over the same database recovered the row to `interrupted`, and `worker_recover(resume)` settled it `completed` with **205 insertions across two files** committed as a snapshot, `npm test` re-run green, and the branch mergeable. What is lost is the worker's own report (`reportSource: "none"`) — it lived in the dead process's memory. **The worktrees really are the durable state (DD-7), and this is the measurement that says so.** |
| Session-independent liveness probe | **verified (phase 1)** | `GET /global/health` → `{healthy: true, version}`; `GET /api/health` → `{healthy}`. Cheap, needs no session, and is the other half of telling "the server died" from "the worker wedged" (§4). The adapter exposes it as `OpenCodeBackend.health()`. |

## 2. Sessions

| Fact | Status | Detail |
|---|---|---|
| Per-session working directory | **verified** | `directory` is a **query parameter**, not a body field: `POST /session?directory=<abs path>`. Confirmed against a real `git worktree`. **This is what lets DD-2 stand** — one server process, N worktrees. |
| Inline permission ruleset | **verified** | `POST /session` accepts `permission: [{permission, pattern, action}]` in the body and echoes it back. No `opencode.json` file injection is needed. |
| Usage / cost | **verified** | The `Session` object carries `cost: number` and `tokens: {input, output, reasoning, cache:{read,write}}`. Budget enforcement is a poll of `GET /session/{id}`. **Caveat:** `cost` is `0` on free-tier models; token counts are always populated, so budget on tokens and treat cost as advisory. |
| Diff summary | **verified** | `Session.summary` carries `{additions, deletions, files, diffs[]}`, and `GET /session/{id}/diff` exists. Cheaper than shelling out to git for the diff-stat line in the worker result. |
| Session reuse retains context | **verified** · *re-confirmed in Phase 6* | A second `prompt_async` to the same session recalled the filename it had created in the first prompt, unprompted. **`worker_revise` and the blocked→resume path are both viable.** Phase 6 built the first of those on it and the assumption held: a revised worker is prompted on the same `sessionID` across every round (asserted directly — one `POST /session` and N prompts), and the spike still re-verifies the underlying fact on every run (`session_retains_context: yes`, 2026-08-29, OpenCode 1.18.25). |
| Sub-sessions | **verified (exists)** | `parentID` on create, `GET /session/{id}/children`. Not exercised. |

## 3. Prompting

| Fact | Status | Detail |
|---|---|---|
| Async prompt | **verified** | `POST /session/{id}/prompt_async` returns **HTTP 204** in ~30 ms and runs the work in the background. DD-1's spawn-and-poll pattern is native, not a workaround. |
| **The provider serves six models, not one** | **verified (phase 8)** · *corrects an assumption* | `GET /provider` lists **six** models under `opencode`: `muse-spark-1.2-contributor-free`, `nemotron-3.5-lightning-free`, `nemotron-3-ultra-free`, `ling-3.0-flash-fin-free`, `mimo-v2.5-free` and `big-pickle`. On **2026-08-30** all six completed a trivial turn on this key, in **1.0–5.8 s**. Phases 6 and 7 both state that every worker here runs the same model and ADR-0005 leans on it — that was true of the *configuration*, never of the provider, and nobody had looked. It is what makes §11 Phase 8's cross-model review real rather than theoretical. |
| **`nemotron-3-ultra-free` does not reliably finish a review turn** | **observed (phase 8)** | Measured **2026-08-30** on the same review task across four models: `muse-spark-1.2-contributor-free`, `ling-3.0-flash-fin-free` and `nemotron-3.5-lightning-free` each completed in **24–33 s** at ~12–14k tokens; `nemotron-3-ultra-free` ran **6.5 minutes and 39,004 tokens without a terminal event** and had to be aborted, and repeated the behaviour under a tight idle budget. **This closes the Phase 7 open item** that a read-only review worker "wedged once and nobody root-caused why": it is model-specific, not review-mode-specific — the same brief and the same worktree finish fine on three other models. Consequence for anyone setting `DISPATCHED_CODE_REVIEW_POOL`: this model is a poor pool member, and the general lesson is that a free model can generate indefinitely without terminating, which the wall-clock budget rather than the idle watchdog is what catches. |
| Model selection | **verified** | `prompt_async` body takes `model: {providerID, modelID}` — split `"opencode/muse-spark-1.2-contributor-free"` on the **first** `/` only (model ids contain slashes; `openrouter/meta-llama/llama-3` is provider `openrouter`). |
| **`POST /session` and `prompt_async` disagree on the model shape** | **verified (phase 1)** | Create wants `model: {providerID, id, variant?}`. `prompt_async` wants `model: {providerID, modelID}`. Same concept, two field names. Sending the prompt shape to create is **accepted and silently ignored** — the session keeps the default model and nothing warns you. `ServeBackend` translates per endpoint; anything else talking to `/session` must too. |
| Per-prompt overrides | **verified (schema)** | `prompt_async` also accepts `agent`, `system`, `tools` (per-tool enable map), `variant` (reasoning effort), and `format`. |
| **Structured output is not universally available** | **verified (phase 2)** · *corrected* | `format: {type: "json_schema", schema, retryCount}` exists and is accepted by the API, but it is **implemented as a forced tool call**, and a provider that only supports `tool_choice: "auto"` rejects the entire request: `[invalid_request_error] only "auto" is supported for tool_choice`. **`opencode/muse-spark-1.2-contributor-free` — the model this fact sheet recommends for tests — is one of them.** The Phase 0/1 row called this "verified (schema)", which meant *read from the OpenAPI document*; sending it fails. Treat schema enforcement as an optimization to attempt and abandon, never as the report contract itself (ADR-0002). The manager latches it off per backend after the first rejection. |
| Abort | **verified (schema)** | `POST /session/{id}/abort` → boolean. |

## 4. Events (SSE)

| Fact | Status | Detail |
|---|---|---|
| **Streams are directory-scoped** | **verified** | `GET /event` delivers **nothing** for a session opened in another directory. You must subscribe to `GET /event?directory=<same abs path used at session create>`. Measured side by side: unscoped saw no `session.idle` in 90 s; scoped saw it at 10.9 s. **This is a silent hang, not an error** — it cost an hour here and would have cost more in Phase 1. |
| Completion signal | **verified** | `session.idle` — `{id: "evt_…", type: "session.idle", properties: {sessionID}}`. Observed 10.9–11.3 s after prompt on a trivial task. |
| Subscribe before prompting | **verified** | Work can finish in ~11 s; establish the stream first or risk missing the event entirely. |
| Event vocabulary | **verified** | The spec's `Event` union has 89 members. Ones that matter: `session.idle`, `session.status` (`{type: "idle" \| "busy" \| "retry"}`), `session.error`, `session.diff`, `message.part.updated` (carries tool state `pending`/`running`/`completed`/`error`), `message.part.delta`, `permission.asked`/`replied` (plus `permission.v2.*`), `question.asked`/`replied`/`rejected` (plus `question.v2.*`), `file.edited`, `worktree.ready`/`failed`. Note `*.asked` keys the request id as `id` while the matching `*.replied` keys it as `requestID`. |
| Server liveness | **verified** · *corrected in Phase 1* | `server.heartbeat` arrives **every 10.0 s, on every subscription, whether or not anything is running** — measured over 75 s on an idle server, not merely "during long runs". It is **not in the spec's `Event` union**: the 89 documented members do not include it, so the spec is not an exhaustive list of what arrives on the wire and an adapter must tolerate unlisted types rather than reject them. The §5 idle watchdog keys off *worker* events, not stream silence: heartbeats with no worker events = the worker is stuck; no heartbeats = the server is gone. Different failures, different responses. |
| First frame is `server.connected` | **verified (phase 1)** | Every subscription opens with `{type: "server.connected", properties: {}}` before anything else. A usable "the stream is live" signal, distinct from the HTTP headers arriving. |
| Two envelope shapes in the spec | **verified (phase 1)** | The live `/event` stream puts the payload under `properties`. The spec *also* defines `data`-keyed variants of the same event types (the durable event log, with `durable`/`metadata`/`location` siblings). Only `properties` has been seen on `/event`; reading both costs nothing and removes a silent-hang class from a future version bump. |
| **A failed turn emits `session.idle` twice** | **verified (phase 2)** | An API error produces `session.error`, then `session.idle`, then — after a trailing `message.updated` — **a second `session.idle`**, measured ~30ms later. `session.idle` carries only `sessionID`: it is scoped to the *session*, not to the prompt, so nothing in the event distinguishes "your turn ended" from "some earlier turn ended". A run loop that re-prompts on the first terminal reads the second as its new turn finishing instantly, with an empty reply, and reports a worker that did nothing. **Use `session.status {type: "busy"}` as the signal that the turn you prompted actually started**, and ignore terminal events that arrive before it. |
| **A prompt sent immediately after a terminal event is silently dropped** | **verified (phase 2)** | `prompt_async` answers **204** and then nothing happens: no busy status, no work, no error, no event of any kind. Measured directly — a prompt sent 26ms after `session.idle` produced nothing in the following 57 seconds, while the same prompt on the same session later ran normally. This bites both paths that re-prompt an existing session: the §5 blocked→resume path and any retry. **Let the session settle (the manager waits 2s) before prompting it again.** *Phase 6 note:* a **revision** prompts a session that has just gone terminal, which makes it the single most exposed path in the system — more than the blocked→resume path, which waits on a human. The guard is `lastTerminalAt`, and the mistake to avoid is clearing it while resetting the other per-turn fields at the start of a round: the manager keeps it deliberately and `test/manager/revise.test.ts` pins that with a mock that drops prompts inside the window. |
| Typed errors | **verified (schema)** · *corrected in Phase 1* | `session.error` carries a discriminated union of **eight** members — the Phase 0 list omitted `UnknownError`: `ProviderAuthError`, `MessageOutputLengthError`, `MessageAbortedError`, `StructuredOutputError`, `ContextOverflowError`, `ContentFilterError`, `APIError`, `UnknownError`. Dispatch on `name`, never on message text. `APIError.data.isRetryable` is authoritative for retry decisions. Aborting a session produces `MessageAbortedError` **followed by** `session.idle` — both arrive, in that order. |

## 5. Agents, config & permissions

| Fact | Status | Detail |
|---|---|---|
| **Custom agents are discovered at server start only** | **verified** | `.opencode/agent/worker.md` in a worktree is picked up by a CLI process whose cwd is that worktree, and by a server **started** in it — but `GET /agent?directory=<worktree>` on an already-running server returns only the built-ins. The `directory` param is accepted and ignored for agent discovery. **Per-worktree agent injection does not work under DD-2.** |
| Built-in agents | **verified** | `build`, `plan` (primary); `explore`, `general` (subagent); plus internal `compaction`, `summary`, `title`. |
| Headless permissions | **verified** | Two independent mechanisms, both work: CLI `--auto` ("auto-approve permissions that are not explicitly denied"), and the inline per-session `permission` ruleset. With a ruleset of `edit/bash: allow`, a full edit+bash run completed with **zero** pending permission requests (`GET /api/session/{id}/permission` → `{"data":[]}`). |
| Default agent ruleset | **verified** | `build` defaults to `{permission:"*", action:"allow"}` plus `doom_loop: ask` and `external_directory: ask` (with allow-listed exceptions). `external_directory: ask` is a useful jail signal for §8 — a worker reaching outside its worktree raises an ask rather than silently writing. |
| **`edit`+`bash` alone is not enough for a long headless run** | **verified (phase 2)** | An `implement` worker with only the `HEADLESS_PERMISSIONS` ruleset was observed raising a permission ask mid-run on a real task. The defaults above are why: `doom_loop: ask` is an *interactive* anti-loop guard, and an unattended worker cannot answer it — left at `ask` it does not stop a runaway, it stops the run. The manager allows `doom_loop` for `implement` workers (its own idle, wall-clock and token budgets already bound loops) and deliberately leaves `external_directory` at `ask`, because that one is meant to reach Claude. |
| **`AGENTS.md` in the session directory is auto-loaded** | **verified (phase 2)** · *resolves unresolved #3* | Settled with a marker string. A file containing `AGENTS_MARKER_JHQ6ILKP` was written to a worktree; a worker in that worktree, instructed **not to read, open, list or search any file** and to answer only from the context it was already given, returned the marker verbatim in 11.7s — against 21s for the same probe when it was told to read the file, which is the round trip a tool call costs. So a file-based brief channel does work. Phase 2 uses the per-prompt `system` field anyway, for reasons that are about the diff and about mutability rather than about pickup — see ADR-0002. *Caveat: instruction-following is not proof; a model that ignored the prohibition would produce the same answer. The timing is the corroborating evidence, not the assertion.* |
| Escalation channel | **verified (phase 7)** · *corrected* | Native, and the endpoint is **not the one this row used to name.** Three shapes exist in the OpenAPI document; measured on the wire on **2026-08-29** against OpenCode **1.18.25**, with a session created `edit: ask` / `bash: deny` and a worker told to write a file: a request raised as `permission.asked` (id `per_…`) is **not found** by the documented v2 endpoint — `POST /api/session/{id}/permission/{requestID}/reply` answers **404 `PermissionNotFoundError`** — and is answered by the v1 session-scoped one, `POST /session/{id}/permissions/{permissionID}` with `{response: "once" \| "always" \| "reject"}`, which returns **200 `true`**, emits `permission.replied`, and **lets the tool call proceed**: the file was written and the turn finished normally. So the two live in different registries and the schema-only reading picked the wrong one. Questions are a separate shape — `POST …/question/{requestID}/reply` takes `{answers: string[][]}`, a selection from the labels the worker offered, not free text. The adapter exposes the permission half as `OpenCodeBackend.respond()`; the probe is `test/e2e/serve.e2e.test.ts` behind `OC_E2E=1 OC_E2E_PERMISSION=1`. |
| **`external_directory` really does fire in a live concurrent run, and it is not deterministic** | **observed (phase 5)** | Measured **2026-08-29**, OpenCode **1.18.25**, free Muse Spark, three concurrent `implement` workers in three worktrees under `<repo>/.orchestrator/worktrees/`. On one of two otherwise-identical runs, **two of the three** workers escalated `the worker needs permission "external_directory" for <repo>/.orchestrator/*` — the directory their own worktrees live in — and blocked; on the second run, with the same four tasks on a fresh copy of the same fixture, **none** did and all four completed on the first pass. So the jail signal works as the row above intends and the escalation path handles it, but *which* tool call reaches outside is model behaviour and varies run to run. Two consequences: an unattended wave can block on a permission nobody is there to grant, and a run that blocks is not evidence of a bug in the run that did not. Not investigated further in Phase 5 — the root cause is which OpenCode tool resolves a path upward, and answering it means instrumenting the adapter's raw permission events. |
| **The session ruleset wins, and in `full` mode nothing ever asks** | **verified (phase 10)** | Measured **2026-08-31**, OpenCode **1.18.25**, free Muse Spark, one `implement` worker in an isolated worktree, the *same* task in both modes: "create the file `/tmp/smoke-probe-*.txt` containing HELLO". In **`jailed`** the worker raised `the worker needs permission "external_directory" for /tmp/*`, blocked at 18 s having spent ~0 tokens, and wrote nothing. In **`full`** it completed in 20 s on 10,606 tokens, **the file was written outside the worktree**, and the trail carried no permission event of any kind — not an ask, not an auto-grant. Two consequences. First, ADR-0011's trade is real and now demonstrated rather than argued: the wall is gone, and the diff is what records the reach. Second, and this is the one worth carrying forward: **`grantInBand()` does not execute on this version.** It exists for a request that arrives despite the ruleset, and 1.18.25 consults the ruleset, finds `external_directory` and `*` allowed, and raises nothing. The path is exercised in `test/manager/phase10.test.ts` — where `ocmock` raises a request without consulting anything — and is otherwise dead code against this provider. Keep it: it is the fallback for the version that behaves differently, and its cost is one branch. A third measurement in passing: a project-level `opencode.json` setting `permission: {bash: "ask"}` **did not** override the session's inline ruleset — the worker ran bash freely and never asked — so the per-session grant is authoritative rather than advisory. |

## 6. Things OpenCode already does that the plan proposed to build

Worth reading before Phase 4:

- ~~`POST /experimental/worktree` (+ `GET`, `DELETE`, `/reset`)~~ — **evaluated on the wire in Phase 4 and declined.** They work; they are the wrong tool. Measured against 1.18.25 in a scratch repository: creation names its own branch (`opencode/<name>` — a requested `branch` is silently overridden), takes **no base ref** so the worktree branches from whatever HEAD is at the moment of the call, places worktrees under `~/.local/share/opencode/worktree/<sha>/<name>` rather than in the repository, and `DELETE` removes the branch along with the worktree with no merged check and no way to withhold it. The missing base ref is the disqualifying one: every worker in a run branching from **one resolved sha** is what makes §6.2's overlap test valid, and losing it produces a wrong answer rather than an error. Local `git worktree` keeps all four properties and is backend-independent. See [ADR-0003](adr/0003-integration-worktree.md). `/experimental/workspace` was not exercised and is not needed.
- `GET /session/{id}/diff` and `Session.summary{additions,deletions,files}` — diff and diff-stat.
- `POST /session/{id}/revert` / `revert/stage` / `revert/commit` / `unrevert` — snapshot and rollback primitives.
- `POST /session/{id}/summarize` and `/compact` — context compaction.
- `format: json_schema` on prompt — schema-enforced structured output with retries.

None of these are drop-in replacements for §6's gated merge, but building git plumbing from scratch without evaluating them first would be wasted work. **Phase 4 evaluated the worktree row and closed it** (above). The diff and revert rows stay open on purpose, for the reason [ADR-0002](adr/0002-worker-contract-channel.md) gives: the diff is the evidence a worker's claims are checked against, and asking the worker's own server for it makes the witness and the accused the same process.

## 7. The host (not OpenCode)

Two facts here, and they are what DD-1 is calibrated against. They are about
*Claude Code*, not about OpenCode, which is why they sit in their own section: an
OpenCode version bump does not invalidate them, and a host upgrade does.

They are the same host, the same version, three days apart, and they disagree by
a factor of ten — because the second call emits progress and the first does not.

| Fact | Status | Detail |
|---|---|---|
| **Claude Code's MCP tool-call timeout is 60 s** | **verified (phase 3)** · *resolves unresolved #1* | Measured on **Claude Code 2.1.251**, on **2026-08-28**, with Dispatched Code registered as a real MCP server (`--mcp-config`, `--strict-mcp-config`) in a headless `claude -p` session, using the timeout probe — the instrument Phase 0 built for exactly this and could not run, named `orchestrator_timeout_probe` at the time and `dispatched_code_timeout_probe` since. `delayMs` of 30,000, 45,000 and 55,000 all returned normally (the last as `{"requestedMs":55000,"actualMs":55002,"returned":true}`); 60,000 failed, and the host named its own limit in the error, quoted as it came: `MCP server "orchestrator" tool "orchestrator_timeout_probe" timed out after 60s`. So it is a hard 60 s deadline on the call, not a shorter budget that happens to round to one. The failure is per tool call — the session continues and the server stays connected — but the call's result is lost, which for a long `worker_wait` means a worker still running with nobody watching. **`worker_wait`'s cap therefore stays at §7's 30,000 ms, now as a measured half of the ceiling rather than a guess.** The remaining 30 s absorbs the tool's own work, the transport, and any host that lowers the limit. |
| **With `notifications/progress`, the same host waits at least 600 s** | **verified (phase 10)** · *closes §11 Phase 9's one unmeasured item* | Measured **2026-08-31**, on the **same Claude Code 2.1.251** as the row above, with Dispatched Code registered as a real MCP server in a live session. The control first: `{delayMs: 55000}` with no progress returned `{"actualMs":55001,"progressSent":0}`, reproducing the 60 s row exactly. Then `{delayMs: 240000, progressEveryMs: 10000}` — **four times the plain ceiling** — returned normally, `{"actualMs":240003,"progressSent":23}`. Then `{delayMs: 600000, progressEveryMs: 10000}`, the largest delay the probe accepts, also returned normally: `{"actualMs":600002,"progressSent":59}`. **So this host does reset its tool-call timeout on progress, and the MCP spec's "may" is a "does" here.** What is *not* known is the ceiling: 600 s is the instrument's limit, not the host's, so this is a measured **floor** and the honest way to write it is `≥600 s`. Since `worker_wait` heartbeats every 10 s unconditionally (§11 Phase 9), this is the ceiling that actually applies to it. **The compiled default stays at 30,000 ms anyway**, and that is deliberate: a host that does *not* reset on progress is still possible, the default has to be safe on one, and the failure mode is asymmetric — too small costs an extra tool call, too large loses the call's result and leaves a worker running with nobody watching it. On this host, set `DISPATCHED_CODE_WAIT_MAX_MS=300000` — half of the verified floor — and a six-minute wave costs two `worker_wait` calls instead of eight. |

---

## Unresolved — carry into Phase 1

1. ~~**Claude Code's MCP tool-call timeout.**~~ **Resolved in Phase 3 — 60 s.** The measurement always needed a live Claude Code session with the server registered, and Phase 3 was the first phase to have one. See the row in §7 for the number, the host version, the date and the method. `worker_wait`'s cap stays at 30,000 ms, now because it is half a measured ceiling rather than because §7 guessed it.
2. ~~**Concurrency.** One serve process with 4+ simultaneous sessions was never exercised.~~
   **Resolved in Phase 1 — yes, at 4.** `test/e2e/serve.e2e.test.ts` (`OC_E2E=1
   OC_E2E_CONCURRENCY=1`) runs four sessions in four git worktrees on one server
   simultaneously. All four completed, all four wrote the file they were asked for,
   and **no stream carried another session's events** — the per-directory
   subscriptions really do isolate. Wall clock per worker: 15.3 s, 15.9 s, 20.3 s,
   20.4 s, against a single-session baseline of 10.9–11.3 s on the same model and
   the same trivial task. So ~1.4–1.9× latency for 4× the work: sublinear, no
   failures, no interference. **Caveat: one run, four sessions, one free-tier
   model.** It does not speak to 8+, to paid providers under rate limits, or to
   long-running workers; re-measure before raising the §5 concurrency cap past 4.

   **Re-measured in Phase 5, twice, on 2026-08-29 against OpenCode 1.18.25.**
   (a) The Phase 1 probe again: four concurrent worktree sessions, all four
   completed in **11.4 / 13.0 / 13.9 / 15.3 s**, and **no stream carried another
   session's events** — the assertion is `sessionID !== this session` over every
   frame received, and it found zero. That is the property all of concurrency
   rests on, and it is now measured on two separate days against two OpenCode
   builds rather than assumed.
   (b) The first end-to-end measurement *through Dispatched Code*: three
   concurrent `implement` workers plus a queued dependent, driven by a live
   Claude Code 2.1.251 session over MCP, on the free
   `opencode/muse-spark-1.2-contributor-free`. All four completed; per-worker
   wall clock 23.8 / 30.1 / 33.5 / 48.7 s at ~6.2k–17.0k tokens each;
   **no rate limiting, no refused prompt, no cross-talk.** So the §11 Phase 5
   default of 3 is comfortable on the free tier. **Still unmeasured:** more than
   four, paid providers under rate limits, and workers running for minutes rather
   than seconds. The cap stays at 3 and `DISPATCHED_CODE_MAX_CONCURRENT` moves it.

   **Phase 6's v1 demo closed one of those three** (2026-08-29, same build, same
   free model): **workers running for minutes rather than seconds.** Across five
   workers and four revision rounds, one worker's revision round ran **212 s** to
   a clean completion — an order of magnitude past Phase 5's 23.8–48.7 s — with
   the record touched throughout, no rate limiting and no refused prompt. So the
   watchdogs and the token polling hold over a multi-minute turn rather than only
   over a fast one. **Still unmeasured:** more than four concurrent, and paid
   providers under rate limits. One new caution: a *read-only* worker handed a
   diff wedged once and hit the idle watchdog at ~14k tokens, and a revision
   recovered it; whether that is a review-mode-specific stall is not root-caused,
   and Phase 7's hardening is the natural home.
3. ~~**`AGENTS.md` pickup.**~~ **Resolved in Phase 2 — yes, it is picked up.** See the row in §5; the probe lives in `test/e2e/manager.e2e.test.ts` behind `OC_E2E=1 OC_E2E_AGENTS=1`. Phase 2 still carries the brief in the per-prompt `system` field, by choice rather than by necessity (ADR-0002).
4. **`cost` on paid providers.** Still open. Phase 2's budget enforcement was the natural place to settle it and could not: this environment has no paid provider, so every run was free-tier and `cost` was `0` throughout, exactly as before. The manager therefore budgets on `totalTokens` and reports `cost` advisorily (`WorkerResult.usage`), and the §4.3 result line prints tokens whenever cost is `0`. Confirm `cost` populates on a paid provider before building dollar-denominated budgets.
5. ~~**Replying to a permission or question request in band.**~~ **Resolved for permissions in Phase 7 — and the shape this row named was wrong.** `OpenCodeBackend.respond()` answers a permission request on `POST /session/{id}/permissions/{permissionID}`, verified on the wire (see the §5 row for the measurement and for the 404 the documented v2 endpoint returns instead). The manager no longer aborts the turn for a permission ask: the worker waits at its tool call, Claude answers with `worker_message` (`decision: "allow" \| "deny"`), and the turn carries straight on — no partial turn, no re-prompt. **Questions still escalate the old way**, deliberately: their reply is a selection from labels the worker offered rather than free text, so forcing Claude's prose into one would answer something nobody asked. That half stays open, and is the smaller half — the demo's three asks were all permissions.

   *The original entry, for the record:* The adapter surfaces `permission.asked` / `question.asked` as normalized events but exposes no way to answer them — Phase 1 did not build one and the endpoint shapes (`…/reply`, `…/reject`) are schema-verified only. Phase 2 works around it: a mid-run ask is converted into an escalation by aborting the turn and delivering Claude's answer as the next prompt to the same session, which keeps its context. Nothing hangs, but a partial turn is lost each time. Add `respond()` to the adapter when the shapes are verified on the wire.

   **Still open after Phase 6, and now measured rather than reasoned about.** Phase 6 did not touch the adapter, so the workaround stands. What the v1 demo added is the price: on one live run (2026-08-29, OpenCode 1.18.25, free Muse Spark, four workers), **`external_directory` fired three times on two different paths** — twice for `<repo>/.orchestrator/*` and once for `/tmp/*` — and each one cost a partial turn plus a `worker_message` round trip. One worker (`w-003`) escalated twice and needed two answers and two revisions before it settled; it ended on 47,531 tokens against 7,715 and 12,481 for the two workers that never escalated. So the cost of the missing in-band reply is roughly **a partial turn per ask, and asks are not rare** — the §5 row's "not deterministic" holds, but "uncommon" would not. This is the strongest argument yet for `respond()`, and it is Phase 7's to make.
6. **`RunBackend` parity.** `opencode run` exposes `--session`, `--format json`, `--agent`, `--model`, `--variant`, `--attach`, `--auto`. The flags exist; the fallback path was not built or exercised.
