# Analysis A — Layer-Composition Graph

Generated 2026-05-19T07:07:11.550Z. Mechanical. Runtime layer
composition (which Live layer provides which Tag, what merges into what).
No interpretation, no remediation.

DOT: `layer-composition.dot` (headline),
`layer-composition-full.dot` (all 79),
`layer-composition-core.dot` (combined degree ≥ 3),
`layer-composition-host-build.dot` (closure around `packages/host-sdk::FiregridRuntimeHostLive`).
Edge style: solid = `merge`, dashed = `provide`, bold = `provideMerge`,
dotted = `requires` (layer-body `yield* Tag` dependency, not an operator).

## ts-morph limits (honest)

- `Layer.unwrapEffect`/`unwrapScoped` (computed/dynamic tag): **10** site(s).
  Produced/consumed tags are NOT statically resolved for these — recorded, not edged.
  - packages/client-sdk/src/firegrid.ts:862
  - packages/cli/src/bin/host.ts:22
  - apps/factory/src/bin/env.ts:51
  - apps/flamecast/src/runtime/host.ts:60
  - packages/host-sdk/src/host/config-live.ts:42
  - packages/host-sdk/src/host/config-live.ts:46
  - packages/host-sdk/src/host/config-live.ts:58
  - packages/host-sdk/src/host/host-owned-durable-tools.ts:9
  - packages/host-sdk/src/host/layers.ts:74
  - packages/host-sdk/src/host/layers.ts:171
- Layer operands resolved by identifier→const (symbol resolution, then
  name fallback). Inline anonymous layers and re-export-* indirection
  that did not resolve are not edged. Const-name collisions across
  packages: none.
- Producer→layer requirement edges are syntactic (`yield* Tag` in the
  layer body), same basis as the type-map S3 pass.

## Live layers declared, by package

| package | layer consts |
|---|---|
| packages/host-sdk | 34 |
| packages/runtime | 24 |
| packages/tiny-firegrid | 5 |
| packages/cli | 4 |
| apps/flamecast | 4 |
| apps/factory | 3 |
| packages/client-sdk | 3 |
| packages/effect-durable-operators | 2 |
| **total** | **79** |

Edges: **62** — operators: merge 19, provide 13, provideMerge 13; plus 17 `requires` (layer-body dependency) edges.

These are **resolved, de-duplicated graph edges** (a source/target that
did not resolve to a catalogued or inline layer node is not edged, and a
repeated source→target pair counts once). They are therefore ≤ the raw
operator **call-site** counts in the *provideMerge vs provide* section
below — that section is the authoritative usage census; this graph is
the structural view.

## Highest fan-in (most layers compose them in)

| layer | fan-in |
|---|---|
| `packages/host-sdk::FiregridRuntimeHostLive` | 6 |
| `packages/host-sdk::runtimeContextWorkflowSupportLayer` | 6 |
| `packages/host-sdk::RuntimeHostAgentToolHostLive` | 5 |
| `packages/runtime::RuntimeControlPlaneRecorderLive` | 5 |
| `packages/runtime::DurableWaitStoreLive` | 5 |
| `packages/host-sdk::RuntimeStartCapabilityLive` | 4 |
| `packages/host-sdk::toolCallWorkflowSupportLayer` | 4 |
| `packages/host-sdk::FiregridMcpServerLayer` | 3 |
| `packages/host-sdk::HostRuntimeObservationSubstrateLive` | 3 |
| `packages/host-sdk::PerContextRuntimeAgentOutputAfterEventsLive` | 2 |
| `packages/host-sdk::RuntimeContextEngineRegistryLive` | 2 |
| `packages/runtime::layer` | 2 |

## Highest fan-out (compose in the most layers)

| layer | fan-out |
|---|---|
| `packages/runtime::RuntimeControlPlaneRecorderLive` | 6 |
| `packages/host-sdk::currentHostSessionLayer` | 5 |
| `packages/host-sdk::RuntimeContextEngineRegistryLive` | 3 |
| `packages/host-sdk::HostRuntimeObservationSubstrateLive` | 3 |
| `inline::WorkflowEngine` | 3 |
| `packages/tiny-firegrid::MemoryRuntimeControlPlaneTableLive` | 3 |
| `apps/flamecast::FiregridBrowserConfigLive` | 2 |
| `packages/runtime::RuntimeContextInsertLive` | 2 |
| `inline::IdGenerator` | 2 |
| `packages/host-sdk::namespaceScopedLayer` | 2 |
| `inline::WorkflowEngineTable` | 2 |
| `inline::AgentToolHost` | 2 |

## Structural cycles

**1** strongly-connected component(s) with > 1 node or a self-loop.

### Cycle 1

- members: `packages/host-sdk::RuntimeToolUseExecutorLive`, `packages/host-sdk::runtimeContextWorkflowSupportLayer`
- symbol path: RuntimeToolUseExecutorLive → runtimeContextWorkflowSupportLayer → RuntimeToolUseExecutorLive

## provideMerge vs provide (counts + named sites)

- `provide`: **22** call sites
- `provideMerge`: **33** call sites

provideMerge sites:

```
apps/factory/src/host.ts:187
apps/factory/src/host.ts:188
packages/cli/src/bin/host.ts:41
packages/cli/src/bin/run.ts:433
packages/cli/src/bin/run.ts:434
apps/flamecast/src/runtime/host.ts:90
packages/host-sdk/src/host/layers.ts:203
packages/host-sdk/src/host/layers.ts:206
packages/host-sdk/src/host/layers.ts:259
packages/host-sdk/src/host/layers.ts:260
packages/host-sdk/src/host/layers.ts:261
packages/host-sdk/src/host/layers.ts:262
packages/host-sdk/src/host/layers.ts:263
packages/host-sdk/src/host/layers.ts:264
packages/host-sdk/src/host/layers.ts:265
packages/host-sdk/src/host/layers.ts:273
packages/host-sdk/src/host/mcp-host.ts:226
packages/host-sdk/src/host/runtime-context-workflow-support.ts:44
packages/host-sdk/src/host/runtime-context-workflow-support.ts:45
packages/host-sdk/src/host/runtime-context-workflow-support.ts:50
packages/host-sdk/src/host/runtime-context-workflow-support.ts:51
packages/host-sdk/src/host/runtime-context-workflow-support.ts:52
packages/host-sdk/src/host/runtime-substrate.ts:81
packages/runtime/src/durable-tools/DurableToolsWaitFor.ts:50
packages/runtime/src/durable-tools/DurableToolsWaitFor.ts:51
packages/tiny-firegrid/src/configurations/codex-acp-tool-call-pipeline.ts:71
packages/tiny-firegrid/src/configurations/current-pipeline.ts:192
packages/tiny-firegrid/src/configurations/dispatcher-driven-pipeline.ts:226
packages/tiny-firegrid/src/configurations/multi-context-pipeline.ts:266
packages/host-sdk/src/agent-tools/execution/toolkit-layer.ts:112
packages/host-sdk/src/agent-tools/execution/toolkit-layer.ts:113
packages/host-sdk/src/agent-tools/execution/toolkit-layer.ts:114
packages/host-sdk/src/agent-tools/execution/toolkit-layer.ts:115
```

provide sites (first 40):

```
apps/factory/src/host.ts:178
packages/client-sdk/src/firegrid.ts:888
packages/cli/src/bin/run.ts:433
apps/flamecast/src/client/main.tsx:50
apps/flamecast/src/client/main.tsx:54
apps/flamecast/src/runtime/host.ts:85
packages/host-sdk/src/host/layers.ts:147
packages/host-sdk/src/host/layers.ts:200
packages/host-sdk/src/host/mcp-host.ts:202
packages/host-sdk/src/host/mcp-host.ts:203
packages/host-sdk/src/host/mcp-host.ts:204
packages/host-sdk/src/host/mcp-host.ts:212
packages/host-sdk/src/host/mcp-host.ts:217
packages/host-sdk/src/host/mcp-host.ts:220
packages/host-sdk/src/host/mcp-host.ts:234
packages/host-sdk/src/host/runtime-context-workflow-support.ts:47
packages/runtime/src/durable-tools/DurableToolsWaitFor.ts:46
packages/runtime/src/durable-tools/DurableToolsWaitFor.ts:47
packages/runtime/src/workflow-engine/DurableStreamsWorkflowEngine.ts:51
packages/host-sdk/src/host/runtime-context-session/codec-adapter.ts:173
packages/host-sdk/src/host/runtime-context-session/codec-adapter.ts:267
packages/host-sdk/src/host/runtime-context-session/codec-adapter.ts:269
```

