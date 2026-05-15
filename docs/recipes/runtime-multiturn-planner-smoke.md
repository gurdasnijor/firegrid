# Runtime Multi-Turn Planner Smoke

Use this proof when validating that one long-lived Firegrid-managed
`RuntimeContext` can receive multiple durable turns through `RuntimeIngress` and
journal stateful planner output through `RuntimeOutput`.

Ground-truth CI proof:

- `packages/runtime/src/runtime-host/runtime-codec-event-plane.test.ts`
- test name includes:
  - `firegrid-factory-aligned-agent-tools.RUNTIME_CODEC.1`
  - `firegrid-dark-factory-app.PLATFORM_PRIMITIVES.2`
  - `firegrid-dark-factory-app.SESSION_TOOLS.2`

The test uses the existing runtime-host and stdio-jsonl codec path:

1. Seed one host-bound `RuntimeContext` with `agentProtocol: "stdio-jsonl"`.
2. Append turn 1 with `appendRuntimeIngress`.
3. Start the runtime with `startRuntime({ contextId })`.
4. Observe turn-1 durable output from `RuntimeOutputTable.events`.
5. Append turn 2 with a distinct ingress idempotency key.
6. Assert turn-2 durable output references turn-1 state.
7. Assert retained `RuntimeIngressTable.inputs` rows are sequenced for both
   turns.

## Hosted Manual Variant

Use the same programmatic runtime-host APIs against hosted Electric/Durable
Streams by composing `FiregridRuntimeHostWithWorkflowLive` with:

- `durableStreamsBaseUrl`: hosted Durable Streams service root, not a
  `/v1/stream/...` URL.
- `namespace`: an isolated smoke namespace, for example
  `runtime-codec-multiturn-manual`.
- `hostId`: one dot-free host id, for example `host_manual`.
- `headers`: runtime-provided auth headers. Do not print or commit token values.
- `input: true`.

Expected hosted streams:

- `<namespace>.firegrid.runtime`
  - `contexts`: one `RuntimeContext` row.
  - `runs`: `started` and terminal `exited` rows for the context.
- `<namespace>.firegrid.host.<hostId>.runtimeIngress`
  - `inputs`: two sequenced `message` rows with distinct idempotency keys.
  - `deliveries`: codec delivery evidence for both input rows.
- `<namespace>.firegrid.host.<hostId>.runtimeOutput`
  - `events`: decoded `firegrid.agent-output` wrapper rows including turn-1
    text, turn-2 text that references turn-1 state, two `TurnComplete` events,
    and `Terminated`.
  - `logs`: stderr lines if the deterministic process emits diagnostics.

This is a substrate smoke, not app acceptance. The factory app still needs its
own hosted proof for provider ingest, accepted facts, subscriber identity, and
planner/operator decision resume.
