# Phase 3 notes — the MCP server

**Phase:** 3 (MCP tool surface) · **Date:** 2026-08-28
**Verified against:** OpenCode 1.18.25, Claude Code 2.1.251,
`@modelcontextprotocol/sdk` 1.30.0

Phase 3's acceptance criteria are two numbers and one demonstration, and this
file records all three with the method used to get them, so the next person can
repeat rather than trust them. It also records what was *not* built, and two bugs
in earlier phases that this one surfaced.

**On the names in this file.** Everything quoted here — commands, prompts, tool
calls, the host's errors, Claude's own words — is reproduced as it ran on
2026-08-28, when the project was called OpenCode Orchestrator. So the probe is
`orchestrator_timeout_probe`, the server's local alias is `orchestrator`, and
the tools come through as `mcp__orchestrator__*`. A measurement rewritten to
match a later name is no longer a measurement.

---

## 1. The host's MCP tool-call timeout — 60 s

Phase 0's first unresolved item, open since the beginning, because the
measurement needs a live Claude Code session with the server registered and
Phase 3 is the first phase to have one.

**Method.** The timeout probe (built in Phase 0, kept for exactly this)
registered as a real MCP server in a headless session and called with increasing
delays.

```bash
claude -p --strict-mcp-config --mcp-config mcp.json \
  --allowedTools "mcp__orchestrator__orchestrator_timeout_probe" \
  --output-format stream-json --verbose \
  "Call the orchestrator_timeout_probe tool exactly once with delayMs=<N>."
```

The `tool_result` block in the stream is the authority, not the model's prose —
a model that says "it timed out" is not evidence, and one that says it returned
when it did not is worse.

| `delayMs` | Wall | Outcome |
|---|---|---|
| 30,000 | 39 s | returned: `{"requestedMs":30000,"actualMs":30000,"returned":true}` |
| 45,000 | 56 s | returned: `{"requestedMs":45000,"actualMs":45002,"returned":true}` |
| 55,000 | 66 s | returned: `{"requestedMs":55000,"actualMs":55002,"returned":true}` |
| 60,000 | 69 s | **failed:** `MCP server "orchestrator" tool "orchestrator_timeout_probe" timed out after 60s` |

**The host names its own limit in the error**, which is a better result than the
sweep was designed to get: no bisection was needed. The planned probes at 90 s,
120 s, 300 s and 600 s were abandoned as redundant rather than run for twenty
minutes of confirmation, and 45 s and 55 s were run instead — because a limit
stated in an error message is still worth bracketing. 55 s returning and 60 s
failing makes it a hard 60 s deadline on the call, not a shorter budget that
happens to round to one.

The whole session survives it: the call fails, the server stays connected, and
the next tool call works.

That is survivable for a probe and not for a `worker_wait`: a lost wait means a
worker still running with nobody watching it.

**Consequence.** `worker_wait`'s cap stays at §7's 30,000 ms. The number has not
changed, but its status has: it was a guess written before anything measured the
ceiling, and it is now **half a measured ceiling**, with the remaining 30 s
absorbing the tool's own work, the transport, and any host configured to a
shorter limit. Recorded in `docs/phase0-facts.md` §7; unresolved item 1 is
struck.

---

## 2. The acceptance criterion — Claude drives a worker end to end

> **AC:** from Claude Code, Claude drives a single worker to completion
> end-to-end.

**Setup.** The golden repo (`test/fixtures/golden/`) in a temp git repository,
Dispatched Code registered over `--mcp-config`, and **only** Dispatched Code's
tools allowed — no `Bash`, no `Edit`, no `Read`. Claude could not have touched
the repository itself even if it had decided to; everything it knows about the
work arrived through the tool surface.

**Prompt.** A task, not a script — no tool was named, so the descriptions had to
do the calibrating:

> Use it to add a `range(values)` function to src/stats.js in the repository the
> orchestrator manages … Delegate the work — do not try to edit any files
> yourself. When it is finished, tell me what actually changed and whether the
> orchestrator agreed with the worker about it.

**What happened.** Four tool calls, in this shape:

```
ToolSearch                       (the host loading the deferred tool schemas — not ours)
mcp__orchestrator__worker_spawn  {task, scope, ownedPaths, acceptance, testCommand}
mcp__orchestrator__worker_wait   {id: "w-001", timeoutMs: 30000}
mcp__orchestrator__worker_result {id: "w-001"}
```

Claude filled in `scope`, `ownedPaths`, `acceptance` and `testCommand` without
being told to — those fields exist because `worker_spawn`'s description says the
brief is the whole contract and a vague task produces a worker that guesses. It
also chose `timeoutMs: 30000`, the documented cap, on the first try.

**The worker's actual output**, on branch `worker/w-001` at snapshot `6bfc170854`:

```diff
+export function range(values) {
+  if (values.length === 0) throw new RangeError("range of an empty list is undefined");
+  return Math.max(...values) - Math.min(...values);
+}
```

plus two cases in `test/checks.mjs`. 2 files, +11/−1. Wall clock 17 s, ~15,800
tokens spent by the worker — none of which reached Claude.

**What Claude reported back**, unprompted about the distinction:

> **Did the orchestrator agree with the worker?** Yes — no discrepancies. The
> worker reported running `npm test` with 4/4 passing, and the orchestrator
> independently re-ran the test suite itself and confirmed 4 passed / 0 failed /
> 0 skipped. It also confirmed the diff only touched the two intended, owned
> files … with nothing out-of-scope.

That paragraph is the part worth keeping. Nothing in the prompt taught Claude to
separate what the worker claimed from what Dispatched Code verified; the tool
descriptions did, which is what §7 means by "delegation heuristics live in the
tool descriptions so Claude self-calibrates" and what DD-8 needs in order to be
more than a comment in a design document.

**AC met.**

---

## 3. The context budget — measured, not asserted

> **Measure:** Claude's context grows by <2k tokens for the interaction.

**Method** (stated so it can be repeated, and so a different number later can be
compared to this one): sum the character counts of every tool result the host was
handed during the interaction, and divide by four. The script is
`test/mcp/tools.test.ts`'s `budget` accumulator for the unit-test version, and
the `stream-json` log for the live one — every `tool_result` block whose
`tool_use` name starts with `mcp__orchestrator__`.

Dividing by four is the standard rough token estimate. It is an approximation and
saying so is part of the honesty: the true figure depends on the tokenizer, and
these results are mostly ASCII prose and short identifiers, which is the case
where four is closest.

**Live session** (the AC run above):

| Tool result | Characters |
|---|---|
| `worker_spawn` | 293 |
| `worker_wait` | 175 |
| `worker_result` | 644 |
| **Total** | **1,112** |

**1,112 characters ≈ 278 tokens, against a budget of 2,000.** Under budget by a
factor of seven, and the largest single contributor is `worker_result` — which is
the one that should be largest, because it is the only one carrying findings
rather than pointers.

For scale: the worker itself spent ~15,800 tokens doing the work. The firewall in
§1 is holding at roughly 1.8% pass-through.

**Where the headroom goes when it goes.** Three fields grow with the work rather
than being fixed: the changed-path list (capped at 12 paths, then `…and N more`),
the discrepancy list (6), and the escalated questions (6, each capped at 400
characters). A worker touching 40 files and raising 20 discrepancies still costs
one page, and `test/mcp/tools.test.ts` proves it with a deliberately hostile
worker — 40 questions of 5,000 characters each, 200 KB of model-authored text,
rendered to under 4,000 characters.

The same measurement runs in CI as an assertion rather than a report — see
`test/mcp/tools.test.ts`, "a whole spawn → wait → result round trip costs under
2k tokens" — so a rendering change that inflates the result fails the suite
instead of being noticed a phase later.

---

## 4. What was deliberately not built

- **`worker_diff`** (§7 lists it, §11 does not). Skipped. `src/workspace/`
  exposes `diffStat` but no paginated unified diff, and the handoff is right that
  the reader belongs there rather than in the MCP layer. `worker_result` already
  carries the diff stat and the changed-path list, which is what the
  reconciliation needs. **Phase 4 should build it**, in `src/workspace/`, under
  §8's 400-line cap.
- **`workspace_merge` / `workspace_cleanup`** (Phase 4). The merge gate, overlap
  detection and worktree pruning do not exist; a tool that promised them would be
  worse than no tool.
- **`worker_revise`** (Phase 6). The session reuse it needs already works. That
  is not a reason to ship it.
- **The concurrency semaphore, the queue, `dependsOn`** (Phase 5). `dependsOn` is
  accepted by `worker_spawn`'s schema and **rejected with a message naming Phase
  5**, rather than ignored — a worker that silently ran before its dependency
  looks like a worker that failed for no reason.
- **Batched `worker_wait`.** §7 wrote `ids`; §11 puts batched waits in Phase 5.
  Phase 3 takes one id. `worker_status` does accept `ids`, because a multi-get is
  not scheduling.

---

## 5. Two bugs in earlier phases, found by building on them

Both are fixed here, with tests, because both are things Phase 3's tools report
and would have reported wrongly.

### The run loop starved its own watchdogs

`WorkerManager.pump()` raced the event stream against a `tickMs` timer and ran
the watchdogs **only when the timer won**. An event stream busier than the tick
wins that race every time — and text deltas arrive far faster than once a second,
because ADR-0002 made the reply the report and turned deltas on for every worker.

So for a chatty worker the token budget, the idle watchdog and the hard deadline
never fired at all. The failure is precisely inverted: the runaway worker §8's
budget exists to stop is the chattiest worker there is.

It had been showing up as two intermittently failing watchdog tests
(`over_budget`, and the idle watchdog under a fast heartbeat) — flaky because
they depended on winning a race the loop was designed to lose. The tick now sets
*how often* the watchdogs run and the race only decides what else the loop does
while waiting. `test/manager/lifecycle.test.ts`, "a chatty worker cannot starve
the watchdogs", emits deltas 20× faster than the tick and fails deterministically
against the old loop.

### A completed worker kept a stale `reason`

`settle()` wrote `reason` into the record only when there was one, so a worker
that blocked, was answered and then finished carried `reported_blocked` into its
final row forever. `WorkerResult.reason` was always correct — `buildResult` omits
it on a clean completion — but every status line read
`w-001 [completed: reported_blocked]`, which says that blocking is why it
completed. The record now clears the reason on completion.

---

## 6. Things worth knowing before Phase 4 builds on this

- **`createDispatchedCode(config, tuning?)` is the seam the tests use.** It builds
  the backend, index and manager and returns them alongside the `McpServer`, so a
  test can drive the real server over `InMemoryTransport` instead of calling
  handlers directly. That matters more than it sounds: a zod schema the SDK
  cannot convert to JSON Schema throws at `listTools` and nowhere earlier, so a
  direct-call test passes and the host fails.
- **The SDK returns input-validation failures as `isError: true` results, not as
  JSON-RPC rejections.** Worth knowing before writing an assertion that expects a
  throw. It is also the better behaviour: the message reaches Claude.
- **Every tool answers rather than throws.** An unknown worker id, a stop on a
  settled worker, a `worker_result` on one that has not settled — all of them
  return usable text. An error teaches a model to avoid a tool that was working
  correctly.
- **`renderResult` is still the only §4.3 formatter.** The MCP layer renders
  three things the manager never had to: a blocked record, a settled record with
  no result, and status/list rows. Everything else goes through `renderResult`,
  because two formatters diverge.
