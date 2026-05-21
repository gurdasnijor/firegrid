# Kernel — Control Plane

`kernel/control-plane/` is the control-plane domain of the runtime kernel: the
durable write-owners for context/run/control-request collection families plus
the daemon that bridges control-request rows into workflow execution. It is
kernel interior — reached from above only through channels, never imported as a
public doorway.

- `recorder/` — the write-owner Tags (`RuntimeContextInsert`, `RuntimeContextRead`,
  `RuntimeRuns`, `RuntimeRunAppendAndGet`, `RuntimeControlRequests`,
  `RuntimeContexts`, `RuntimeLocalContextResolver`) and the
  `RuntimeControlPlaneRecorderLive` layer, plus the `time.ts` clock helper. This
  is a **leaf** module group: it imports only protocol/launch + Effect, with no
  path to `workflow-engine/`. Consumers of the write-owner Tags (the workflows,
  the observation streams) import from here so `packages/runtime/src` stays free
  of folder-level cycles.
- `request-dispatcher.ts` — the control-request reconciler daemon + the
  request-row→reflected bridge (load-bearing; do not delete). It depends on the
  `workflow-engine/` and on the recorder Tags.
- `index.ts` — the combined control-plane barrel (recorder + dispatcher), backing
  the `@firegrid/runtime/control-plane` subpath for host composition.

An "authority" is not a new type family; it is the unique live layer that
provides capability tags for a durable table family. Use stock Effect surfaces:

- append-only writes: `Queue.Enqueue<Row>`;
- stream-terminal writes: `Sink.Sink<Out, In, L, E, R>`;
- observations: `Stream.Stream<Row, E, R>`;
- lookups or committed-row writes: narrow object services returning `Effect`.

This mirrors Effect's own least-privilege split. A runtime table layer may
provide many tags, but consumers should request only the capability they need.

## Boundary Rules

- Export capability tags and provider layers, not registry metadata.
- Keep table-taking helpers private provider internals or explicit test
  fixtures.
- Do not encode lifecycle policy in row providers. For waits, the provider
  owns wait rows and completion rows; the operator/router interprets them.
