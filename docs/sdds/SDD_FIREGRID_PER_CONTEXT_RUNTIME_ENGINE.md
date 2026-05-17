# SDD: Per-Context Runtime Engine and Client Input Intents

Status: ratified target for the #315 reshape.

Date: 2026-05-17

Related specs:

- `firegrid-workflow-driven-runtime`
- `firegrid-schema-projection-contract`
- `firegrid-host-context-authority`
- `workflow-engine-durable-state`

Related SDDs:

- `docs/sdds/SDD_PATH_X_IMPLEMENTATION.md`
- `docs/sdds/SDD_FIREGRID_SCHEMA_PROJECTION_CONTRACT.md`
- `docs/sdds/SDD_FIREGRID_HOST_SDK.md`

## Decision

Runtime input from clients is modeled as durable, namespace-scoped
`RuntimeInputIntent` records. Runtime execution is modeled as one
workflow engine scope per active `RuntimeContext`, with the workflow
engine stream URL derived from `contextId`, not from the host stream
prefix.

The accepted chain is:

```txt
client prompt / permission response
  -> protocol-owned RuntimeInputIntent in the namespace control stream
  -> host-wide local dispatcher observes the namespace intent stream
  -> dispatcher finds the active local per-context engine for contextId
  -> local engine completes the RuntimeContextWorkflow input deferred
  -> RuntimeContextWorkflowNative resumes
  -> RuntimeContextWorkflowSession.send writes to the raw/codec adapter
```

The rejected chains are:

- client writes workflow deferred rows directly;
- client writes `RuntimeIngressTable` rows;
- host router opens another host's workflow stream by
  `RuntimeContext.host.streamPrefix`;
- `appendRuntimeIngressToOwner` remains as a post-Path-X routing
  primitive;
- each per-context engine subscribes to the whole namespace intent
  stream independently.

## Why This Is The Stable Shape

The workflow engine can already be provisioned from a `streamUrl`; the
host-owned behavior is a layer-construction choice, not a workflow
engine requirement. Changing the workflow stream URL from
`hostPrefix.workflow` to a context-derived workflow stream makes the
runtime context the durable isolation boundary.

The client still writes only intent. That preserves the schema
projection contract: client code owns session identity, prompt and
permission intent creation, snapshots, and waits; it does not own
workflow deferred names, runtime input state, host stream prefixes, or
live adapter transports.

The owner host still performs the wake locally. Firegrid's current
workflow engine resumes local registered workflow fibers when
`engine.deferredDone` is called. The dispatcher therefore runs on the
host that owns the active per-context engine and calls
`deferredDone` locally. This avoids requiring a cross-process workflow
wake primitive.

## Ownership Claim

Per-context engines require an exclusive durable claim before a host
starts or attaches the engine for a `RuntimeContext`.

V1 ownership is sticky:

- a context row carries the durable owner binding;
- creating or claiming a context is first-writer-wins for `contextId`;
- reattaching by the same owner is idempotent;
- another host attempting to start the same context fails before engine
  provisioning;
- lease expiry, takeover, rebalance, and scheduler-driven reassignment
  are explicitly out of scope for this cut.

This is the minimum mechanism needed to prevent two hosts from running
workflow engines over the same context stream concurrently. It is not a
new scheduling plane.

## Subscription Shape

The runtime host installs one host-wide dispatcher over the namespace
`RuntimeInputIntent` stream. It maintains or reads a local active-engine
registry keyed by `contextId`.

On each intent:

1. If no local active engine exists for `intent.contextId`, the
   dispatcher ignores it or leaves it for startup reconciliation.
2. If a local active engine exists, the dispatcher completes the
   content-derived runtime-input deferred on that local engine.
3. Durable idempotency remains keyed by the input intent id and the
   workflow deferred sequence.

The dispatcher does not filter by `context.host.hostId` to decide
cross-host routing, and it never opens a workflow stream for a different
host. The active per-context engine is the ownership boundary.

## Simplification

This removes the bridge code introduced by a host-owned workflow-stream
model:

- no `appendRuntimeIngressToOwner`;
- no owner-host workflow URL construction from
  `RuntimeContext.host.streamPrefix`;
- no cross-host prompt routing through another host's workflow stream;
- no `router-direct-deferred` follow-up;
- no `RuntimeIngressTable.inputs` / delivery tracker resurrection.

The remaining dispatcher is a local demux, not a cross-host router. Its
job is to connect durable namespace intent rows to already-owned local
per-context workflow engines.

## Costs And Risks

The design helps downstream work by making RuntimeContext the unit of
durable isolation. Tests and operators can reason about one context
stream, one workflow engine, and one live owner.

The design can hurt downstream work if ownership semantics expand
beyond sticky ownership in the same slice. Lease expiry, host failover,
context migration, and scheduler-driven placement are real features and
must be designed separately. Bundling them into this cut would turn the
simple claim into a scheduling subsystem.

The namespace context directory remains necessary for discovery,
`watchContexts`, snapshots, and stable client handles. It must stay a
thin directory and read index, not grow back into a runtime input
application authority.

## Implementation Consequences

The #315 client-intent work should be reshaped, not merged as the
host-owned-router bridge:

- keep `RuntimeInputIntent` schema, protocol helpers, namespace control
  stream table family, and client `session.prompt` /
  `session.permissions.respond` intent writes;
- keep schema projection language that clients append protocol-owned
  input intents;
- replace `RuntimeInputControlRouterLive` with a host-wide local
  dispatcher over active per-context engines;
- replace host-owned workflow engine layer construction with
  context-derived workflow engine stream construction;
- delete or avoid `appendRuntimeIngressToOwner` and owner-host workflow
  stream URL routing;
- add validation for duplicate host start/attach rejection and
  cross-host client intent delivery to the owner context's local engine.

## Validation

The implementation is not complete until tests prove:

- two hosts cannot both start or attach engines for the same
  `contextId`;
- duplicate start/attach by the same owner is idempotent;
- a client/host that does not own the context can append a
  `RuntimeInputIntent`, and the owning host's local dispatcher completes
  the per-context workflow deferred;
- no production code calls `appendRuntimeIngressToOwner` or opens owner
  workflow streams from another host's stream prefix;
- client code has no imports from runtime, host-sdk, workflow engine,
  durable deferred, runtime ingress tables, or live adapters.
