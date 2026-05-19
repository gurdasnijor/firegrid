# Type Catalog & Composition Map — Summary

Generated 2026-05-19T06:51:24.726Z. Mechanical static map. No
interpretation, no remediation — what is declared and what references
what. Artifacts: `catalog.json`, `type-composition.dot` (headline, filtered),
`full.dot` (every node), `service-deps.dot`, `per-package/<pkg>/types.dot`.

## Resolution honesty

- Resolved type references: **942**
- Name-matched but **unresolved** among visited identifier nodes (not
  edges): **0** — `as`-casts, dynamic dispatch,
  re-export indirection, or a name colliding with an external symbol
  that ts-morph could not point at a catalogued declaration.
- **Lower-bound caveat.** The composition graph is built by resolving
  *identifier* nodes whose text matches a declared name. References that
  the syntactic traversal never reaches as a bare identifier — string-
  literal types, mapped/conditional/template-literal type indirection,
  declaration-merged augmentations, and anything elided by inference —
  are not counted at all (neither resolved nor unresolved). Edge counts
  are a floor, not a census. `unresolvedNamedRefs = 0` means every
  *name-matched identifier* resolved, not that every reference was seen.
- Cross-package resolution uses a `paths` map synthesized from each
  `package.json` `exports`. Runtime layer composition (`Layer.merge`,
  built layers) is **out of scope** — static type composition only.

Unresolved sample (first 0):

```
(none)
```

## Declared types by kind

| kind | count |
|---|---|
| type-alias | 265 |
| schema-struct | 148 |
| interface | 134 |
| context-tag | 36 |
| layer-instance | 30 |
| other | 22 |
| schema-tagged-class | 20 |
| schema-union | 16 |
| workflow | 1 |
| **total** | **672** |

## Declared types by package

| package | count | kinds |
|---|---|---|
| packages/protocol | 239 | type-alias:123, schema-struct:95, schema-union:8, interface:5, context-tag:3, schema-tagged-class:3, other:2 |
| packages/runtime | 160 | type-alias:46, interface:44, context-tag:21, schema-struct:18, schema-tagged-class:14, layer-instance:7, other:5, schema-union:5 |
| packages/host-sdk | 96 | interface:30, type-alias:27, layer-instance:17, schema-struct:9, context-tag:8, schema-union:3, workflow:1, schema-tagged-class:1 |
| apps/factory | 52 | type-alias:26, schema-struct:23, interface:2, other:1 |
| packages/effect-durable-streams | 46 | interface:25, type-alias:12, other:9 |
| packages/effect-durable-operators | 29 | type-alias:23, interface:4, context-tag:1, schema-tagged-class:1 |
| packages/client-sdk | 20 | interface:10, other:3, context-tag:2, type-alias:2, layer-instance:2, schema-tagged-class:1 |
| packages/tiny-firegrid | 18 | interface:9, type-alias:4, schema-struct:3, context-tag:1, layer-instance:1 |
| packages/cli | 8 | interface:4, other:2, layer-instance:1, type-alias:1 |
| apps/flamecast | 4 | layer-instance:2, type-alias:1, interface:1 |

## Top 20 most-referenced types (codebase-wide)

| type | kind | referrers |
|---|---|---|
| `packages/protocol::RuntimeContext` | type-alias | 18 |
| `packages/effect-durable-streams::HeadersRecord` | interface | 11 |
| `packages/effect-durable-operators::DurableTableHeaders` | type-alias | 10 |
| `packages/protocol::CurrentHostSession` | context-tag | 10 |
| `packages/protocol::RuntimeControlPlaneTable` | other | 10 |
| `packages/effect-durable-streams::Offset` | type-alias | 9 |
| `packages/effect-durable-operators::DurableTableService` | type-alias | 8 |
| `packages/host-sdk::RuntimeHostTopologyOptions` | interface | 7 |
| `apps/factory::DarkFactoryFactSchema` | schema-struct | 7 |
| `packages/client-sdk::LaunchInputError` | other | 7 |
| `packages/effect-durable-operators::DurableTableError` | schema-tagged-class | 7 |
| `packages/effect-durable-streams::Endpoint` | interface | 7 |
| `packages/runtime::DurableWaitRowLookup` | context-tag | 7 |
| `packages/runtime::DurableWaitRowUpsert` | context-tag | 7 |
| `packages/runtime::DurableWaitCompletionRowLookup` | context-tag | 7 |
| `packages/runtime::DurableWaitCompletionRowUpsert` | context-tag | 7 |
| `packages/protocol::PermissionDecisionSchema` | schema-union | 6 |
| `packages/client-sdk::AppendError` | other | 6 |
| `packages/protocol::RuntimeInputIntentRow` | type-alias | 6 |
| `packages/host-sdk::AgentToolHost` | context-tag | 6 |

## Top 20 types referenced from `packages/tiny-firegrid`

| type | kind | refs from tiny-firegrid |
|---|---|---|
| `packages/host-sdk::RuntimeHostTopologyOptions` | interface | 6 |
| `packages/protocol::RuntimeContext` | type-alias | 2 |
| `packages/protocol::RuntimeInputIntentRow` | type-alias | 2 |
| `packages/runtime::RuntimeEnvResolverPolicy` | context-tag | 1 |
| `packages/runtime::RuntimeWaitSource` | type-alias | 1 |
| `packages/runtime::RuntimeAgentOutputObservation` | interface | 1 |
| `packages/runtime::AgentInputEvent` | type-alias | 1 |
| `packages/runtime::AgentCodecError` | schema-tagged-class | 1 |
| `packages/protocol::AgentOutputEvent` | type-alias | 1 |
| `packages/runtime::ProcessOutputChunk` | type-alias | 1 |

## `packages/protocol` types never referenced outside protocol

184 of 239 protocol declarations are
internal-only (no resolved cross-package referrer):

- `packages/protocol::AgentTextDeltaPart` (type-alias)
- `packages/protocol::AgentToolCallPart` (type-alias)
- `packages/protocol::StopReason` (type-alias)
- `packages/protocol::PermissionOptionKind` (type-alias)
- `packages/protocol::PermissionOptionSchema` (schema-struct)
- `packages/protocol::PermissionOption` (type-alias)
- `packages/protocol::AgentCapabilitiesSchema` (schema-struct)
- `packages/protocol::AgentReadyEventSchema` (schema-struct)
- `packages/protocol::AgentTextChunkEventSchema` (schema-struct)
- `packages/protocol::AgentToolUseEventSchema` (schema-struct)
- `packages/protocol::AgentPermissionRequestEventSchema` (schema-struct)
- `packages/protocol::AgentTurnCompleteEventSchema` (schema-struct)
- `packages/protocol::AgentStatusEventSchema` (schema-struct)
- `packages/protocol::AgentErrorEventSchema` (schema-struct)
- `packages/protocol::AgentTerminatedEventSchema` (schema-struct)
- `packages/protocol::FiregridRuntimeObservationSourceName` (type-alias)
- `packages/protocol::SleepToolInputSchema` (schema-struct)
- `packages/protocol::SleepToolInput` (type-alias)
- `packages/protocol::SleepToolOutputSchema` (schema-struct)
- `packages/protocol::SleepToolOutput` (type-alias)
- `packages/protocol::RuntimeWaitSourceSchema` (schema-union)
- `packages/protocol::RuntimeWaitSource` (type-alias)
- `packages/protocol::RuntimeWaitQuerySchema` (schema-struct)
- `packages/protocol::RuntimeWaitQuery` (type-alias)
- `packages/protocol::WaitForToolInputSchema` (schema-struct)
- `packages/protocol::WaitForToolInput` (type-alias)
- `packages/protocol::WaitForToolOutputSchema` (schema-union)
- `packages/protocol::WaitForToolOutput` (type-alias)
- `packages/protocol::SpawnOptionsSchema` (schema-struct)
- `packages/protocol::SpawnToolInputSchema` (schema-struct)
- `packages/protocol::SpawnToolInput` (type-alias)
- `packages/protocol::WorkflowTerminalStateSchema` (schema-union)
- `packages/protocol::SpawnToolOutputSchema` (schema-struct)
- `packages/protocol::SpawnToolOutput` (type-alias)
- `packages/protocol::SpawnTaskSchema` (schema-struct)
- `packages/protocol::SpawnAllToolInputSchema` (schema-struct)
- `packages/protocol::SpawnAllToolInput` (type-alias)
- `packages/protocol::SpawnAllChildResultSchema` (schema-struct)
- `packages/protocol::SpawnAllChildResult` (type-alias)
- `packages/protocol::SpawnAllToolOutputSchema` (schema-struct)
- `packages/protocol::SpawnAllToolOutput` (type-alias)
- `packages/protocol::SessionHandleSchema` (schema-struct)
- `packages/protocol::SessionHandle` (type-alias)
- `packages/protocol::SessionNewToolInputSchema` (schema-struct)
- `packages/protocol::SessionNewToolInput` (type-alias)
- `packages/protocol::SessionNewToolOutputSchema` (schema-struct)
- `packages/protocol::SessionNewToolOutput` (type-alias)
- `packages/protocol::SessionPromptToolInputSchema` (schema-struct)
- `packages/protocol::SessionPromptToolOutputSchema` (schema-struct)
- `packages/protocol::SessionStatusInputSchema` (schema-struct)
- `packages/protocol::SessionStatusInput` (type-alias)
- `packages/protocol::SessionStatusOutputSchema` (schema-struct)
- `packages/protocol::SessionStatusOutput` (type-alias)
- `packages/protocol::SessionCancelToolInputSchema` (schema-struct)
- `packages/protocol::SessionCancelToolInput` (type-alias)
- `packages/protocol::SessionCancelToolOutputSchema` (schema-struct)
- `packages/protocol::SessionCancelToolOutput` (type-alias)
- `packages/protocol::SessionCloseToolInputSchema` (schema-struct)
- `packages/protocol::SessionCloseToolInput` (type-alias)
- `packages/protocol::SessionCloseToolOutputSchema` (schema-struct)

…and 124 more (see catalog.json).

## `packages/host-sdk` types referenced from apps/ or consumer packages

8 cross-package consumption edges into host-sdk:

- `packages/host-sdk::RuntimeHostTopologyOptions  ← apps/factory::DarkFactoryHostConfig`
- `packages/host-sdk::FiregridMcpServerListenerConfig  ← packages/cli::firegridHostLayer`
- `packages/host-sdk::RuntimeHostTopologyOptions  ← packages/tiny-firegrid::CodexAcpToolCallPipelineOptions`
- `packages/host-sdk::RuntimeHostTopologyOptions  ← packages/tiny-firegrid::DurableStreamsBackedPipelineOptions`
- `packages/host-sdk::RuntimeHostTopologyOptions  ← packages/tiny-firegrid::MultiContextProductionConsumingPipelineOptions`
- `packages/host-sdk::RuntimeHostTopologyOptions  ← packages/tiny-firegrid::OutputJournalPipelineOptions`
- `packages/host-sdk::RuntimeHostTopologyOptions  ← packages/tiny-firegrid::PermissionFlowPipelineOptions`
- `packages/host-sdk::RuntimeHostTopologyOptions  ← packages/tiny-firegrid::StdioJsonlToolExecutionPipelineOptions`


## Cycles

- type-composition: **0** strongly-connected component(s) with >1 node or a self-loop.
  - (none)
- service-deps: **0** SCC(s).
  - (none)

## Maximum composition depth

Longest resolved referrer→referent path: **12** edges, from
`packages/host-sdk::RuntimeControlRequestReconcilerLive` (cycle-guarded; condensed over SCCs).
