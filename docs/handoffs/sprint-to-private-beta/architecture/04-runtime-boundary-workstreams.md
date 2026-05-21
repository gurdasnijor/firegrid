# Runtime Boundary Workstreams

Do not dispatch "move host-sdk to runtime." Dispatch by spine.

## Workstream A: Runtime Context Workflow Spine

Candidate files:

- `packages/host-sdk/src/host/runtime-context-workflow-runtime.ts`
- `packages/host-sdk/src/host/runtime-input-deferred.ts`
- `packages/host-sdk/src/host/runtime-context-workflow-core.ts`
- `packages/host-sdk/src/host/runtime-context-workflow-support.ts`
- `packages/host-sdk/src/host/runtime-substrate.ts`

Target:

- runtime owns workflow-engine lifecycle, active execution mechanics, deferred
  input delivery, checkpoint source, runtime output/input authority, and
  workflow support;
- host-sdk provides only top-level host composition and host-local config;
- public host composition cannot see workflow engine internals.

Acceptance:

- carveout list shrinks;
- runtime does not import host-sdk;
- host-sdk projection code depends on runtime-owned capability tags, not
  `host/runtime-substrate.ts`.

## Workstream B: Control-Plane Spine

Candidate files:

- `packages/host-sdk/src/host/control-request-reconciler.ts`
- `packages/host-sdk/src/host/commands.ts`
- session/control pieces of `packages/host-sdk/src/host/agent-tool-host-live.ts`

Current role:

```text
protocol-owned control request rows
  -> control request dispatcher observes rows
  -> runtime control workflows execute requests
  -> completion rows record terminal outcome
```

Important correction: the old 5s polling loop is no longer the live shape. The
current daemon performs a startup backfill scan and then uses `.rows()` stream
subscriptions; `pollIntervalMs` is vestigial API/name debt. The live problem is
not polling cost. The live problem is that the control-plane dispatcher and
workflow-engine Layer are still exported and composed from host-sdk.

Target:

- runtime owns the dispatcher/daemon and hides it inside the runtime
  host/control-plane spine;
- workflow definitions stay under
  `packages/runtime/src/workflow-engine/workflows/`;
- host-sdk exposes public host/session/control capabilities, not
  `RuntimeControlRequestWorkflowEngineLive` or reconciler internals;
- stale poll-era options are removed or compatibility-shimmed with deletion
  target.

Do not delete `control-request-reconciler.ts` until its request-row
compatibility bridge has moved or the durable request-row surface is retired.

## Workstream C: Runtime Output And Session Adapter Spine

Candidate files:

- `packages/host-sdk/src/host/per-context-runtime-output.ts`
- `packages/host-sdk/src/host/runtime-context-session/*`
- runtime-backed parts of `packages/host-sdk/src/host/channels/session-self/*`
- `packages/host-sdk/src/host/projection-observer.ts`

Target:

- runtime owns ACP/stdio-jsonl session adapters, codec selection, stderr
  journaling, output streaming, and encoded input-event delivery;
- runtime exposes normalized observation/capability tags;
- host-sdk exposes channel wrappers and host composition;
- simulations use client waits, semantic channels, or package-local runtime
  observations instead of exported host projection observers.

`tf-6w3s` sharpened this from "general boundary debt" into external-effect
adapter debt: `runtime-context-session/codec-adapter.ts` and
`runtime-context-session/raw-adapter.ts` own `ReadableStream` /
`WritableStream` conversion and `Effect.tryPromise(... stdin.write ...)`
effects. Those are adapter bodies, not host composition. Host-sdk may choose
which runtime session adapter to install; the byte-stream adapter
implementation belongs below the runtime line.

## Workstream D: Tool Execution And Agent/MCP Binding

Candidate files:

- `packages/host-sdk/src/agent-tools/execution/tool-use-to-effect.ts`
- `packages/host-sdk/src/agent-tools/execution/toolkit-layer.ts`
- `packages/runtime/src/agent-event-pipeline/subscribers/runtime-tool-use-executor.ts`
- `packages/host-sdk/src/host/mcp-host.ts` for the boundary decision only

Target:

- runtime owns common tool execution services and workflow-backed execution;
- host-sdk/agent binding owns MCP/Effect-AI `Tool` / `Toolkit` projection;
- `toolkit-layer.ts` stops importing `host/runtime-substrate.ts`;
- `runtime-tool-use-executor.ts` moves out of `subscribers/` because it is a
  service tag, not a scoped observation subscriber.
- MCP HTTP server installation is decided explicitly: either it remains a
  binding-edge projection server in host-sdk with no durable substrate
  authority, or its server body moves to a runtime/agent-tools package. Do not
  leave it as an unnamed exception to the external-effect adapter rule.

Post-beta package decision: extract agent/MCP binding into `@firegrid/agent-tools`
after private beta unless evidence says it must split earlier.

## Workstream E: Durable Authorities

Legitimate runtime substrate:

- `packages/runtime/src/authorities/runtime-control-plane-recorder.ts`
- `packages/runtime/src/authorities/README.md`

Rule:

- authorities are narrow runtime-owned capability providers over durable table
  families;
- they should export tags/layers and typed operations;
- they should not become public table-facade escape hatches;
- host-sdk should compose them only through top-level runtime capabilities.

## Workstream F: External-Effect Adapter Boundary

Source-read evidence:

- `docs/research/tf-6w3s-external-effect-adapter-inventory.FINDING.md`

Verdict:

- application-level adapter set is finite and matches the One Substrate SDD
  directionally;
- `effect-durable-streams` and `effect-durable-operators` are legitimate
  substrate transport libraries outside runtime;
- product-layer host/CLI hits remain follow-up work or explicit exceptions.

Actionable surfaces:

- `packages/host-sdk/src/host/runtime-context-session/codec-adapter.ts`
- `packages/host-sdk/src/host/runtime-context-session/raw-adapter.ts`
- `packages/host-sdk/src/host/mcp-host.ts`
- `packages/cli/src/bin/run.ts` embedded Durable Stream test server start/stop

Target:

- session byte-stream adapters move below the runtime line;
- MCP HTTP server placement is recorded as either binding-edge projection
  exception or moved under a runtime/agent-tools package;
- CLI embedded test-server lifecycle is either moved to a test/dev harness
  module or explicitly documented as a CLI dev-only exception;
- One Substrate synthesis does not claim "all external effects are already in
  runtime" until these dispositions are closed.
