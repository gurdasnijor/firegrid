# UKV sim — session workflow body does not execute (no run created on launch)

- **Author:** Lane 4 (enforcement/verification), reproduced this session.
- **Date:** 2026-06-01 · branch `sim/unified-kernel-validation` HEAD `9ae900731` (fresh worktree).
- **Status:** root-cause located to break point **(a) launch→session-workflow-start creates no run**. Couples `tf-ll90.11.2` (sim/engine reproducibility), `tf-ll90.3` (recoverPendingSignals/kernel-write-arm wiring, R14), `tf-ll90.14` (real-agent proof must be deterministic). **Blocks Agent3's RUN-sim wave** (.14/.4.1/.5.1 all need the body to execute).
- **Epistemic tier:** observed (3 local runs) + source-read. The canonical committed run refutes "deterministically broken" — see §Divergence.

## Symptom
`pnpm --filter @firegrid/tiny-firegrid simulate:run unified-kernel-validation` completes (`DriverCompleted`) but the agent never runs:
- `output_matched=false`; `snapshot_run_count=0`, `snapshot_output_count=0`, all probe output counts 0.
- Driver probes: 3 observed (only the durable offset writes from `start`/`prompt`), 3 surfaced-gap, 7 public-surface-blocked.
- **No** `firegrid.unified.adapter.start_or_attach`, **no** `…source.local_process.open_byte_pipe`, **no** `…acp.*` codec spans, **no** `firegrid.unified.session.body`, **no** `firegrid.workflow_engine.execution.execute`.
- Subprocess side of the trace = **0 spans**.

## Runs (data)
| Run | output wait | total spans | subprocess side | execute | runs created |
|---|---|---|---|---|---|
| local #1 | 12s | 89 | 0 | 0 | 0 |
| local #2 | 12s | 89 | 0 | 0 | 0 |
| local #3 | **30s** (bumped) | 143 | 0 | 0 | 0 |
| local #4 (lmdb confirmed loadable) | 12s | 89 | 0 | 0 | 0 |
| **canonical committed** (`docs/findings/tf-ll90-ukv-13-probe-migration.md`, run `…21-12-49`) | 12s | **433** | **13** | **>0** | **>0** |

The +54 spans at 30s are all SDK-side `durable_table.get` poll loops over the empty output stream — bumping the wait did **not** change execution. So this is **not** a latency/timeout issue.

## Ruled out (instrumented, not assumed — the §0 meta-rule)
- **Timeout/latency:** 30s (2.5× headroom) produced identical 0-execute/0-run. Not marginal latency.
- **Toolchain:** the subprocess binary runs standalone — `node --import tsx src/bin/fake-acp-agent-process.ts` answered an ACP `initialize` with a valid `InitializeResponse`. tsx works; the parent sim runs via tsx.
- **lmdb / durable storage:** lmdb is a real transitive dep (`@durable-streams/server 0.3.1 → lmdb 3.5.4`, the in-process run-store), and it **loads fine** from the server's resolution context (`require('lmdb') → OK function`; platform prebuilt `@lmdb+lmdb-darwin-arm64@3.5.4` present). Re-running with lmdb confirmed loadable: identical 0-execute. Durable writes also demonstrably land (`durable_table.insert_or_get` + `producer_append` + `http POST 200` + `durable_table.get/rows` all fire). lmdb is **not** the cause. (Earlier "lmdb BROKEN" was a false signal from `require`-ing it at the repo-root cwd where it is not a direct dep.)

## Break-point analysis (a)/(b)/(c)
**(b) `JournalObserverLive` — NOT the break.** The daemon (`observers.ts:95`, kind `journal-to-sibling-workflows`) ran for **14.17s = the full sim** (sim 14.22s) and was `Interrupted` **only at normal scope teardown** — by design (docstring: "Layer scope ends → daemon fiber is interrupted; no manual teardown required"). It consumes `RuntimeAgentOutputEvents` (agent **output**, downstream of the body) and drained an **empty** stream because no agent ran. It is a *consequence* of the starved body, not the cause.

**(c) Execution poller — ALIVE, not the break.** The engine queried `firegrid.runtime.runs` and `firegrid.workflow.clockWakeups` (poller ran) but found **0 runs** to execute.

**(a) ★ THE BREAK — launch creates no session-workflow run.** The launch wrote the **context row** (`firegrid.runtime.contexts` `insert_or_get` + `producer_append`, primary_key=contextId) and the prompt signal was appended (`firegrid.client.channel.session_prompt.append`), but **no workflow run was ever created** (`runs` queried-empty; `snapshot_run_count=0`). `RuntimeContextSessionWorkflow` is **registered** (1 of 6 `workflow_engine.workflow.register`) but never **started** → no `session.body` → no `adapter.start_or_attach` → no subprocess spawn → no agent output → the observer (b) drains empty and the poller (c) finds no runs. Everything downstream is starved by the body never starting.

### Composition note
`FiregridHost` (`packages/runtime/src/unified/host.ts:254-286`) merges the 6 workflow Lives + `UnifiedSignalingChannelBindingsLive` (sends the real start/prompt signals) + the engine, but **does not call `recoverPendingSignals`** (consistent with handoff §3: "recoverPendingSignals UNWIRED — defined `unified/signal.ts:196`; zero prod callers; not in FiregridHost"; R14 / `tf-ll90.3`). On a *fresh* run the first signal should start the body via the engine's live subscription (recovery is only for post-crash wakeups), so the missing recovery call alone does not fully explain a fresh-run 0-start — the exact engine mechanism that turns the **first start/prompt signal into a created run** is where the break sits. That is the next dig (engine live-signal→run-creation), owned by `tf-ll90.11.2` + `tf-ll90.3`.

## Divergence (the load-bearing caveat)
The **canonical committed run** (same trunk code) **did** create the run and execute the body (433 spans, subprocess=13, `adapter.kind=production-codec`, real ACP `tool_call` + `request_permission`). So the code **can** start the body; it is **not** deterministically broken. My fresh checkout reproduces 0-execute 4/4. Therefore the first-signal→run-creation is either:
- **env-specific** (a reproducibility break unique to a fresh worktree), or
- **nondeterministic/flaky** (a race the canonical run won and mine loses every time).

**Decisive disambiguation:** Agent3's cross-env reproducibility test (in flight). If the canonical env *also* intermittently fails to create the run → real flakiness in the "definition of done" sim. If it reliably executes and fresh checkouts never do → an environment/setup break worth root-causing (and the sim's cross-env reproducibility is itself a finding).

## Recommendation
1. Root-cause the engine's **first start/prompt signal → run creation** path (`tf-ll90.11.2`), with the live-subscription vs `recoverPendingSignals` (`tf-ll90.3`) wiring in scope.
2. Until the body executes deterministically on a fresh checkout, treat the UKV sim as **not yet a reliable real-agent proof** — `tf-ll90.14` must show a created run + `open_byte_pipe` + `adapter.start_or_attach` + real ACP spans, not just `DriverCompleted`.
