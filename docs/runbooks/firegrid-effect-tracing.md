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
