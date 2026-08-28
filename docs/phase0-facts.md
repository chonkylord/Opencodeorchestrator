# Phase 0 — OpenCode fact sheet

**OpenCode version:** `1.18.23` · **Verified:** 2026-08-28 · **Reproduce:** `bun run spike/spike.ts`

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
| OpenAPI spec | **verified** | Served at `GET /doc` (~479 KB, 162 paths). Treat it as the contract source and diff it on version bumps to catch drift. |

## 2. Sessions

| Fact | Status | Detail |
|---|---|---|
| Per-session working directory | **verified** | `directory` is a **query parameter**, not a body field: `POST /session?directory=<abs path>`. Confirmed against a real `git worktree`. **This is what lets DD-2 stand** — one server process, N worktrees. |
| Inline permission ruleset | **verified** | `POST /session` accepts `permission: [{permission, pattern, action}]` in the body and echoes it back. No `opencode.json` file injection is needed. |
| Usage / cost | **verified** | The `Session` object carries `cost: number` and `tokens: {input, output, reasoning, cache:{read,write}}`. Budget enforcement is a poll of `GET /session/{id}`. **Caveat:** `cost` is `0` on free-tier models; token counts are always populated, so budget on tokens and treat cost as advisory. |
| Diff summary | **verified** | `Session.summary` carries `{additions, deletions, files, diffs[]}`, and `GET /session/{id}/diff` exists. Cheaper than shelling out to git for the diff-stat line in the worker result. |
| Session reuse retains context | **verified** | A second `prompt_async` to the same session recalled the filename it had created in the first prompt, unprompted. **`worker_revise` and the blocked→resume path are both viable.** |
| Sub-sessions | **verified (exists)** | `parentID` on create, `GET /session/{id}/children`. Not exercised. |

## 3. Prompting

| Fact | Status | Detail |
|---|---|---|
| Async prompt | **verified** | `POST /session/{id}/prompt_async` returns **HTTP 204** in ~30 ms and runs the work in the background. DD-1's spawn-and-poll pattern is native, not a workaround. |
| Model selection | **verified** | Body takes `model: {providerID, modelID}` — split `"opencode/muse-spark-1.2-contributor-free"` on the **first** `/` only. |
| Per-prompt overrides | **verified (schema)** | `prompt_async` also accepts `agent`, `system`, `tools` (per-tool enable map), `variant` (reasoning effort), and `format`. |
| Structured output | **verified (schema)** | `format: {type: "json_schema", schema, retryCount}` — the model's reply can be schema-constrained **and retried on violation** by OpenCode itself. This is a materially better way to enforce the §4.2 report contract than asking for a file and hoping. |
| Abort | **verified (schema)** | `POST /session/{id}/abort` → boolean. |

## 4. Events (SSE)

| Fact | Status | Detail |
|---|---|---|
| **Streams are directory-scoped** | **verified** | `GET /event` delivers **nothing** for a session opened in another directory. You must subscribe to `GET /event?directory=<same abs path used at session create>`. Measured side by side: unscoped saw no `session.idle` in 90 s; scoped saw it at 10.9 s. **This is a silent hang, not an error** — it cost an hour here and would have cost more in Phase 1. |
| Completion signal | **verified** | `session.idle` — `{id: "evt_…", type: "session.idle", properties: {sessionID}}`. Observed 10.9–11.3 s after prompt on a trivial task. |
| Subscribe before prompting | **verified** | Work can finish in ~11 s; establish the stream first or risk missing the event entirely. |
| Event vocabulary | **verified** | 89 variants in the spec. Ones that matter: `session.idle`, `session.status` (`{type:"busy"}`), `session.error`, `session.diff`, `message.part.updated` (carries tool state `pending`/`running`/`completed`), `message.part.delta`, `permission.asked`/`replied`, `question.asked`/`replied`/`rejected`, `file.edited`, `worktree.ready`/`failed`. |
| Server liveness | **verified** | `server.heartbeat` arrives on the stream during long runs. The §5 idle watchdog should key off *worker* events, not stream silence — a heartbeat with no worker events means the worker is stuck; no heartbeat means the server is gone. Different failures, different responses. |
| Typed errors | **verified (schema)** | `session.error` carries a discriminated union: `ProviderAuthError`, `MessageOutputLengthError`, `MessageAbortedError`, `StructuredOutputError`, `ContextOverflowError`, `ContentFilterError`, `APIError`. Map these to worker terminal states directly rather than string-matching. |

## 5. Agents, config & permissions

| Fact | Status | Detail |
|---|---|---|
| **Custom agents are discovered at server start only** | **verified** | `.opencode/agent/worker.md` in a worktree is picked up by a CLI process whose cwd is that worktree, and by a server **started** in it — but `GET /agent?directory=<worktree>` on an already-running server returns only the built-ins. The `directory` param is accepted and ignored for agent discovery. **Per-worktree agent injection does not work under DD-2.** |
| Built-in agents | **verified** | `build`, `plan` (primary); `explore`, `general` (subagent); plus internal `compaction`, `summary`, `title`. |
| Headless permissions | **verified** | Two independent mechanisms, both work: CLI `--auto` ("auto-approve permissions that are not explicitly denied"), and the inline per-session `permission` ruleset. With a ruleset of `edit/bash: allow`, a full edit+bash run completed with **zero** pending permission requests (`GET /api/session/{id}/permission` → `{"data":[]}`). |
| Default agent ruleset | **verified** | `build` defaults to `{permission:"*", action:"allow"}` plus `doom_loop: ask` and `external_directory: ask` (with allow-listed exceptions). `external_directory: ask` is a useful jail signal for §8 — a worker reaching outside its worktree raises an ask rather than silently writing. |
| Escalation channel | **verified (schema)** | Native: `GET /api/session/{id}/question` + `…/reply` + `…/reject`, and the same shape for `permission`. The §5 "blocked" state maps onto these directly — no need to invent a protocol. |

## 6. Things OpenCode already does that the plan proposed to build

Worth reading before Phase 4:

- `POST /experimental/worktree` (+ `GET`, `DELETE`, `/reset`) and `/experimental/workspace` — native worktree/workspace management, with `worktree.ready` / `worktree.failed` events.
- `GET /session/{id}/diff` and `Session.summary{additions,deletions,files}` — diff and diff-stat.
- `POST /session/{id}/revert` / `revert/stage` / `revert/commit` / `unrevert` — snapshot and rollback primitives.
- `POST /session/{id}/summarize` and `/compact` — context compaction.
- `format: json_schema` on prompt — schema-enforced structured output with retries.

None of these are drop-in replacements for §6's gated merge, but building git plumbing from scratch without evaluating them first would be wasted work.

---

## Unresolved — carry into Phase 1

1. **Claude Code's MCP tool-call timeout.** The instrument is built (`orchestrator_timeout_probe`) and verified working over real JSON-RPC, but the measurement requires the server registered in a live Claude Code session. It cannot be taken from inside this container. *Run it before finalizing the `worker_wait` ≤30 s cap.*
2. **Concurrency.** One serve process with 4+ simultaneous sessions was never exercised. §14 Q5 stands.
3. **`AGENTS.md` pickup.** A file was placed in the worktree but the model was never asked to prove it read it. Verify with a marker string before relying on it to carry the task brief — and note that per-prompt `system` may be the better channel regardless.
4. **`cost` on paid providers.** Only free-tier models were exercised here (`cost: 0` throughout). Confirm `cost` populates on a paid provider before building dollar-denominated budgets.
5. **`RunBackend` parity.** `opencode run` exposes `--session`, `--format json`, `--agent`, `--model`, `--variant`, `--attach`, `--auto`. The flags exist; the fallback path was not built or exercised.
