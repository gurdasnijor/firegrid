# tf-2ld2 Sim 3 Binding-Swap Isolation Finding

Verdict: **GREEN**

Cycle 1 Sim 3 validates the SDD Pattern 3 claim for `SessionPermissionChannel`: a scoped `Layer.scoped(SessionPermissionChannel, autoApprovePolicy(default))` can swap behavior for one session scope while the permission response value still persists through the default durable binding.

## Scope

- Channel contract: `@firegrid/protocol/channels/session-permission`
- Channel target: `session.permissions.respond`
- Channel direction: `call`
- Session A Layer: default durable `SessionPermissionChannelLive` wrapped by `SessionPermissionAutoApproveLayer`
- Session B Layer: default durable `SessionPermissionChannelLive`
- Inventory path: not exercised

The sim also contributes the shared protocol-owned channel scaffolding requested by the channel placement clarification: `ChannelTarget`, `makeChannelTarget`, channel direction/source-class schemas, generic channel types, binding interface types, and generic factories live under `@firegrid/protocol/channels`. `ChannelInventory` remains host-sdk-owned.

## Run Evidence

Command:

```bash
pnpm --filter firelab simulate:run sim3-binding-swap-isolation --timeout-ms 120000
```

Run:

- `runId`: `2026-05-20T23-56-50-006Z__sim3-binding-swap-isolation`
- `traceId`: `f2b586c2dc8381c7bcf075258163f3c2`
- `trace`: `packages/firelab/.simulate/runs/2026-05-20T23-56-50-006Z__sim3-binding-swap-isolation/trace.jsonl`
- Driver span: `firegrid.sim3.binding_swap_isolation.driver`
- Driver span status: `{ "code": 1 }`

## Durable-Row Queries

The sim queries the durable runtime input-intent table after both permission calls complete:

```ts
control.inputIntents.query(coll =>
  coll.toArray
    .filter(row => row.contextId === sessionId)
    .flatMap(row => {
      const summary = summarizePermissionResponse(row)
      return summary === undefined ? [] : [summary]
    })
    .sort((left, right) => left.inputId.localeCompare(right.inputId))
)
```

Session A query input:

```json
{
  "sessionId": "ctx_ext_WyJ0aW55LWZpcmVncmlkIiwic2ltMy1iaW5kaW5nLXN3YXAtc2Vzc2lvbi1hIl0",
  "requestId": "sim3-permission-a-1"
}
```

Session A query result:

```json
[
  {
    "inputId": "input_ctx_ext_WyJ0aW55LWZpcmVncmlkIiwic2ltMy1iaW5kaW5nLXN3YXAtc2Vzc2lvbi1hIl0_sim3_ctx_ext_WyJ0aW55LWZpcmVncmlkIiwic2ltMy1iaW5kaW5nLXN3YXAtc2Vzc2lvbi1hIl0_sim3-permission-a-1",
    "contextId": "ctx_ext_WyJ0aW55LWZpcmVncmlkIiwic2ltMy1iaW5kaW5nLXN3YXAtc2Vzc2lvbi1hIl0",
    "permissionRequestId": "sim3-permission-a-1",
    "decision": "Allow",
    "origin": "sim3:autoApprove:session-a"
  }
]
```

Session B query input:

```json
{
  "sessionId": "ctx_ext_WyJ0aW55LWZpcmVncmlkIiwic2ltMy1iaW5kaW5nLXN3YXAtc2Vzc2lvbi1iIl0",
  "requestId": "sim3-permission-b-1"
}
```

Session B query result:

```json
[
  {
    "inputId": "input_ctx_ext_WyJ0aW55LWZpcmVncmlkIiwic2ltMy1iaW5kaW5nLXN3YXAtc2Vzc2lvbi1iIl0_sim3_ctx_ext_WyJ0aW55LWZpcmVncmlkIiwic2ltMy1iaW5kaW5nLXN3YXAtc2Vzc2lvbi1iIl0_sim3-permission-b-1",
    "contextId": "ctx_ext_WyJ0aW55LWZpcmVncmlkIiwic2ltMy1iaW5kaW5nLXN3YXAtc2Vzc2lvbi1iIl0",
    "permissionRequestId": "sim3-permission-b-1",
    "decision": "Deny",
    "origin": "sim3:default:session-b"
  }
]
```

Cross-session leak query:

```ts
sessionBResponses.filter(row =>
  row.decision === "Allow" && row.origin === "sim3:autoApprove:session-a"
).length
```

Cross-session leak result: `0`

Same channel Tag assertion result:

```json
{
  "sameChannelTag": true,
  "sameChannelTarget": "session.permissions.respond"
}
```

## Interpretation

Session A's auto-approve policy made the scoped decision, but the durable row was still written through the default responder binding. Session B used the same `SessionPermissionChannel` Tag and target with a different Layer and persisted its default-path response independently.

This supports the SDD's corrected framing: auto-approve is a non-durable scoped policy over the durable write, not a bypass of durability.
