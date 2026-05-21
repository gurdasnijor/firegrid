# SDD: Workflow-Driven Runtime Planes

Doc-Class: historical-reference
Status: historical — references the `firegrid-durable-tools` plane, which was
deleted (PR #519). Channel binding is now the host-plane channel router
(`docs/sdds/SDD_FIREGRID_HOST_PLANE_CHANNEL_ROUTER.md`) and durable suspension
is owned by the one-substrate workflow engine. This proposal was previously
listed as "current direction" in `docs/README.md`; it no longer is. Do not
dispatch from it. Not in `docs/cannon/README.md`.
Date: 2026-05-13

Status (original): Proposal, docs-only. This SDD is a candidate simplification of
`SDD_FIREGRID_RUNTIME_HOST_DISPATCHER_AND_CLAIMS.md`, not an implementation
authorization.

Blocked by:

- DurableTable hardening currently in progress.
- A focused review of whether the existing workflow activity-claim mechanism
  can be the single execution fence for runtime-host side effects.

Related:

- `SDD_FIREGRID_RUNTIME_HOST_DISPATCHER_AND_CLAIMS.md`
- `PROPOSAL_DURABLE_CLAIM_PRIMITIVE_2026-05-13.md`
- `SDD_FIREGRID_DURABLE_TOOLS.md`
- `docs/reviews/REVIEW_POST_DURABLETABLE_CLEANUP_FOLLOWUPS_2026-05-13.md`
- `workflow-engine-durable-state.feature.yaml`
- `firegrid-durable-tools.feature.yaml`
- `firegrid-workflow-driven-runtime.feature.yaml`

## Thesis

Firegrid should prefer **workflow execution** as the runtime coordination plane
when the work already has durable orchestration semantics.

Instead of introducing a separate runtime-host dispatcher with its own
context-ownership mutex, model host supervision and runtime-context lifecycle
as durable workflows:

```txt
HostWorkflow(hostId)
  observes eligible RuntimeContext rows
  starts or resumes RuntimeContextWorkflow(contextId)

RuntimeContextWorkflow(contextId)
  owns the lifecycle of one runtime context
  performs side effects through workflow activities
  records user-visible runs, output, ingress, and terminal evidence
```

The load-bearing claim is: **workflow activity claims are already the
one-host-at-a-time side-effect fence**. If the runtime-context lifecycle is
modeled as workflow activities, then separate `DurableKeyedMutex<contextId>`
ownership may be unnecessary for the normal context-execution path.

## Why Revisit The Dispatcher/Mux Proposal

The dispatcher SDD correctly identified a real bug class: multiple hosts can
observe the same context row and start live side effects. Its proposed fix was
a durable context-ownership primitive (`DurableKeyedMutex<contextId>`).

That may still be necessary for non-workflow side effects. But Firegrid now has
a DurableTable-backed workflow engine whose activity-claim path already exists
to prevent duplicate activity execution across workers. If every live runtime
side effect is inside a workflow activity, then the workflow engine can be the
coordination boundary:

```txt
many hosts may resume the same workflow
only the host that wins the activity claim performs the activity side effect
losing hosts suspend / observe progress
```

That is a simpler model than building a second ownership subsystem beside the
workflow engine.

## Plane Model

This SDD separates durable planes by responsibility.

| Plane | Durable owner | What it means | What it must not do |
|---|---|---|---|
| Host plane | `HostWorkflow(hostId)` plus optional host evidence rows | Supervises a host process, advertises capability, observes eligible contexts, starts/resumes child context workflows | Own product-specific session semantics or perform side effects outside workflow activities |
| Runtime context plane | `RuntimeContextWorkflow(contextId)` | Durable lifecycle of one launched runtime context | Depend on app-local watchers or in-memory sets for correctness |
| Session plane | product/app workflow or child context workflow | Product-level conversation/session state, waits, tool decisions, child spawns | Recreate host dispatch or runtime delivery policy |
| Ingress plane | `RuntimeIngressTable` plus workflow activity/wait integration | User prompts and runtime input intents | Emit bytes before durable claim/workflow activity coordination |
| Output plane | `RuntimeOutputTable` | User-visible runtime events/logs/output facts | Act as execution authority |
| Workflow engine plane | `WorkflowEngineTable` | Orchestration state, deferreds, clocks, activity claims | Become a public substrate package or app-owned control plane |

The design principle is:

```txt
tables record intent/evidence
workflows own orchestration
activities own live side effects
activity claims fence side effects
```

## Proposed Workflow Hierarchy

### `HostWorkflow(hostId)`

One long-running workflow per physical host or host process identity.

Responsibilities:

- record host start/readiness evidence if needed;
- watch or wait for eligible `RuntimeControlPlaneTable.contexts` rows;
- apply host capability filters;
- start/resume `RuntimeContextWorkflow(contextId)` for eligible contexts;
- enforce per-host local capacity with ordinary in-memory `Semaphore` if
  needed;
- periodically heartbeat or retire host evidence if product requirements need
  liveness visibility.

Non-responsibilities:

- directly starting sandbox processes;
- claiming context ownership with a separate mutex;
- writing runtime output except through child context workflow activities;
- embedding product session logic.

### `RuntimeContextWorkflow(contextId)`

One workflow execution per runtime context.

Responsibilities:

- read the context row by `contextId`;
- record run started/exited/failed rows;
- run the external runtime effects through a workflow activity;
- complete when the runtime context reaches a terminal state;
- resume safely after host restart.

The workflow execution id should be the context id:

```txt
executionId = contextId
workflowName = firegrid.runtimeContext
```

This gives the durable workflow engine one stable key for the context's
orchestration history.

### `runRuntimeContext` Activity

The runtime-context workflow should **not** model every inbound message as a
separate workflow activity. That would make chatty agent sessions pay activity
claim/write overhead per prompt fragment or input row.

The preferred activity granularity is one long-lived `runRuntimeContext`
activity per runtime attempt:

```txt
RuntimeContextWorkflow(contextId)
  upsert run started evidence
  run runRuntimeContext(contextId, attempt)
  upsert run terminal evidence

runRuntimeContext(contextId, attempt)
  start the opaque execution target
  subscribe to RuntimeIngressTable.inputs
  deliver stdin bytes with per-input durable delivery checkpoints
  write RuntimeOutputTable rows with deterministic output keys
  observe process exit and return exit evidence
```

That keeps the live execution target and its streaming IO inside the workflow
activity fence, while keeping per-message delivery as an internal durable
stream/checkpoint loop instead of a workflow activity per message.

The activity claim gates the `runRuntimeContext` effect itself: only one host
performs the external runtime side effects for a given `(contextId, attempt)`
at a time. The delivery checkpoint gates each input row inside that activity so
a retry or restart can replay retained inputs without re-emitting bytes that
were already durably claimed.

This is a deliberate hybrid:

- workflow activity claim = one-host-at-a-time external runtime effects;
- `RuntimeIngressTable.deliveries` = per-input AtMostOnce delivery evidence;
- `RuntimeOutputTable` = deterministic output evidence written by the activity.

The alternative "one delivery activity per input row" is not the default
design. It may be useful for coarse tool calls, but it is too heavyweight for
normal agent message streams.

### Session / Tool Workflows

Product sessions can either:

- live inside the runtime-context workflow when the session is exactly one
  context; or
- become child workflows spawned by the runtime-context workflow when the
  product needs durable fan-out, child agents, `schedule_me`, or long-running
  tool orchestration.

The session plane should not create another host ownership model. It should use
workflow child execution, `wait_for`, `DurableClock`, and activities.

### Durable Wait / Trigger / Schedule Semantics

A key proof for this proposal is whether it collapses the durable-tools design
space onto workflow primitives instead of requiring parallel routers for every
tool.

The target mapping is:

| Capability | Workflow-native shape | Extra table/router needed? |
| --- | --- | --- |
| `sleep(durationMs)` | `DurableClock.sleep(...)` inside the workflow | No |
| `schedule_me(when, prompt)` | persist intent in workflow state, `DurableClock.sleep` until `when`, then append runtime input | No separate timer table |
| `wait_for(trigger, timeoutMs?)` | race a table-match deferred against `DurableClock.sleep` | Only a table-trigger-to-deferred adapter |
| `spawn(agent, prompt)` | child workflow execution + parent await/poll | No host dispatcher |
| `spawn_all(tasks)` | N child workflow executions + workflow aggregation | No fanout service unless product evidence requires one |
| `execute(sandbox, input)` | workflow activity around the external side effect | No separate claim path if the activity claim suffices |

This is the strongest reason to prefer the workflow-driven model: durable
time, suspension, replay, and child execution already exist in
`@effect/workflow` and are backed by `WorkflowEngineTable`. Firegrid should not
rebuild those semantics in `packages/runtime/src/durable-tools` unless a
specific capability cannot be expressed through workflow primitives.

Under this model, `packages/runtime/src/durable-tools` is provisional and
small. Its only clear job is the bridge for table-trigger waits:

```txt
DurableTable source row matches trigger
  -> router writes wait completion evidence
  -> router resolves Workflow DurableDeferred
  -> workflow resumes and decodes at the call site
```

Everything temporal should prefer `DurableClock` directly. Everything that
starts or owns side effects should prefer workflow activities. Everything that
spawns or aggregates work should prefer child workflows.

Effect `Schedule` is still useful here, but as the expression language for
recurrence/backoff/calendar policy, not as the durable sleeper by itself.
`Schedule.driver(...).next(...)` stores its driver state in memory and sleeps
through the normal Effect clock. Firegrid's durable shape should be:

```txt
Effect Schedule computes the next delay/deadline
  -> Workflow persists the scheduling intent/state
  -> DurableClock.sleep(...) durably suspends until that deadline
  -> Workflow resumes and runs the next scheduled step
```

Do not use `effect/Scheduler` as the durable scheduling abstraction. That
module is the runtime task scheduler for fiber execution (`scheduleTask`,
`shouldYield`), not the product-level temporal model. Durable product time
belongs in `WorkflowEngineTable.clockWakeups` through `DurableClock`.

## Durability Semantics By Plane

### Host Semantics

- Host process startup is not itself durable; host workflow state is durable.
- Restarting the same host identity resumes `HostWorkflow(hostId)`.
- Multiple hosts may observe the same context intent.
- The host workflow is allowed to duplicate **resume requests**, because
  duplicate resume requests are not side effects.
- Live side effects must happen only inside workflow activities.

### Runtime Context Semantics

- A context row is intent, not authority.
- `RuntimeContextWorkflow(contextId)` is the durable authority to progress that
  context's lifecycle.
- Duplicate calls to start/resume the context workflow are acceptable.
- Activity claims decide which host performs each live step.
- Run/output rows are durable evidence of progress, not the coordination lock.

### Session Semantics

- Sessions are workflow state or app-owned DurableTable evidence, depending on
  whether the product needs workflow suspension.
- `wait_for`, `sleep`, `spawn`, `spawn_all`, `schedule_me`, and `execute`
  should be workflow-facing APIs.
- A session/tool side effect is a workflow activity unless a concrete product
  case proves it cannot be.

### Ingress Semantics

- User input rows are durable intent.
- Input emission to the opaque execution target is a live side effect and
  should be coordinated by the context workflow.
- The context workflow coordinates input emission by running a long-lived
  `runRuntimeContext` activity, not by starting one workflow activity per input
  row.
- `RuntimeIngressTable.deliveries` remains the per-input delivery checkpoint
  inside `runRuntimeContext`. It is not a competing host-ownership
  plane; it is message-level evidence used by the activity to survive replay
  and restart.

### Output Semantics

- Output rows are evidence.
- Output writes do not grant ownership or coordination authority.
- Output table queries drive UI and client snapshots.

## What This Simplifies

If accepted, this model removes or defers several pieces of the current
dispatcher/mutex direction.

### Likely Removed From The Normal Context Path

- `DurableKeyedMutex<contextId>` as the primary context ownership primitive.
- Runtime-host `claims` / `claimOutcomes` row families.
- App-local `Set<contextId>` correctness fences.
- A dispatcher whose primary job is "claim context, then call `startRuntime`."
- General-purpose `insertIfAbsent` pressure from context ownership alone.

### Still Potentially Needed

- A hardened workflow activity-claim implementation.
- Host evidence rows for observability, liveness, scheduling, and capacity.
- `DurableClaim<K>` or `insertIfAbsent` for per-message delivery checkpoints
  and other non-workflow side effects if they still require multi-host fencing
  beyond the `runRuntimeContext` activity claim.
- A lightweight host workflow runner in the root/product composition.
- A fire-and-forget workflow initiation API, because the host workflow must
  start/resume child workflows without awaiting their completion.

## Current-To-Target Codepath Sketches

These sketches are intentionally approximate. Their purpose is to show which
current responsibilities move, not to specify final module names.

### Host Plane

Current shape in `packages/runtime/src/runtime-host/index.ts`:

```txt
FiregridRuntimeHostLive(options)
  derive three table stream URLs
  provide RuntimeControlPlaneTable
  provide RuntimeIngressTable
  provide RuntimeOutputTable
  provide LocalProcessSandboxProvider

FiregridRuntimeHostWithWorkflowLive(options)
  provide FiregridRuntimeHostLive
  provide DurableStreamsWorkflowEngine.layer

external watcher / app host
  watches contexts
  calls startRuntime(contextId)
```

`startRuntime(contextId)` is currently the execution authority:

```txt
startRuntime(contextId)
  read RuntimeControlPlaneTable.contexts[contextId]
  allocate activityAttempt by querying runs
  write run started
  build local-process command
  build stdin stream from RuntimeIngressTable.inputs + deliveries
  stream sandbox process
    for each output chunk:
      write RuntimeOutputTable event/log row
    on exit:
      write run exited
    on error:
      write run failed
```

Target shape:

```txt
FiregridRuntimeHostLive(options)
  provide shared runtime tables
  provide workflow engine
  provide durable-tools wait_for sources
  provide sandbox provider
  start/resume HostWorkflow(hostId)

HostWorkflow(hostId)
  wait_for eligible RuntimeContext rows
  for each eligible context:
    initiate RuntimeContextWorkflow(contextId)
  never starts local processes directly
```

The host plane becomes a workflow supervisor. It can repeat observations and
resume calls safely because those are orchestration effects, not external
runtime side effects. The side-effect fence moves to
`RuntimeContextWorkflow` activities.

### Runtime Context Plane

Current shape:

```txt
app/runtime watcher
  startRuntime(contextId)
    owns context lifecycle directly
    owns external runtime side effects directly
    owns output writes directly
    owns stdin stream wiring directly
```

Target shape:

```txt
RuntimeContextWorkflow(contextId)
  read context row
  choose next attempt or reuse durable attempt state
  write run started evidence
  run runRuntimeContext(contextId, attempt)
  write run exited/failed evidence
```

`runRuntimeContext` is the current `startRuntime` body narrowed to the
external side effects needed to progress the context:

```txt
runRuntimeContext(contextId, attempt)
  build local-process command
  start/get opaque execution target
  subscribe to RuntimeIngressTable.inputs for this context
  use RuntimeIngressTable.deliveries to skip already-emitted inputs
  emit stdin bytes
  stream stdout/stderr/exit
  write RuntimeOutputTable rows with deterministic keys
  return exit evidence
```

This preserves the streaming process model. The activity boundary is the
side-effectful context run, not every message.

### Ingress Plane

Current shape:

```txt
appendRuntimeIngress(request)
  read existing input by inputId
  allocate sequence by querying existing rows
  insert sequenced RuntimeIngressTable.inputs row

localProcessStdinDelivery(contextId, subscriberId)
  subscribe to sequenced inputs
  for each input:
    read deliveries[key]
    upsert delivery claim
    emit bytes
```

Target shape:

```txt
appendRuntimeIngress(request)
  remains a user intent append
  does not decide host or execution ownership

runRuntimeContext(contextId, attempt)
  owns the delivery loop for the live execution target
  uses delivery checkpoints per input row
  may use activity-attempt-scoped subscriber identity
```

This means `RuntimeIngressTable.deliveries` remains message-level evidence, but
it stops looking like a separate host ownership system. The
`runRuntimeContext` activity claim answers "which host is performing the
external runtime effects"; delivery rows answer "which inputs has that activity
already attempted to emit?"

### Output Plane

Current shape:

```txt
streamSandboxProcess(...)
  output chunk -> outputRowFromProcessChunk(...)
  outputTable.events/logs.upsert(...)
```

Target shape:

```txt
runRuntimeContext(...)
  output chunk -> deterministic RuntimeOutputTable row
```

The write path can remain almost identical. The simplification is semantic:
output rows are evidence produced by the run activity, not writes from a
top-level host function that also owns lifecycle authority.

### Workflow Engine Plane

Current shape:

```txt
WorkflowEngine.activityExecute(...)
  claimActivity(activityKey)
    raw DurableStream producer append
    wait/poll for activityClaims materialization
  if this worker won:
    run activity body
    write activity result
  else:
    suspend
```

Target shape:

```txt
WorkflowEngine.activityExecute(...)
  hardened activity claim fence
  if this worker won:
    run runRuntimeContext or other activity
    write activity result
  else:
    suspend
```

The workflow engine plane becomes more important, not less. This SDD depends
on hardening that activity-claim fence before making it the primary runtime
side-effect boundary.

### Product App Plane

Current Flamecast toy shape:

```txt
app host
  create Firegrid client
  watch contexts where createdBy == flamecast-toy
  keep in-memory Set<contextId>
  call startRuntime(contextId)
```

Target shape:

```txt
app/root process
  configure Firegrid runtime host
  start HostWorkflow(hostId)

UI
  launch context through @firegrid/client
  observe RuntimeControlPlaneTable / RuntimeOutputTable through live queries
```

Product apps no longer implement a host watcher as application logic.

## Production-Like Proposed Code Shape

The target should look like a small refactor of the current files, not a new
framework. These snippets are not intended to compile as-is, but they use the
current APIs and module names where possible.

### Runtime Host Composition

`packages/runtime/src/runtime-host/index.ts` should mostly compose long-lived
Layers and start the host workflow. It should stop containing runtime-context
execution logic.

```ts
export const FiregridRuntimeHostLive = (
  options: RuntimeHostTopologyOptions,
) => {
  const urls = runtimeTableUrls(options)

  return Layer.mergeAll(
    Layer.succeed(RuntimeHostConfig, {
      inputEnabled: options.input === true,
      hostId: options.hostId,
    }),
    RuntimeControlPlaneTable.layer(tableLayer(urls.controlPlane, options)),
    RuntimeIngressTable.layer(tableLayer(urls.ingress, options)),
    RuntimeOutputTable.layer(tableLayer(urls.output, options)),
    DurableStreamsWorkflowEngine.layer({
      streamUrl: urls.workflow,
      workerId: options.hostId,
      ...(options.headers !== undefined ? { headers: options.headers } : {}),
    }),
    DurableToolsWaitForLive({
      streamUrl: urls.durableTools,
      ...(options.headers !== undefined ? { headers: options.headers } : {}),
    }),
    LocalProcessSandboxProvider.layer().pipe(
      Layer.provide(NodeContext.layer),
    ),
    RuntimeContextWorkflowLayer,
    HostWorkflowLayer,
    RuntimeSourceCollectionsLayer,
  )
}
```

`RuntimeSourceCollectionsLayer` is where the host registers the table
collections that `wait_for` can observe. The key point: source registration is
composition, not a new polling service.

```ts
export const RuntimeSourceCollectionsLayer = Layer.scopedDiscard(
  Effect.gen(function* () {
    const sources = yield* SourceCollections
    const control = yield* RuntimeControlPlaneTable

    yield* sources.register(sourceCollectionStreamHandle(
      "runtime.contexts",
      control.contexts.rows(),
    ))
  }),
)
```

### Host Workflow

There are two practical migration steps. The immediate step can make
`startRuntime` a workflow entrypoint without adding host discovery. The later
step adds `HostWorkflow` once the control-plane table has an explicit
"eligible to run" state. That caveat matters because the current
`RuntimeContext` row has no status field; `createdBy` alone is not enough to
express "next unclaimed context" without repeatedly matching the same retained
row.

Immediate compatibility step:

```ts
export const startRuntime = (options: StartRuntimeOptions) =>
  RuntimeContextWorkflow.execute(
    { contextId: options.contextId },
    {
      executionId: `runtime-context:${options.contextId}`,
      discard: false,
    },
  )
```

Later host-supervisor step, after adding a context lifecycle/requested field
or an equivalent durable "runtime work" row:

```ts
const HostWorkflow = Workflow.make({
  name: "firegrid.host",
  payload: Schema.Struct({
    hostId: Schema.String,
    createdBy: Schema.optional(Schema.String),
  }),
  success: Schema.Void,
  idempotencyKey: ({ hostId }) => `host:${hostId}`,
})

const HostWorkflowLayer = HostWorkflow.toLayer((payload) =>
  Effect.gen(function* () {
    let waitIndex = 0
    while (true) {
      const next = yield* WaitFor.match({
        name: `next-runtime-context/${payload.hostId}/${waitIndex++}`,
        source: "runtime.contexts",
        trigger: [
          { path: ["status"], equals: "requested" },
          ...(payload.createdBy === undefined
            ? []
            : [{ path: ["createdBy"], equals: payload.createdBy }]),
        ],
        resultSchema: RuntimeContextSchema,
      })

      if (next._tag === "Timeout") continue

      yield* RuntimeContextWorkflow.execute(
        { contextId: next.row.contextId },
        { executionId: `runtime-context:${next.row.contextId}`, discard: true },
      )
    }
  }),
)
```

This still depends on resolving the fire-and-forget question: current
`execute(..., { discard: true })` joins until the child workflow suspends or
finishes. If that is too coupled, the workflow engine needs a narrow
`initiate/resume` operation that records/resumes the child execution without
joining it.

Until the control-plane table has an eligibility field, product code can still
call `startRuntime(contextId)` after launch. The important simplification is
that `startRuntime` delegates into `RuntimeContextWorkflow` instead of owning
the local process.

### Synchronous Run Mode

The same immediate step supports a Fireline-style "boot one selected agent
now" path without waiting for the full host-supervisor model.

```sh
firegrid run [firegrid host/runtime options] -- <agent command...>
```

The command should be product-shaped, not a second runtime design:

```txt
firegrid run -- <agent command...>
  resolve Firegrid host config from Config/env plus non-secret flags
  build a RuntimeContext row from the command after --
  insert RuntimeControlPlaneTable.contexts[contextId]
  call startRuntime({ contextId })
  block until RuntimeContextWorkflow returns exit evidence
  exit with the runtime-context run's exit code
```

Production-like shape:

```ts
export const runSelectedAgent = (
  request: {
    readonly requestedBy?: string
    readonly argv: ReadonlyArray<string>
    readonly cwd?: string
  },
) =>
  Effect.gen(function* () {
    const control = yield* RuntimeControlPlaneTable
    // Same row shape as @firegrid/client's launch normalization. A real
    // implementation should extract the row constructor instead of creating a
    // second launch normalization path.
    const contextId = `ctx_${crypto.randomUUID()}`
    const createdAt = yield* Clock.currentTimeMillis.pipe(
      Effect.map((millis) => new Date(millis).toISOString()),
    )

    yield* control.contexts.insert({
      contextId,
      createdAt,
      ...(request.requestedBy === undefined
        ? {}
        : { createdBy: request.requestedBy }),
      runtime: normalizeRuntimeIntent(local.jsonl({
        argv: [...request.argv],
        ...(request.cwd === undefined ? {} : { cwd: request.cwd }),
      })),
    })

    return yield* startRuntime({ contextId })
  })
```

This is not the same as `HostWorkflow`. It is a synchronous convenience entry
point over the same runtime context workflow. That makes it useful for local
ACP/Zed-style testing: all Firegrid table, ingress, output, workflow, and
local-process provider layers are exercised, but the operator gets normal "run
a command and wait for exit" ergonomics.

### Runtime Context Workflow

The context workflow is where the current `startRuntime` lifecycle belongs.
It owns durable lifecycle evidence and invokes `runRuntimeContext` for the
live external effects.

```ts
const RuntimeContextWorkflow = Workflow.make({
  name: "firegrid.runtime-context",
  payload: Schema.Struct({
    contextId: Schema.String,
  }),
  success: Schema.Struct({
    contextId: Schema.String,
    activityAttempt: Schema.Number,
    exitCode: Schema.Number,
    signal: Schema.optional(Schema.String),
  }),
  idempotencyKey: ({ contextId }) => `runtime-context:${contextId}`,
})

const RuntimeContextWorkflowLayer = RuntimeContextWorkflow.toLayer((payload) =>
  Effect.gen(function* () {
    const control = yield* RuntimeControlPlaneTable

    const context = yield* control.contexts.get(payload.contextId).pipe(
      Effect.flatMap(Option.match({
        onNone: () => Effect.fail(new Error(`context not found: ${payload.contextId}`)),
        onSome: Effect.succeed,
      })),
    )

    const activityAttempt = yield* allocateRuntimeAttempt(context.contextId)

    yield* writeRunStarted(context, activityAttempt)

    const exit = yield* runRuntimeContext.execute({
      context,
      activityAttempt,
    })

    yield* writeRunExited(context, activityAttempt, exit)

    return {
      contextId: context.contextId,
      activityAttempt,
      ...exit,
    }
  }),
)
```

Most of the current `startRuntime` code moves into small helpers used here:
`allocateRuntimeAttempt`, `writeRunStarted`, and `writeRunExited`. Those
helpers still use `RuntimeControlPlaneTable.runs`; the change is that they run
inside a durable workflow execution instead of a top-level host function.

### `runRuntimeContext` Activity

`runRuntimeContext` is the answer to the "one activity per message" concern.
It is one workflow activity per runtime attempt, and that activity performs
the live external side effects required to progress the context.

```ts
const runRuntimeContext = Activity.make({
  name: "firegrid.runtime-context.run",
  success: Schema.Struct({
    exitCode: Schema.Number,
    signal: Schema.optional(Schema.String),
  }),
  execute: Effect.fn(function* (input: {
    readonly context: RuntimeContext
    readonly activityAttempt: number
  }) {
    return yield* runRuntimeContextEffect(input.context, input.activityAttempt)
  }),
})
```

`runRuntimeContextEffect` is intentionally close to today's `startRuntime`
body:

```ts
const runRuntimeContextEffect = (
  context: RuntimeContext,
  activityAttempt: number,
) =>
  Effect.gen(function* () {
    const hostConfig = yield* RuntimeHostConfig
    const ingressTable = yield* RuntimeIngressTable
    const outputTable = yield* RuntimeOutputTable
    const command = yield* commandForContext(context)

    const stdin = hostConfig.inputEnabled
      ? localProcessStdinDelivery({
        contextId: context.contextId,
        subscriberId: `runtime-context:${context.contextId}:attempt:${activityAttempt}:stdin`,
      }).pipe(
        Stream.provideService(RuntimeIngressTable, ingressTable),
      )
      : undefined

    const writeOutputChunk = (
      sequence: number,
      chunk: Extract<ProcessOutputChunk, { readonly type: "output" }>,
    ) =>
      outputRowFromProcessChunk(context, activityAttempt, sequence, chunk).pipe(
        Effect.flatMap(row =>
          row.source === "stdout"
            ? outputTable.events.upsert(row)
            : outputTable.logs.upsert(row)),
      )

    return yield* streamSandboxProcess({
      labels: { firegridRuntimeContextId: context.contextId },
      ...(context.runtime.config.cwd === undefined
        ? {}
        : { workingDir: context.runtime.config.cwd }),
      providerConfig: { contextId: context.contextId },
      command: {
        ...command,
        ...(stdin === undefined ? {} : { stdin }),
      },
    }).pipe(
      Stream.mapAccum(0, (sequence, chunk) => [
        sequence + 1,
        { sequence, chunk },
      ] as const),
      Stream.tap(({ sequence, chunk }) =>
        chunk.type === "output"
          ? writeOutputChunk(sequence, chunk)
          : Effect.void),
      Stream.filter((item): item is {
        readonly sequence: number
        readonly chunk: Extract<ProcessOutputChunk, { readonly type: "exit" }>
      } => item.chunk.type === "exit"),
      Stream.runHead,
      Effect.flatMap(Option.match({
        onNone: () => Effect.fail(new Error("process ended without exit")),
        onSome: ({ chunk }) => Effect.succeed({
          exitCode: chunk.exitCode,
          ...(chunk.signal === undefined ? {} : { signal: chunk.signal }),
        }),
      })),
    )
  })
```

This sketch deliberately keeps `localProcessStdinDelivery` in the path. The
workflow activity claim owns the process. `RuntimeIngressTable.deliveries`
continues to own per-input "already emitted" evidence.

That compatibility wrapper is the point where the current `runtime-host/index.ts` collapses: the
host API no longer knows how to build stdin streams, write output chunks, or
manage process exit. It only starts or resumes the context workflow.

## Effect On Existing Code

### `packages/runtime/src/workflow-engine/internal/engine-runtime.ts`

The activity-claim path remains load-bearing. The desired simplification is not
to bypass it, but to make more runtime side effects flow through it.

Near-term hardening may still be required:

- isolate or remove the raw `effect-durable-streams` producer path;
- remove polling around activity-claim materialization;
- replace wall-clock calls with `Clock` where appropriate;
- expose a narrow "initiate/resume without join" workflow operation if the host
  workflow needs it.

### `packages/runtime/src/runtime-host`

`startRuntime(contextId)` should stop being the public execution-authority
operation. It should become either:

- the implementation body of `runRuntimeContext`; or
- a small compatibility wrapper that starts/resumes
  `RuntimeContextWorkflow(contextId)`.

The activity boundary is the runtime-context run, not every individual message.
This preserves the existing streaming process model while moving the
correctness fence to workflow activity ownership.

### `apps/flamecast/src/runtime/host.ts`

The Flamecast toy host watcher should be temporary. In the target model it
either:

- starts `HostWorkflow(hostId)` and does nothing else; or
- disappears in favor of a root host runner that any app can configure.

### Durable Tools

`wait_for` is the one durable-tools capability that may remain because it
bridges DurableTable changes into workflow deferred completion. It should
resolve existing workflow executions; it should not become a separate
workflow-dispatch service.

This reframing also narrows `packages/runtime/src/durable-tools`:

- it remains the workflow-facing "await table condition" adapter;
- it should not grow into host dispatch, runtime ownership, or process
  lifecycle management;
- it should not own runtime-context execution;
- it may be unused by the synchronous `firegrid run -- <agent>` path, because
  that path already has a selected context and can call `startRuntime`
  directly;
- it becomes useful again for long-lived workflows that need to wait on
  durable table changes, such as a future `HostWorkflow`, `schedule_me`, or
  product session workflows.

In other words, workflows make durable-tools smaller and more precise. The
package is provisional: if `wait_for` can be folded directly into workflow
runtime helpers without a package-level router, delete the package rather than
preserving it. The parts that look like dispatch, temporal scheduling, or
ownership should not be built there.

## Open Design Questions

1. **HostWorkflow identity.** Is it one workflow per physical host/process
   (`host:${hostId}`), one per namespace (`namespace:${namespace}:host`), or
   both? Recommendation for v0: one per physical host/process, because local
   host capabilities and process capacity are host-specific.
2. **Child workflow initiation.** What exact workflow-engine API starts or
   resumes `RuntimeContextWorkflow(contextId)` without joining it? The current
   `execute(..., { discard: true })` behavior should be checked; it must not
   serialize host dispatch behind child completion.
3. **Workflow activity claim hardening.** The activity-claim path is a
   precondition, not a follow-up. The current raw producer and polling loop
   must be hardened before this model becomes the runtime side-effect fence.
   Prefer event-driven materialization or a tighter internal fence over
   exposing a broad public conditional-write primitive.
4. **Runtime-context run retry semantics.** If a host crashes while
   `runRuntimeContext` is performing external side effects, how does another
   host resume?
   v0 may require stable host identity so the same host can resume its own
   activity claim; multi-host takeover requires explicit stale-owner policy.
5. **Ingress delivery checkpoints.** Does `RuntimeIngressTable.deliveries`
   remain the message-level checkpoint inside `runRuntimeContext`,
   or is it replaced by a narrower activity-private delivery table?
6. **Session boundary.** Which product session state is just UI/queryable
   DurableTable evidence, and which state needs workflow suspension?
7. **Host liveness.** What is the minimal host evidence needed before
   multi-host scheduling? Heartbeats may be observability-only at first if
   workflow activity claims already fence side effects.

## Validation Bar

This model should not proceed to implementation unless it clarifies the
durability semantics across all planes. A successful implementation plan must
be able to prove:

1. Two hosts can observe the same context row without duplicate process-start
   side effects.
2. Restarting a host resumes host workflow supervision without replaying live
   side effects.
3. Restarting a context workflow resumes from durable workflow state and table
   evidence.
4. Runtime output and run rows remain user-visible evidence, not coordination
   locks.
5. Ingress bytes are emitted only after durable workflow/activity coordination.
6. Per-message ingress does not require one workflow activity per input row.
7. Restart after a mid-run host crash either resumes under the same stable host
   identity or refuses takeover with explicit durable evidence.
8. `wait_for`/clock behavior works inside both host and context workflows.
9. Product session workflows compose with runtime context workflows without
   creating a third dispatch plane.
10. Before using activity claims as a high-throughput runtime fence, an
   activity-claim load test proves the expected concurrency and materialization
   latency envelope for the target deployment. Exact numbers should come from
   product scale assumptions before implementation; this is a hardening gate,
   not a prerequisite for the first happy-path spike.

## Candidate Rollout

1. **Architecture review only.** Decide whether this SDD supersedes the
   context-ownership parts of
   `SDD_FIREGRID_RUNTIME_HOST_DISPATCHER_AND_CLAIMS.md`.
2. **Workflow-engine review.** Audit `engine-runtime.ts` for what is required
   to support host/context workflow hierarchy, especially fire-and-forget child
   workflow initiation.
3. **DurableTable hardening.** Finish the current Phase 0 DurableTable
   hardening before any new table write primitive.
4. **Context workflow spike.** Implement
   `firegrid-workflow-driven-runtime.PHASE_1_CONTEXT_WORKFLOW.*`: make
   `startRuntime(contextId)` delegate to `RuntimeContextWorkflow` and move
   local-process start/run/output into `runRuntimeContext` for one runtime
   attempt. Prove duplicate `startRuntime(contextId)` does not duplicate
   process start.
5. **Synchronous run spike.** Implement
   `firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.*`: create one
   `RuntimeContext` row from `firegrid run -- <agent command...>`, call
   `startRuntime`, block for the workflow result, and exit with the runtime
   exit code.
6. **Activity-claim hardening.** Implement
   `firegrid-workflow-driven-runtime.PHASE_3_ACTIVITY_CLAIMS.*` before making
   workflow activity claims the broad runtime side-effect fence.
7. **Temporal workflow spike.** Implement
   `firegrid-workflow-driven-runtime.PHASE_4_TEMPORAL_WORKFLOWS.*`: prove
   `Schedule` policy plus `DurableClock.sleep` covers `sleep` and
   `schedule_me` without a Firegrid timer table.
8. **Host workflow spike.** Implement
   `firegrid-workflow-driven-runtime.PHASE_5_HOST_WORKFLOW.*` only after the
   control-plane table can express eligible work explicitly.
9. **Flamecast cleanup.** Delete app-local host watcher correctness logic and
   consume either the synchronous runner or the product host runner.
10. **Revisit claims/mutexes.** Add `DurableClaim`, `DurableKeyedMutex`, or
   `insertIfAbsent` only for side effects that remain outside workflow
   activities and have concrete call sites.

## Non-Goals

- This SDD does not remove DurableTable.
- This SDD does not remove the workflow engine.
- This SDD does not authorize a generic workflow-name registry or public
  `executeByName` API.
- This SDD does not introduce a new top-level package.
- This SDD does not claim exactly-once external side effects; external systems
  still need idempotency or target-side fencing where appropriate.
- This SDD does not implement `DurableClaim`, `DurableKeyedMutex`, or
  `DurableTable.insertIfAbsent`.
