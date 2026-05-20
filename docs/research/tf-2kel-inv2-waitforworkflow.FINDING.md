# FINDING — tf-2kel INV-2: WaitForWorkflow as nested workflow execution

Status authority: bead `tf-2kel`. Governing input: OLA SDD
"One-Substrate" architectural de-risking — INV-2 (validates Steps 2-3).
Scope: a tiny-firegrid sim that proves the Firegrid workflow engine
handles the racing match/timeout shape natively, with NO production
wait-router involvement, NO API changes.

## Verdict — ACCEPTANCE MET (a / b / c / d)

The engine handles the shape natively. The custom `WaitForWorkflow`
defined with stock `@effect/workflow` primitives (`Workflow.make`,
`Activity.make`, `DurableDeferred.raceAll`, `DurableClock.sleep`)
executes end-to-end against a real `claude-agent-acp` agent making
real MCP `wait_for` tool calls, on a real Durable Streams test server,
with the production wait-router substrate intentionally absent from
this code path. No `@effect/workflow` or `@firegrid/runtime` API
changes were required.

The sim lives at
`packages/tiny-firegrid/src/simulations/inv2-waitforworkflow/`.

Live run: `2026-05-20T06-58-42-986Z__inv2-waitforworkflow`
(`packages/tiny-firegrid/.simulate/runs/.../trace.jsonl`,
`DriverCompleted` outcome, 18 s wall, 6 862 spans).

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

The handler captures the sim's `WorkflowEngine` context once at toolkit
layer build time and re-provides it inside every invocation, so the
toolkit's `R = never` contract is preserved. There is no involvement of
`ToolCallWorkflow`, `toolUseToEffect`, `runWaitForTool`, or
`WaitFor.match` on this path.

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

## What this does NOT prove (out of scope, owned by other INVs)

- **Restart-replay durability** (`source` replay across worker death,
  Activity attempt-reclaim semantics on the same execution). That is
  INV-3 / `tf-r5e3` and explicitly out of scope here. The seam used in
  this sim (a single sim-local engine, never restarted, fact rows
  pre-seeded before the agent calls `wait_for`) is the simplest possible
  shape; INV-3 will exercise the durability story.
- **`SourceAsOffset` payload `executionId`-deterministic offset semantics**
  — also INV-3.
- **Production replacement of `WaitFor.match`**. INV-2 is a design
  validation, not a swap. The production wait-router is left untouched
  by this sim; promoting this shape to production is a separate decision.

## Reproduction

```
pnpm --filter @firegrid/tiny-firegrid simulate:run inv2-waitforworkflow
```

Requires `ANTHROPIC_API_KEY`. Wall-clock ~18 s per run. Trace is
written to
`packages/tiny-firegrid/.simulate/runs/<runId>/trace.jsonl`.

## Trace artifact (committed)

The full per-run trace (6 862 spans, ~9 MB) is gitignored under
`packages/tiny-firegrid/.simulate/`. A focused excerpt
(`tf-2kel-inv2-waitforworkflow.trace-excerpt.jsonl`, alongside this
file) carries the load-bearing spans the verdicts above are derived
from:

- every `firegrid.sim.inv2.*` span
- `workflow_engine.workflow.register` for the WaitForWorkflow
- `workflow_engine.execution.execute` for both nested executions
- `workflow_engine.activity.execute` / `activity.claim` for the match
  Activities
- `workflow_engine.deferred.done` for both raceAll race deferreds
- `workflow_engine.clock.schedule` for both DurableClock.sleep timeouts
- a 3-span sample of `wait_router.complete_match` (sufficient to show
  the `firegrid.wait.source: AgentOutputAfter` attribution — the
  remaining 353 spans in the full trace are the same shape)
