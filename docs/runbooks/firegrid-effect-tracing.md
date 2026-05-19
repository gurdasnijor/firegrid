# Firegrid Effect Tracing Runbook

Firegrid core packages emit Effect spans with `Effect.withSpan` and
`Effect.annotateCurrentSpan`. They do not own exporter policy and do not depend
on `@effect/opentelemetry` directly; that boundary is required by
`firegrid-observability.PACKAGE_BOUNDARY.1`.

## In-repo simulation capture

The G-MCP-2 smoke and the standalone tiny-firegrid simulation runner use
`packages/tiny-firegrid/src/simulations/trace-recorder.ts` to install an Effect
`Tracer` with `Effect.withTracer` and collect ended spans in memory.
`packages/tiny-firegrid/src/simulations/trace-artifacts.ts` turns those spans
into reusable run artifacts. The Codex ACP smoke can write gitignored
review-compatible legacy files:

- `tooling/analysis/mcp-tool-exposure-trace.md` for review.
- `tooling/analysis/mcp-tool-exposure-trace.json` for scripts and trace-tree
  post-processing.

Standalone simulations store gitignored local evidence assets under
`packages/tiny-firegrid/.simulate/`:

- `.simulate/latest.json`
- `.simulate/runs/<run-id>/run.json`
- `.simulate/runs/<run-id>/trace.md`
- `.simulate/runs/<run-id>/trace.json`
- `.simulate/runs/<run-id>/live-spans.jsonl`
- `.simulate/runs/<run-id>/traces.otlp.jsonl`
- `.simulate/runs/<run-id>/duckdb/load.sql`
- `.simulate/runs/<run-id>/duckdb/tiny-firegrid.duckdb`

The preferred interface is the standalone simulation runner, not Vitest:

```bash
OPENAI_API_KEY=... \
pnpm --filter @firegrid/tiny-firegrid simulate:run -- codex-acp-tool-call-pipeline
```

By default the runner infers:

- namespace: `tiny-run-<simulation-id>-<run-suffix>`
- run directory: `packages/tiny-firegrid/.simulate/runs/<run-id>`

Override with:

```bash
TINY_FIREGRID_NAMESPACE=...
TINY_FIREGRID_SIMULATE_DIR=...
TINY_FIREGRID_TIMEOUT="90 seconds"
TINY_FIREGRID_RUN_ID=...
FIREGRID_DURABLE_STREAMS_URL=...
```

`simulate run` starts an in-process `DurableStreamTestServer` by default,
matching the scenario-test pattern. Override the URL with
`FIREGRID_DURABLE_STREAMS_URL` or `TINY_FIREGRID_DURABLE_STREAMS_URL` to attach
to an external server instead. Viewer commands such as `show`, `tail`, `duckdb`,
and `query` operate only on stored runs and never start agent, host, or
durable-streams processes implicitly. The runner launches the host configuration,
runs the driver through the public `Firegrid` client surface, captures Effect
spans, and writes the OTLP/DuckDB bundle. A simulation is a small registry entry:

- `makeHost(env)`: returns the host configuration Layer.
- `driver(env)`: an Effect that requires only `Firegrid`.
- `summarize(result)`: turns the driver result into artifact metadata.

That shape keeps host configuration, public-client behavior, and artifact
capture separated. The existing Codex ACP smoke can remain as compatibility
evidence, but new system simulations should be added under
`packages/tiny-firegrid/src/simulations`.

## Viewing tiny-firegrid traces

List available simulations and local runs:

```bash
pnpm --filter @firegrid/tiny-firegrid simulate:list
pnpm --filter @firegrid/tiny-firegrid simulate:runs
pnpm --filter @firegrid/tiny-firegrid simulate:show
```

For token-efficient agent inspection, tail or attach to ended span records:

```bash
pnpm --filter @firegrid/tiny-firegrid simulate:tail
pnpm --filter @firegrid/tiny-firegrid simulate:attach -- <run-id>
pnpm --filter @firegrid/tiny-firegrid simulate:run -- codex-acp-tool-call-pipeline --tail
```

`tail` and `attach` stream `.simulate/runs/<run-id>/live-spans.jsonl`, which is
written as spans start and end during the simulation. `simulate run` has an
Effect-level timeout of `90 seconds` by default. Timeout writes
`simulate.run.timeout` and `simulate.run.failed`; Ctrl-C or SIGTERM writes
`simulate.run.interrupted` before scoped host and embedded durable-streams
cleanup. The runner does not synthesize heartbeat or phase events; the live
stream is runner lifecycle plus real span start/end records. Because the live
stream is append-only, interrupted runs still leave useful evidence even when
the finalized DuckDB bundle has not been written yet.

## Querying tiny-firegrid traces with DuckDB

The generated `traces.otlp.jsonl` file is OTLP JSONL shaped for
`smithclay/duckdb-otlp`, which reads OpenTelemetry Collector file-export style
trace exports via `read_otlp_traces(...)`.

Install DuckDB locally, then load the latest tiny-firegrid run:

```bash
pnpm --filter @firegrid/tiny-firegrid simulate:duckdb
```

If there is no `latest` run, the command exits with the exact `simulate:run`
command to create one. It does not silently start a long real-agent simulation.

That command opens:

```text
packages/tiny-firegrid/.simulate/runs/<run-id>/duckdb/tiny-firegrid.duckdb
```

with:

```text
packages/tiny-firegrid/.simulate/runs/<run-id>/duckdb/load.sql
```

The loader installs and loads the community `otlp` extension, then materializes
the run into `tiny_firegrid_spans` and creates `tiny_firegrid_span_summary`.
Useful starting queries:

```sql
SELECT * FROM tiny_firegrid_span_summary LIMIT 25;

SELECT
  span_name,
  round(duration / 1000000.0, 3) AS duration_ms,
  span_attributes
FROM tiny_firegrid_spans
WHERE span_name LIKE 'firegrid.%'
ORDER BY duration DESC
LIMIT 50;

SELECT *
FROM tiny_firegrid_failed_spans
ORDER BY timestamp;
```

For one-off queries:

```bash
pnpm --filter @firegrid/tiny-firegrid simulate:query -- \
  latest \
  "SELECT * FROM tiny_firegrid_span_summary LIMIT 25;"
```

If DuckDB is already open, run:

```sql
.read packages/tiny-firegrid/.simulate/runs/<run-id>/duckdb/load.sql
```

or directly query:

```sql
INSTALL otlp FROM community;
LOAD otlp;
SELECT * FROM read_otlp_traces('packages/tiny-firegrid/.simulate/runs/<run-id>/traces.otlp.jsonl');
```

## Production or operator traces

A host application that wants real traces should provide an OpenTelemetry Layer
around the same Firegrid program. The idiom from the vendored Effect source
(`repos/effect/packages/opentelemetry/examples/index.ts`) is:

```ts
import * as NodeSdk from "@effect/opentelemetry/NodeSdk"
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http"
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base"
import { Effect } from "effect"

const FiregridOtelLive = NodeSdk.layer(() => ({
  resource: {
    serviceName: "firegrid-host",
  },
  spanProcessor: new BatchSpanProcessor(
    new OTLPTraceExporter({
      url: process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
    }),
  ),
}))

await Effect.runPromise(
  firegridHostProgram.pipe(
    Effect.provide(FiregridOtelLive),
  ),
)
```

For local debugging, replace the OTLP exporter with
`ConsoleSpanExporter` and `SimpleSpanProcessor` from
`@opentelemetry/sdk-trace-base`. Product packages, tracer apps, and smoke
harnesses may choose exporters and sampling policy; reusable Firegrid packages
only emit spans.

## Full e2e traces through real agent runtimes

There are three different meanings of "end-to-end" for real ACP, Claude, and
Codex agents:

1. Host e2e: client SDK -> Firegrid host -> workflow -> codec -> sandbox
   process boundary -> Firegrid MCP server. This PR enables that path with
   Effect spans. Install an OpenTelemetry Layer in the host process to export it.
2. MCP wire e2e: every JSON-RPC request from the external agent to Firegrid's
   MCP server (`initialize`, `tools/list`, `tools/call`) is represented as a
   host span. This does not require agent cooperation and is the next useful
   G-MCP-2 simulation because it would show whether the agent calls `tools/list` and
   what response the server returns.
3. Agent-internal e2e: spans inside the external agent runtime itself,
   including its model/tool planner loop. That requires the agent process to
   support OpenTelemetry or another trace exporter. Firegrid can pass exporter
   env vars through the local process sandbox, but it cannot manufacture
   internal Codex or Claude spans from the host process.

For actual operator debugging, use all available layers:

- Provide `NodeSdk.layer` in the Firegrid host process.
- Use the local-process boundary spans to see process launch, stdout bytes,
  stderr bytes, stdin-backed codec sends, and process exit code without tracing
  inside the external agent.
- Use codec spans as the protocol boundary: ACP session setup, prompts,
  permission callbacks, session updates, termination, and stdio-jsonl
  stdin-send/stdout-decode are all host-observable even when the agent runtime
  has no internal tracer.
- Add MCP JSON-RPC method spans at the Firegrid MCP HTTP boundary so
  non-instrumented agents are still observable from the outside.
- Effect AI already emits `McpServer.<method>` spans from
  `repos/effect/packages/ai/ai/src/McpServer.ts` for methods that reach the
  server (`McpServer.initialize`, `McpServer.tools/list`,
  `McpServer.tools/call`). If an HTTP POST span has only
  `McpServer.initialize`, the agent connected but did not discover or call the
  tool catalog.
- When the agent runtime supports it, pass `OTEL_EXPORTER_OTLP_*`,
  `OTEL_SERVICE_NAME`, and `OTEL_RESOURCE_ATTRIBUTES` through the sandbox env
  and route it to the same collector. Follow ACP's Agent Telemetry Export RFD:
  use standard OTLP environment variables for subprocess agents, keep telemetry
  out-of-band from ACP stdio, and do not override existing user-provided
  `OTEL_*` variables. User-configured telemetry export takes precedence over a
  Firegrid-provided local collector.
- Treat host/agent trace joining as best-effort unless the agent runtime
  explicitly accepts W3C trace context. Without that support, the reliable join
  key is the Firegrid context id plus MCP request spans, not a single shared
  trace id.

## Critical span boundaries

The highest-leverage Firegrid spans are now at the places where causality can
break:

- Public client session entry: `sessions.createOrLoad`, `prompt`, and `start`
  root spans establish the trace that host work should inherit.
- Host reconciliation: runtime control request reconciliation, claim, context
  materialization, start request handling, and completion writes show whether a
  client request was never claimed, claimed by another host, abandoned, or
  completed.
- Runtime context engine registry: `startOrAttach`, `claimActive`,
  `reconcile`, input-intent dispatch, deferred append, and engine close show
  whether a context has a live workflow engine and whether input reached it.
- Runtime context workflow body: native workflow registration/run,
  session start/send activities, output waits, input deferred checks,
  permission-response waits, output handling, input handling, tool-use
  activities, and the reactive loop show the decisions the context workflow
  made between durable observations.
- Workflow engine runtime: execution `execute`, `resume`, `poll`, `interrupt`,
  activity claims/execution, deferred result/done, and durable clock scheduling
  connect Firegrid host spans to workflow execution ids.
- DurableTable facade: layer acquire plus `insert`, `upsert`, `delete`,
  `insertOrGet`, `get`, `query`, `rows`, `subscribe`, producer-fenced append,
  and `awaitTxId` spans carry table namespace, collection, durable type,
  primary-key field, and operation metadata. This is the consistency-debugging
  layer for "row written vs row observed" questions.
- Runtime output: per-context output append/read spans and runtime-output
  journal streams show whether agent output was written, decoded, and made
  observable to waits/subscribers.
- Durable waits: wait row lookup/upsert, completion lookup/upsert, wait router
  source selection, attach, initial check, trigger match, and deferred
  completion show whether `wait_for` persisted, attached to a source, observed
  a row, matched predicates, and notified the workflow.

## Span quality rules

- Use stable span names for substrate boundaries, not call-site prose.
- Put bounded identifiers in attributes: context id, workflow id, activity
  attempt, protocol, tool count, and event tag are acceptable for this
  diagnostic path.
- Do not attach prompts, provider credentials, tenant data, payload bodies, or
  authorization decisions as span attributes.
- Annotate values discovered after span open with `Effect.annotateCurrentSpan`.
- Keep one trace around the user-facing session entry so client, host,
  workflow, codec, and agent-event-pipeline spans share parentage.
- Remember that host-side tracing cannot see inside an external agent process
  unless that process also exports spans. For G-MCP-2, the current trace proves
  the host catalog and codec injection are present; the remaining unknown is
  at or after ACP agent-side MCP discovery/tool exposure.
