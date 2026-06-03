# tf-vnur — MCP Cutover Deletion Baseline

Evidence-only baseline for the parent MCP cutover (`tf-az7y`). This document
does not propose cutover mechanics and does not mark anything dead today. It
records the source-verified surface that becomes deletable only after the named
precondition serves the same contract through `mcp-host` as the universal
gateway over durable streams.

Counting rule: whole-file counts come from `wc -l`; range counts are inclusive
`end - start + 1`. The required-cutover subtotal excludes the optional HTTP MCP
transport follow-up.

## Summary

| Target | Required deletable LoC | Optional/later LoC | Serving precondition |
| --- | ---: | ---: | --- |
| Client SDK direct durable-table reads | 318 | 0 | Phase 2 client-as-MCP-client serves reads through MCP/durable-streams |
| Parallel operation catalogs / projection machinery | 143 | 0 | MCP `tools/list` / `tools/call` becomes the discovery and dispatch contract |
| Redundant unified channel binding stubs | 112 | 0 | Phase 3 removes placeholder binding layer after real gateway routes are the single path |
| Superseded task-event gateway artifact | 1,534 | 0 | Phase 3 production task-projection adapter replaces the spike-local task-event gateway |
| HTTP MCP transport | 0 | 318 | Optional later: durable-streams transport is the only supported MCP transport |
| **Total** | **2,107** | **318** |  |

Baseline total including optional follow-up: **2,425 LoC**.

## 1. Client SDK Direct Durable-Table Reads

Current evidence:

- [packages/client-sdk/src/firegrid.ts](../../packages/client-sdk/src/firegrid.ts:13)
  imports `RuntimeControlPlaneTable`, `RuntimeOutputTable`, durable stream URL
  helpers, runtime projection views, and row types at lines 13-32.
- [packages/client-sdk/src/firegrid.ts](../../packages/client-sdk/src/firegrid.ts:379)
  publicly exposes `FiregridRuntimeTables` / `firegridRuntimeTableTags` at
  lines 379-387.
- [packages/client-sdk/src/firegrid.ts](../../packages/client-sdk/src/firegrid.ts:935)
  resolves `RuntimeControlPlaneTable` and `RuntimeOutputTable` inside `make`
  at lines 935-936.
- [packages/client-sdk/src/firegrid.ts](../../packages/client-sdk/src/firegrid.ts:956)
  builds direct read helpers over `.rows()` / table collections at lines
  956-982, reads snapshots at lines 984-1028, waits over
  `output.events.rows()` at lines 1042-1132, and performs projection
  materialization waits / fallback context reads at lines 1134-1185.
- [packages/client-sdk/src/firegrid.ts](../../packages/client-sdk/src/firegrid.ts:1548)
  constructs and exports standalone table layers at lines 1548-1619; its
  service docs still list `RuntimeControlPlaneTable` and `RuntimeOutputTable`
  as required scope at lines 1588-1600.

Deletable LoC after Phase 2 serves this through client-as-MCP-client:

| Surface | LoC |
| --- | ---: |
| Direct table/projection imports, lines 13-32 | 20 |
| Public table exports, lines 379-387 | 9 |
| Direct table yield + read/projection helpers, lines 935-936, 956-982, 984-1028, 1042-1132, 1134-1185 | 217 |
| Table layer wiring/docs, lines 1548-1619 | 72 |
| **Total** | **318** |

Precondition: Phase 2 must make the SDK a client of the MCP gateway for these
read contracts. Until then these lines are the current airgap read path.

## 2. Parallel Operation Catalogs / Projection Machinery

Current evidence:

- [docs/findings/tf-7whh-operation-inventory.md](tf-7whh-operation-inventory.md:10)
  records 19 canonical operations across agent-tool, client, CLI,
  session-facade, and channel surfaces at lines 10-30.
- [docs/findings/tf-7whh-operation-surface-inventory.md](tf-7whh-operation-surface-inventory.md:39)
  counts 15 agent-tool operations, 6 session-facade operations, 14 channel
  targets, and 23 channel registrations at lines 39-46.
- [docs/findings/tf-7whh-operation-surface-inventory.md](tf-7whh-operation-surface-inventory.md:53)
  identifies six operations declared independently on multiple surfaces at
  lines 53-66.
- [docs/findings/tf-7whh-operation-surface-inventory.md](tf-7whh-operation-surface-inventory.md:118)
  states that `firegridProjection` reaches agent-tools and session-facade, but
  the channel surface is disjoint and requires an alias map at lines 118-137.
- [packages/protocol/src/session-facade/operations.ts](../../packages/protocol/src/session-facade/operations.ts:51)
  declares `FiregridClientOperations` as a parallel `{ input, output }` catalog
  at lines 51-98.
- [packages/client-sdk/src/operations.ts](../../packages/client-sdk/src/operations.ts:1)
  is still a compatibility re-export for the protocol catalog at lines 1-17.
- [packages/protocol/src/projection/schema.ts](../../packages/protocol/src/projection/schema.ts:4)
  defines the projection annotation and metadata reader at lines 4-28.

Deletable LoC after MCP `tools/list` / `tools/call` is the authoritative
operation discovery and dispatch surface:

| Surface | LoC |
| --- | ---: |
| `packages/protocol/src/session-facade/operations.ts` | 98 |
| `packages/client-sdk/src/operations.ts` | 17 |
| `packages/protocol/src/projection/schema.ts` | 28 |
| **Total** | **143** |

Precondition: the cutover must not remove schemas used by the MCP toolkit
itself; the deletion target is the parallel client/session-facade operation
catalog and its projection metadata machinery once `tools/list` is the
inventory.

## 3. Redundant Unified Channel Binding Stubs

Current evidence:

- [docs/findings/tf-7whh-operation-inventory.md](tf-7whh-operation-inventory.md:96)
  lists channel registrations at lines 96-122 and shows duplicate target
  registrations for `host.permissions.respond`, `host.prompt`, `session.cancel`,
  `session.close`, and `session.prompt`.
- [docs/findings/tf-7whh-operation-surface-inventory.md](tf-7whh-operation-surface-inventory.md:101)
  calls out `as never` stub channels and duplicate registrations at lines
  101-117.
- [packages/runtime/src/unified/channel-bindings.ts](../../packages/runtime/src/unified/channel-bindings.ts:118)
  defines the stub binding block at lines 118-222. The inline comments label
  these as stubs and say production hosts override them.
- [packages/runtime/src/unified/channel-bindings.ts](../../packages/runtime/src/unified/channel-bindings.ts:306)
  defines the production signaling overrides at lines 306-444.
- [packages/runtime/src/unified/channel-bindings.ts](../../packages/runtime/src/unified/channel-bindings.ts:461)
  composes the stub `UnifiedChannelBindingsLive` at lines 461-467.

Deletable LoC after the real gateway routes are the single path:

| Surface | LoC |
| --- | ---: |
| Stub channel block, lines 118-222 | 105 |
| Stub composition, lines 461-467 | 7 |
| **Total** | **112** |

Precondition: Phase 3 must leave production signaling/gateway routes as the
only binding layer. The production signaling overrides are not counted here
because they are still the current real route.

## 4. Superseded Task-Event Gateway Artifact

Current evidence:

- [docs/findings/2026-06-03-tf-2cfw-mcp-task-projection.md](2026-06-03-tf-2cfw-mcp-task-projection.md:5)
  records the replacement shape: `session_prompt` MCP task state can be a
  runtime-output projection without a spike-local task-event log at lines 5-9.
- The same finding records that the newer projection sim has no `task-events`,
  `appendTaskEvent`, or `taskEvents` under that sim at lines 25-28, derives
  `tasks/get` from runtime output at lines 38-41, backs `tasks/result` from
  runtime output at lines 43-47, and maps `tasks/update` to
  `HostPermissionRespondChannel.binding.append` at lines 49-52.
- [packages/tiny-firegrid/src/simulations/mcp-tasks-gateway/wire.ts](../../packages/tiny-firegrid/src/simulations/mcp-tasks-gateway/wire.ts:75)
  defines the old `task-events` stream plus `appendTaskEvent` / `taskEvents`
  helpers at lines 75-101.
- [packages/tiny-firegrid/src/simulations/mcp-tasks-gateway/protocol.ts](../../packages/tiny-firegrid/src/simulations/mcp-tasks-gateway/protocol.ts:7)
  imports and uses the old task-event helpers at lines 7-10, 109-118, 141, and
  434.
- [packages/tiny-firegrid/src/simulations/mcp-tasks-gateway/driver.ts](../../packages/tiny-firegrid/src/simulations/mcp-tasks-gateway/driver.ts:113)
  creates and watches the old `task-events` stream at lines 113-118, 190-199,
  and 271-295.
- [packages/tiny-firegrid/src/simulations/mcp-task-projection-gateway/protocol.ts](../../packages/tiny-firegrid/src/simulations/mcp-task-projection-gateway/protocol.ts:229)
  implements the replacement projection shape in source: project task state from
  output observations at lines 229-285, wait for projected terminal output at
  lines 344-370, create a self-describing task id and forward `session_prompt`
  at lines 449-498, and serve `tasks/get` / `tasks/result` / `tasks/update` at
  lines 501-540.
- [packages/tiny-firegrid/src/simulations/mcp-task-projection-gateway/host.ts](../../packages/tiny-firegrid/src/simulations/mcp-task-projection-gateway/host.ts:271)
  wires the replacement to `RuntimeOutputTable`, `SessionAgentOutputChannel`,
  and `HostPermissionRespondChannel` at lines 271-318.

Deletable LoC after a production task-projection adapter replaces the old
spike-local task-event gateway:

| Surface | LoC |
| --- | ---: |
| `packages/tiny-firegrid/src/simulations/mcp-tasks-gateway/driver.ts` | 424 |
| `packages/tiny-firegrid/src/simulations/mcp-tasks-gateway/host.ts` | 337 |
| `packages/tiny-firegrid/src/simulations/mcp-tasks-gateway/index.ts` | 11 |
| `packages/tiny-firegrid/src/simulations/mcp-tasks-gateway/protocol.ts` | 616 |
| `packages/tiny-firegrid/src/simulations/mcp-tasks-gateway/wire.ts` | 146 |
| **Total** | **1,534** |

Precondition: Phase 3 must land the production MCP task-projection adapter in
the universal gateway. The newer `mcp-task-projection-gateway` sim is evidence
for the replacement and is not counted as deletable here.

## 5. HTTP MCP Transport (Optional Later)

Current evidence:

- [packages/runtime/src/unified/mcp-host/mcp-host.ts](../../packages/runtime/src/unified/mcp-host/mcp-host.ts:1)
  is the host-owned HTTP MCP server. Its header says it composes
  `McpServer.layer` / `RpcServer.layerProtocolHttp`, registers the toolkit, and
  mounts `/runtime-context/:contextId` at lines 1-35.
- [packages/runtime/src/unified/mcp-host/mcp-host.ts](../../packages/runtime/src/unified/mcp-host/mcp-host.ts:92)
  defines listener config at lines 92-119 and the HTTP server layer at lines
  162-237.
- [packages/runtime/src/unified/mcp-host/runtime-context-mcp-base-url.ts](../../packages/runtime/src/unified/mcp-host/runtime-context-mcp-base-url.ts:1)
  is the host-owned URL publication helper for that HTTP route at lines 1-81.

Optional deletable LoC after durable-streams is the only supported MCP
transport:

| Surface | LoC |
| --- | ---: |
| `packages/runtime/src/unified/mcp-host/mcp-host.ts` | 237 |
| `packages/runtime/src/unified/mcp-host/runtime-context-mcp-base-url.ts` | 81 |
| **Optional total** | **318** |

Precondition: optional follow-up after cutover. Phase 1 keeps this available, so
it is not part of the required deletion subtotal.

## Not Counted

- `packages/runtime/src/unified/mcp-host/toolkit.ts`,
  `toolkit-layer.ts`, and `tool-dispatch.ts`: these are the gateway/toolkit
  surface, not deletion targets for the universal-MCP direction.
- Production signaling overrides in
  [packages/runtime/src/unified/channel-bindings.ts](../../packages/runtime/src/unified/channel-bindings.ts:306):
  current real channel path; not counted until a later source-verified gateway
  replacement exists.
- `packages/tiny-firegrid/src/simulations/mcp-task-projection-gateway/`: current
  replacement evidence for target 4; not counted as deletable in this baseline.
