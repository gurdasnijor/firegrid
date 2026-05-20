# Type Catalog & Composition Map — Summary

Generated 2026-05-20T10:08:55.762Z. Mechanical static map. No
interpretation, no remediation — what is declared and what references
what. Artifacts: `catalog.json`, `type-composition.dot` (headline, filtered),
`full.dot` (every node), `service-deps.dot`, `per-package/<pkg>/types.dot`.

## Resolution honesty

- Resolved type references: **1013**
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
| type-alias | 277 |
| interface | 199 |
| schema-struct | 161 |
| other | 40 |
| context-tag | 36 |
| layer-instance | 33 |
| schema-union | 26 |
| schema-tagged-class | 20 |
| workflow | 5 |
| **total** | **797** |

## Declared types by package

| package | count | kinds |
|---|---|---|
| packages/protocol | 243 | type-alias:125, schema-struct:97, schema-union:8, interface:5, context-tag:3, schema-tagged-class:3, other:2 |
| packages/tiny-firegrid | 177 | interface:74, schema-struct:33, type-alias:31, other:19, schema-union:9, layer-instance:6, workflow:4, context-tag:1 |
| packages/runtime | 155 | type-alias:44, interface:43, context-tag:20, schema-struct:17, schema-tagged-class:14, layer-instance:7, other:5, schema-union:5 |
| packages/host-sdk | 114 | type-alias:37, interface:31, layer-instance:17, schema-struct:14, context-tag:9, schema-union:4, workflow:1, schema-tagged-class:1 |
| packages/effect-durable-streams | 46 | interface:25, type-alias:12, other:9 |
| packages/effect-durable-operators | 30 | type-alias:24, interface:4, context-tag:1, schema-tagged-class:1 |
| packages/client-sdk | 24 | interface:13, other:3, type-alias:3, context-tag:2, layer-instance:2, schema-tagged-class:1 |
| packages/cli | 8 | interface:4, other:2, layer-instance:1, type-alias:1 |

## Top 20 most-referenced types (codebase-wide)

| type | kind | referrers |
|---|---|---|
| `packages/protocol::RuntimeContext` | type-alias | 16 |
| `packages/protocol::RuntimeControlPlaneTable` | other | 13 |
| `packages/effect-durable-streams::HeadersRecord` | interface | 11 |
| `packages/protocol::CurrentHostSession` | context-tag | 11 |
| `packages/protocol::RowOtelContextSchema` | schema-struct | 11 |
| `packages/tiny-firegrid::FactRowSchema` | schema-struct | 11 |
| `packages/effect-durable-streams::Offset` | type-alias | 9 |
| `packages/runtime::RuntimeAgentOutputObservation` | interface | 9 |
| `packages/runtime::RuntimeContextError` | schema-tagged-class | 8 |
| `packages/effect-durable-operators::DurableTableHeaders` | type-alias | 7 |
| `packages/client-sdk::LaunchInputError` | other | 7 |
| `packages/effect-durable-operators::DurableTableError` | schema-tagged-class | 7 |
| `packages/effect-durable-operators::DurableTableService` | type-alias | 7 |
| `packages/effect-durable-streams::Endpoint` | interface | 7 |
| `packages/client-sdk::AppendError` | other | 6 |
| `packages/host-sdk::AgentToolHost` | context-tag | 6 |
| `packages/host-sdk::RuntimeHostConfig` | context-tag | 6 |
| `packages/host-sdk::RuntimeContextEngineRegistry` | context-tag | 6 |
| `packages/protocol::RuntimeOutputTable` | other | 6 |
| `packages/protocol::AgentOutputEvent` | type-alias | 6 |

## Top 20 types referenced from `packages/tiny-firegrid`

| type | kind | refs from tiny-firegrid |
|---|---|---|
| `packages/runtime::RuntimeAgentOutputObservation` | interface | 3 |
| `packages/protocol::RuntimeControlPlaneTable` | other | 3 |
| `packages/runtime::AgentInputEvent` | type-alias | 2 |
| `packages/host-sdk::RuntimeExitEvidence` | schema-struct | 2 |
| `packages/runtime::RuntimeContextError` | schema-tagged-class | 2 |
| `packages/host-sdk::FiregridHost` | type-alias | 1 |
| `packages/client-sdk::Firegrid` | context-tag | 1 |
| `packages/protocol::AgentOutputEventSchema` | schema-union | 1 |
| `packages/host-sdk::RuntimeContextWorkflowPayload` | schema-struct | 1 |
| `packages/host-sdk::StartRuntimeResultSchema` | schema-struct | 1 |
| `packages/host-sdk::RuntimeContextWorkflowExecutionEnv` | type-alias | 1 |
| `packages/protocol::CurrentHostSession` | context-tag | 1 |
| `packages/host-sdk::RuntimeContextWorkflowSession` | context-tag | 1 |
| `packages/runtime::RuntimeAgentOutputAfterEvents` | context-tag | 1 |
| `packages/runtime::WorkflowEngineTable` | other | 1 |
| `packages/runtime::WorkflowActivityClaimRow` | type-alias | 1 |
| `packages/runtime::WorkflowClockWakeupRow` | type-alias | 1 |
| `packages/protocol::AgentOutputEvent` | type-alias | 1 |

## `packages/protocol` types never referenced outside protocol

191 of 243 protocol declarations are
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

…and 131 more (see catalog.json).

## `packages/host-sdk` types referenced from consumer packages

8 cross-package consumption edges into host-sdk:

- `packages/host-sdk::FiregridHost  ← packages/tiny-firegrid::TinyFiregridSimulation`
- `packages/host-sdk::FiregridMcpServerListenerConfig  ← packages/cli::firegridHostLayer`
- `packages/host-sdk::RuntimeExitEvidence  ← packages/tiny-firegrid::Inv1StreamZipState`
- `packages/host-sdk::RuntimeContextWorkflowPayload  ← packages/tiny-firegrid::RuntimeContextWorkflowStreamZip`
- `packages/host-sdk::StartRuntimeResultSchema  ← packages/tiny-firegrid::RuntimeContextWorkflowStreamZip`
- `packages/host-sdk::RuntimeContextWorkflowExecutionEnv  ← packages/tiny-firegrid::RuntimeContextWorkflowStreamZipLayer`
- `packages/host-sdk::RuntimeExitEvidence  ← packages/tiny-firegrid::StreamZipState`
- `packages/host-sdk::RuntimeContextWorkflowSession  ← packages/tiny-firegrid::RuntimeContextWorkflowStreamZipLayer`


## Cycles

- type-composition: **0** strongly-connected component(s) with >1 node or a self-loop.
  - (none)
- service-deps: **0** SCC(s).
  - (none)

## Maximum composition depth

Longest resolved referrer→referent path: **12** edges, from
`packages/host-sdk::RuntimeControlRequestReconcilerLive` (cycle-guarded; condensed over SCCs).
