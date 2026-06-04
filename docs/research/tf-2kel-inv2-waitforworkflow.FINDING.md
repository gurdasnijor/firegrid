# FINDING — tf-2kel INV-2: WaitForWorkflow as nested workflow execution

Status authority: bead `tf-2kel`. Governing input: OLA SDD
"One-Substrate" architectural de-risking — INV-2 (validates Steps 2-3).
Scope: a firelab sim that proves the Firegrid workflow engine
handles the racing match/timeout shape natively, with NO production
wait-router involvement, NO API changes.

## Verdict — ACCEPTANCE MET (a / b / c / d), in two equivalent R-discharge shapes

The engine handles the shape natively. The custom `WaitForWorkflow`
defined with stock `@effect/workflow` primitives (`Workflow.make`,
`Activity.make`, `DurableDeferred.raceAll`, `DurableClock.sleep`)
executes end-to-end against a real `claude-agent-acp` agent making
real MCP `wait_for` tool calls, on a real Durable Streams test server,
with the production wait-router substrate intentionally absent from
this code path. No `@effect/workflow` or `@firegrid/runtime` API
changes were required.

This FINDING covers TWO sibling sims, each independently sufficient to
clear acceptance, that exercise the SAME `WaitForWorkflow` body shape
but discharge the `WorkflowEngine.WorkflowEngine` requirement on the
tool handler in TWO different ways. The Path A amendment (cf. PR #458
commit list) was added after the initial sim landed, to demonstrate the
@effect/workflow-canonical layer-composition shape alongside the
initial capture-and-re-provide shape — see §"R-discharge shape" below.
The recommendation for the production cutover at
`packages/host-sdk/src/agent-tools/execution/tool-use-to-effect.ts:runWaitForTool`
is the layer-composition shape.

**Cross-finding integration (PR #457 merged 2026-05-20 a445f70c — INV-3
verdict REPLAY-WORKS).** INV-2's design validation here + INV-3's
durability validation together close the SDD One-Substrate question
end-to-end: the engine handles the racing match/timeout shape natively
(INV-2), AND that shape's durability across worker bounce holds
empirically (INV-3, 345-span trace, with the in-process-scoped-bounce
bound documented). The production cutover at `tool-use-to-effect.ts`
can retire the wait-router substrate in the same transaction it swaps
`WaitFor.match → engine.execute(WaitForWorkflow, ...)`; see the
"Recommendation for the SDD production cutover" section below for the
concrete file/line changes and the residual-risk note carried forward
from INV-3's documented bound.

| Sim folder                                                                       | R-discharge shape         | Live run id                                          |
|---|---|---|
| `packages/firelab/src/simulations/inv2-waitforworkflow/`                   | capture-and-re-provide    | `2026-05-20T06-58-42-986Z__inv2-waitforworkflow`         |
| `packages/firelab/src/simulations/inv2-waitforworkflow-layered/`           | layer-composition (canonical) | `2026-05-20T07-15-23-072Z__inv2-waitforworkflow-layered` |

Both runs: `DriverCompleted`, ~18–19 s wall, ~6 800 spans, all four
acceptance criteria met identically.

## Acceptance verdicts (against bead tf-2kel)

**(a) Agent's `wait_for` tool calls succeed via the nested workflow
execution path.** ✅

Single tool name surfaced on the agent: `wait_for` (count: 1 distinct
`firegrid.agent_output.tool_name` value, exactly the prompted name from
the sim's lone custom MCP server — production `wait_for` was not
injected because the runtime config carries `runtimeContextMcp` NEITHER
SET nor `enabled: true`).

Sim handler invocations: `firegrid.sim.inv2.wait_for_tool` span
count = 2 — exactly matching the prompt's two `wait_for` calls
(`inv2-call-a` / `inv2-call-b`).

Engine dispatches: `firegrid.workflow_engine.execution.execute` count
for `firegrid.workflow.name = firegrid.sim.inv2.wait-for-workflow` = 2.

Agent emitted the prompt-stipulated terminal marker `FIREGRID_INV2_DONE`
exactly once. The driver loop observed it, returned `sawResultMarker:
true`, the sim terminated cleanly.

**(b) trace shows `DurableDeferred.raceAll` firing + Activity result
records being written.** ✅

`firegrid.workflow_engine.activity.execute` for activity name
`wait-for-workflow.match/inv2-call-{a,b}` = 2 — both Activity result
records are written (one per nested workflow execution; an Activity
result record on the `activities` table is the durable artifact of a
successful Activity exit per
`packages/runtime/src/workflow-engine/internal/table.ts`).

`firegrid.workflow_engine.deferred.done` for deferred name pattern
`wait-for-workflow.race/*` = 2 — the `DurableDeferred.raceAll` race
deferred received a `done` (Match outcome) for each of the two
executions. (`@effect/workflow/DurableDeferred.raceAll` writes the
first-completer's exit to the race deferred; that this fires per
execution end-to-end is the direct evidence the racing primitive works
inside our engine without any plumbing.)

`firegrid.workflow_engine.clock.schedule` for clock name
`wait-for-workflow.timeout/*` = 2 — the loser side of each race
(the `DurableClock.sleep`) was durably scheduled, exactly as the body
declares.

(`activity.claim` count = 6 = 2 executions × 3 phases —
register/start/finish — typical for a clean Activity lifecycle on this
engine.)

**(c) NO `firegrid.durable_tools.wait_router.complete_match` spans
emitted for the `wait_for` tool path.** ✅

Total `complete_match` spans in the trace: 356. Broken down by
`firegrid.wait.source` attribute:

| `firegrid.wait.source` | count |
|---|---|
| `AgentOutputAfter`     | 356 |
| `CallerFact`           |   0 |

All 356 `complete_match` spans are `AgentOutputAfter` — these come from
the production runtime-context workflow resolving `session.wait.forAgentOutput(...)`
calls the **driver** makes (the empirical poll loop on the public client
surface). They are NOT on the `wait_for` tool path; they are the
substrate behind `session.wait.forAgentOutput`, which is a separate
production surface this sim has no reason to disable.

The load-bearing observation is the zero in the `CallerFact` row: the
production wait-router never resolved a `wait_for` tool call against
the `inv2-waitforworkflow.facts` CallerFact stream — because no
`WaitFor.match` was invoked on that source, no wait row was written
into the wait table, and the router had no wait to attach. The
nested-workflow path owns the entire match/timeout resolution.

`firegrid.wait.family` distribution on the 356 spans:
`output-after` = 300 (the remaining 56 are unannotated spans from the
same source family). Consistent with the AgentOutputAfter-only
attribution above.

**(d) The engine handles this shape natively with no API changes.** ✅

The sim builds entirely on existing exported APIs:

- `Workflow.make({ name, payload, success, idempotencyKey })` from
  `@effect/workflow`
- `Workflow.toLayer(body)` to register the body against the engine
- `Activity.make({ name, success, execute })`
- `DurableDeferred.raceAll({ name, success, error: Schema.Never, effects })`
- `DurableClock.sleep({ name, duration, inMemoryThreshold })`
- `CallerOwnedFactStreams` from `@firegrid/host-sdk` (the host
  composition's resolver from CallerFact stream name → concrete
  `Stream<unknown, unknown>`)
- `DurableStreamsWorkflowEngine.layer({ streamUrl, workerId })` from
  `@firegrid/runtime/workflow-engine` for the sim-local engine
- `@effect/ai/McpServer.layerHttp` + `Toolkit.make` /
  `Tool.make` / `Toolkit.toLayer` for the sim's custom one-tool MCP
  server bound on a sim-local loopback port

Production touched (read-only): zero edits to `packages/runtime`,
`packages/host-sdk`, `packages/client-sdk`, `packages/host-sdk/test`,
or `packages/runtime/test`.

## How the agent's `wait_for` reaches `WaitForWorkflow.execute`

The agent (`@agentclientprotocol/claude-agent-acp@0.36.1`) is launched
via `local.jsonl({...})` with TWO deliberate config choices:

1. **`runtimeContextMcp` NOT set** — the host's codec start path
   (`packages/host-sdk/src/host/runtime-context-session/codec-adapter.ts`
   §`resolveEffectiveMcpServers`) only injects the production
   `firegrid-runtime-context` MCP server (which would expose the
   production `wait_for` lowering onto `WaitFor.match`) when
   `runtimeContextMcp.enabled === true`. With it omitted, no production
   tool surface is attached.
2. **`mcpServers: [{ name: "firegrid-sim-inv2-wait-for-workflow", server:
   { type: "url", url: "http://127.0.0.1:14773/mcp" } }]`** — the sim's
   custom MCP server is the agent's ONLY MCP-side tool source.

The sim's custom MCP server (`mcp-server.ts`) exposes one tool, named
`wait_for`, with the same `waitQuery / whereFields / timeoutMs`
input shape as the production `WaitForToolInputSchema` plus an explicit
`executionKey` the agent supplies per call (each nested execution is
keyed off this so the engine treats them as distinct workflow
executions). The tool handler:

```
input → WaitForWorkflow.execute({ executionKey, stream, whereFields,
                                  timeoutMs })
      → { matched: true, event: outcome.raw }     // Match
        | { matched: false, timedOut: true }      // Timeout
```

How the `WorkflowEngine` requirement on `WaitForWorkflow.execute` is
discharged into that handler — capture vs layer-composition — is the
subject of §"R-discharge shape" below. The two sibling sims differ
ONLY in that mechanism; neither involves `ToolCallWorkflow`,
`toolUseToEffect`, `runWaitForTool`, or `WaitFor.match` on the
`wait_for` tool path.

## How `WaitForWorkflow` is composed

```
WaitForWorkflow = Workflow.make({
  name: "firegrid.sim.inv2.wait-for-workflow",
  payload: { executionKey, stream, whereFields, timeoutMs },
  success: Match { raw } | Timeout,
  idempotencyKey: ({ executionKey }) => executionKey,
})

WaitForWorkflow.toLayer(({ executionKey, stream, whereFields, timeoutMs }) => {
  const matchActivity = Activity.make({
    name: `wait-for-workflow.match/${executionKey}`,
    success: Schema.Unknown,
    execute: Effect.gen(function*() {
      const streams = yield* CallerOwnedFactStreams
      const source = streams.streamFor(stream)
      const first = yield* Stream.runHead(
        source.pipe(Stream.filter(row => matchesTrigger(row, whereFields))),
      )
      return Option.match(first, { onNone: () => null, onSome: row => row })
    }).pipe(Effect.orDie),                     // stream errors are defects
  })

  return DurableDeferred.raceAll({
    name: `wait-for-workflow.race/${executionKey}`,
    success: WaitForWorkflowOutcomeSchema,
    error: Schema.Never,
    effects: [
      matchActivity.pipe(Effect.map(raw => ({ _tag: "Match", raw }))),
      DurableClock.sleep({
        name: `wait-for-workflow.timeout/${executionKey}`,
        duration: Duration.millis(timeoutMs),
        inMemoryThreshold: Duration.zero,
      }).pipe(Effect.as({ _tag: "Timeout" })),
    ],
  })
})
```

The body shape matches the OLA SDD pseudocode directly:
`DurableDeferred.raceAll([Activity(Stream.runHead(source.filter(trigger))),
DurableClock.sleep(timeoutMs)])`. The `source.filter(trigger)` is
expressed inside the `Activity` as `source.pipe(Stream.filter(...))`
because the host-composition resolver returns a stream and `Stream.filter`
is the idiomatic predicate combinator.

## Host composition

The sim host (`host.ts`):

- Defines its own `Inv2FactTable extends DurableTable("inv2WaitForWorkflowFacts",
  { facts: FactRowSchema })`, seeds 4 rows (2 matching: one each for
  `inv2-corr-a` / `inv2-corr-b`; 2 decoys: wrong `correlationId` /
  wrong `eventType`).
- Provides `CallerOwnedFactStreams` resolving the table's
  `facts.rows()` stream behind the stream name
  `inv2-waitforworkflow.facts`.
- Provides `FiregridLocalHostLive` for agent runtime (subprocess
  launch / journal / per-context engine).
- Provides `SimWaitForMcpServerLayer` (loopback 127.0.0.1:14773, path
  `/mcp`), which carries `CallerOwnedFactStreams` into the
  `WaitForWorkflow`-body Activity through the layer dependency chain.

The Path-A-amendment sibling sim `inv2-waitforworkflow-layered/`
mirrors this exactly, with three localized renames so the two sims can
coexist on the same Durable Streams test server:
fact stream name `inv2-waitforworkflow-layered.facts`,
DurableTable key `inv2WaitForWorkflowLayeredFacts`, MCP loopback port
14774, MCP server name `firegrid-sim-inv2-wait-for-workflow-layered`,
execution keys `inv2-layered-call-{a,b}`, marker
`FIREGRID_INV2_LAYERED_DONE`.

## R-discharge shape: capture-and-re-provide vs layer-composition

The `wait_for` tool handler must somehow have `WorkflowEngine.WorkflowEngine`
in scope when it calls `WaitForWorkflow.execute(...)`. There are two
shapes that work; this FINDING demonstrates BOTH against the same
workflow body and records that they produce identical observable
outcomes. The recommendation for the production cutover is shape #2,
on the grounds that it's the @effect/workflow-canonical shape.

### Shape 1 — Capture-and-re-provide  (sim: `inv2-waitforworkflow`)

`Tool.make` declares NO dependencies; the handler's static R is `never`.
The toolkit Layer build captures `Effect.context<WorkflowEngine.WorkflowEngine>()`
once and the handler re-provides it per invocation:

```ts
const SimWaitForToolkitLayer = SimWaitForToolkit.toLayer(
  Effect.map(
    Effect.context<WorkflowEngine.WorkflowEngine>(),
    (captured) => ({
      wait_for: (input): Effect.Effect<Success, Failure /* R = never */> =>
        Effect.gen(function*() {
          const outcome = yield* WaitForWorkflow.execute({...})
          return ...
        }).pipe(Effect.provide(captured)),   // <-- re-provide the captured engine
    }),
  ),
)
```

The engine is in scope by virtue of the toolkit Layer being built UNDER
a layer chain that already includes the engine. `Effect.context<…>()`
is the seam; the closure carries the engine to every later invocation.

### Shape 2 — Layer-composition  (sim: `inv2-waitforworkflow-layered` — CANONICAL)

`Tool.make` declares `dependencies: [WorkflowEngine.WorkflowEngine]`;
the handler's static R is `WorkflowEngine.WorkflowEngine`. The handler
body does NOT capture and does NOT re-provide. The layer chain
provides the engine via `Layer.provideMerge` at one place, satisfying
the engine requirement for BOTH the handler AND the workflow body
registration:

```ts
const SimWaitForTool = Tool.make("wait_for", {
  ...,
  dependencies: [WorkflowEngine.WorkflowEngine],   // <-- canonical R declaration
})...

const SimWaitForToolkitLayer = SimWaitForToolkit.toLayer({
  wait_for: (input): Effect.Effect<Success, Failure, WorkflowEngine.WorkflowEngine> =>
    Effect.gen(function*() {
      const outcome = yield* WaitForWorkflow.execute({...})   // <-- engine resolved from ambient
      return ...
    }),
})

return Layer.mergeAll(
  Layer.scopedDiscard(McpServer.registerToolkit(SimWaitForToolkit)),
  HttpRouter.Default.serve(),
  WaitForWorkflowLayer,                              // <-- requires WorkflowEngine
).pipe(
  Layer.provide(SimWaitForToolkitLayer),             // <-- also requires WorkflowEngine (Tool.dependencies)
  Layer.provideMerge(engineLayer),                   // <-- single point of provision; satisfies BOTH
  Layer.provide(McpServer.layerHttp({...})),
  Layer.provide(NodeHttpServer.layer(createServer, {...})),
  Layer.provide(Logger.remove(Logger.defaultLogger)),
)
```

This is exactly the shape @effect/workflow uses in its own test suite
at `repos/effect/packages/workflow/test/WorkflowEngine.test.ts:14-23`
(vendored mirror of the upstream
[`Effect-TS/effect WorkflowEngine.test.ts:94`](https://github.com/Effect-TS/effect/blob/main/packages/workflow/test/WorkflowEngine.test.ts#L94)):

```ts
Effect.provide(LongWorkflowLayer.pipe(
  Layer.provideMerge(WorkflowEngine.layerMemory)
))
```

— workflow body layer composed with `Layer.provideMerge(engineLayer)`,
then provided to the consuming Effect. The handler just calls
`LongWorkflow.execute(...)` and the engine is resolved through the
ambient Effect context exactly like any other service.

### Side-by-side

|                                            | Capture-and-re-provide                                           | Layer-composition (canonical)                              |
|---|---|---|
| `Tool.make` `dependencies`                  | unset                                                            | `[WorkflowEngine.WorkflowEngine]`                          |
| Handler `R` (static)                       | `never`                                                          | `WorkflowEngine.WorkflowEngine`                            |
| Handler body                                | captures ambient at layer-build, `Effect.provide` per call       | direct call, engine resolved from ambient                  |
| Engine provision site                       | INSIDE the toolkit layer (closure of captured context)           | OUTSIDE the toolkit layer (`Layer.provideMerge(engineLayer)`) |
| Same engine for handler + workflow body?   | Yes (must be — both captured under the same layer chain)         | Yes (provided once at `provideMerge` boundary)             |
| `@effect/workflow` test-suite usage         | not used in upstream tests                                       | `WorkflowEngine.test.ts:14-23` (`Layer.provideMerge(WorkflowEngine.layerMemory)`) |
| Tool dependency relationship type-tracked? | no (handler's static R = `never`)                                | yes (Tool.dependencies → handler R = WorkflowEngine)       |

### Empirical equivalence

Both sims drive the same agent (`claude-agent-acp@0.36.1`) through the
same prompt (modulo a name disambiguation marker), against the same
seeded CallerFact stream shape, dispatching the same `WaitForWorkflow`
definition. Acceptance counts are identical (per-execution multiples,
not totals, are the meaningful comparison — driver-side
`session.wait.forAgentOutput` poll-count varies run-to-run for
unrelated reasons):

| Per-execution-multiple                                                                    | inv2-waitforworkflow | inv2-waitforworkflow-layered |
|---|---|---|
| `firegrid.sim.inv2{,_layered}.wait_for_tool` spans                                        | 2                    | 2                            |
| `workflow_engine.execution.execute` (workflow `firegrid.sim.inv2.wait-for-workflow`)      | 2                    | 2                            |
| `workflow_engine.activity.execute` (`wait-for-workflow.match/...`)                        | 2                    | 2                            |
| `workflow_engine.deferred.done` (`wait-for-workflow.race/...`)                            | 2                    | 2                            |
| `workflow_engine.clock.schedule` (`wait-for-workflow.timeout/...`)                        | 2                    | 2                            |
| `wait_router.complete_match` with `firegrid.wait.source = CallerFact`                     | 0                    | 0                            |
| Terminal marker text-chunk count                                                          | 1                    | 1                            |
| Run wall-clock                                                                            | ~18 s                | ~19 s                        |
| Run outcome                                                                                | `DriverCompleted`    | `DriverCompleted`            |

Same outcomes by every observable measure; the shape of how
`WorkflowEngine` reaches the handler is a layer-composition choice
with no runtime-behavior implication. Restart-replay equivalence is
implied (both shapes hand the engine to identical workflow body code,
which is what restart re-attaches against — durable state lives in
`firegrid.workflow.*` durable tables, not in the toolkit closure or
the layer chain) but INV-3 / `tf-r5e3` will exercise it empirically.

### Recommendation for the SDD production cutover

When the SDD's One-Substrate Steps 2-3 land at
`packages/host-sdk/src/agent-tools/execution/tool-use-to-effect.ts:runWaitForTool`,
prefer the layer-composition shape (Shape 2). Reasons:

1. **It's the canonical shape.** `@effect/workflow`'s own tests use
   `Layer.provideMerge(WorkflowEngine.layerMemory)` against workflow
   body layers; the production cutover should not pioneer a different
   convention.
2. **The dependency relationship is type-tracked.** `Tool.dependencies`
   makes the handler's engine requirement statically visible to
   `Toolkit.HandlersFrom`. Capture-and-re-provide hides this in a
   closure; it works but cannot be relied on by external code.
3. **No internal Effect-context plumbing.** The handler body is a
   normal Effect over a normal service requirement, with no
   `Effect.context<…>()` capture seam or `Effect.provide(captured)`
   per call. Future readers don't need to know why the closure
   construction exists.
4. **The engine is provisioned at one explicit place.** The host
   composition's `Layer.provideMerge(engineLayer)` is the obvious
   answer to "where does the engine come from?" — the same answer
   for the workflow body registration and for the tool handler. With
   capture-and-re-provide, the answer for the tool handler is "look
   inside the toolkit-layer closure, not the layer chain."

The production tool-use-to-effect.ts cutover should:

- Add `dependencies: [WorkflowEngine.WorkflowEngine]` to the production
  `WaitForTool` definition in
  `packages/host-sdk/src/agent-tools/bindings/tools.ts` (the existing
  `FiregridToolDependencies` set already encodes the same convention
  for `FiregridAgentToolContext` and `IdGenerator.IdGenerator`).
- Replace `runWaitForTool`'s `WaitFor.match(...)` body with
  `engine.execute(WaitForWorkflow, ...)` per the SDD.
- Compose `WaitForWorkflowLayer` (the body registration) alongside the
  existing `ToolCallWorkflowLayer` under
  `HostRuntimeObservationSubstrateLive` in
  `packages/host-sdk/src/host/runtime-substrate.ts`, OR — preferably —
  drop `ToolCallWorkflowLayer` entirely if the SDD's One-Substrate
  conclusion is that the wrapper workflow becomes unnecessary once
  `wait_for` dispatches a real nested workflow.
- **Retire the wait-router substrate in the SAME transaction.**
  INV-3 has now landed (see "Restart-replay durability" below); the
  REPLAY-WORKS verdict closes the durability gap that previously
  gated this. The wait-router (`packages/runtime/src/durable-tools/
  internal/wait-router.ts`), the durable-wait-store, and the
  registration-replay machinery (`startRouter`, the
  `HostOwnedDurableToolsWaitForLive` layer chain in
  `packages/host-sdk/src/host/host-owned-durable-tools.ts`) have no
  remaining non-redundant role on the `wait_for` path once
  `engine.execute(WaitForWorkflow, ...)` is doing the work — the
  engine's own `WorkflowExecutionRow` / `WorkflowActivityRow` /
  `WorkflowDeferredRow` / `WorkflowClockWakeupRow` tables are the
  durable artifact, and `engine.resume` on restart re-attaches the
  execution against those tables (which is exactly what INV-3
  exercised with a 345-span trace across in-process scoped-host-bounce).
  The one residual-risk note for that retirement is the documented
  INV-3 bound — see below — which is not blocking for the cutover
  but should be acknowledged in its PR description.

The capture-and-re-provide shape (Shape 1) remains a valid local
fallback for ad-hoc test harnesses and one-off sims; the sibling
sim file is kept as a side-by-side reference, not as a precedent
worth following in production.

## Engine-shape observations worth keeping

1. **`Activity.make` cleanly hosts a long-blocking Stream.runHead**.
   The Activity remained running for the wall time it took the agent to
   ask permission + the engine to schedule + the durable observation to
   replay; the engine wrote ONE `activity.execute` span per execution
   (no retry-storm, no spurious timeouts on the Activity side itself).
2. **The race deferred resolves on the match side cleanly**. Two
   `deferred.done` events with deferred name matching `wait-for-workflow.race`
   — both Match outcomes (the seeded rows were already present, so
   `Stream.runHead` completed before the 30 s sleep). `Schema.Never`
   on the error channel held; no error-side propagation needed.
3. **`DurableClock.sleep` scheduled but did not fire** (deadline
   30 s, actual race resolution <20 s wall total for both calls). The
   "losing" sleep was canceled by `raceAll`'s underlying `Effect.raceAll`
   semantics — no `clock.fire` span for either timeout, exactly what a
   match-side win should produce.

## What this does NOT prove (in this sim)

- **Restart-replay durability** is not exercised by THIS sim — the
  INV-2 seam is a single sim-local engine, never restarted, fact rows
  pre-seeded before the agent calls `wait_for`. That is by design;
  durability is INV-3's scope.

  → **INV-3 has landed and the verdict is REPLAY-WORKS.** See
  `docs/research/tf-r5e3-inv3-waitforworkflow-restart-replay.FINDING.md`
  (PR #457, merged a445f70c, 2026-05-20). Self-contained
  `inv3-restart-replay` sim, 345-span trace evidence across in-process
  scoped-host-bounce: already-written replay returns the same value,
  live-after-restart resubscribes for next match, timeout deadline
  preserved across restart. All 4 OLA acceptance criteria met.

  **Documented bound** (carried forward into the cutover risk
  register): stock firelab runner has no OS process-kill /
  restart API, so the sim closes/rebuilds scoped host generations
  against the same Durable Streams URLs (the `env.stopSignal` route
  from OLA's acceptance spec). REPLAY-WORKS is established
  empirically for in-process scoped-bounce; OS-level process-kill
  bounce remains an unexercised-but-not-disproven case. The engine's
  durable artifacts (workflow execution / activity / deferred / clock
  tables in Durable Streams) are the same in either bounce mode, so
  the gap is a runner-shape gap, not an engine-shape gap.

- **`SourceAsOffset` payload `executionId`-deterministic offset
  semantics** — also covered by INV-3 (see PR #457 FINDING for the
  source-position determinism evidence).

- **Production replacement of `WaitFor.match`**. INV-2 is a design
  validation, not a swap. The production wait-router is left untouched
  by this sim; promoting this shape to production is a separate PR
  whose scope is now clear (see §"Recommendation for the SDD
  production cutover" above, including the wait-router-retirement
  bullet point that INV-3's REPLAY-WORKS verdict unlocks).

## Reproduction

```
pnpm --filter firelab simulate:run inv2-waitforworkflow
pnpm --filter firelab simulate:run inv2-waitforworkflow-layered
```

Requires `ANTHROPIC_API_KEY`. Wall-clock ~18–19 s per run. Traces are
written to
`packages/firelab/.simulate/runs/<runId>/trace.jsonl`.

## Trace artifacts (committed)

The full per-run traces (each ~6 800 spans, ~9 MB) are gitignored
under `packages/firelab/.simulate/`. Two focused excerpts
alongside this file carry the load-bearing spans the verdicts above
are derived from:

- `tf-2kel-inv2-waitforworkflow.trace-excerpt.jsonl` —
  capture-and-re-provide variant (`firegrid.sim.inv2.*` namespace).
- `tf-2kel-inv2-waitforworkflow-layered.trace-excerpt.jsonl` —
  layer-composition variant (`firegrid.sim.inv2_layered.*` namespace).

Each excerpt includes:

- every `firegrid.sim.inv2{,_layered}.*` span (sim's own observability)
- `workflow_engine.workflow.register` for the WaitForWorkflow
- `workflow_engine.execution.execute` for both nested executions
- `workflow_engine.activity.execute` / `activity.claim` for the match
  Activities
- `workflow_engine.deferred.done` for both raceAll race deferreds
- `workflow_engine.clock.schedule` for both DurableClock.sleep timeouts
- a 3-span sample of `wait_router.complete_match` (sufficient to show
  the `firegrid.wait.source: AgentOutputAfter` attribution — the
  remaining ~350 spans per run in the full trace are the same shape)
