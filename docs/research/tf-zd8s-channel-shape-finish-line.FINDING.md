# tf-zd8s Channel Shape Finish-Line Finding

## Verdict

GREEN: per-channel contract Tags now cover the channel-axis finish-line set, and the old app-facing `ChannelInventory` service has been retired from product TypeScript. The only remaining string lookup is explicitly named as the runtime-context MCP edge catalog, not a canonical application registry.

## Final Tag Inventory

Already-landed protocol Tags reused as-is:

| Channel | Direction | Contract citation | Live/binding citation |
| --- | --- | --- | --- |
| `SessionAgentOutputChannel` | ingress service (`forContext`) | `packages/protocol/src/channels/session-agent-output.ts` | `packages/host-sdk/src/host/channels/session-agent-output/index.ts` |
| `HostSessionsCreateOrLoadChannel` | callable | `packages/protocol/src/channels/host-sessions-create-or-load.ts` | `packages/host-sdk/src/host/channels/host-sessions-create-or-load-live.ts` |
| `SessionPermissionChannel` | callable | `packages/protocol/src/channels/session-permission.ts` | `packages/host-sdk/src/host/channels/session-permission/index.ts` |

New protocol Tags delivered in this bead:

| Channel | Direction | Contract citation | Live/binding citation |
| --- | --- | --- | --- |
| `HostContextsCreateChannel` | callable | `packages/protocol/src/channels/host-control.ts:27` | `packages/host-sdk/src/host/channels/host-control/index.ts:186` |
| `HostPromptChannel` | egress | `packages/protocol/src/channels/host-control.ts:57` | `packages/host-sdk/src/host/channels/host-control/index.ts:214` |
| `SessionPromptChannel` | egress service (`forSession`) | `packages/protocol/src/channels/host-control.ts:64` | `packages/host-sdk/src/host/channels/host-control/index.ts:225` |
| `HostSessionsStartChannel` | callable | `packages/protocol/src/channels/host-control.ts:75` | `packages/host-sdk/src/host/channels/host-control/index.ts:244` |
| `HostContextSnapshotChannel` | callable direct-query | `packages/protocol/src/channels/host-control.ts:103` | `packages/host-sdk/src/host/channels/host-control/index.ts:266` |
| `HostSessionSnapshotChannel` | callable direct-query | `packages/protocol/src/channels/host-control.ts:106` | `packages/host-sdk/src/host/channels/host-control/index.ts:275` |
| `HostContextsChannel` | ingress | `packages/protocol/src/channels/host-control.ts:164` | `packages/host-sdk/src/host/channels/host-control/index.ts:284` |
| `SessionLifecycleChannel` | ingress service (`forSession`) | `packages/protocol/src/channels/host-control.ts:171` | `packages/host-sdk/src/host/channels/host-control/index.ts:292` |
| `HostPermissionRespondChannel` | callable | `packages/protocol/src/channels/host-control.ts:184` | `packages/host-sdk/src/host/channels/host-control/index.ts:304` |
| `SessionSelfLifecycleChannel` | ingress | `packages/protocol/src/channels/session-self.ts:9` | `packages/host-sdk/src/host/channels/session-self/index.ts` |
| `SessionSelfCheckpointChannel` | ingress | `packages/protocol/src/channels/session-self.ts:11` | `packages/host-sdk/src/host/channels/session-self/index.ts` |

The lane-5 contract decisions are therefore resolved as follows:

- tf-zd8s owns and delivers all seven missing Tags lane 5 named: `HostContextsCreateChannel`, `HostPromptChannel`, `SessionPromptChannel`, `HostSessionsStartChannel`, `HostContextSnapshotChannel`, `HostSessionSnapshotChannel`, `HostContextsChannel`, and `SessionLifecycleChannel`.
- Permission response uses option (a): `HostPermissionRespondChannel` is distinct from `SessionPermissionChannel`. Top-level permission response carries `contextId`; session-scoped response derives scope from the session handle.

## ChannelInventory Retirement

`packages/host-sdk/src/host/channel.ts` no longer exports generic channel contracts or an app-facing `ChannelInventory`. It now contains only `UnknownChannelTarget`, `RuntimeContextMcpChannelCatalog`, `makeRuntimeContextMcpChannelCatalog`, `RuntimeContextMcpChannelCatalogLive`, `findRuntimeContextMcpChannel`, and metadata projection helpers (`packages/host-sdk/src/host/channel.ts:8`, `packages/host-sdk/src/host/channel.ts:15`, `packages/host-sdk/src/host/channel.ts:23`, `packages/host-sdk/src/host/channel.ts:29`, `packages/host-sdk/src/host/channel.ts:37`, `packages/host-sdk/src/host/channel.ts:73`). Product TypeScript has zero hits for `ChannelInventory`, `makeChannelInventory`, `ChannelInventoryLive`, or `findChannel`.

The MCP edge remains intentionally string-addressed: agent tools still receive channel names as strings, and the runtime-context MCP metadata projection reads `RuntimeContextMcpChannelCatalog` to annotate `wait_for` tool schemas. That is a compatibility adapter, not an application registry.

## Static Lowering Check

The new host Live layer lowers each channel family to the same durable primitives listed in the SDD:

- `HostContextsCreateChannel` writes `RuntimeControlPlaneTable.contextRequests.insertOrGet(...)` through `appendContextCreateRequest` (`packages/host-sdk/src/host/channels/host-control/index.ts:113`, `packages/host-sdk/src/host/channels/host-control/index.ts:186`).
- `HostPromptChannel` and `SessionPromptChannel` write `RuntimeControlPlaneTable.inputIntents.insertOrGet(...)` through `appendInputIntent` (`packages/host-sdk/src/host/channels/host-control/index.ts:88`, `packages/host-sdk/src/host/channels/host-control/index.ts:214`, `packages/host-sdk/src/host/channels/host-control/index.ts:225`).
- `HostSessionsStartChannel` writes `RuntimeControlPlaneTable.startRequests.insertOrGet(...)` and returns the start ack (`packages/host-sdk/src/host/channels/host-control/index.ts:244`).
- `HostContextSnapshotChannel` / `HostSessionSnapshotChannel` compose direct reads over context, run, event, and log rows (`packages/host-sdk/src/host/channels/host-control/index.ts:142`, `packages/host-sdk/src/host/channels/host-control/index.ts:266`, `packages/host-sdk/src/host/channels/host-control/index.ts:275`).
- `HostContextsChannel` streams `control.contexts.rows()` (`packages/host-sdk/src/host/channels/host-control/index.ts:284`).
- `SessionLifecycleChannel` streams `control.runs.rows()` filtered by session/context id (`packages/host-sdk/src/host/channels/host-control/index.ts:292`).
- `HostPermissionRespondChannel` writes a required-action-result input intent and returns the durable input id (`packages/host-sdk/src/host/channels/host-control/index.ts:304`).

Boundary checks:

- `rg "@firegrid/host-sdk" packages/runtime/src/` returns zero.
- `rg "ChannelInventory|makeChannelInventory|ChannelInventoryLive|findChannel\b" packages/host-sdk/src packages/protocol/src packages/client-sdk/src packages/runtime/src --type ts` returns zero.
- `pnpm run lint:deps` is green; the channel contract imports no longer cycle through `launch/index.ts`.

## Validation

- `pnpm run typecheck` green.
- `pnpm run lint:dead` green.
- `pnpm run lint:deps` green.
- `pnpm run lint` green.

`pnpm preflight` green before task-exit.
