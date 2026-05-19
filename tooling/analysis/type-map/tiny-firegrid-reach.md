# Analysis C — tiny-firegrid Reach Subgraph

Generated 2026-05-19T07:11:44.135Z. Mechanical. Forward closure of the
type-composition graph from every type declared in `packages/tiny-firegrid`
(16 roots). No interpretation, no remediation.

DOT: `tiny-firegrid-reach.dot` (closure,
unreached substrate PUBLIC in a dashed sidebar), `tiny-firegrid-reach-full.dot` (entire closure, 56 nodes).

## Honesty

- Edges are the same symbol-resolved type-composition edges as the
  initial map (identifier resolution; `as`-casts / string-literal /
  mapped-type indirection not traversed — reach is a **lower bound**).
- PUBLIC classification joined from `catalog.json` (Analysis B):
  joined.
- "substrate" = `packages/*` excluding `packages/tiny-firegrid`; apps are consumers
  and excluded. Substrate packages: `packages/cli`, `packages/client-sdk`, `packages/effect-durable-operators`, `packages/effect-durable-streams`, `packages/host-sdk`, `packages/protocol`, `packages/runtime`.

## Reach

- tiny-firegrid roots: **16**
- total types reached (transitive closure): **56**
- of the 657 declared types, that is **9%**

## Coverage of each package's PUBLIC surface

| package | declared | PUBLIC | PUBLIC reached | % PUBLIC reached | any reached |
|---|---|---|---|---|---|
| apps/factory | 52 | 0 | 0 | 0% | 0 |
| apps/flamecast | 4 | 0 | 0 | 0% | 0 |
| packages/cli | 8 | 1 | 0 | 0% | 0 |
| packages/client-sdk | 20 | 18 | 0 | 0% | 0 |
| packages/effect-durable-operators | 29 | 8 | 1 | 13% | 1 |
| packages/effect-durable-streams | 46 | 29 | 0 | 0% | 0 |
| packages/host-sdk | 89 | 38 | 1 | 3% | 1 |
| packages/protocol | 233 | 221 | 22 | 10% | 22 |
| packages/runtime | 160 | 122 | 15 | 12% | 16 |
| packages/tiny-firegrid (roots) | 16 | 0 | 0 | 0% | 16 |

## Substrate PUBLIC types NOT reached by tiny-firegrid (coverage gaps)

**398** substrate public types are never exercised by
the proving ground:

- `packages/cli::firegridHostLayer` (layer-instance)
- `packages/client-sdk::AppendError` (other)
- `packages/client-sdk::ClientOptions` (interface)
- `packages/client-sdk::Firegrid` (context-tag)
- `packages/client-sdk::FiregridConfig` (context-tag)
- `packages/client-sdk::FiregridConfigError` (schema-tagged-class)
- `packages/client-sdk::FiregridControlPlaneTableLive` (layer-instance)
- `packages/client-sdk::FiregridError` (type-alias)
- `packages/client-sdk::FiregridPermissionsClient` (interface)
- `packages/client-sdk::FiregridService` (interface)
- `packages/client-sdk::FiregridSessionHandle` (interface)
- `packages/client-sdk::FiregridSessionPermissionsClient` (interface)
- `packages/client-sdk::FiregridSessionWaitClient` (interface)
- `packages/client-sdk::FiregridSessionsClient` (interface)
- `packages/client-sdk::LaunchInputError` (other)
- `packages/client-sdk::PreloadError` (other)
- `packages/client-sdk::PromptInputError` (type-alias)
- `packages/client-sdk::RuntimeContextHandle` (interface)
- `packages/client-sdk::RuntimeContextSnapshot` (interface)
- `packages/effect-durable-operators::AnyDurableTableTag` (type-alias)
- `packages/effect-durable-operators::DurableTableCollection` (type-alias)
- `packages/effect-durable-operators::DurableTableError` (schema-tagged-class)
- `packages/effect-durable-operators::DurableTableProviderProps` (interface)
- `packages/effect-durable-operators::DurableTableProviderStatus` (type-alias)
- `packages/effect-durable-operators::DurableTableService` (type-alias)
- `packages/effect-durable-operators::DurableTableTagClass` (type-alias)
- `packages/effect-durable-streams::Bound` (interface)
- `packages/effect-durable-streams::CloseOptions` (interface)
- `packages/effect-durable-streams::Conflict` (other)
- `packages/effect-durable-streams::CreateOptions` (interface)
- `packages/effect-durable-streams::DecodeError` (other)
- `packages/effect-durable-streams::Endpoint` (interface)
- `packages/effect-durable-streams::ErrorHandler` (type-alias)
- `packages/effect-durable-streams::Gone` (other)
- `packages/effect-durable-streams::HeadResult` (interface)
- `packages/effect-durable-streams::HeaderValue` (type-alias)
- `packages/effect-durable-streams::HeadersRecord` (interface)
- `packages/effect-durable-streams::LiveMode` (type-alias)
- `packages/effect-durable-streams::NotFound` (other)
- `packages/effect-durable-streams::Offset` (type-alias)
- `packages/effect-durable-streams::ParamsRecord` (interface)
- `packages/effect-durable-streams::Producer` (interface)
- `packages/effect-durable-streams::ProducerAppendOpts` (interface)
- `packages/effect-durable-streams::ProducerAppendResult` (type-alias)
- `packages/effect-durable-streams::ProducerFailure` (type-alias)
- `packages/effect-durable-streams::ProducerOptions` (interface)
- `packages/effect-durable-streams::ReadError` (type-alias)
- `packages/effect-durable-streams::ReadOpts` (interface)
- `packages/effect-durable-streams::RetryOpts` (interface)
- `packages/effect-durable-streams::SequenceGap` (other)
- `packages/effect-durable-streams::SnapshotResult` (interface)
- `packages/effect-durable-streams::StaleEpoch` (other)
- `packages/effect-durable-streams::StreamClosed` (other)
- `packages/effect-durable-streams::TransportError` (other)
- `packages/effect-durable-streams::WriteError` (type-alias)
- `packages/host-sdk::AgentToolHost` (context-tag)
- `packages/host-sdk::AgentToolHostService` (interface)
- `packages/host-sdk::AppendSessionPromptParams` (interface)
- `packages/host-sdk::ExecuteSandboxToolParams` (interface)
- `packages/host-sdk::ExecuteSessionCapabilityParams` (interface)

…and 338 more (full list in `tiny-firegrid-reach-full.dot` complement / catalog.json).

## Substrate types reached that are NOT PUBLIC (reaching into internals)

**1** non-public substrate types are reached by the
tiny-firegrid closure (boundary touch — internal symbols exercised
without going through a package entry point):

- `packages/runtime::AgentOutputAfterWaitSourceSchema` (INTERNAL, schema-struct)

