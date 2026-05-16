# Runtime Source Boundaries

This directory is still flat after the runtime agent event-pipeline cutover.
The target from
[`SDD_FIREGRID_RUNTIME_BOUNDARY_RECONCILIATION.md`](../../../docs/sdds/SDD_FIREGRID_RUNTIME_BOUNDARY_RECONCILIATION.md)
is to keep the clean agent event-pipeline roles explicit now, then group them
under an `agent-event-pipeline/` bounded context after host extraction.

The agent event pipeline is:

```txt
sources -> codecs -> events -> transforms -> authorities -> subscribers
                         \                         /
                          pipeline/session-runtime
```

The arrows describe ownership of data flow, not import permission. Durable
state is owned by capability provider layers, and runtime behavior composes
ordinary Effect surfaces (`Context.Tag`, `Layer`, `Queue.Enqueue`, `Stream`,
`Sink`, and narrow `Effect` services). Avoid adding Firegrid-specific wrapper
types when an Effect surface already describes the role.

## Load-Bearing Pipeline Folders

| Folder | Role |
| --- | --- |
| [`sources/`](./sources/README.md) | Live byte/process/resource acquisition. |
| [`codecs/`](./codecs/README.md) | Protocol wire-format normalization. |
| [`events/`](./events/README.md) | Normalized runtime event contracts and envelope helpers. |
| [`transforms/`](./transforms/README.md) | Pure stream/row shaping operators. |
| [`authorities/`](./authorities/README.md) | Durable Effect capability providers. |
| [`subscribers/`](./subscribers/README.md) | Host-scoped drivers over durable observations. |
| [`pipeline/`](./pipeline/README.md) | Per-session event-loop composition. |

## Adjacent Runtime Boundaries

These are intentionally not agent event-pipeline stages:

- `host/`: runtime host topology and command entrypoints.
- `waits/`: durable coordination operator and wait-owned router.
- `workflow-engine/`: workflow substrate adapter.
- `agent-tools/`: tool schemas, lowering, MCP exposure, and host-coupled live
  services.
- `agent-adapters/`: projections over codec sessions.
- `verified-webhook-ingest/`: external ingress/source adapter.

If new code does not fit one of the pipeline folder roles, start by classifying
its semantic role instead of adding another convenience folder.
