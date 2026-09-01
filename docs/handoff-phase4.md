# Handoff: implement Phase 4 — isolation & the gated merge

You are picking up **Dispatched Code** at
`chonkylord/Opencodeorchestrator`. Phases 0, 1, 2 and 3 are complete and pushed.
Your job is Phase 4, and only Phase 4.

Work on `main` and push there when done. (If your session designates a feature
branch instead, that wins — push there and say which you used.)

Phase 3 made the system usable: Claude can spawn a worker from a live Claude Code
session, watch it, and read a structured result. What it cannot do is **take the
work**. Every worker's output currently ends its life on a branch nobody merges.
This is the phase where a worktree full of good work becomes a commit on the
integration branch — or is rejected, cleanly, with the tree exactly as it was.

That "exactly as it was" is the whole phase. A merge pipeline that half-fails is
worse than no merge pipeline, because the user's repository is the thing it
half-fails in.

---

## 1. Read these first, in this order

Do not start coding until you have read all five.

| File | Why |
|---|---|
| `projectplan.md` §6, §8, §11 | §6 is your specification: worktree ops, overlap detection, the gated pipeline. §8 caps the diff at 400 lines. §11 is your acceptance criteria. **§6.1 contains two statements Phase 2 proved false** — see §3 below; correcting them is part of the job. |
| `src/workspace/` — all four files | The layer you are extending. `git.ts` (argv-only, no shell, hooks disabled, identity per-invocation), `worktree.ts` (`createWorktree`, `snapshotCommit`, `changedFiles`, `diffStat`), `verify.ts` (`runTestCommand` — whose docstring already says "the exit code is what the merge gate in Phase 4 will key off"). Most of your primitives exist. |
| `src/manager/state.ts` §"Transitions" | `merged` is already a state and `merge` is already a trigger, with exactly one legal edge: `completed → merged`. It was enumerated in Phase 2 and has never fired. **You fire it.** Illegal transitions throw, which is how you find out you tried to merge a `failed` worker. |
| `src/mcp/tools.ts` and `docs/phase3-notes.md` | The tool surface you are adding to, and the measurements that constrain it. In particular: **the host gives up on a tool call at 60 seconds**, measured, and your merge runs a test suite. See §3, trap 1. |
| `docs/adr/0002-worker-contract-channel.md` §"Why the diff comes from local git" | You are about to be tempted by `POST /experimental/worktree` and `GET /session/{id}/diff`. ADR-0002 says exactly where that temptation is legitimate and where it is not, and the distinction is not about convenience. |

Verified against **OpenCode 1.18.25** and **Claude Code 2.1.251**. If
`opencode --version` differs materially, run `bun run spike` first — it is the
drift canary.

---

## 2. Your task

From `projectplan.md` §11:

> **Phase 4 — Isolation & merge (4–5 days)**
> - WorktreeManager, per-worker config injection, snapshot commits, diff tooling,
>   overlap detection, gated merge with auto-rollback, cleanup.
>
> **AC:** two workers on disjoint files merge green; a seeded conflicting merge is
> detected and rolled back; failed test gate restores pre-merge state.

Three of those six are already built and tested — worktrees, per-worker config
injection and snapshot commits all landed in Phase 2. Read §3 before you rebuild
any of them. Concretely, deliver:

1. **`src/workspace/diff.ts`** — a paginated unified diff reader, respecting §8's
   400-line cap, with a cursor. This is `worker_diff`, which §7 lists and Phase 3
   deliberately did not build; the phase notes say so and say the reader belongs
   here rather than in the MCP layer. Phase 4 needs it anyway: a human deciding
   whether to accept a merge wants the diff, and so does a `review` worker.
2. **`src/workspace/overlap.ts`** — §6.2. Intersect the changed-file sets of a set
   of workers and classify: disjoint, shared file, shared *integration* file
   (`package.json`, lockfiles, router indexes, barrels). The classification is the
   product; the intersection is ten lines.
3. **`src/workspace/merge.ts`** — §6.3, DD-6. Sequential merge into an integration
   branch, a test gate after **each** merge, `git reset --hard` to the pre-merge
   sha on red, and a result that says precisely which worker broke it and how.
4. **Cleanup** — prune worktrees and branches (`git worktree remove`, branch
   delete), plus §9's orphan scan: `worker/*` branches and worktrees with no index
   row. **Unmerged work is not garbage** — see §3.
5. **The MCP tools:** `worker_diff`, `workspace_merge`, `workspace_cleanup`, per
   §7's shapes. `workspace_merge` cannot be synchronous; §3 trap 1 explains why,
   and it is the largest design decision in the phase.
6. **`test/workspace/` extensions and `test/mcp/` coverage** — the merge tests want
   real git repositories, which `test/fixtures/golden.ts` already gives you, plus
   `breakGoldenRepo()` for a suite that fails for a real reason rather than a
   stubbed exit code. The MCP tools go over real JSON-RPC like every other tool.
7. **An ADR.** Where the merge happens, and whether OpenCode's native worktree
   endpoints are adopted for creation and cleanup, are both decisions the next
   phase should not have to reverse-engineer. `docs/adr/0003-*.md`.

---

## 3. Facts you must not re-derive — and the ones that will silently break you

**The three that will cost you hours, or cost a user their working tree:**

> **1. `workspace_merge` runs a test suite, and DD-1 gives you two seconds.**
> This is not a detail to discover late. The gate in §6.3 runs the repository's
> own test command after every merge — minutes, plausibly tens of minutes — and
> Phase 3 *measured* the host's ceiling: **Claude Code 2.1.251 abandons a tool
> call at 60 seconds and says so in the error** (`docs/phase0-facts.md` §7). §7's
> table says `workspace_merge` returns a "merge + test-gate result", which reads
> synchronous and cannot be. So the merge is **spawn-and-poll like everything
> else**: start it, return a handle, and give Claude something to poll. Decide
> early whether that handle is a new first-class entity with its own state (a
> `merges` table beside `workers`) or a reuse of the worker row, because every
> tool signature in the phase depends on the answer. `worker_stop` and
> `worker_message` in `src/mcp/tools.ts` are the pattern for starting work and
> returning; copy their shape, including catching the promise's rejection so a
> failure cannot become an unhandled rejection that kills the server.

> **2. Do not merge in the user's checkout.** `config.repoRoot` is a real
> repository that a human may have open, on a branch of their choosing, with
> uncommitted changes in it. `git merge` there — or worse, `git reset --hard`
> there, which is your rollback — destroys work the orchestrator never created
> and cannot restore. **Merge in a dedicated integration worktree**
> (`git worktree add` under `.orchestrator/`, which is already in
> `.git/info/exclude`), test there, roll back there. The user's branch is touched
> only if they ask for it, as a separate, explicit, fast-forward-if-possible step.
> Nothing in §6.3 says this, because §6.3 was drawn before there was a real
> repository to be careful about. It is the single most dangerous thing in the
> phase and it is entirely preventable by choosing the right cwd once.

> **3. A `completed` worker may have no commit at all.** `snapshotCommit` returns
> `{committed: false, files: []}` when the worker changed nothing, and
> `WorkerResult.snapshot` is then absent or `committed: false`. A worker can
> complete, report enthusiastically, and leave an empty branch — Phase 2's
> reconciliation exists precisely because that happens. Code that reaches for
> `result.snapshot.sha` to merge will null-dereference on exactly the workers
> most worth being suspicious of. This is Phase 4's version of the trap Phase 3
> hit with `blocked` workers having no result: **check before you dereference,
> and treat "nothing to merge" as an outcome to report rather than an error.**

The rest:

- **Worktrees, config injection and snapshot commits are built.** §11 lists them
  under Phase 4 because the plan was written before Phase 2 pulled them forward.
  `createWorktree` does §6.1's `git worktree add <path> -b worker/<id> <base-sha>`,
  writes `.orchestrator/` into `.git/info/exclude`, and refuses to clobber an
  occupied path. Permissions are injected inline at session create and the brief
  travels in the per-prompt `system` field. Do not rebuild any of it.
- **Every worker in a run branches from the same resolved sha.** `createWorktree`
  resolves the ref to a sha rather than passing the ref, deliberately: a run that
  takes twenty minutes must not have its workers based on different commits.
  **That is what makes §6.2's set intersection a valid overlap test** — if the
  bases could differ, comparing changed-file sets would mean nothing.
- **`runTestCommand` returns an exit code and does not parse counts**, on purpose:
  every framework prints them differently and a regex that guesses wrong is worse
  than an exit code that does not. Your gate keys off `passed`. Two consequences:
  §13's flaky-test mitigation ("gate re-runs failures once before declaring red")
  is yours to implement, and DD-8 still holds — **the test command comes from the
  brief, never from a worker's report.** `verify.ts`'s docstring explains why that
  one line is load-bearing.
- **`merged` and `merge` already exist in the state machine**, with one legal edge
  (`completed → merged`) and nothing else. Use them rather than inventing a state.
  The machine throws on an illegal move, so attempting to merge a `timed_out`
  worker fails loudly at the transition instead of quietly at the git call.
- **`git()` is the only way to run git, and it is the way it is on purpose.** No
  shell (argv only, so a branch name can never become a command), a timeout on
  every call, identity supplied per-invocation, and `core.hooksPath=/dev/null` —
  because a repository under a worker's control may carry hooks, and a merge must
  not be a path for repository content to execute in the manager's process tree
  (DD-8). If you find yourself reaching for `execFile("git", …)` directly, you
  have just dropped all four.
- **Cleanup must not be able to destroy unmerged work.** DD-7 says the worktrees
  are the durable state and the database is an index; a `workspace_cleanup` that
  prunes an unmerged `worker/*` branch deletes the only copy of what a worker
  produced. Merged branches are safe to prune, unmerged ones need `force: true`
  and a description that says what force means. The orphan scan **reports** by
  default; §9 says "report or prune" and the safe half is the default.
- **`.orchestrator/` must never enter a merge.** `snapshotCommit` unstages it
  before committing and `changedFiles`/`diffStat` filter it, so worker branches
  are already clean — but your integration worktree lives under the same directory
  and your merge commits are yours to keep clean too.
- **Worker output is untrusted (DD-8), and a diff is worker output.** `worker_diff`
  renders text a model wrote into files. Cap it (§8: 400 lines), paginate it, and
  never let it become part of a tool description or a shell string. The Phase 3
  caps in `src/mcp/render.ts` are the precedent.
- **The DD-2 boundary test polices `src/` and that includes everything you write.**
  Do not name an OpenCode endpoint, a raw event type, or the phrase for starting
  the server process — in code *or in comments*. `test/opencode/boundary.test.ts`
  fails the build the moment you do, which is the point.
- **stdout is the JSON-RPC channel.** Every diagnostic goes to stderr. One stray
  `console.log` corrupts the protocol and the symptom is a host that says nothing
  is wrong.
- **There is no wave, and you are not building one.** §6.2 says "after all workers
  in a wave finish"; the queue and the concurrency semaphore are Phase 5. In Phase
  4 a wave is whatever set of worker ids Claude hands you, having waited for them
  itself with `worker_wait`.

---

## 4. Definition of done

- [ ] `npx tsc --noEmit` clean.
- [ ] `bun test` green, **including the existing 171** — you must not regress them.
- [ ] `bun run spike` still green.
- [ ] Every tool returns in under two seconds, asserted in a test, `worker_wait`
      excepted. **`workspace_merge` included** — it starts the merge and returns.
- [ ] **Two workers on disjoint files merge green** — the AC, over real JSON-RPC.
- [ ] **A seeded conflicting merge is detected and rolled back**, with the
      integration branch bit-identical to its pre-merge sha afterwards. Assert on
      the sha, not on "it didn't throw".
- [ ] **A failed test gate restores pre-merge state** — use `breakGoldenRepo()` so
      the suite fails on an assertion, not on a stubbed exit code.
- [ ] The user's checkout is untouched by any of it. Test it: dirty the working
      tree of the fixture repo, run a full merge cycle, assert the dirt is still
      there and `git status` is otherwise unchanged.
- [ ] `worker_diff` respects the 400-line cap and paginates.
- [ ] No module outside `src/opencode/` names an OpenCode endpoint or event.
- [ ] Committed and pushed.
- [ ] `projectplan.md` §11 Phase 4 marked complete, in the same style as Phases 0
      through 3, linking to what you produced.
- [ ] Anything you discovered that contradicts `docs/phase0-facts.md`,
      `projectplan.md` §2/§6/§7 or the ADRs is **corrected there** — in place, not
      appended. **Three are already known and are yours:** §6.1 says the report
      contract should "prefer `format: {type: "json_schema", …}`", which ADR-0002
      established does not work on the model this project defaults to; and §6.1
      calls `AGENTS.md` pickup "unverified", which Phase 2 verified (it works, and
      is documented in `docs/phase0-facts.md` §5). §2's DD-4 row still describes
      the `report.json` channel that ADR-0002 replaced. Fix all three.

---

## 5. Scope boundaries

**Do not build**, however tempting:

- **The concurrency semaphore, the queue, `dependsOn`, batched `worker_wait`**
  (Phase 5). `worker_spawn` already accepts `dependsOn` and rejects it with a
  message naming Phase 5. Leave that as it is; do not make it work.
- **`worker_revise`** (Phase 6). §6.3 step 2's option (a) — "send the worker a
  'rebase onto new base, resolve, re-test' message" — is a revision, and the
  review loop is Phase 6's. In Phase 4, a red gate rolls back and **reports**;
  Claude may then answer or respawn. Building the rebase loop here means building
  half of Phase 6 without its revision caps, which is how infinite fix loops get
  shipped.
- **Budget enforcement, retries with backoff, run reports, metrics** (Phase 7).
  The orphan *scan* is yours because cleanup needs it; the orphan *TTL pruning
  policy* is Phase 7's.
- **A merge UI, a conflict resolver, or three-way merge cleverness.** Git's own
  merge is the merge. Your job is the gate around it and the rollback under it.

If Phase 4 turns out to be blocked on something, finish every unblocked part,
push it, and say plainly what is left and why. Do not quietly narrow the scope.

---

## 6. Environment notes

```bash
npm install                     # project deps — a fresh clone has no node_modules
npm install -g opencode-ai      # installs cleanly; verified 1.18.25
bun test                        # 175 tests (171 pass, 4 skip), no OpenCode needed
bun run spike                   # confirm the baseline is green before you start
OC_E2E=1 bun test test/e2e      # the real-OpenCode tests, if you want the baseline
```

- Wire the server into a host with
  `claude mcp add dispatched-code -- bun run "$PWD/src/mcp/server.ts"`, or configure
  it with `DISPATCHED_CODE_REPO` / `_DB` / `_MODEL` / `_BASE_URL` / `_VERIFY_TESTS`
  (README → Configuration).
- **You can drive a live Claude Code session from inside this container**, which
  is how Phase 3 took its measurements and how you can demonstrate a merge
  end-to-end if you want to:
  `claude -p --strict-mcp-config --mcp-config mcp.json --allowedTools "mcp__orchestrator__…" --output-format stream-json --verbose "…"`.
  The `tool_result` blocks in that stream are the evidence; the model's prose
  about what happened is not.
- `opencode/muse-spark-1.2-contributor-free` works with no configured credentials
  and is the default. It **rejects schema-constrained output**; the manager
  handles that and you should not be surprised to see it.
- `test/ocmock/` is a scriptable fake server. Phase 3 added `abortDelayMs` to it
  so that "the tool returned before the operation finished" could be asserted
  rather than raced; you will want the same trick for a slow test gate. **Extend
  it rather than reaching for real OpenCode.**
- `test/fixtures/golden.ts` materializes the golden repo into a temp git
  repository, and `breakGoldenRepo()` makes its suite fail on a real assertion.
  Never point a test at this repository itself — the merge tests create branches
  and reset them, and doing that in Dispatched Code's own checkout would be
  indistinguishable from a bug.
- **Do not run `pkill -f 'opencode serve'`.** `pkill -f` matches full command
  lines including your own shell's; Phase 3 did it anyway and killed its own
  session. Match on a PID you captured.
- `NO_PROXY` must include `127.0.0.1,localhost`. The adapter handles this itself.

---

## 7. A note on model routing

If you are orchestrating this across models: the **rollback and the integration-
worktree choice** are the least delegable parts — they are the ones where being
wrong damages a user's repository rather than producing a wrong answer, and they
want the strongest reviewer you have. The **diff reader and its pagination** are
well-specified and independently testable; Phase 3's `render.ts` is a working
precedent for the caps. **Overlap detection** is a small pure function over sets
plus a judgment call about what counts as an integration file, and is a good
candidate to build first, because it is the input to everything else.

---

## 8. Before you finish

Three items remain open across the earlier phases. **One of them is finally
yours to close:**

1. **OpenCode's native worktree and revert endpoints.** `docs/phase0-facts.md` §6
   lists `POST /experimental/worktree` (+ `GET`, `DELETE`, `/reset`) and
   `POST /session/{id}/revert` / `revert/commit` / `unrevert`, none evaluated, and
   warns against building git plumbing by hand without looking. ADR-0002 already
   drew the line: the **diff used for reconciliation** must not come from the
   worker's own server, because that makes the witness and the accused the same
   process — but **creation and cleanup** carry no such objection, and ADR-0002
   explicitly says Phase 4 should revisit them. Evaluate them on the wire, decide,
   and record the decision in your ADR. "We did not look" is the one answer that
   is not available, because Phase 0 already flagged it twice.
2. **`cost` on paid providers.** Still open, still blocked on not having one.
   Budgets are on tokens; `WorkerResult.usage.cost` is advisory and is `0` on
   every provider exercised so far. If you happen to have a paid key, one worker
   run settles it.
3. **Replying to a permission or question request in band.** The adapter surfaces
   these asks but cannot answer them, so the manager converts a mid-run ask into
   an escalation by aborting the turn and delivering the answer as the next
   prompt. It works and it costs a partial turn. If you find yourself in the
   adapter anyway, `…/reply` and `…/reject` are the endpoints, and they are
   schema-verified only — verify them on the wire before relying on them.
