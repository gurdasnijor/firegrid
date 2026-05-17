# RFC: Client Runtime Input Intents

Status: Draft implementation contract

Related:

- `firegrid-schema-projection-contract.CLIENT_SESSION_FACADE.5-1`
- `firegrid-schema-projection-contract.CLIENT_SESSION_FACADE.9-1`
- `firegrid-schema-projection-contract.BOUNDARIES.5`
- `docs/rfc/external/durable-stream-agent-plaform-rfc/coding/client-model.md`

## Summary

Programmatic client prompting is part of the Firegrid API surface. The boundary is
not "clients cannot write"; the boundary is "clients write intent, not runtime
state."

```ts
yield* session.prompt({ text: "Continue." })
yield* session.permissions.respond({
  permissionRequestId,
  decision: { _tag: "Allow", optionId: "allow" },
})
```

Those calls append protocol-owned runtime input intents to the namespace control
stream. They do not write runtime input tables, workflow deferred rows, host
owned streams, process stdin, codec sessions, or adapter transports.

`RuntimeInputIntent` is the durable client-written input record. It is not a
transitional bridge and it does not coexist with the deleted runtime-ingress
tier.

## Flow

```txt
client-sdk session.prompt / permissions.respond
  -> decode protocol schema
  -> append RuntimeInputIntent to the namespace control stream
  -> return accepted intent identity

owning host runtime
  -> observes RuntimeInputIntent rows for locally owned RuntimeContext rows
  -> converts the intent to the workflow runtime-input request
  -> completes the owner workflow runtime-input DurableDeferred

RuntimeContextWorkflowNative
  -> observes the completed runtime-input deferred
  -> decodes it into AgentInputEvent
  -> calls RuntimeContextWorkflowSession.send

RawAdapter / CodecAdapter
  -> performs the live transport write
```

## Ownership

The client is the canonical writer of user intent records. The workflow/host
owner is the canonical writer of runtime input state and live delivery effects.

This prevents the older incorrect shape:

```txt
client-sdk
  -> writes authoritative runtime input state directly
```

and preserves the intended shape:

```txt
client-sdk
  -> appends durable control intent

workflow/host owner
  -> applies idempotency, sequencing, and ownership checks
  -> mutates runtime-owned state
```

## Post-Path-X Deletion Contract

The long-term path is:

```txt
client -> RuntimeInputIntent -> owner-host router -> DurableDeferred -> send
```

The runtime-ingress tier must stay deleted: no `RuntimeIngressTable.inputs`, no
`RuntimeIngressTable.deliveries`, no delivery tracker, no delivery subscriber,
and no runtime-ingress public subpath. #315 may still call the existing
`appendRuntimeIngressToOwner` helper name internally because #314 already made
that helper complete owner workflow deferred input instead of writing ingress
tables. The named follow-up is **router-direct-deferred**: migrate the router to
call the owner workflow deferred completion path directly and remove the
compatibility-shaped helper dependency. That follow-up must not introduce
another durable table or alter the client API.

## Constraints

- `@firegrid/client-sdk` must not import `@firegrid/host-sdk` or
  `@firegrid/runtime`.
- Client prompt and permission response methods must not construct host-owned
  stream URLs or workflow deferred names.
- Host/workflow code must remain the only path from accepted intent to
  `RuntimeContextWorkflowSession.send`.
- Protocol schemas remain the shared operation contract for client, CLI, MCP,
  app adapters, and host execution.
