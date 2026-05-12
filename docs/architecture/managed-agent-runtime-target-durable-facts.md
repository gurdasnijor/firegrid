# Target Architecture: Managed-Agent Runtime Over Durable Facts

**Status:** canonical target architecture. Promoted from "proposed fork"
to canonical on 2026-05-12 (post tracer 017). The earlier
`managed-agent-runtime-target.md` was deleted as part of the same
cleanup — see `legacy-drift-inventory-2026-05-12.md` F12 for the
rationale.

**Last updated:** 2026-05-12

Source material:

- `docs/research/durable-execution-api-design-survey.md` (historical research)
- `docs/proposals/SDD_EFFECT_NATIVE_DURABLE_STREAMS_PRODUCTION_CUTOVER.md`
- `docs/tracers/010-workflow-backed-tools.md`
- `docs/tracers/012-agent-ingress-prompt-stream.md` (historical — accepted-row family deleted in tracer 017)
- `docs/tracers/013-reactive-workflow-operators.md`
- `docs/tracers/016-session-plane-input-control-surface.md`
- `docs/tracers/017-effect-durable-operators.md`

## Thesis

Firegrid is a managed durable agent runtime whose runtime behavior is driven by
durable facts. The target architecture is:

```txt
client or workflow intent
  -> durable fact stream
  -> named wait descriptor, durable time, or projection predicate
  -> runtime-host-owned operator/dispatcher
  -> @effect/workflow execution or resume
  -> follow-up durable facts through existing authority surfaces
```

The stream primitive at implementation boundaries is
`effect-durable-streams`:

```ts
const stream = DurableStream.define({
  endpoint: { url: runtimeHostStreams.input.ingress },
  schema: RuntimeIngressRowSchema,
})

yield* stream.append(row)
yield* stream.read({ live: false }).pipe(...)
yield* stream.producer({ producerId })
```

`@firegrid/durable-streams` owns Firegrid-specific Durable Streams substrate
pieces that remain real dependencies: workflow engine, state helpers, and test
infrastructure. It is not a retained-log wrapper package and should not grow
new public `DurableLog`, `DurableLogWriter`, `appendJson`,
`readRetainedJson`, or producer helper protocols.

This target protects these invariants:

- `effect-native-production-cutover.RUNTIME_IO.1`
- `effect-native-production-cutover.RUNTIME_IO.2`
- `effect-native-production-cutover.GUARDRAILS.1`
- `effect-native-production-cutover.GUARDRAILS.2`
- `effect-durable-operators.FIREGRID_PROOF.1`
- `effect-durable-operators.FIREGRID_PROOF.2`
- `firegrid-platform-invariants.AUTHORITY.8`
- `firegrid-agent-ingress.SUBSCRIBERS.1`
- `firegrid-reactive-workflow-operators.OPERATOR.1`
- `firegrid-reactive-workflow-operators.WORKFLOW.2`

## Core Model

### Durable Facts

A durable fact is a schema-owned row in a durable stream. It may be runtime
input, runtime output, required-action request/resolution, scheduled work,
spawn request, tool execution request, or operator progress.

Domain modules own:

- schema;
- IDs and idempotency keys;
- row constructors;
- pure folds;
- focused Effect programs where they encode domain behavior.

They do not own generic log objects. Reading, appending, and producing rows use
`DurableStream.define({ endpoint, schema })` directly.

### Named Wait Descriptors

A wait descriptor is durable data that says what a workflow or operator is
waiting for:

```ts
interface WaitDescriptor<Params> {
  readonly waitId: string
  readonly ownerId: string
  readonly sourceId: string
  readonly matcherId: string
  readonly matcherVersion: number
  readonly matcherParams: Params
  readonly cursor?: DurableStream.Offset
  readonly timeoutAt?: string
  readonly idempotencyKey: string
}
```

Do not persist arbitrary JavaScript predicates. A host-owned matcher registry
may turn `(matcherId, matcherVersion, matcherParams)` into a local predicate,
but the durable row stores only data. If matcher code is unavailable or
incompatible, the operator records a typed expected failure rather than
silently skipping work.

### Runtime Operators And Dispatchers

A runtime operator is a host-owned program that reacts to durable facts, durable
time, or projection predicates and drives `@effect/workflow`.

A dispatcher is the host-owned process that runs selected operators. It is not
a client API and not a workflow-specific endpoint.

```ts
interface RuntimeOperator<Fact, Payload, Error, Requirements> {
  readonly operatorId: string
  readonly sourceId: string
  readonly facts: Stream.Stream<Fact, Error, Requirements>
  readonly select: (fact: Fact) => Option.Option<Payload>
  readonly executionId: (payload: Payload) => string
  readonly execute: (input: {
    readonly payload: Payload
    readonly executionId: string
  }) => Effect.Effect<string, Error, WorkflowEngine.WorkflowEngine | Requirements>
}
```

The current snapshot-array `OperatorSource.scan` shape is acceptable as a
minimal tracer 013 proof. The target operator source should be stream-native so
retained scans and live follow do not collapse into `collect -> array -> loop`
unless the fold actually needs a retained snapshot.

### Workflow Waits

Inside workflow handlers, use `@effect/workflow` primitives directly:

- `Workflow.make` and `Workflow.toLayer` for durable workflow definitions;
- `Activity` for side-effecting work;
- `DurableClock` for durable sleeps/timers;
- `DurableDeferred` for external durable resolution;
- ordinary `Effect`, `Stream`, `Sink`, `Scope`, and `Layer`.

External clients, tools, and agents do not call `workflow.execute` through a
public Firegrid endpoint. They append facts. Operators react downstream.

## Host Config vs Client Request

The runtime host owns stream topology, workflow engine selection,
materialization strategy, provider wiring, operator set, and matcher registry.

```ts
const RuntimeHostLive = FiregridRuntimeHostLive({
  streams: {
    workflow: env.FIREGRID_WORKFLOW_STREAM_URL,
    controlPlane: env.FIREGRID_RUNTIME_CONTEXT_STREAM_URL,
    runtimeOutput: env.FIREGRID_RUNTIME_OUTPUT_STREAM_URL,
    // Tagged input capability: ingress + checkpoints are one
    // indivisible value (`RuntimeInputDurableStreams`) so misconfigured
    // half-state is unrepresentable. Omit `input` to start with no
    // ingress (`runtimeInputDisabled`).
    input: new RuntimeInputDurableStreams({
      ingress: env.FIREGRID_RUNTIME_INGRESS_STREAM_URL,
      checkpoints: env.FIREGRID_RUNTIME_INPUT_CHECKPOINTS_STREAM_URL,
    }),
    requiredActions: env.FIREGRID_REQUIRED_ACTION_STREAM_URL,
    schedules: env.FIREGRID_SCHEDULE_STREAM_URL,
    operatorProgress: env.FIREGRID_OPERATOR_PROGRESS_STREAM_URL,
  },
  workflowEngine: DurableStreamsWorkflowEngine.layer({
    streamUrl: env.FIREGRID_WORKFLOW_STREAM_URL,
  }),
  materialization: materializeStrategy({
    connection: pgConfig,
    projections: [sessionProjection(), requiredActionProjection()],
  }),
  operators: [
    requiredActionOperator(),
    runtimeIngressDeliveryOperator(),
    scheduledPromptOperator(),
    childSpawnOperator(),
  ],
  matchers: [
    runtimeOutputJsonLineMatchers(),
    requiredActionMatchers(),
    sessionProjectionMatchers(),
  ],
  providers: {
    sandboxes: [localProcessSandbox()],
    runtimes: [stdioRuntime()],
    tools: [workflowTools()],
  },
})
```

Client launch and prompt requests describe one agent or user intent:

```ts
const handle = yield* firegrid.launch({
  runtime: local.jsonl({
    argv: ["node", "agent.js"],
  }),
})

yield* firegrid.prompt({
  contextId: handle.contextId,
  payload: { type: "text", text: "Continue with the next task." },
  idempotencyKey: "user:continue:1",
})
```

Clients do not pass stream URLs, workflow engine choices, materialization
backend, operator registrations, matcher code, provider registries, or runtime
host topology.

## Target Package And Module Shape

This target prefers bounded runtime modules and provider namespaces until a
package extraction is earned. The generic durable-operator primitives
(`DurableConsumer`, `DurableTable`, `DurableProjection`,
`ConsumerCheckpointStore`) live **outside** the runtime package, in
`effect-durable-operators`. Runtime code consumes them; it does not
re-implement them.

```txt
packages/
  effect-durable-streams/
    src/
      DurableStream.ts
      Reader.ts
      Writer.ts
      Bound.ts

  effect-durable-operators/
    src/
      DurableConsumer.ts
      DurableTable.ts
      DurableProjection.ts
      ConsumerCheckpointStore.ts

  durable-streams/
    src/
      DurableStreamsWorkflowEngine.ts
      DurableState.ts
      test-utils/

  protocol/
    src/
      launch/
      runtime-context/
      runtime-ingress/
      runtime-output/
      required-action/
      session/

  runtime/
    src/
      runtime-host/
        index.ts
        input.ts                # RuntimeInputStreams tagged capability
      runtime-context/
        workflow.ts
        service.ts
        launcher.ts
      runtime-ingress/
        schema.ts
        ids.ts
        rows.ts
        local-process-stdin.ts  # uses DurableConsumer + AtMostOnce
      required-action/
        schema.ts
        rows.ts
        workflow.ts             # uses DurableConsumer / DurableTable
      scheduling/
        schema.ts
        rows.ts                 # uses DurableConsumer + workflow durable clock
      spawn/
        schema.ts
        rows.ts                 # child terminals -> DurableTable
      tools/
        workflow-tools.ts
      providers/
        sandboxes/
        runtimes/
        workspaces/
        tools/
        secrets/
      materialization/
        core/
        state-protocol/
        materialize/
```

### Existing-but-deprecated (active drift, not target shape)

These modules **exist on `main`** today and are scheduled for removal
under Lane A of the legacy-drift inventory
(`docs/architecture/legacy-drift-inventory-2026-05-12.md`). They are
NOT part of the target tree and must not be reintroduced when adding
new runtime capabilities:

```txt
packages/runtime/src/
  runtime-operators/        # bespoke DurableConsumer; Lane A folds into effect-durable-operators (F1)
  required-action/
    launcher.ts             # mini composition root; Lane A merges into FiregridRuntimeHostLive (F3)
    service.ts              # re-folds retained rows per query; Lane A migrates to DurableTable (F2)
  materialization/
    raw-fold/               # in-process strategy; kept while firegrid-materialization-engines ACIDs require it (F4)
```

A `runtime-waits/` directory has been proposed in earlier drafts but
does not currently exist; the durable-wait pattern is expected to land
as `DurableConsumer` + workflow `DurableDeferred` composition (see
`README` of `effect-durable-operators` for the wait_for sketch).

Future extraction candidates:

- sandbox providers, after a second provider creates reuse pressure;
- materialization package, after host strategy APIs stabilize;
- wait/scheduling substrate, after named wait descriptors prove ownership;
- tool provider packages, after workflow-backed tools prove the lowering.

Do not create package families for every launch slot before current code forces
the boundary.

## Durable Affordances

These APIs are exposed to workflows, tools, or managed-agent runtime code;
external clients still append launch, prompt, or decision facts through public
Firegrid surfaces and do not invoke private workflow handles.

### `wait_for(trigger, timeout?)`

Runtime capability API shape:

```ts
const event = yield* RuntimeWait.waitFor({
  waitId: `wait:${contextId}:assistant-finished`,
  trigger: RuntimeOutputTriggers.jsonLine({
    contextId,
    source: "stdout",
    matcherId: "assistant.text.includes",
    matcherVersion: 1,
    params: { text: "done" },
  }),
  timeout: "5 minutes",
  idempotencyKey: `assistant-finished:${contextId}`,
})
```

Lowering:

```txt
wait_for(trigger, timeout)
  -> append firegrid.wait.requested fact
  -> runtime wait operator reads source durable stream
  -> named matcher evaluates retained/live facts
  -> append firegrid.wait.matched or firegrid.wait.timed_out
  -> waiting workflow resumes through DurableDeferred or workflow resume
```

Implementation boundary:

```ts
const output = DurableStream.define({
  endpoint: { url: runtimeHostStreams.runtimeOutput },
  schema: RuntimeJournalEventSchema,
})

const match = output.read({ live: "long-poll", offset: trigger.cursor }).pipe(
  Stream.filter(row => row.type === "firegrid.runtime.output.stdout"),
  Stream.filter(row => row.event.contextId === trigger.contextId),
  Stream.filterMap(row => matcher.match(row)),
  Stream.runHead,
)
```

Timeouts that are externally visible must produce durable terminal facts, not
only in-memory failures.

### Required-Action And User Approval Waits

Runtime capability API shape:

```ts
const decision = yield* RequiredAction.requestAndWait({
  requiredActionId: `ra:${contextId}:${toolCallId}`,
  runtimeContextId: contextId,
  requestKind: "tool_approval",
  subject: { type: "tool-call", id: toolCallId },
  prompt: "Allow this tool call?",
  expiresAt,
})
```

Lowering:

```txt
RequiredAction.requestAndWait(...)
  -> append firegrid.required_action.requested
  -> RequiredActionWorkflow stores DurableDeferred token
  -> external resolver appends firegrid.required_action.resolved
  -> required-action operator/resolver completes DurableDeferred
  -> workflow records/returns terminal decision
```

Implementation boundary:

```ts
const requiredActions = DurableStream.define({
  endpoint: { url: runtimeHostStreams.requiredActions },
  schema: RequiredActionRowSchema,
})

yield* requiredActions.append(makeRequiredActionRequestedRow(request))

const token = yield* DurableDeferred.token(RequiredActionResolutionDeferred)
const decision = yield* DurableDeferred.await(RequiredActionResolutionDeferred)
```

Required actions are not a permissions provider, callback package, product UI,
or workflow-specific launch endpoint.

### `schedule_me(when, prompt)`

Agent/tool/workflow-facing runtime capability shape:

```ts
yield* RuntimeSchedule.scheduleMe({
  scheduleId: `schedule:${contextId}:follow-up`,
  contextId,
  when: "2026-05-11T18:00:00.000Z",
  prompt: { type: "text", text: "Check deployment status." },
  idempotencyKey: `follow-up:${contextId}:deployment`,
})
```

Lowering:

```txt
schedule_me(when, prompt)
  -> append firegrid.schedule.requested fact
  -> schedule operator waits through durable time
  -> operator appends runtime_ingress.requested via host ingress surface
  -> provider adapter routes input through effect-durable-operators.DurableConsumer
     with ClaimPolicy.AtMostOnce; the durable claim is written to the
     inputCheckpoints stream by ConsumerCheckpointStoreLive before bytes
     reach stdin
```

Implementation boundary:

```ts
const schedules = DurableStream.define({
  endpoint: { url: runtimeHostStreams.schedules },
  schema: RuntimeScheduleRowSchema,
})

yield* schedules.append(makeScheduleRequestedRow(request))

yield* DurableClock.sleep({
  name: `schedule:${request.scheduleId}`,
  duration: millisUntil(request.when),
})

yield* appendRuntimeIngress({
  contextId: request.contextId,
  kind: "message",
  authoredBy: "workflow",
  payload: request.prompt,
  idempotencyKey: request.idempotencyKey,
})
```

### `spawn(agent, prompt)` And `spawn_all`

Agent/tool/workflow-facing runtime capability shape:

```ts
const child = yield* RuntimeSpawn.spawn({
  parentContextId,
  childContextId: `ctx_child_${taskId}`,
  runtime: local.jsonl({ argv: ["node", "child-agent.js"] }),
  prompt: { type: "text", text: "Summarize these logs." },
  idempotencyKey: `spawn:${parentContextId}:${taskId}`,
})

const result = yield* RuntimeSpawn.awaitCompletion({
  childContextId: child.contextId,
  timeout: "30 minutes",
})
```

`spawn_all` is a fan-out over the same primitive:

```ts
const children = yield* Effect.forEach(tasks, task =>
  RuntimeSpawn.spawn({
    parentContextId,
    childContextId: childContextIdFor(task),
    runtime: task.runtime,
    prompt: task.prompt,
    idempotencyKey: `spawn:${parentContextId}:${task.id}`,
  }),
)

const results = yield* Effect.forEach(children, child =>
  RuntimeSpawn.awaitCompletion({ childContextId: child.contextId }),
)
```

Lowering:

```txt
spawn(agent, prompt)
  -> append child runtime-context/control fact through host runtime surface
  -> append initial runtime_ingress.requested through host ingress surface
  -> start child runtime through FiregridRuntimeHost
  -> await child terminal run fact or session projection
```

Implementation boundary:

```ts
const control = DurableStream.define({
  endpoint: { url: runtimeHostStreams.controlPlane },
  schema: RuntimeControlPlaneRowSchema,
})

const terminal = control.read({ live: "long-poll" }).pipe(
  Stream.filter(row => row.contextId === childContextId),
  Stream.filter(isTerminalRuntimeState),
  Stream.runHead,
)
```

Child spawning must call the same runtime and ingress surfaces available to
clients. It must not introduce a private workflow launch API.

### `execute(tool/sandbox, input)`

Agent/tool/workflow-facing runtime capability shape:

```ts
const output = yield* RuntimeExecute.execute({
  executionId: `exec:${contextId}:${toolCallId}`,
  contextId,
  target: { kind: "tool", name: "filesystem.write" },
  input: {
    path: "README.md",
    text: "Updated by agent.",
  },
  idempotencyKey: `tool:${toolCallId}`,
})
```

Lowering:

```txt
execute(target, input)
  -> append firegrid.execution.requested fact
  -> execution operator claims/fences idempotency key
  -> provider/tool/sandbox adapter performs live side effect
  -> append firegrid.execution.completed or firegrid.execution.failed fact
  -> waiting workflow resumes from durable result
```

Implementation boundary:

```ts
const executions = DurableStream.define({
  endpoint: { url: runtimeHostStreams.executions },
  schema: RuntimeExecutionRowSchema,
})

yield* executions.append(makeExecutionRequestedRow(request))

yield* executions.read({ live: "long-poll" }).pipe(
  Stream.filter(isTerminalExecutionFor(request.executionId)),
  Stream.runHead,
)
```

This is future work. It must not become a generic provider registry in the
client launch request.

## Materialization

Materialization remains host-owned strategy and query infrastructure. It should
not become the durable execution API.

Target shape:

```txt
runtime-output fact stream
  -> materialization EventSource
  -> EventProjector
  -> EventSink implementation
  -> queryable projection
```

Materialize, State Protocol, and raw retained folds are EventSink or
strategy implementations. They are not durable truth. Durable Streams remain
the source of runtime facts.

## What Current Code Becomes Historical Baggage

If this target is accepted, these items should be treated as cleanup candidates
or historical scaffolding:

- `packages/runtime/src/stream-native-runtime-loop/**`: DELETED in tracer 017
  along with `docs/tracers/015-stream-native-runtime-loop-validation.md` and
  `features/firegrid/stream-native-runtime-loop.feature.yaml`. Listed here
  for historical reference; the surface no longer exists.
- Snapshot-array `OperatorSource.scan`: acceptable tracer 013 proof, but target
  sources should be stream-native where live/no-gap behavior matters.
- `RequiredActionsLive`, `RequiredActionRuntimeLive`, and
  `RequiredActionStateLive`: may stay if explicitly accepted as a domain API,
  but should not be copied as a generic service pattern for waits, ingress, or
  runtime output.
- `docs/proposals/SDD_EFFECT_NATIVE_DURABLE_STREAMS_PRODUCTION_CUTOVER.md`
  examples that mention `runtime-ingress/stream.ts`,
  `runtime-ingress/folds.ts`, or `runtime-output/stream.ts`: those were
  mid-review helper shapes, not the final post-cutover target.
- `docs/tracers/012-agent-ingress-prompt-stream.md` references to
  `runtime-ingress/service.ts` or a service-backed ingress store: replace with
  schema/ids/rows and host-owned direct DurableStream programs.
- Any target-doc examples that imply `DurableStreamLog.layer`,
  `RuntimeOutput.layer`, `RuntimeIngressLive`, or `RuntimeCaptureJournalLive`.

## Decisions This Target Would Settle

1. `effect-durable-streams` is the visible durable stream primitive at
   implementation boundaries.
2. `@firegrid/durable-streams` is substrate support, not retained-log wrapper
   API.
3. Firegrid does not add `DurableLog` or `DurableLogWriter` object protocols.
4. Clients and tools append durable facts; they do not launch private workflows.
5. `wait_for`, `schedule_me`, `spawn`, `spawn_all`, and `execute` lower to
   durable facts plus runtime-host-owned operators.
6. Runtime host config owns topology, operators, matchers, workflow engine,
   materialization, and providers.
7. Client launch/prompt requests own only agent/user intent.
8. Match predicates are named/versioned data plus params, not persisted code.
9. Required actions are durable fact/workflow behavior, not a permissions
   provider package or callback plane.

## Decisions Still Open

1. Where wait request/outcome row schemas live: protocol, runtime, or a future
   wait package.
2. Whether `RequiredActions` remains an exported domain service or becomes
   functions over explicit stream endpoints.
3. How operator progress is represented durably for long-running live sources.
4. How no-gap retained snapshot plus live follow is exposed for operator
   sources when `snapshotThenFollow` is required.
5. What matcher registry shape is safe for host config without becoming a
   client provider registry.
6. Whether timeout rows are universal for all waits or only required for waits
   with externally visible behavior.
7. How concurrency and rate-limit policy attach to `spawn_all` and `execute`.
8. When materialization moves out of `@firegrid/runtime`, if ever.
9. When provider namespaces graduate from runtime-internal modules to packages.

## Next Architecture Tracers

Run stabilization/design tracers before new feature expansion:

1. **Durable Fact Wait Descriptor**: implement named matcher wait request and
   outcome rows over runtime-output, with timeout and rescan idempotency.
2. **Scheduled Runtime Ingress**: prove `schedule_me` appends durable schedule
   facts and later appends runtime ingress through the host path.
3. **Child Agent Spawn Lowering**: prove `spawn` creates a child runtime
   context, appends initial ingress, starts the child through host surface, and
   awaits durable completion.
4. **Required-Action API Shape Decision**: either keep `RequiredActions` as a
   deliberate domain service or cut it down to functions over explicit stream
   endpoints before workflow-backed tools depend on it.

Every tracer above needs scenario-level E2E proof through production package
surfaces per `firegrid-platform-invariants.PRODUCTION_SURFACE.5`.
