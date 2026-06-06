# fluent-control-surface-send-read

Firelab witness for the first vertical slice of
`features/fluent/control-plane/fluent-control-surface.feature`.

Covered scenarios:

- Send appends addressed input.
- Reads are projections over durable state.

The host serves a loopback HTTP ingress backed by `FluentControlHttp` and
`FluentControlSurface` from `@firegrid/fluent-runtime` against Firelab's real
Durable Streams server. The driver discovers that ingress and initiates
send/read/head through `@firegrid/client-sdk`; the host does not self-drive the
target behavior.

`sendAddressedInput` persists a fenced `fluent.control.input.addressed` event to
the entity stream. Producer identity is per `(entityId,inputId)`, so repeating
the same input id is idempotent and a different input id is an independent send.
`readEntity` and `headEntity` derive projections from
`FluentStore.collectSession` and `FluentStore.headSession`.

Wake/redrive delivery is not wired in this narrow slice. The coverage gate
`fluent_control_surface.post_append_boundary` makes that boundary explicit:
send acceptance stops after the durable append and does not synchronously invoke
a handler.

The driver only corroborates final durable rows by reading the entity stream
directly after it has caused send/read/head through the external ingress. The
Firelab verdict is computed from `coverage.gates` over host-side spans.
