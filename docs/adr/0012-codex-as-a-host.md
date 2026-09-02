# ADR-0012 — Codex CLI as an MCP host

- **Status:** Accepted
- **Date:** 2026-09-02
- **Phase:** 11 (a second host)
- **Evidence:** every number below was measured against `codex-cli 0.152.1` on
  Linux, with Dispatched Code registered as a real stdio MCP server. Method and
  caveats in [Method](#method).
- **Amends:** the startup order in `src/mcp/server.ts`'s header (note 1)

## Context

Everything this project had measured about a *host* was measured about Claude
Code: the 60 s tool-call ceiling in `docs/phase0-facts.md` §7, the ≥600 s ceiling
that the same host allows once a call emits `notifications/progress`, and
`worker_wait`'s 30,000 ms cap, which is half the first of those. Codex is a
second host with its own answers to all three, and nothing had asked it.

Codex is the **client** here. Workers stay OpenCode; a Codex worker backend is
explicitly out of scope, and DD-2 is untouched — nothing outside
`src/opencode/` learned anything new.

## Decision

Support Codex as a first-class host, and make one behavioural change to do it:
**warm the OpenCode backend without waiting for it before serving the
protocol.** Everything else Codex needs is documentation and one startup
diagnostic.

## What was measured

### 1. The launch directory is right, and the environment is not

Codex launches a stdio MCP server with **`cwd` set to the directory `codex`
itself was invoked from** — not the config directory, not `$HOME`. Verified
twice: with a recording stub, and with the real server, which logged
`backend ready (repo /home/user/dispatched-code)` after being started from that
repository. So the zero-configuration launch orchestrates the tree the user is
actually in, which is what `loadConfig`'s `resolve(read(env, "REPO") ?? cwd)`
needs and gets. `config.toml`'s `cwd` key overrides it if anybody wants that.

The environment is the opposite story, and it is the finding most likely to cost
somebody an afternoon. **Codex passes a stdio MCP server a fixed core
environment and nothing else.** Measured by exporting variables into the shell
that launched `codex` and reading `process.env` inside the server: what arrives
is `HOME`, `LANG`, `LOGNAME`, `PATH`, `SHELL`, `TERM`, `TMPDIR`, `USER`, a set
of well-known CA-bundle variables (`CURL_CA_BUNDLE`, `NODE_EXTRA_CA_CERTS`,
`SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`, `GIT_SSL_CAINFO`, `PIP_CERT`,
`CARGO_HTTP_CAINFO`), and **exactly** what `[mcp_servers.<name>.env]` declares.

`DISPATCHED_CODE_REPO`, `DISPATCHED_CODE_MODEL`, `ORCHESTRATOR_REPO`,
`HTTPS_PROXY` and an invented `FOO_AMBIENT` all failed to arrive.
`shell_environment_policy.inherit = "all"` — the obvious lever — **does not
change it**: still the same core set. So the filter is not the shell policy, and
there is no configuration that widens it.

The consequence is sharp, because this project's entire configuration surface is
environment variables: **under Codex, a `DISPATCHED_CODE_*` variable exported in
your shell does nothing at all, silently.** Every setting has to be written into
`config.toml`. `PATH` surviving is what makes the default launch work at all —
`bun` and `opencode` are both found through it — and `HOME` surviving is what
lets OpenCode find the credentials `opencode auth login` wrote.

### 2. Codex does not advertise `roots`, and answers `roots/list` anyway

Codex's `initialize` carries `protocolVersion: "2025-06-18"`,
`clientInfo: {name: "codex-mcp-client", title: "Codex", version: "0.152.1"}`, and
`capabilities: {elicitation: {form: {}, url: {}}}`. **No `roots` capability.**

But a server that sends `roots/list` regardless gets `{"roots": []}` — a
successful, empty answer rather than a method-not-found error. That distinction
matters for any code that asks the host where it is: the honest reading of an
empty list from Codex is "this host does not do roots", **not** "this host has no
directory open", and code that treats the second as a disagreement with
`repoRoot` would warn on every Codex session. This checkout has no `roots/list`
call to fix — the `askTheHostWhereItIs` the task description refers to lives in
work that is not in this branch — so this is recorded as the constraint any such
code has to satisfy rather than as a change.

### 3. The startup race — the finding that needed a code change

**Codex does not wait for a slow MCP server before building the model's tool
list.** A server that is still starting when the first turn is composed is
simply absent, with no error, no warning, and no entry anywhere the user would
look. The symptom is the worst kind available: *the model never calls a tool it
was never told about.*

Measured by registering several stub servers that delay their `initialize`
reply by a fixed amount, and reading the tool list out of the model request:

| `initialize` delay | In the model's tool list? |
|---|---|
| 250 ms | yes |
| 500 ms | yes |
| 1000 ms | yes |
| 1500 ms | **no** (3 consecutive runs, single server) |
| 2000 / 4000 / 8000 ms | **no** |

`startup_timeout_sec = 60` on that server does not change the answer — that key
governs how long Codex will wait before giving up on the server *entirely*, and
is a different number from this one. A server that misses the window is absent
for the **whole thread**, not just the first turn: a second model request in the
same run carried the same list.

The boundary is not a constant. With eight stub servers registered, even 1100 ms
missed. So the honest description is **a race against Codex's own turn setup, on
the order of one second**, and not a configurable deadline. Which also means it
cannot be tuned around — it can only be won.

**Dispatched Code was losing it.** The server awaited `backend.start()` — a
`opencode serve` spawn, ~1.3 s to "listening" per `phase0-facts.md` §1 — before
connecting the transport, and answered `initialize` at **~2.0 s**. It did not
appear in the model's tool list. Under Codex, out of the box, this MCP server
did not exist.

### 4. Tool exposure: one namespace per server, and every schema accepted

Codex groups each MCP server into a single `namespace` tool named
`mcp__<server>`, with the server name normalized — `dispatched-code` becomes
`mcp__dispatched_code`. The individual tools live inside it, and the model
invokes one by emitting a `function_call` carrying a `namespace` field beside
the plain tool name. (Every flattened spelling — `mcp__server__tool`,
`server__tool`, dotted, slashed — is rejected with `unsupported call`. The
feature flag `non_prefixed_mcp_tool_names` exists and is marked "under
development", so this shape is not settled.)

Nothing in this tool surface troubles it. All **17** tools were served and
accepted in one `tools/list` of **36,535 bytes**: descriptions up to 3,256
characters, `budget`'s nested optional object, arrays of strings, enums. No
rejection, no truncation, no complaint. `annotations` are carried across intact.
Codex sends `_meta.progressToken` on `tools/list` and on tool calls, so the
progress path in `startHeartbeat` is live rather than a no-op — which turns out
not to help, for the reason in §5.

### 5. The ceiling is 300 s, flat, and progress does not move it

**Codex gives up on an MCP tool call at 300 seconds**, and names its own limit
the way Claude Code does: `timed out awaiting tools/call after 300s`. A
`{delayMs: 600000}` probe failed at 300,058 ms.

The same probe **with** `progressEveryMs: 10000` failed at 300,053 ms.

That is the important half. Claude Code resets its tool-call timeout on
progress — that is what `docs/phase0-facts.md` §7's second row measured, and it
is why a heartbeat is worth sending. **Codex accepts the progress frames and
does not reset anything.** A 60 s call with `progressEveryMs: 5000` returned
normally reporting `progressSent: 11`, so the frames are delivered and
tolerated; they simply buy no time. The two hosts differ by a factor of ten in
one direction and are identical in the other, and a reader who assumes progress
behaves the same everywhere would set a cap that loses results.

There is no knob. The MCP-server config struct in the shipped binary carries
`command`, `env`, `cwd`, `url`, `http_headers`, `bearer_token`,
`startup_timeout_sec`, `startup_timeout_ms`, `supports_parallel_tool_calls`,
`omit_tools_from`, `scopes` and the OAuth fields — and **no per-call timeout**.
300 s is what you get.

So on Codex the right cap is **`DISPATCHED_CODE_WAIT_MAX_MS=150000`**: half of a
measured ceiling, by the same rule that makes the compiled default 30,000.

### 6. stdout stayed clean

The whole session was run through a proxy that logged both directions of the
pipe. Every frame on stdout was JSON-RPC; every diagnostic went to stderr,
including OpenCode's own `opencode server listening on http://127.0.0.1:4096`,
which reaches stderr through the adapter's `onServerLog` and never touches the
protocol channel. Codex surfaces that stderr in its own logs. The handshake was
unaffected by any of it.

## What changed

**`src/mcp/server.ts` starts the backend without awaiting it.** The warm-up
still begins at launch — it now runs alongside recovery and the handshake rather
than in front of them — so decision 1's original point (pay the ~45-event cold
start once, not on whichever worker is first) is preserved. Every entry point on
`ServeBackend` already awaits the same memoized `start()`, so nothing can use a
backend that has not come up, and a backend that never comes up now fails at the
first spawn with its own error instead of being invisible.

Measured: `initialize` answered at **0.185 s** instead of ~2.0 s, with the
backend spawned in-process and no `DISPATCHED_CODE_BASE_URL`. `mcp__dispatched_code`
appears in the model's tool list, and a real `dispatched_code_timeout_probe`
call through Codex returns normally.

The cost accepted: a spawn issued in the first second of a process's life now
waits for the backend where before the process would not have been answering
yet. That is the same wait, moved to where it is visible.

**One startup diagnostic.** `hostAdvice()` reads `clientInfo` at `initialize`
and, if the host is Codex *and* the cap is still the compiled default, prints
one line naming the 300 s ceiling, the `150000` setting, and the fact that it has
to go in `config.toml` rather than a shell profile.

## Why a diagnostic and not a per-host default

The obvious thing — detect Codex and quietly use 150,000 — cannot be done, and
the reason is an ordering constraint rather than caution. `worker_wait`'s cap is
baked into its own description *and* into the `max` on its `timeoutMs` schema,
both fixed when the tools are registered; registration must happen before
`connect()`; and `initialize` — the first moment the host names itself — arrives
after that. Deferring registration until after the handshake would fix the
ordering and lose something much worse: §3 is exactly the measurement that says a
server which is slow to register can lose the entire turn. Trading a correct
default for a chance of not existing is not a trade worth making.

So the host is detected, and what it buys is one accurate line instead of a
wrong default.

## Method

Codex was driven with **no OpenAI credentials**. The MCP handshake, the launch
environment, the tool list and the startup race all happen before any model
turn and were measured directly. To exercise actual tool *calls* — which is
what §5's ceiling needed — Codex was pointed at a local OpenAI-compatible
server over `wire_api = "responses"` (`model_providers.fake.base_url`), which
returns a scripted `function_call` and holds its own HTTP response open
indefinitely so that the host is always the thing that gives up first.

That is a real Codex tool-call path — Codex's own MCP client, its own timeout,
its own router — with a scripted model in place of a real one. What it does
**not** exercise is a real model's choice of tool name, which is why §4's
namespace shape is recorded as "how Codex dispatches" rather than "how the model
will spell it".

Two proxies were used and both are in the scratch directory rather than the
repository: a stdio tee that relays the real server's pipes verbatim while
logging both directions, and a recording stub that answers the minimum protocol
and dumps everything the host tells it.

## Unresolved

1. **Codex 0.147.0 is unmeasured.** Everything here is `0.152.1`. The task this
   came from names 0.147.0 as the installed version; the two are close but the
   `namespace` tool shape in §4 sits behind feature flags that are explicitly
   "under development", so it is the row most likely to differ.
2. **The startup-race boundary is machine-dependent.** ~1 s here, and it moves
   with the number of registered servers and presumably with process-spawn cost.
   Dispatched Code now answers in 0.185 s, which is an order of magnitude inside
   it, but "how much margin is enough" is not a number anybody has.
3. **A real authenticated session was never run.** The account available for
   this work is rate-limited until 2026-09-25, so §5's ceiling was measured
   through the fake provider described above rather than against a live model.
   The ceiling is the host's and the fake provider cannot influence it, but a
   real session is the confirmation that has not been done.
4. **`roots/list` is untested against a real consumer**, because this branch has
   no code that calls it. The measurement stands (`{"roots": []}`, no
   capability); what has not been proven is that a caller degrades correctly.

## When to revisit

- A Codex release that changes the `namespace` tool shape, or flips
  `non_prefixed_mcp_tool_names` on.
- Any measurement of the 300 s ceiling that disagrees, especially on a Codex
  version that resets it on progress — that would make the heartbeat worth as
  much here as it is on Claude Code, and would move the recommended cap.
- A host whose startup race is tighter than Codex's. 0.185 s is comfortable
  against ~1 s and would not be against ~100 ms.
