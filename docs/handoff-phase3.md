# Handoff: implement Phase 3 — the MCP server

You are picking up **Dispatched Code** at
`chonkylord/Opencodeorchestrator`. Phases 0, 1 and 2 are complete and pushed.
Your job is Phase 3, and only Phase 3.

Work on `main` and push there when done. (If your session designates a feature
branch instead, that wins — push there and say which you used.)

This is the phase where the system stops being a library and starts being a
product. Everything below this layer is built and tested; what you are writing is
**the whole of what Claude ever sees**. Get the tool descriptions wrong and a
correct delegation layer gets used incorrectly.

---

## 1. Read these first, in this order

Do not start coding until you have read all five.

| File | Why |
|---|---|
| `src/manager/index.ts` and `src/manager/types.ts` | The API you are wrapping. `WorkerSpec` in, `WorkerRecord`/`WorkerResult` out. Read the whole of `types.ts` — every field on `WorkerResult` exists because something needed it, and `renderResult` already turns it into §4.3. |
| `src/manager/worker.ts` §"public surface" | `spawn` / `wait` / `answer` / `cancel` / `recover` / `rebuildIndex` / `dispose` / `halt`. **Two of these do not return in under two seconds and DD-1 says your tools must** — see §3 below. |
| `projectplan.md` §7, §8, §11 | The tool table, the truncation and context budgets, and your acceptance criteria. §7 lists twelve tools; §11 names seven. §11 wins — see §5. |
| `docs/adr/0002-worker-contract-channel.md` | Why the report is the reply, why the schema constraint is optional, and why the reconciliation's diff comes from local git. You are about to describe all of this to Claude in tool descriptions; describe it accurately. |
| `test/manager/lifecycle.test.ts` | Executable documentation of every state Claude will poll. In particular: what a `blocked` worker looks like, and what a `timed_out` one carries that a `failed` one does not. |

Verified against **OpenCode 1.18.25**. If `opencode --version` differs materially,
run `bun run spike` first — it is the drift canary.

---

## 2. Your task

From `projectplan.md` §11:

> **Phase 3 — MCP server (2–3 days)**
> - Tools: spawn, status, wait, result, output, stop, list. Async pattern +
>   pagination.
>
> **AC:** from Claude Code, Claude drives a single worker to completion
> end-to-end. **Measure:** Claude's context grows by <2k tokens for the
> interaction.

Concretely, deliver:

1. **`src/mcp/server.ts`** — the real server. It owns one `ServeBackend`, one
   `Store`, one `WorkerManager`, calls `manager.recover()` on startup (§9), and
   disposes cleanly on `SIGINT`/`SIGTERM`. `src/mcp/server.ts` currently holds
   Phase 0 scaffolding (`orchestrator_hello`, `orchestrator_timeout_probe`);
   keep the probe — it is an instrument you still need (§8) — and replace the
   rest.
2. **The seven tools**, per §7's parameter and return shapes: `worker_spawn`,
   `worker_status`, `worker_wait`, `worker_result`, `worker_output`,
   `worker_stop`, `worker_list`. Plus `worker_message`, which §11 does not name
   but the blocked path is useless without: a worker that asks a question nobody
   can answer is a worker that times out.
3. **Tool descriptions that make Claude self-calibrate.** §7's delegation
   heuristics ("delegate multi-file implementation; do not delegate single-file
   edits or codebase questions") belong *in the descriptions*, not in a doc
   nobody loads. So does DD-8: a worker's summary is a **claim**, and the
   `discrepancies` field is Dispatched Code's own finding about that claim.
4. **Pagination and truncation** (§8): event pages of 50, result summaries under
   ~1.5k tokens, and a hard cap on every field that a worker can influence the
   size of. `renderResult` already respects the result budget; `worker_output`
   is yours, and `Store.listEvents({limit, afterID})` is the cursor you want.
5. **Configuration.** The server needs to know which repository it orchestrates
   and where to put its database. Environment variables are fine
   (`DISPATCHED_CODE_REPO`, `DISPATCHED_CODE_DB`, `DISPATCHED_CODE_MODEL`); defaulting the
   repo to `process.cwd()` is fine. Say what you chose in the README.
6. **`test/mcp/`** — the tool surface driven over real JSON-RPC against `ocmock`,
   not by calling the handlers directly. The `InMemoryTransport` pair from
   `@modelcontextprotocol/sdk` makes this cheap, and it is the only way to catch
   a schema that the SDK rejects at registration time.
7. **The context measurement.** The AC is a number, not a vibe. See §4.

---

## 3. Facts you must not re-derive — and the ones that will silently break you

**The three that will cost you hours if you ignore them:**

> **1. `manager.cancel()` and `manager.answer()` do not return in under two
> seconds, and DD-1 says your tools must.** Both were deliberately made to
> resolve only once the worker has *actually* moved — `cancel` awaits the run
> loop settling (up to `abortGraceMs`, 10s), `answer` awaits the follow-up prompt
> going out (which itself waits up to `retrySettleMs`, 2s, for the session to
> settle). That is the right contract for a library caller and the wrong one for
> an MCP tool. `worker_stop` and `worker_message` must **start** the operation and
> return; do not await. Fire the promise, catch its rejection so it cannot become
> an unhandled rejection that kills the server, and let Claude poll
> `worker_status`. Test that both return promptly — a test that only asserts the
> final state will pass either way.

> **2. A `blocked` worker has no `WorkerResult`.** The result is built at settle,
> and `blocked` is not a settle. `manager.get(id)` returns a `WorkerRecord` whose
> `questions` field carries what the worker asked and whose `result` is
> `undefined`. `worker_result` on a blocked worker must render the *record* — the
> questions, the state, the elapsed time — rather than dereferencing `result` and
> handing Claude a crash or, worse, an empty summary that reads like a worker
> that did nothing. This is the single most likely null-dereference in the phase.

> **3. `worker_wait`'s ≤30s cap is still unverified.** `projectplan.md` §7 caps
> it at 30,000ms and Phase 0's unresolved item 1 says the real host tool-call
> timeout was never measured, because measuring it requires a live Claude Code
> session — **which is what you are about to have.** `orchestrator_timeout_probe`
> is built and works over real JSON-RPC. Take the measurement (§8) before you
> pick the cap, and put the number in `docs/phase0-facts.md`. Do not ship a
> guess as if it were a fact; that is exactly the mistake the structured-output
> row records.

The rest:

- **`manager.wait()` already has the semantics `worker_wait` needs.** It resolves
  on any *settled* state — which includes `blocked`, because a blocked worker is
  finished as far as Dispatched Code is concerned — and it **resolves rather
  than throws** on timeout, because "still running" is a legitimate answer. Do
  not wrap it in your own timeout race.
- **`spawn()` is already DD-1-compliant.** It creates the worktree and session in
  the background and returns a record in `spawned`. Do not await anything else in
  `worker_spawn`.
- **`renderResult()` is the §4.3 formatter and it is already tested against the
  context budget.** Use it. If you find yourself formatting a result by hand in
  the MCP layer, you have two formatters and they will diverge.
- **The DD-2 boundary test polices `src/` and that includes `src/mcp/`.** Import
  `ServeBackend` from `src/opencode/index.js` — never from `./opencode/serve.js`
  — and do not write the words that `test/opencode/boundary.test.ts` greps for,
  in code *or in comments*: endpoint paths, raw OpenCode event type names, and
  the phrase for starting the server process. It will fail the build the moment
  you do, which is the point.
- **stdout is the JSON-RPC channel.** Every diagnostic goes to stderr. The Phase 0
  scaffolding already does this and the comment explaining why is worth keeping.
  A single stray `console.log` in a code path you added silently corrupts the
  protocol, and the symptom is a host that says nothing is wrong.
- **Worker output is untrusted (DD-8).** Summaries, questions, risks and
  follow-ups are text a model wrote after reading a repository that may contain
  anything. Pass it through as data; never let it become part of a tool
  description, never interpolate it into a shell string, and consider whether
  your rendering makes it visually distinguishable from Dispatched Code's own
  findings. `discrepancies` is Dispatched Code talking; `summary` is the worker
  talking, and Claude should be able to tell.
- **One `ServeBackend` per server process, pre-warmed.** The first prompt on a
  fresh server emits ~45 unscoped events before generation starts. Call
  `backend.start()` at server startup, not on the first `worker_spawn`, or the
  first worker of every session pays for it.
- **Recovery runs before anything else.** `manager.recover()` turns rows left
  `running` by a dead process into `interrupted`; `manager.rebuildIndex()` puts
  rows back from worktree manifests when the database is gone. Both are cheap and
  both are meaningless if a `worker_spawn` has already raced past them.

---

## 4. Definition of done

- [ ] `npx tsc --noEmit` clean.
- [ ] `bun test` green, **including the existing 146** — you must not regress them.
- [ ] `bun run spike` still green.
- [ ] Every tool returns in under two seconds, asserted in a test, `worker_wait`
      excepted and bounded by the measured cap.
- [ ] The full loop works over real JSON-RPC against `ocmock`: spawn → poll →
      result, blocked → message → completed, stop.
- [ ] **From a live Claude Code session, Claude drives one worker on the golden
      repo to completion end-to-end** — the AC. Record the transcript shape in
      the phase notes.
- [ ] **Claude's context grows by <2k tokens for that interaction**, measured
      rather than asserted. The cheapest honest method: sum the character counts
      of every tool result returned during the interaction and divide by four,
      then state the method alongside the number so the next person can repeat it.
      If it comes in over budget, say so and say which field is responsible.
- [ ] No module outside `src/opencode/` names an OpenCode endpoint or event.
- [ ] Committed and pushed.
- [ ] `projectplan.md` §11 Phase 3 marked complete, in the same style as Phases
      0, 1 and 2, linking to what you produced.
- [ ] Anything you discovered that contradicts `docs/phase0-facts.md`,
      `projectplan.md` §7 or `docs/adr/0002-*` is **corrected there** — in place,
      not appended — rather than left for the next agent to trip over.

---

## 5. Scope boundaries

**Do not build**, however tempting:

- **`workspace_merge` and `workspace_cleanup`** (Phase 4). The merge gate,
  overlap detection and worktree pruning do not exist yet, and a tool that
  promises them is worse than no tool.
- **`worker_revise`** (Phase 6). §7 lists it; §11 puts the review loop in Phase 6.
  The session reuse it needs already works — that is not a reason to ship it now.
- **The concurrency semaphore, the queue, and `dependsOn`** (Phase 5). §7's
  `worker_spawn` signature includes `dependsOn?`; accept the parameter and
  reject it with a clear "not until Phase 5" rather than silently ignoring it, or
  leave it out entirely. Do not implement scheduling.
- **`worker_diff`** is a judgment call. §7 lists it, §11 does not, and the
  workspace layer currently exposes `diffStat` but no paginated unified diff. If
  you build it, the diff reader belongs in `src/workspace/`, not in the MCP
  layer, and it must respect §8's 400-line cap. If you skip it, say so in the
  phase notes so Phase 4 knows it is unbuilt.

If Phase 3 turns out to be blocked on something, finish every unblocked part,
push it, and say plainly what is left and why. Do not quietly narrow the scope.

---

## 6. Environment notes

```bash
npm install -g opencode-ai      # installs cleanly; verified 1.18.25
npm install                     # project deps
bun test                        # 146 tests, no OpenCode needed
bun run spike                   # confirm the baseline is green before you start
OC_E2E=1 bun test test/e2e      # the real-OpenCode tests, if you want the baseline
```

- Wire the server into a host with
  `claude mcp add dispatched-code -- bun run "$PWD/src/mcp/server.ts"`.
- `opencode/muse-spark-1.2-contributor-free` works with no configured
  credentials and is the default. It **rejects schema-constrained output**; the
  manager already handles that, and you should not be surprised to see a
  `structured_output_unsupported` event in a worker's log.
- `test/ocmock/` is a scriptable fake server covering success, hang, blocked,
  over-budget, crash, lying-report and format-unsupported, plus a
  `dropPromptsWithinMs` guard. **Extend it rather than reaching for real
  OpenCode** — it runs in milliseconds and it reproduces three failures that are
  silent hangs against the real thing.
- `test/fixtures/golden.ts` materializes the golden repo into a temp git
  repository. Use it for anything that needs a real worktree; never point a test
  at this repository itself.
- **Do not run `pkill -f 'opencode serve'`.** `pkill -f` matches full command
  lines including your own shell's. Match on a PID you captured.
- `NO_PROXY` must include `127.0.0.1,localhost`. The adapter handles this itself;
  anything you write that talks HTTP to localhost outside the adapter needs the
  same treatment.

---

## 7. A note on model routing

If you are orchestrating this across models: the **tool descriptions** deserve
the stronger generalist and are the least delegable thing in the phase — they are
prompt engineering aimed at a model, not code, and their quality determines
whether the whole system gets used correctly. The **pagination, truncation and
JSON-RPC plumbing** are well-specified and independently testable. The **context
measurement** is a small self-contained piece of instrumentation and a good
candidate to build first, because it tells you whether everything else is
working.

---

## 8. Before you finish

Three items from earlier phases remain open. **One of them is finally yours to
close**, and it is the one this phase's own cap depends on:

1. **Claude Code's MCP tool-call timeout.** `dispatched_code_timeout_probe` is built
   and verified over real JSON-RPC; the measurement needs a live Claude Code
   session with the server registered, which Phase 3 is the first phase to have.
   Call it with increasing `delayMs` until the host gives up. The largest delay
   that still returns is the ceiling; `worker_wait`'s cap goes under it with
   margin. Record the number, the host, and the date in `docs/phase0-facts.md`
   and strike the item off the unresolved list.
2. **`cost` on paid providers.** Still open, and still blocked on not having one.
   Budgets are on tokens; `WorkerResult.usage.cost` is advisory and is `0` on
   every provider exercised so far. If you happen to have a paid key, one worker
   run settles it.
3. **Replying to a permission or question request in band.** The adapter surfaces
   these asks but cannot answer them, so the manager converts a mid-run ask into
   an escalation by aborting the turn and delivering the answer as the next
   prompt. It works and it costs a partial turn. If you find yourself in the
   adapter anyway, `…/reply` and `…/reject` are the endpoints, and they are
   schema-verified only — verify them on the wire before relying on them.
