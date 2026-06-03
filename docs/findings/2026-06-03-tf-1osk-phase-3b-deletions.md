# tf-1osk Phase 3b Deletion Ledger

## Verdict

Phase 3b deletes the redundant client/session operation catalogs and the obsolete
aggregate production stub channel layer. `projection/schema.ts` stays live:
runtime MCP toolkit code imports `getFiregridProjectionMetadata`
(`packages/runtime/src/unified/mcp-host/toolkit.ts:28`) and reads it while
projecting tools (`packages/runtime/src/unified/mcp-host/toolkit.ts:168-170`);
agent-tool schemas also re-export the annotation seam
(`packages/protocol/src/agent-tools/schema.ts:28-33`).

## Target #2: Operation Catalogs

Deleted:

- `packages/client-sdk/src/operations.ts`
- `packages/protocol/src/session-facade/operations.ts`

The client now imports canonical protocol schemas directly
(`packages/client-sdk/src/firegrid.ts:37-80`) and uses them for decoders and
operation metadata (`packages/client-sdk/src/firegrid.ts:418-455`,
`packages/client-sdk/src/firegrid.ts:952-977`,
`packages/client-sdk/src/firegrid.ts:1044-1046`,
`packages/client-sdk/src/firegrid.ts:1115-1117`,
`packages/client-sdk/src/firegrid.ts:1226-1227`). The protocol
`session-facade` barrel no longer exports an operations catalog.

## Target #3: Channel Stubs

Deleted:

- `HostPromptChannelLive`
- `SessionPromptChannelLive`
- `SessionCancelChannelLive`
- `SessionCloseChannelLive`
- `HostPermissionRespondChannelLive`
- `UnifiedChannelBindingsLive`

Kept:

- `HostSessionsStartChannelLive`

`host.sessions.start` is still composed by the production signaling layer
(`packages/runtime/src/unified/channel-bindings.ts:360-365`) and is explicitly
an acknowledgement channel with no parked body to arm under the per-event model
(`packages/runtime/src/unified/channel-bindings.ts:118-130`). Prompt, terminal,
and permission delivery use the production signaling bindings instead
(`packages/runtime/src/unified/channel-bindings.ts:215-353`).

The only package test that consumed the old aggregate now provides test-local
no-op channel fixtures instead of preserving production stubs
(`packages/runtime/test/mcp-host/mcp-tool-dispatch-sleep.test.ts:91-151`).
