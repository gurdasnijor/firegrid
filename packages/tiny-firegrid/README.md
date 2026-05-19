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
# Catalog (what can I run?)
pnpm --filter @firegrid/tiny-firegrid simulate:list

# Run a named simulation (no default — the id is required)
pnpm --filter @firegrid/tiny-firegrid simulate:run codex-acp-tool-calls

# History (what have I run?)
pnpm --filter @firegrid/tiny-firegrid simulate:runs

# Render a past run's trace as a markdown tree (defaults to the latest run)
pnpm --filter @firegrid/tiny-firegrid simulate:show
pnpm --filter @firegrid/tiny-firegrid simulate:show 2026-05-19T23-10-46-560Z__codex-acp-tool-calls
```

`simulate:run` starts an embedded Durable Streams test server unless
`DURABLE_STREAMS_BASE_URL` is set. `FIREGRID_RUNTIME_NAMESPACE` overrides the
default namespace.

## Traces

Each run writes one JSON-line-per-span file to
`.simulate/runs/<runId>/trace.jsonl`. That file is the durable artifact;
everything else is derived from it.

- `simulate:show <runId?>` renders a parent/child span tree with elapsed times
  and a `firegrid.side` annotation per node.
- `simulate:runs` lists run directories that contain a `trace.jsonl`.
- The most recent run is also pointed at by `.simulate/latest.json`.

The trace destination is overridable:

| Condition | Destination |
|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` set | OTLP HTTP (production observability) |
| `--console` flag passed to `simulate:run` | `ConsoleSpanExporter` to stdout (noisy; debugging aid) |
| default | `.simulate/runs/<runId>/trace.jsonl` |

Every run is emitted under one `firegrid.simulation.run` root span. The runner
wraps the host and driver in `firegrid.side.host` and `firegrid.side.driver`
subtrees and propagates `firegrid.side` as a span attribute to every descendant
span (via `Effect.annotateSpans`), so the side dimension survives below the
wrappers and can be used as a filter on any span in the run.

## Methodology

See [docs/methodology.md](./docs/methodology.md) for the discipline this package
follows: what counts as a simulation, what the trace is (and isn't) responsible
for, and how findings get filed.

## Migration backlog

`src/simulations/to-be-migrated/` holds simulation drivers from before the
post-#426 runner shape. They are hidden from discovery (`simulate:list` will
not surface them and `simulate:run` cannot execute them) until each one is
ported into its own `<id>/{index,driver,host}.ts` folder under
`src/simulations/`.
