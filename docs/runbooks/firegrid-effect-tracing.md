# Firegrid Effect Tracing Runbook

Firegrid core packages emit Effect spans with `Effect.withSpan` and
`Effect.annotateCurrentSpan`. They do not own exporter policy and do not depend
on `@effect/opentelemetry` directly; that boundary is required by
`firegrid-observability.PACKAGE_BOUNDARY.1`.

## In-repo evidence capture

The G-MCP-2 smoke uses `packages/tiny-firegrid/test/support/trace-recorder.ts`
to install an Effect `Tracer` with `Effect.withTracer` and collect ended spans
in memory. It writes two artifacts:

- `tooling/analysis/mcp-tool-exposure-trace.md` for review.
- `tooling/analysis/mcp-tool-exposure-trace.json` for scripts and trace-tree
  post-processing.

Run it on demand with live model credentials:

```bash
OPENAI_API_KEY=... \
pnpm --filter @firegrid/tiny-firegrid exec vitest run \
  --config ./vitest.smoke.config.ts \
  test/codex-acp-tool-call-pipeline.smoke.test.ts \
  --testTimeout 300000 \
  --hookTimeout 300000
```

That recorder is intentionally test-local. It is useful for committed evidence
because it is deterministic at the trace-export layer and does not require a
collector, but it is not the production exporter path.

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
   G-MCP-2 probe because it would show whether the agent calls `tools/list` and
   what response the server returns.
3. Agent-internal e2e: spans inside the external agent runtime itself,
   including its model/tool planner loop. That requires the agent process to
   support OpenTelemetry or another trace exporter. Firegrid can pass exporter
   env vars through the local process sandbox, but it cannot manufacture
   internal Codex or Claude spans from the host process.

For actual operator debugging, use all available layers:

- Provide `NodeSdk.layer` in the Firegrid host process.
- Add MCP JSON-RPC method spans at the Firegrid MCP HTTP boundary so
  non-instrumented agents are still observable from the outside.
- When the agent runtime supports it, pass `OTEL_EXPORTER_OTLP_*`,
  `OTEL_SERVICE_NAME`, and `OTEL_RESOURCE_ATTRIBUTES` through the sandbox env
  and route it to the same collector.
- Treat host/agent trace joining as best-effort unless the agent runtime
  explicitly accepts W3C trace context. Without that support, the reliable join
  key is the Firegrid context id plus MCP request spans, not a single shared
  trace id.

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
