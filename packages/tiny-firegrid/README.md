# tiny-firegrid

Private simulation runner for generating observable Firegrid host/client runs.

Each runnable simulation lives in a folder under `src/simulations/` with a
default export from `index.ts`:

```ts
import type { TinyFiregridSimulation } from "../../types.ts"

export default {
  id: "my-simulation",
  description: "short description",
  host: env => /* configured FiregridHost layer */,
  driver: /* Effect requiring Firegrid */,
} satisfies TinyFiregridSimulation<unknown>
```

The driver only receives the `Firegrid` client service. Host configuration stays
behind the `host(env)` layer so simulations exercise the same network-separated
client boundary as production callers.

## Commands

```bash
pnpm --filter @firegrid/tiny-firegrid simulate:list
pnpm --filter @firegrid/tiny-firegrid simulate:run -- codex-acp-tool-calls
```

`simulate:run` starts an embedded Durable Streams test server unless
`DURABLE_STREAMS_BASE_URL` is set. `FIREGRID_RUNTIME_NAMESPACE` overrides the
default namespace.

By default, completed spans are printed to stdout with OpenTelemetry's
`ConsoleSpanExporter`. Set `OTEL_EXPORTER_OTLP_ENDPOINT` to send traces to an
OTLP endpoint instead.

Each run is emitted under one `firegrid.simulation.run` root span. The runner
wraps the host and driver in `firegrid.side.host` and `firegrid.side.driver`
subtrees so viewers can follow one run top-to-bottom without joining separate
trace roots.
