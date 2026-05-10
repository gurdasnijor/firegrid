# Target Architecture: Managed-Agent Runtime Package Model

This document captures the target package and composition model to stress-test
against real Firegrid call sites. It is intentionally separate from the Agent D
stress brief: this document states the desired architecture; the stress brief
asks an agent to prove or falsify it through a working restructure.

## Core Split

Firegrid should separate three concerns:

1. **Substrate packages** hide storage/execution substrates behind Effect
   services.
2. **Runtime kernel packages** define Firegrid's managed-agent execution model.
3. **Launch-slot packages** define and implement orthogonal managed-agent
   dimensions such as runtime adapter, sandbox, workspace, tools, and secrets.

Durable Streams is the first substrate package. It earns a package boundary
because it should be the only place concrete Durable Streams APIs leak into
Firegrid:

```txt
@firegrid/durable-streams is the only package that imports @durable-streams/*.
```

The rest of the system should not copy that substrate-driven split. Provider
packages should follow the launch/configuration slots that collaborate to
deliver a managed agent.

## Client Launch Config vs Runtime Host Config

Keep these configuration planes separate.

Client launch config describes the agent request:

```ts
firegrid.launch({
  runtime: acp({ agent: claudeCode() }),
  sandbox: localProcess({ cwd: "/workspace" }),
  workspace: gitWorkspace({
    repo: "github:org/repo",
    ref: "main",
    mountPath: "/workspace",
  }),
  tools: [mcp("linear", { url: env.LINEAR_MCP_URL })],
  secrets: envSecrets(["ANTHROPIC_API_KEY"]),
  policies: {
    approval: { default: "deny" },
  },
})
```

Runtime host config describes how this Firegrid runtime instance operates:

```ts
const FiregridHostLive = Layer.mergeAll(
  DurableStreamsWorkflowEngine.layer({
    streamUrl: env.WORKFLOW_STREAM_URL,
  }),
  DurableState.layer({
    runtimeContext: {
      streamUrl: env.RUNTIME_CONTEXT_STREAM_URL,
      descriptor: RuntimeContext.stateDescriptor,
    },
  }),
  DurableStreamLog.layer({
    runtimeOutput: {
      streamUrl: env.RUNTIME_OUTPUT_STREAM_URL,
      event: RuntimeOutput.journalEvent,
    },
  }),
  MaterializationStrategy.layer(
    materializeStrategy({
      connection: pgConfig,
      projections: [sessionProjection(), permissionProjection()],
    }),
  ),
)
```

The client must not choose Firegrid's internal materialization backend. A
runtime host may use Materialize, StreamDB/State Protocol, raw retained-log
folds, SQLite, or another backend. Clients observe the session/query API, not
the host's projection engine.

## Target Package Structure

```txt
packages/
  protocol/
    src/
      launch/
      session/
      runtime-context/
      runtime-output/

  durable-streams/
    src/
      DurableStreamsWorkflowEngine.ts
      DurableStreamLog.ts
      DurableStreamProducer.ts
      DurableState.ts
      DurableStateProtocol.ts
      DurableCursor.ts
      internal/
        workflow/
        state/
        stream/
      index.ts

  runtime/
    src/
      runtime-context/
      runtime-output/
      runtime-operator/
      launch/
      index.ts

  runtimes/
    core/
    acp/
    claude-code/

  sandboxes/
    core/
    local-process/
    compute-sdk/

  workspaces/
    core/
    git/
    local-fs/

  tools/
    core/
    mcp/

  secrets/
    core/
    env/

  materialization/
    core/
    state-protocol/
    raw-fold/
    materialize/
```

## Substrate Package

`@firegrid/durable-streams` owns Durable Streams substrate concerns, analogous
to `@effect/cluster` owning cluster-backed implementations.

Expected public services:

- `DurableStreamsWorkflowEngine`: Durable Streams-backed implementation of
  `@effect/workflow`'s `WorkflowEngine`;
- `DurableStreamLog`: append/read/tail retained stream events without exposing
  `DurableStream`;
- `DurableStreamProducer`: `IdempotentProducer` wrapper with standard producer
  identity, batching, flush, detach, and error handling;
- `DurableState`: StreamDB/createStreamDB-backed state lifecycle;
- `DurableStateProtocol`: State Protocol change writer/encoder over Durable
  Streams;
- `DurableCursor`: cursor/offset helpers and retained-read boundaries.

Do not add generic surfaces such as `DurableClaim` or
`DurableStreamsTestServer` until a tracer or implementation needs them. Claims
may become real substrate concerns, but current producer identity and workflow
activity guarantees should be stress-tested first. Test-server helpers can live
in package test utilities before becoming public API.

Non-contents:

- runtime context semantics;
- runtime output semantics;
- sandbox providers;
- tools/providers;
- materialization projections;
- Materialize provider/query code.

## Launch-Slot Packages

Launch-slot packages align with the top-level client launch shape.

| Launch key | Core package | Provider packages | Role |
| --- | --- | --- | --- |
| `runtime` | `@firegrid/runtimes-core` | `@firegrid/runtime-acp`, `@firegrid/runtime-claude-code` | Agent protocol/harness adapter. |
| `sandbox` | `@firegrid/sandboxes-core` | `@firegrid/sandbox-local-process`, `@firegrid/sandbox-compute-sdk` | Execution environment and command streaming. |
| `workspace` | `@firegrid/workspaces-core` | `@firegrid/workspace-git`, `@firegrid/workspace-local-fs` | Files/resources mounted or exposed to runtime/sandbox. |
| `tools` | `@firegrid/tools-core` | `@firegrid/tool-mcp` | Tool specs, bindings, and future harness components. |
| `secrets` | `@firegrid/secrets-core` | `@firegrid/secrets-env` | Secret resolution into private bindings. |

Do not preserve `@firegrid/runtime-node` as a package boundary. Local process is
a sandbox provider, so it belongs in `@firegrid/sandbox-local-process`.

## Approvals And Required Actions

Do not model permissions as a top-level package family or as a
`permissions-callback` provider. Permission requests and approvals are runtime
workflow behavior.

The realistic shape is an Effect workflow that emits or observes a required
action event, then durably waits for a resolution event:

```ts
const approvalWorkflow = workflow.toLayer((payload, executionId) =>
  Effect.gen(function* () {
    const initial = yield* processInitialActivity(payload)

    const approval = yield* WorkflowInstance.waitForEvent("approval", {
      timeout: Duration.hours(24),
    })

    if (approval.approved) {
      yield* processApprovalActivity(initial, approval)
    } else {
      yield* processRejectionActivity(initial, approval.reason)
    }

    return { status: approval.approved ? "approved" : "rejected" }
  }),
)
```

The workflow consumes the durable event stream and blocks through
`@effect/workflow` machinery until the approval/rejection resolution is durable.
Notification delivery may later use callbacks, webhooks, UI subscriptions, or
another transport, but that is not the semantic package boundary.

The package placement to stress-test:

```txt
runtime/
  required-action/
    approval-workflow.ts
    required-action-events.ts
```

The runtime host owns the workflows and event subscriptions. Clients and tools
interact through durable required-action/session events, not through a
`permissions-callback` provider.

## Materialization

Materialization is a runtime host concern, not a client launch setting.

`@firegrid/materialization` defines the common abstraction:

```ts
interface MaterializationEngine {
  readonly project: <Source, Projection>(input: {
    readonly source: EventSource<Source>
    readonly projector: EventProjector<Source, Projection>
    readonly target: ProjectionTarget
  }) => Effect.Effect<ProjectionSummary, ProjectionError>

  readonly query: <A>(
    query: ProjectionQuery<A>,
  ) => Effect.Effect<ReadonlyArray<A>, ProjectionError>

  readonly subscribe: <A>(
    query: ProjectionQuery<A>,
  ) => Stream.Stream<A, ProjectionError>
}
```

Strategy subpaths:

- `@firegrid/materialization/state-protocol`: StreamDB/State Protocol-backed
  projection engine over `@firegrid/durable-streams`;
- `@firegrid/materialization/raw-fold`: retained-log fold engine for simple
  local/test projections;
- `@firegrid/materialization/materialize`: Materialize-backed projection/query
  engine.

Materialize is not a special sidecar. It is one implementation of the
runtime-host materialization slot, selected by subpath import from the single
materialization package.

## Tools Future Fit

`tools/core` must be shaped for more than metadata. Fireline's
choreography/combinator model treats tools, resources, middleware, approvals,
and routing as harness components over managed-agent primitives.

At minimum:

```ts
interface ToolProvider {
  readonly describe: Effect.Effect<ReadonlyArray<ToolSpec>, ToolError>
  readonly bind: (
    context: RuntimeContext,
  ) => Effect.Effect<ToolBinding, ToolError>
}

interface ToolComponent {
  readonly spec: ToolComponentSpec
  readonly lower: Effect.Effect<HarnessComponent, ToolError>
}
```

Tools are both launch-time topology data and runtime harness components. MCP is
one provider implementation of that slot, not the slot itself.

Some tools should be implemented as workflows behind the tool interface because
their semantics are inherently durable:

| Tool | Runtime backing |
| --- | --- |
| `sleep(durationMs)` | Workflow sleeps through durable clock/timer machinery. |
| `wait_for(trigger, timeoutMs?)` | Workflow waits for an event/projection match and timeout terminalization. |
| `schedule_me(when, prompt)` | Workflow appends a future self-prompt intent when a timer fires. |
| `spawn(agent, prompt)` | Workflow calls the same launch API available to clients, then waits for child completion. |

This suggests a future provider package such as
`@firegrid/tool-workflows` or an internal runtime tool provider that exposes
durable tools backed by `@effect/workflow`. The exact package name should be
stress-tested; the important property is that these tools are not ad hoc
callbacks. They are tool-layer interfaces over durable workflows.

## Composition Root Shape

A runtime host root assembles substrate services, runtime domain services,
launch-slot provider registries, and one materialization strategy:

```ts
const FiregridHostLive = Layer.mergeAll(
  DurableStreamsWorkflowEngine.layer({ streamUrl: env.WORKFLOW_STREAM_URL }),
  DurableState.layer({ /* runtime context state */ }),
  DurableStreamLog.layer({ /* runtime output journal */ }),

  RuntimeContext.layer({ store: "runtimeContext" }),
  RuntimeOutput.layer({ journal: "runtimeOutput" }),
  RuntimeOperator.layer,

  RuntimeRegistry.layer([acpRuntime(), claudeCodeRuntime()]),
  SandboxRegistry.layer([localProcess(), computeSdk()]),
  WorkspaceRegistry.layer([gitWorkspaceProvider(), localFsWorkspaceProvider()]),
  ToolRegistry.layer([mcpToolProvider()]),
  SecretResolver.layer(envSecretsProvider()),

  MaterializationEngine.layer(
    materialize({
      connection: pgConfig,
      projections: [sessionProjection(), permissionProjection()],
    }),
  ),
)
```

The stress test should determine whether this root is ergonomic and type-safe
when applied to tracer 001, tracer 002, and a hypothetical Flamecast app root.

## Open Questions And Tracers

Each open question below should be answered by a focused tracer. The target
architecture should be refined after each tracer lands; do not resolve these by
adding speculative package structure ahead of implementation pressure.

| Open question | Why it matters | Tracer |
| --- | --- | --- |
| What is the production runtime host root, and how is it separated from client launch requests? | Current composition is still spread across package helpers and scenario setup. We need one production surface that owns host-wide substrate/materialization/provider choices while clients only describe launch intent. | 006: Runtime Host Root And Launch Boundary |
| What exactly belongs to the runtime kernel after substrate extraction? | `runtime-context`, `runtime-output`, `runtime-operator`, and `launch` need clear responsibility boundaries before more packages are split out. | 006: Runtime Host Root And Launch Boundary |
| What is the first concrete launch-slot package contract? | The package model should be proven through one slot before creating every future package family. The sandbox slot is the most grounded because tracer 001 already depends on process streaming. | 007: Sandbox Slot Extraction |
| What is the materialization engine contract against current tracer 002 code? | The target says materialization is host-selected and pluggable, but current code still has event-pipeline and strategy details that need to converge on a common API. | 008: Materialization Strategy Interface |
| What durable records and workflow waits implement required actions? | Approval should be workflow/event-wait behavior, not a callback package. We need the request, resolution, timeout, and wait identity model. | 009: Required-Action Workflow |
| How do workflow-backed tools enter the agent tool surface? | `sleep`, `wait_for`, `schedule_me`, and `spawn` need a common tool-layer interface over durable workflows. | 010: Workflow-Backed Tools |
| Who owns projection target schemas, encoders, folds, and query adapters? | Tracer 008 intentionally left State Protocol query support hardcoded to session schemas. Strategies should supply storage/query mechanics while projection targets own their schemas and target-specific query mapping. | 011: Projection Target Schema Ownership |
| How do clients and tools supply prompts over the Durable Streams substrate? | Firegrid has durable runtime output, but no unified durable input model for initial prompts, follow-up prompts, steering, or tool-driven `spawn(agent, prompt)`. Prompt ingress needs its own authority boundary before real runtime providers are added. | 012: Agent Ingress Prompt Stream |

### 006 Focus

The next design tracer should focus on the first two questions:

```txt
runtime host config
  -> chooses durable substrate
  -> chooses materialization strategy
  -> registers current runtime/sandbox/tool/secret providers as far as they exist

client launch request
  -> describes one agent request
  -> does not choose streams, materialization backend, workflow engine, or host provider registry
```

Tracer 006 should produce the smallest production root that can run the current
runtime context flow without making scenario tests the only working composition
surface. It should not introduce the full launch-slot package split unless the
root cannot be expressed without it.
