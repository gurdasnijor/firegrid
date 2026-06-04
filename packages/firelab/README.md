# firelab

Private simulation runner for generating observable Firegrid host/client runs.

Each runnable simulation lives in a folder under `src/simulations/` with a
default export from `index.ts`:

```ts
import type { FirelabSimulation } from "../../types.ts"

export default {
  id: "my-simulation",
  description: "short description",
  host: env => /* configured FiregridHost layer */,
  driver: /* Effect requiring Firegrid */,
} satisfies FirelabSimulation<unknown>
```

The driver only receives the `Firegrid` client service. Host configuration stays
behind the `host(env)` layer so simulations exercise the same network-separated
client boundary as production callers.

Experimental substrate workbenches may set `launchHost: false` and omit
`host(env)` when their finding explicitly does not validate the Firegrid
client/host seam. Keep those exceptions bead-scoped and documented in the
finding.

## Experiment Ergonomics

Experiment authors can import `@firegrid/firelab/experiment` for two
thin helpers:

- participant launch and prompt helpers that use the public Firegrid
  client/session surface and describe channel metadata without exact JSON
  echo prompts.
- post-run artifact helpers that load native `trace.jsonl`, `simulate:show`,
  `simulate:perf`, and caller-supplied durable row sources for assertions.

These helpers do not compute experiment verdicts. They keep drivers focused on
launching participants and leave analysis to native artifacts after the run.

## Commands

```bash
# Catalog (what can I run?)
pnpm --filter @firegrid/firelab simulate:list

# Run a named simulation (no default — the id is required)
pnpm --filter @firegrid/firelab simulate:run codex-acp-tool-calls

# History (what have I run?)
pnpm --filter @firegrid/firelab simulate:runs

# Post-hoc perf summary for a past run
pnpm --filter @firegrid/firelab simulate:perf 2026-05-19T23-10-46-560Z__codex-acp-tool-calls

# Render a past run's trace as a markdown tree (defaults to the latest run)
pnpm --filter @firegrid/firelab simulate:show
pnpm --filter @firegrid/firelab simulate:show 2026-05-19T23-10-46-560Z__codex-acp-tool-calls
```

`simulate:run` starts an embedded Durable Streams test server unless
`DURABLE_STREAMS_BASE_URL` is set. `FIREGRID_RUNTIME_NAMESPACE` overrides the
default namespace.

## Traces

Each run writes one JSON-line-per-span file to
`.simulate/runs/<runId>/trace.jsonl`. That file is the durable artifact;
everything else is derived from it.

For the Firegrid tracing contract behind those spans, including the
`Effect.annotateSpans` side-propagation rule and runtime/package boundaries,
see [`docs/runbooks/firegrid-effect-tracing.md`](../../docs/runbooks/firegrid-effect-tracing.md).

- `simulate:show <runId?>` renders a parent/child span tree with elapsed times
  and a `firegrid.side` annotation per node.
- `simulate:perf <runId>` prints top spans by self-time, HTTP route rolls,
  and idle gaps. Pass `--finding-draft` to emit idle-gap finding-source draft
  material to stderr without mutating findings files.
- `simulate:runs` lists run directories that contain a `trace.jsonl`.
- The most recent run is also pointed at by `.simulate/latest.json`.

The trace destination is overridable:

| Condition | Destination |
|---|---|
| `OTEL_EXPORTER_OTLP_ENDPOINT` set | OTLP HTTP (production observability) |
| `--console` flag passed to `simulate:run` | `ConsoleSpanExporter` to stdout (noisy; debugging aid) |
| default | `.simulate/runs/<runId>/trace.jsonl` |

## Watching a run in real time

While a run is writing its trace.jsonl, an **adaptive heartbeat** prints to
stderr so you can tell at a glance whether the simulation is alive, slow, or
stalled:

```
[00:02] spans=27 (+27)  sides={host=20,sdk=6,driver=1}  last=firegrid.client.session.create_or_load +1.9s
[00:04] spans=27 (+0)   sides={host=20,sdk=6,driver=1}  last=firegrid.client.session.create_or_load +3.9s
[00:08] spans=69 (+42)  sides={host=45,sdk=23,driver=1}  last=firegrid.durable_table.layer.acquire +2.9s
[00:10] spans=69 (+0)   sides={...}  last=firegrid.durable_table.layer.acquire +4.9s  ⚠ idle 4s
```

Fields, left to right: `elapsed`, total `spans` (delta since last tick),
side breakdown, most-recent span name + time since. The `⚠ idle Ns` marker
appears when no spans have arrived for ≥2× the current interval — converts
"is it stalled?" into "no, last activity was `acp.session_update`, the agent
is in an LLM round-trip."

The interval **adapts**: starts at 2s, doubles on consecutive idle ticks up
to 10s, resets to 2s when activity arrives. Fast runs get one or two ticks
and exit; LLM-bound runs settle into the 10s rhythm. Bounded volume keeps
the signal readable in cmux-dispatch / CI log contexts where unbounded
per-span output would be noise.

Pass `--watch` to also emit a compact one-line summary per completed span
(in addition to the heartbeat) — useful for interactive debugging:

```bash
pnpm --filter @firegrid/firelab simulate:run codex-acp-tool-calls --watch
```

The heartbeat fires only when the destination is the JSONL file. Under
`--console` or `OTEL_EXPORTER_OTLP_ENDPOINT`, the existing channels (stdout
spans / remote backend) already provide an activity signal.

For a richer streaming-tree view of a run as it happens, point any
OTLP-aware tool — e.g. [`otel-tui`](https://github.com/ymtdzzz/otel-tui) —
at the trace file. The heartbeat is the bounded summary; otel-tui is the
full live tree.

Every run is emitted under one `firegrid.simulation.run` root span. The runner
wraps the host and driver in `firegrid.side.host` and `firegrid.side.driver`
subtrees and propagates `firegrid.side` as a span attribute to every descendant
span (via `Effect.annotateSpans`), so the side dimension survives below the
wrappers and can be used as a filter on any span in the run.

## Runner internals

Trace readers should use `src/runner/trace.ts` instead of re-parsing
`trace.jsonl` ad hoc. `SpanRecord` captures the JSONL span shape,
`nsFromHrTime`, `startNs`, `endNs`, and `durationNs` keep OpenTelemetry
hrtime arithmetic in bigint space, and `resolveRunDir` / `readTraceSpans`
provide the shared run lookup and parse path used by `simulate:show` and
`simulate:perf`.

## Methodology

See [docs/methodology.md](./docs/methodology.md) for the discipline this package
follows: what counts as a simulation, what the trace is (and isn't) responsible
for, and how findings get filed.
