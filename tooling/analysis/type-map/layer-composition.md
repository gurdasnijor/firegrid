# Analysis A — Layer-Composition Graph

Generated 2026-05-20T10:09:30.152Z. Mechanical. Runtime layer
composition (which Live layer provides which Tag, what merges into what).
No interpretation, no remediation.

DOT: `layer-composition.dot` (headline, core filter),
`layer-composition-full.dot` (all 102),
`layer-composition-core.dot` (combined degree ≥ 3),
`layer-composition-host-build.dot` (closure around `packages/host-sdk::FiregridRuntimeHostLive`).
Edge style: solid = `merge`, dashed = `provide`, bold = `provideMerge`,
dotted = `requires` (layer-body `yield* Tag` dependency, not an operator).

## ts-morph limits (honest)

- `Layer.unwrapEffect`/`unwrapScoped` (computed/dynamic tag): **11** site(s).
  Produced/consumed tags are NOT statically resolved for these — recorded, not edged.
  - packages/client-sdk/src/firegrid.ts:1065
  - packages/cli/src/bin/host.ts:22
  - packages/host-sdk/src/host/config-live.ts:42
  - packages/host-sdk/src/host/config-live.ts:46
  - packages/host-sdk/src/host/config-live.ts:58
  - packages/host-sdk/src/host/host-owned-durable-tools.ts:19
  - packages/host-sdk/src/host/layers.ts:79
  - packages/host-sdk/src/host/layers.ts:93
  - packages/host-sdk/src/host/layers.ts:127
  - packages/host-sdk/src/host/layers.ts:222
  - packages/tiny-firegrid/src/runner/telemetry.ts:205
- Layer operands resolved by identifier→const (symbol resolution, then
  name fallback). Inline anonymous layers and re-export-* indirection
  that did not resolve are not edged. Const-name collisions across
  packages: none.
- Producer→layer requirement edges are syntactic (`yield* Tag` in the
  layer body), same basis as the type-map S3 pass.

## Live layers declared, by package

| package | layer consts |
|---|---|
| packages/host-sdk | 37 |
| packages/tiny-firegrid | 34 |
| packages/runtime | 22 |
| packages/cli | 4 |
| packages/client-sdk | 3 |
| packages/effect-durable-operators | 2 |
| **total** | **102** |

Edges: **70** — operators: merge 18, provide 13, provideMerge 21; plus 18 `requires` (layer-body dependency) edges.

These are **resolved, de-duplicated graph edges** (a source/target that
did not resolve to a catalogued or inline layer node is not edged, and a
repeated source→target pair counts once). They are therefore ≤ the raw
operator **call-site** counts in the *provideMerge vs provide* section
below — that section is the authoritative usage census; this graph is
the structural view.

## Highest fan-in (most layers compose them in)

| layer | fan-in |
|---|---|
| `packages/host-sdk::RuntimeHostAgentToolHostLive` | 6 |
| `packages/host-sdk::FiregridRuntimeHostLive` | 6 |
| `packages/host-sdk::runtimeContextWorkflowSupportLayer` | 6 |
| `packages/tiny-firegrid::streamZipWorkflowSupportLayer` | 6 |
| `packages/runtime::RuntimeControlPlaneRecorderLive` | 5 |
| `packages/host-sdk::RuntimeStartCapabilityLive` | 4 |
| `packages/host-sdk::toolCallWorkflowSupportLayer` | 4 |
| `packages/host-sdk::FiregridMcpServerLayer` | 3 |
| `packages/host-sdk::HostRuntimeObservationSubstrateLive` | 3 |
| `packages/runtime::DurableWaitStoreLive` | 3 |
| `packages/tiny-firegrid::generationLayer` | 3 |
| `packages/host-sdk::PerContextRuntimeAgentOutputAfterEventsLive` | 2 |

## Highest fan-out (compose in the most layers)

| layer | fan-out |
|---|---|
| `packages/runtime::RuntimeControlPlaneRecorderLive` | 7 |
| `packages/host-sdk::currentHostSessionLayer` | 5 |
| `packages/host-sdk::HostRuntimeObservationSubstrateLive` | 5 |
| `inline::WorkflowEngine` | 4 |
| `packages/host-sdk::namespaceScopedLayer` | 3 |
| `packages/host-sdk::RuntimeContextEngineRegistryLive` | 3 |
| `inline::WorkflowEngineTable` | 3 |
| `inline::AgentToolHost` | 3 |
| `packages/runtime::RuntimeContextInsertLive` | 2 |
| `inline::IdGenerator` | 2 |
| `packages/host-sdk::RuntimeToolUseExecutorLive` | 2 |
| `packages/runtime::RuntimeAgentOutputEventsLayer` | 2 |

## Structural cycles

**1** strongly-connected component(s) with > 1 node or a self-loop.

### Cycle 1

- members: `packages/host-sdk::RuntimeToolUseExecutorLive`, `packages/host-sdk::runtimeContextWorkflowSupportLayer`
- symbol path: RuntimeToolUseExecutorLive → runtimeContextWorkflowSupportLayer → RuntimeToolUseExecutorLive

## provideMerge vs provide (counts + named sites)

- `provide`: **73** call sites
- `provideMerge`: **69** call sites

provideMerge sites:

```
packages/cli/src/bin/host.ts:41
packages/cli/src/bin/run.ts:433
packages/cli/src/bin/run.ts:434
packages/host-sdk/src/host/layers.ts:254
packages/host-sdk/src/host/layers.ts:257
packages/host-sdk/src/host/layers.ts:310
packages/host-sdk/src/host/layers.ts:311
packages/host-sdk/src/host/layers.ts:312
packages/host-sdk/src/host/layers.ts:313
packages/host-sdk/src/host/layers.ts:314
packages/host-sdk/src/host/layers.ts:315
packages/host-sdk/src/host/layers.ts:316
packages/host-sdk/src/host/layers.ts:324
packages/host-sdk/src/host/mcp-host.ts:263
packages/host-sdk/src/host/runtime-context-workflow-support.ts:38
packages/host-sdk/src/host/runtime-context-workflow-support.ts:39
packages/host-sdk/src/host/runtime-context-workflow-support.ts:44
packages/host-sdk/src/host/runtime-context-workflow-support.ts:45
packages/host-sdk/src/host/runtime-context-workflow-support.ts:46
packages/host-sdk/src/host/runtime-substrate.ts:58
packages/runtime/src/durable-tools/DurableToolsWaitFor.ts:50
packages/runtime/src/durable-tools/DurableToolsWaitFor.ts:51
packages/host-sdk/src/agent-tools/execution/toolkit-layer.ts:111
packages/host-sdk/src/agent-tools/execution/toolkit-layer.ts:112
packages/host-sdk/src/agent-tools/execution/toolkit-layer.ts:113
packages/host-sdk/src/agent-tools/execution/toolkit-layer.ts:114
packages/tiny-firegrid/src/simulations/codex-acp-tool-calls/host.ts:85
packages/tiny-firegrid/src/simulations/dark-factory/host.ts:139
packages/tiny-firegrid/src/simulations/dark-factory/host.ts:150
packages/tiny-firegrid/src/simulations/dark-factory/host.ts:151
packages/tiny-firegrid/src/simulations/inv1-stream-zip-body/host.ts:674
packages/tiny-firegrid/src/simulations/inv1-stream-zip-body/host.ts:675
packages/tiny-firegrid/src/simulations/inv1-stream-zip-body/host.ts:680
packages/tiny-firegrid/src/simulations/inv1-stream-zip-body/host.ts:681
packages/tiny-firegrid/src/simulations/inv1-stream-zip-body/host.ts:682
packages/tiny-firegrid/src/simulations/inv1-stream-zip-body/host.ts:789
packages/tiny-firegrid/src/simulations/inv2-waitforworkflow/host.ts:179
packages/tiny-firegrid/src/simulations/inv2-waitforworkflow/host.ts:180
packages/tiny-firegrid/src/simulations/inv2-waitforworkflow/mcp-server.ts:202
packages/tiny-firegrid/src/simulations/inv2-waitforworkflow-layered/host.ts:182
```
…and 29 more.

provide sites (first 40):

```
packages/client-sdk/src/firegrid.ts:1091
packages/cli/src/bin/run.ts:433
packages/host-sdk/src/host/layers.ts:101
packages/host-sdk/src/host/layers.ts:103
packages/host-sdk/src/host/layers.ts:251
packages/host-sdk/src/host/mcp-host.ts:239
packages/host-sdk/src/host/mcp-host.ts:240
packages/host-sdk/src/host/mcp-host.ts:241
packages/host-sdk/src/host/mcp-host.ts:249
packages/host-sdk/src/host/mcp-host.ts:254
packages/host-sdk/src/host/mcp-host.ts:257
packages/host-sdk/src/host/mcp-host.ts:269
packages/host-sdk/src/host/mcp-host.ts:275
packages/host-sdk/src/host/runtime-context-workflow-support.ts:41
packages/runtime/src/durable-tools/DurableToolsWaitFor.ts:46
packages/runtime/src/durable-tools/DurableToolsWaitFor.ts:47
packages/runtime/src/workflow-engine/DurableStreamsWorkflowEngine.ts:51
packages/tiny-firegrid/src/runner/runtime.ts:99
packages/tiny-firegrid/src/runner/telemetry.ts:215
packages/host-sdk/src/host/runtime-context-session/codec-adapter.ts:191
packages/host-sdk/src/host/runtime-context-session/codec-adapter.ts:323
packages/host-sdk/src/host/runtime-context-session/codec-adapter.ts:325
packages/tiny-firegrid/src/simulations/codec-stdio-jsonl-live/host.ts:219
packages/tiny-firegrid/src/simulations/codec-stdio-jsonl-live/host.ts:220
packages/tiny-firegrid/src/simulations/codex-acp-tool-calls/host.ts:68
packages/tiny-firegrid/src/simulations/codex-acp-tool-calls/host.ts:69
packages/tiny-firegrid/src/simulations/dark-factory/host.ts:105
packages/tiny-firegrid/src/simulations/dark-factory/host.ts:127
packages/tiny-firegrid/src/simulations/inv1-stream-zip-body/host.ts:677
packages/tiny-firegrid/src/simulations/inv1-stream-zip-body/host.ts:771
packages/tiny-firegrid/src/simulations/inv1-stream-zip-body/host.ts:772
packages/tiny-firegrid/src/simulations/inv2-waitforworkflow/host.ts:146
packages/tiny-firegrid/src/simulations/inv2-waitforworkflow/host.ts:154
packages/tiny-firegrid/src/simulations/inv2-waitforworkflow/host.ts:161
packages/tiny-firegrid/src/simulations/inv2-waitforworkflow/host.ts:162
packages/tiny-firegrid/src/simulations/inv2-waitforworkflow/host.ts:174
packages/tiny-firegrid/src/simulations/inv2-waitforworkflow/mcp-server.ts:201
packages/tiny-firegrid/src/simulations/inv2-waitforworkflow/mcp-server.ts:203
packages/tiny-firegrid/src/simulations/inv2-waitforworkflow/mcp-server.ts:210
packages/tiny-firegrid/src/simulations/inv2-waitforworkflow/mcp-server.ts:216
```
…and 33 more.
