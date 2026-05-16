# SDD: Firegrid Runtime Host Modularity

Status: draft

Related specs:

- `firegrid-runtime-host-modularity`
- `firegrid-workflow-driven-runtime`
- `firegrid-host-context-authority`
- `firegrid-factory-aligned-agent-tools`
- `firegrid-schema-projection-contract`

## Problem

`packages/runtime/src/runtime-host/index.ts` has become the aggregate root for
almost every runtime-host concern. It currently contains public exports,
runtime workflow execution, raw local-process execution, codec session
execution, runtime ingress routing, host topology layers, runtime observation
composition, and the live `AgentToolHost` implementation.

That aggregation made sense while the substrate was still forming: keeping the
authority root in one file made it easier to prove that RuntimeContext,
RuntimeIngress, RuntimeOutput, workflow execution, host-owned tables, and
agent-tool lowering shared the same host scope.

Now the dark-factory work has proven those primitives in combination. The same
aggregate file is becoming a source of confusion. It hides which code is:

- durable control-plane lifecycle;
- data-plane process/codec execution;
- host-owned table topology;
- public runtime-host API;
- agent-tool lowering authority;
- client/session capability wiring.

The goal of this work is not to replace those primitives. The goal is to make
the existing boundaries visible so downstream cleanup is safer and smaller.

## Goals

1. Split `runtime-host/index.ts` into focused modules without changing runtime
   behavior.
2. Preserve the public runtime-host export surface during the first refactor.
3. Keep `startRuntime` workflow-backed and aligned with
   `firegrid-workflow-driven-runtime`.
4. Make raw-process execution, codec execution, ingress routing, layer
   topology, and live agent-tool lowering independently understandable.
5. Reduce future pressure to solve app/client/tool concerns by adding more code
   to the runtime-host aggregate root.

## Non-Goals

- Do not delete `RuntimeContextWorkflow` in this modularity pass.
- Do not change durable row schemas, stream names, host id derivation, workflow
  execution identity, activity attempt allocation, or RuntimeIngress delivery
  semantics.
- Do not introduce a new runtime scheduler, host supervisor, sidecar process,
  MCP process, provider registry, or app-specific table.
- Do not move product surfaces such as `DarkFactoryTable`, provider facts,
  planner prompts, or UI read models into runtime-host.
- Do not make `@firegrid/client` import runtime-host implementation modules.

## Current Aggregate Responsibilities

The current `runtime-host/index.ts` contains these separate concerns:

```txt
runtime-host/index.ts
  public exports / barrel
  workflow-backed startRuntime
  run lifecycle rows
  raw local-process stream execution
  agent codec execution
  RuntimeIngress append/routing
  host-owned table Layer topology
  runtime observation source composition
  RuntimeStartCapability provider
  RuntimeHostAgentToolHostLive
```

Those responsibilities should remain in the runtime package, but not in one
file.

## Target Shape

The first refactor should be a behavior-preserving extraction. A reasonable
module shape is:

```txt
packages/runtime/src/runtime-host/
  index.ts
    public runtime-host exports only

  execution.ts
    startRuntime
    RuntimeStartCapabilityLive
    RuntimeContextWorkflow composition
    run lifecycle row writes

  raw-process-runtime.ts
    raw local-process runRuntimeContext path
    stdout/stderr journal row conversion

  codec-runtime.ts
    agentProtocol selection
    AgentCodec open/send/output loop
    RuntimeIngress -> AgentInputEvent delivery
    AgentOutputEvent journaling
    ToolUse -> toolUseToEffect -> ToolResult when supported

  ingress.ts
    appendRuntimeIngress
    owner-host RuntimeIngress routing
    idempotent input sequencing

  layers.ts
    CurrentHostSession layer
    RuntimeHostTopologyFromConfig
    FiregridRuntimeHostLive
    FiregridLocalHostLive
    host-owned table/workflow/observation layer composition

  agent-tool-host-live.ts
    RuntimeHostAgentToolHostLive
    session_new/session_prompt/schedule_me host seams
    unsupported execute/cancel/close seams
```

The exact filenames can change during implementation, but each extracted file
should have one primary responsibility and should not become a smaller copy of
the current aggregate.

## Public Export Compatibility

`packages/runtime/src/runtime-host/index.ts` should remain the public import
path for existing callers. The first extraction should not require callers or
tests to update imports from `../runtime-host/index.ts`.

Allowed public exports include the existing runtime-host API:

- `FiregridRuntimeHostLive`;
- `FiregridRuntimeHostWithWorkflowLive`;
- `FiregridLocalHostLive`;
- `FiregridRuntimeHostFromConfig`;
- `FiregridRuntimeHostWithWorkflowFromConfig`;
- `FiregridRuntimeHostWithWorkflowFromConfigWithEnvPolicy`;
- `RuntimeHostTopologyFromConfig`;
- `RuntimeStartCapabilityLive`;
- `appendRuntimeIngress`;
- context-authority exports already re-exported today;
- runtime observation source exports already re-exported today.

If an alias is redundant, the modularity pass may mark it as compatibility
surface in comments, but should not remove it until a separate compatibility
decision is made.

## Workflow Boundary

`startRuntime(contextId)` still starts or resumes `RuntimeContextWorkflow`.
That is an explicit requirement of `firegrid-workflow-driven-runtime`.

It is valid to move the workflow declaration and lifecycle helpers into
`execution.ts`. It is not valid in this pass to replace workflow execution with
a direct in-memory `Effect`, a process map, or a host-local mutex.

Future work may revisit whether a single-activity workflow remains the right
shape, but that would be a spec change. This SDD only enables the smaller
cleanup that makes that future discussion easier.

## Codec Runtime Boundary

The codec runtime path is a runtime-host data-plane concern. It should be
separate from workflow lifecycle and layer topology.

The codec module should own:

- selecting `AcpCodec` vs `StdioJsonlCodec` from `RuntimeContext.runtime`;
- opening `AgentByteStream` through `SandboxProvider`;
- translating sequenced RuntimeIngress rows into `AgentInputEvent`;
- journaling `AgentOutputEvent` rows into `RuntimeOutputTable`;
- lowering supported `ToolUse` events through `toolUseToEffect`;
- sending `ToolResult` back only for codecs that support it.

The codec module should not own:

- public session/client API;
- app-owned fact tables;
- provider-specific actions;
- RuntimeContext creation or host topology.

## Ingress Boundary

`appendRuntimeIngress` is a routing primitive. It resolves the
`RuntimeContext`, opens the owner host's `RuntimeIngressTable`, sequences the
input idempotently, and returns the durable row.

That function should live in an ingress-focused module. It should not construct
agent sessions, spawn child processes, know about app facts, or inspect
provider semantics.

## Agent-Tool Host Boundary

`RuntimeHostAgentToolHostLive` is the production host implementation behind
agent-tool lowering. It is allowed to compose runtime-host authority, workflow
execution, and ingress routing.

It should be isolated from the core runtime execution file because its concerns
are different:

- `session_new` creates/starts child RuntimeContext-backed sessions;
- `session_prompt` appends to the owner session's RuntimeIngress;
- `schedule_me` appends after durable workflow delay;
- unsupported execute/cancel/close seams fail explicitly.

This module is still runtime-owned. It should not move into
`packages/runtime/src/agent-tools`, because `agent-tools` owns schema/tool
projection and lowering shape, not host topology or RuntimeContext authority.

## Layer Topology Boundary

Host layer composition should be readable as infrastructure topology:

```txt
namespace scope
  RuntimeHostConfig
  RuntimeControlPlaneTable
  SandboxProvider

host scope
  CurrentHostSession
  RuntimeIngressTable
  RuntimeOutputTable
  WorkflowEngine
  RuntimeSourceRegistrationsLive
  DurableToolsWaitForLive
```

The layer module should make it obvious which streams are namespace-scoped and
which streams are host-owned. Inline stream URL construction should remain
behind `runtimeControlPlaneStreamUrl` and `hostOwnedStreamUrl`.

## Implementation Order

Recommended extraction order:

1. Extract pure row/projection helpers and raw-process runtime helpers.
2. Extract RuntimeIngress append/routing.
3. Extract codec runtime execution and keep existing codec tests green.
4. Extract workflow lifecycle/start runtime.
5. Extract host layer topology.
6. Extract `RuntimeHostAgentToolHostLive`.
7. Leave `index.ts` as a compatibility barrel and remove any accidental
   duplicate imports.

Each step should keep the existing focused runtime-host tests green before the
next extraction.

## Validation

The modularity pass should prove no behavior change through existing tests,
especially:

- runtime start/duplicate-start tests;
- prompt routing tests;
- env binding tests;
- raw local-process runtime codec tests;
- stdio-jsonl and ACP runtime codec event-plane tests;
- runtime observation source tests;
- two-host isolation tests;
- sync-run integration tests.

New tests are not required for a pure extraction unless a hidden behavior gap is
found. If a refactor changes behavior, stop and update the relevant feature
spec before continuing.

## Acceptance

The pass is successful when a reviewer can answer these questions without
reading a 1500-line aggregate file:

- Where does `startRuntime` enter workflow execution?
- Where is raw process stdout/stderr converted into durable output rows?
- Where are ACP/stdio-jsonl codec events converted into durable output rows?
- Where is RuntimeIngress owner-host routing implemented?
- Where is host-owned stream topology composed?
- Where do agent tool calls get runtime-host authority?

If those questions require following product-specific app code, client code, or
MCP transport code, the boundaries are still too tangled.
