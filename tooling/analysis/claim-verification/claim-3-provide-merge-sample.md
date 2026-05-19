# Claim 3 — Most provideMerge sites should be provide

## Claim & test (restated)

HYPOTHESIS: of the 33 `Layer.provideMerge` sites, most are unnecessary —
the merged tag isn't consumed downstream, so plain `provide` would be
behaviorally identical; the convention accreted without justification.
TEST: sample 8 sites across the 8 mandated files; for each, classify
LOAD-BEARING / REDUNDANT / UNCLEAR with downstream R-channel evidence.

**Scope note:** the full census is **33** sites
(`grep -rn 'Layer\.provideMerge' packages apps --include='*.ts' | grep
-v -e '\.test\.' -e '/test/'`). The 8 rows are a **deliberate sample,
not the census**. Conclusions about the sample are firm; extrapolation
to all 33 is explicitly bounded (see caveat).

Effect semantics used throughout: `base.pipe(Layer.provideMerge(X))`
provides `X` into `base`'s requirements **and** keeps `X` (and base ROut)
in the composite output; plain `Layer.provide(X)` discharges the
requirement but **drops `X` from output**. A site is LOAD-BEARING when a
cited downstream consumer's R-channel resolves the kept tag (or kept
base ROut) from this composition — `provide` would fail to compile or
break a deferred-context capture.

| # | site (file:line) | merged tag | downstream consumer + R-channel evidence (file:line) | class |
|---|---|---|---|---|
| 1 | `host-sdk/src/host/layers.ts:203` | `hostTables` (`RuntimeOutputTable` + sandbox-command table) | `RuntimeAgentOutputEventsLayer = Effect.map(RuntimeOutputTable,…)` (`runtime/src/agent-event-pipeline/authorities/runtime-output-journal.ts:60-62`); `RuntimeOutputTable` in exported `FiregridHost` union (`layers.ts:234`); in-file comment `layers.ts:153-167` states the binding exists solely for that downstream dependency | LOAD-BEARING |
| 2 | `host-sdk/src/host/layers.ts:264` | `session` (`CurrentHostSession`) | resolved via `Effect.map(CurrentHostSession,…)` in `Layer.unwrapEffect` siblings (`layers.ts:75,172,106-119`) sharing the `Layer.mergeAll` base (`layers.ts:251-258`); `CurrentHostSession` in exported `FiregridHost` (`layers.ts:232`); re-consumed by `HostOwnedDurableToolsWaitForLive` (`host-owned-durable-tools.ts:11`) | LOAD-BEARING |
| 3 | `host-sdk/src/host/runtime-context-workflow-support.ts:44` | `HostRuntimeObservationSubstrateLive` | support layer consumed via `Effect.provide(runtimeContextWorkflowSupportLayer(…))` (`host/commands.ts:79`, `host/agent-tool-host-live.ts:202`); workflow body does `const executor = yield* RuntimeToolUseExecutor` (`runtime-context-workflow-core.ts:239`); executor captures `DurableWait*` via `Effect.context<…>()` (`runtime-substrate.ts:94,35-39`); TFIND-031 comment (`runtime-context-workflow-support.ts:17-38`) documents `merge`/`provide` here silently breaks the layer-build-time capture | LOAD-BEARING |
| 4 | `host-sdk/src/agent-tools/execution/toolkit-layer.ts:115` | `AgentToolHost` | `toolCallWorkflowSupportLayer` consumed via `Effect.provide(...)` (`toolkit-layer.ts:174`); workflow body `toolUseToEffect` does `yield* AgentToolHost` (`tool-use-to-effect.ts:262,285,301,427,432,459,496`); in-file comment `toolkit-layer.ts:108-110` explicitly states the requirement "must be discharged here, not re-surfaced onto every MCP tool handler" | LOAD-BEARING |
| 5 | `host-sdk/src/host/mcp-host.ts:226` | `HttpServer.HttpServer` (`NodeHttpServer.layer`) | `FiregridMcpServerLayer` typed `Layer.Layer<HttpServer.HttpServer,…>` (`cli/src/bin/run.ts:412,448`); `hostAndMcpLayer` does `Layer.tap(ctx => seedContextAndPrintReady(…).pipe(Effect.provide(ctx)))` (`run.ts:455-459`); `seedContextAndPrintReady` consumes `HttpServer.addressFormattedWith` (`run.ts:383`); also `publishRuntimeContextMcpBase` consumes `HttpServer.HttpServer` (`runtime-context-mcp-base-url.ts:101,104`) | LOAD-BEARING |
| 6 | `host-sdk/src/host/runtime-substrate.ts:81` | `Layer.mergeAll(RuntimeAgentOutputEventsLayer, PerContextRuntimeAgentOutputAfterEventsLive, RuntimeControlPlaneRecorderLive)` | merged-in tags discharge base RIn (`DurableToolsWaitFor.ts:33-36`: `RuntimeWaitStreamsLive` requires `RuntimeAgentOutputEvents`); `provideMerge` preserves base ROut (`DurableWait*`/`DurableToolsTable`/wait-router) captured downstream by `RuntimeToolUseExecutorLive`'s `Effect.context<…>()` (`runtime-substrate.ts:94`) via `runtime-context-workflow-support.ts:44,47` and `toolkit-layer.ts:112` | LOAD-BEARING |
| 7 | `tiny-firegrid/src/configurations/current-pipeline.ts:192` | `WorkflowEngine.WorkflowEngine` (`WorkflowEngine.layerMemory`) | `Effect.provide(program, Layer.mergeAll(…).pipe(Layer.provideMerge(WorkflowEngine.layerMemory)))` (`current-pipeline.ts:186-194`); `program` does `const engine = yield* WorkflowEngine.WorkflowEngine` (`:160`), `engine.deferredDone(…)` (`:164`) | LOAD-BEARING |
| 8 | `apps/factory/src/host.ts:187` | `appTable` (`DarkFactoryTable`) | `DarkFactoryHostLive` → `factoryHostLayerFromConfig` (`bin/env.ts:48-60`) → `Effect.provide(program, factoryHostLayerFromConfig(...))` (`bin/live-smoke.ts:157`); `program` → `readFactoryRunStatus` (`live-smoke.ts:146`) does `const table = yield* DarkFactoryTable` (`host.ts:457,283,330,436,497`); base of the `.pipe` is only `client` (no `DarkFactoryTable` RIn) | LOAD-BEARING |

## Count & verdict

- LOAD-BEARING: **8** · REDUNDANT: **0** · UNCLEAR: **0**

Every sampled site keeps a tag (or, in #1/#6, preserves a base ROut)
that a concretely-cited downstream consumer resolves from this
composition's output — frequently through `@effect/workflow`
deferred-context captures where the `provideMerge`/`provide` distinction
is load-bearing **and explicitly documented in-code** as a hazard
against exactly this substitution (TFIND-031 comment cluster:
`runtime-context-workflow-support.ts:17-38`, `toolkit-layer.ts:101-110`,
`runtime-substrate.ts:42-65`). "Accreted without justification" is not
supported by the sample.

**Bounded-extrapolation caveat:** the mandated sample is concentrated in
the host workflow/MCP substrate — the most provideMerge-load-bearing
region by design. The verdict is evaluated on the 8-site sample as
instructed; the other 25 sites were not classified. A full census could
surface REDUNDANT cases (e.g. `cli/src/bin/host.ts:41`, `flamecast`, or
sibling `tiny-firegrid` configs not individually verified here). Per the
brief, REFUTED on the sample means no follow-up census is mandated, but
the caveat is recorded so the bound is explicit.

VERDICT: REFUTED (LOAD-BEARING 8 / REDUNDANT 0 / UNCLEAR 0)
