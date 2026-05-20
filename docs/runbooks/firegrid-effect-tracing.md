# Firegrid Effect Tracing Runbook

Firegrid core packages emit Effect spans with `Effect.withSpan` and
`Effect.annotateCurrentSpan`. They do not own exporter policy and do not depend
on `@effect/opentelemetry` directly; that boundary is required by
`firegrid-observability.PACKAGE_BOUNDARY.1`.

## In-repo simulation capture

The tiny-firegrid simulation runner installs `@effect/opentelemetry/NodeSdk`
in the simulation process and writes one JSON object per ended span to
`packages/tiny-firegrid/.simulate/runs/<run-id>/trace.jsonl`.
`firegrid-observability.TINY_FIREGRID_SIMULATIONS.3` makes that JSONL trace the
durable local evidence artifact; `simulate:show`, `simulate:runs`, and
`simulate:perf` are derived views over the same file.

The preferred interface is the tiny-firegrid CLI, not Vitest:

```bash
pnpm --filter @firegrid/tiny-firegrid simulate:run codex-acp-tool-calls
```

By default the runner infers:

- namespace: `tiny-firegrid`
- run directory: `packages/tiny-firegrid/.simulate/runs/<run-id>`
- trace file: `packages/tiny-firegrid/.simulate/runs/<run-id>/trace.jsonl`

Override with:

```bash
FIREGRID_RUNTIME_NAMESPACE=...
DURABLE_STREAMS_BASE_URL=...
```

`simulate:run` starts an in-process `DurableStreamTestServer` by default.
Setting `DURABLE_STREAMS_BASE_URL` attaches to an external Durable Streams
server instead. The runner launches the host configuration, runs the driver
through the public `Firegrid` client surface, and writes spans through the file
exporter. A simulation is a small registry entry under
`packages/tiny-firegrid/src/simulations/<id>/index.ts`:

- `id`: stable simulation id.
- `description`: catalog text shown by `simulate:list`.
- `host(env)`: returns the host configuration Layer.
- `driver`: an Effect that requires only `Firegrid`.

That shape keeps host configuration, public-client behavior, and artifact
capture separated. New runnable simulations should use a dedicated
`<id>/{index,driver,host}.ts` folder under
`packages/tiny-firegrid/src/simulations/`. Legacy pre-runner simulations remain
under `src/simulations/to-be-migrated/` and are intentionally hidden from
`simulate:list`.

## Viewing tiny-firegrid traces

List available simulations and local runs, then render a stored run as a
markdown tree:

```bash
pnpm --filter @firegrid/tiny-firegrid simulate:list
pnpm --filter @firegrid/tiny-firegrid simulate:runs
pnpm --filter @firegrid/tiny-firegrid simulate:show
pnpm --filter @firegrid/tiny-firegrid simulate:show <run-id>
```

`simulate:show` resolves the latest usable run when no run id is supplied,
skips legacy run folders without `trace.jsonl`, and treats spans whose parent
has not been exported as visual roots. That keeps interrupted or still-flushing
runs inspectable instead of producing an empty tree.

For post-hoc performance inspection:

```bash
pnpm --filter @firegrid/tiny-firegrid simulate:perf <run-id>
pnpm --filter @firegrid/tiny-firegrid simulate:perf <run-id> \
  --top 20 \
  --idle-threshold-ms 1000 \
  --finding-threshold-ms 30000 \
  --finding-draft
```

`simulate:perf` implements
`firegrid-observability.TINY_FIREGRID_SIMULATIONS.11` and reports top spans by
self-time, HTTP route rolls, and idle gaps with start timestamp, end timestamp,
and duration. Idle gaps are finding sources, not just operator convenience.
`firegrid-observability.TINY_FIREGRID_SIMULATIONS.12` requires draft finding
material to be explicit and non-mutating: `--finding-draft` writes the draft to
stderr and never edits `docs/findings/` or any findings file silently.

While a run is active, the file exporter is paired with an adaptive stderr
heartbeat. The heartbeat fires only when the trace destination is
`.simulate/runs/<run-id>/trace.jsonl`; `--console` or
`OTEL_EXPORTER_OTLP_ENDPOINT` already provide their own activity signal.

```bash
pnpm --filter @firegrid/tiny-firegrid simulate:run codex-acp-tool-calls --watch
```

Without `--watch`, the heartbeat prints bounded digest lines every 2-10s.
With `--watch`, it also emits one compact line per completed span. The heartbeat
is intentionally not a streaming tree; use `simulate:show` or an external
OTLP-aware tool for structural trace inspection.

## Runner trace helpers

Trace readers should use `packages/tiny-firegrid/src/runner/trace.ts` rather
than duplicating JSONL parsing or hrtime tuple math:

- `SpanRecord`: the JSONL span shape written by the file exporter.
- `resolveRunDir` and `readTraceSpans`: shared latest/run-id resolution and
  parsing used by `simulate:show` and `simulate:perf`.
- `nsFromHrTime`, `startNs`, `endNs`, and `durationNs`: bigint helpers for
  OpenTelemetry hrtime tuples.

The `hrtime-number-arithmetic` ast-grep rule enforces this convention in CI.
Direct `span.startTime[0] * ...`, `span.endTime[0] * ...`, or
`span.duration[0] * ...` arithmetic is blocked because converting seconds to
nanoseconds in number space loses precision beyond roughly 26 hours.

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
