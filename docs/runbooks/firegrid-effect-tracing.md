# Firegrid Effect Tracing Runbook

Firegrid core packages emit Effect spans with `Effect.withSpan` and
`Effect.annotateCurrentSpan`. They do not own exporter policy and do not depend
on `@effect/opentelemetry` directly; that boundary is required by
`firegrid-observability.PACKAGE_BOUNDARY.1`.

## In-repo simulation capture

The standalone firelab simulation runner uses
`packages/firelab/src/simulations/trace-recorder.ts` to install an Effect
`Tracer` with `Effect.withTracer` and collect ended spans in memory.
`packages/firelab/src/simulations/trace-artifacts.ts` turns those spans
into reusable run artifacts.

Standalone simulations store gitignored local evidence assets under
`packages/firelab/.simulate/`:

- `.simulate/latest.json`
- `.simulate/runs/<run-id>/run.json`
- `.simulate/runs/<run-id>/trace.md`
- `.simulate/runs/<run-id>/trace.json`
- `.simulate/runs/<run-id>/live-spans.jsonl`
- `.simulate/runs/<run-id>/traces.otlp.jsonl`
- `.simulate/runs/<run-id>/duckdb/load.sql`
- `.simulate/runs/<run-id>/duckdb/firelab.duckdb`

The preferred interface is the standalone simulation runner, not Vitest:

```bash
OPENAI_API_KEY=... \
pnpm --filter firelab simulate:run -- codex-acp-tool-call-pipeline
```

By default the runner infers:

- namespace: `tiny-run-<simulation-id>-<run-suffix>`
- run directory: `packages/firelab/.simulate/runs/<run-id>`

Override with:

```bash
TINY_FIREGRID_NAMESPACE=...
TINY_FIREGRID_SIMULATE_DIR=...
TINY_FIREGRID_TIMEOUT="90 seconds"
TINY_FIREGRID_RUN_ID=...
FIREGRID_DURABLE_STREAMS_URL=...
```

`simulate run` starts an in-process `DurableStreamTestServer` by default.
Override the URL with
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
capture separated. New system simulations should be added under
`packages/firelab/src/simulations`.

## Viewing firelab traces

List available simulations and local runs:

```bash
pnpm --filter firelab simulate:list
pnpm --filter firelab simulate:runs
pnpm --filter firelab simulate:show
```

For token-efficient agent inspection, tail or attach to ended span records:

```bash
pnpm --filter firelab simulate:tail
pnpm --filter firelab simulate:attach -- <run-id>
pnpm --filter firelab simulate:run -- codex-acp-tool-call-pipeline --tail
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

## Querying firelab traces with DuckDB

The generated `traces.otlp.jsonl` file is OTLP JSONL shaped for
`smithclay/duckdb-otlp`, which reads OpenTelemetry Collector file-export style
trace exports via `read_otlp_traces(...)`.

Install DuckDB locally, then load the latest firelab run:

```bash
pnpm --filter firelab simulate:duckdb
```

If there is no `latest` run, the command exits with the exact `simulate:run`
command to create one. It does not silently start a long real-agent simulation.

That command opens:

```text
packages/firelab/.simulate/runs/<run-id>/duckdb/firelab.duckdb
```

with:

```text
packages/firelab/.simulate/runs/<run-id>/duckdb/load.sql
```

The loader installs and loads the community `otlp` extension, then materializes
the run into `firelab_spans` and creates `firelab_span_summary`.
Useful starting queries:

```sql
SELECT * FROM firelab_span_summary LIMIT 25;

SELECT
  span_name,
  round(duration / 1000000.0, 3) AS duration_ms,
  span_attributes
FROM firelab_spans
WHERE span_name LIKE 'firegrid.%'
ORDER BY duration DESC
LIMIT 50;

SELECT *
FROM firelab_failed_spans
ORDER BY timestamp;
```

For one-off queries:

```bash
pnpm --filter firelab simulate:query -- \
  latest \
  "SELECT * FROM firelab_span_summary LIMIT 25;"
```

If DuckDB is already open, run:

```sql
.read packages/firelab/.simulate/runs/<run-id>/duckdb/load.sql
```

or directly query:

```sql
INSTALL otlp FROM community;
LOAD otlp;
SELECT * FROM read_otlp_traces('packages/firelab/.simulate/runs/<run-id>/traces.otlp.jsonl');
```

## Production or operator traces

A host application that wants real traces provides an OpenTelemetry Layer around
the same Firegrid program. Firegrid applications should use the shared
Node-only helper in `@firegrid/observability/node` instead of copying exporter
wiring into each executable:

```ts
import { FiregridOtelLive } from "@firegrid/observability/node"
import { Effect } from "effect"

const FiregridOtelLayer = FiregridOtelLive({
  resource: {
    serviceName: "firegrid-host",
    attributes: {
      "firegrid.process.role": "firegrid-host",
    },
  },
  destination: { _tag: "file", filePath: ".firegrid/trace.jsonl" },
})

await Effect.runPromise(
  firegridHostProgram.pipe(
    Effect.provide(FiregridOtelLayer),
  ),
)
```

The shared helper writes one ended span per JSON line for file destinations,
supports console export for interactive tools, accepts extra span processors
such as firelab's heartbeat processor, and switches to OTLP JSON export
when `OTEL_EXPORTER_OTLP_ENDPOINT` is set. Product packages and smoke harnesses
still choose opt-in policy, resource attributes, and stdout/stderr discipline;
reusable Firegrid packages only emit spans.

`firegrid acp` is quiet by default and keeps stdout reserved for ACP JSON-RPC
frames. Enable host-process trace export explicitly:

```bash
pnpm firegrid -- acp \
  --otel-file .firegrid/acp-trace.jsonl \
  --cwd "$PWD" \
  --agent codex-acp \
  --agent-protocol acp \
  -- npx -y @zed-industries/codex-acp@0.14.0
```

`FIREGRID_OTEL_FILE=.firegrid/acp-trace.jsonl` is equivalent. If
`OTEL_EXPORTER_OTLP_ENDPOINT` is also set, the shared Layer routes spans to the
OTLP endpoint rather than the local file.

### Trace path under Zed (tf-r1gz)

When an editor such as Zed launches `firegrid acp`, the agent process inherits
**the editor's** working directory, not your repo. A *relative* `--otel-file`
therefore used to resolve against that editor cwd, so `.firegrid/acp-trace.jsonl`
landed somewhere outside the repo and appeared "missing." Two safeguards now
remove that footgun:

- A relative `--otel-file` is resolved against `--cwd` when you pass it (the
  project root the example pairs it with); otherwise against the process cwd.
  Pass `--cwd "$PWD"` — or an absolute `--otel-file` — to pin the artifact to
  your repo regardless of where the editor launches the agent.
- At startup the command prints the resolved **absolute** trace path to
  `stderr` (`firegrid acp: writing OTEL spans to <abs>`). stdout stays reserved
  for ACP JSON-RPC frames, so this is safe; check stderr/the Zed agent log if
  you are unsure where the file went.

File-destination spans are written immediately per ended span (a
`SimpleSpanProcessor`, matching the console destination), so a long-running ACP
agent populates the JSONL artifact continuously without needing to exit — and an
abrupt editor disconnect no longer discards a pending batch. Set
`FIREGRID_OTEL_FILE_FLUSH=batched` to restore 5s/512-span `BatchSpanProcessor`
batching for high-span-rate non-interactive hosts that prefer throughput over
per-span latency; the default is `immediate`.

### Span phases — observing in-flight spans (tf-9ia9)

By default the file destination writes one record per span **end**. A span that
wraps in-flight work — an open ACP session, a prompt turn that is hanging — is
invisible until it closes, which is exactly the case you need to see when
debugging a live hang ("did `new_session` start and stall in `waitForContext`,
or was `codec.newSession` never issued?").

Set `FIREGRID_OTEL_FILE_PHASES=start-end` to also record a **start** line when
each span opens:

```bash
FIREGRID_OTEL_FILE_PHASES=start-end \
firegrid acp --agent claude-acp --agent-protocol acp \
  --otel-file .firegrid/acp-trace.jsonl --cwd "$PWD" \
  -- npx -y @agentclientprotocol/claude-agent-acp@0.36.1
```

Every record carries a `phase` field:

- `phase:"start"` — emitted when the span opens. Carries `name`, ids, `kind`,
  `startTime`, `attributes`, `links`, `resource`. It omits `endTime`/`duration`/
  `status` (the span is still running). The `attributes` are the span's
  creation-time attributes (e.g. `codec.sdk.call`'s injected MCP
  `mcp_server_count`), so you can read the call's metadata even though the span
  never ends.
- `phase:"end"` — the existing completed-span record, now tagged. It keeps every
  field it had before, so end-only consumers are unaffected.

The default is `end` (end-only), so existing readers and saved trace files are
unchanged unless you opt in. Records are keyed by `spanId` + `phase`, not line
order — a span that opens and closes within one tick may write its `end` line
before its `start` line.

Read just the in-flight spans (started, not yet ended) like this:

```bash
F=.firegrid/acp-trace.jsonl
node -e '
const fs=require("fs");
const ended=new Set(), started=new Map();
for (const l of fs.readFileSync(process.argv[1],"utf8").split("\n")) {
  if(!l.trim())continue; const s=JSON.parse(l);
  if(s.phase==="end")ended.add(s.spanId); else if(s.phase==="start")started.set(s.spanId,s.name);
}
for(const [id,name] of started) if(!ended.has(id)) console.log("IN-FLIGHT",name,id);
' "$F"

# Span-name histogram over COMPLETED spans only (ignore start lines):
node -e '
const fs=require("fs");const c={};
for(const l of fs.readFileSync(process.argv[1],"utf8").split("\n")){if(!l.trim())continue;const s=JSON.parse(l);if(s.phase==="start")continue;c[s.name]=(c[s.name]||0)+1}
for(const k of Object.keys(c).sort())console.log(String(c[k]).padStart(5),k)
' "$F"
```

Existing histogram one-liners that count every line will double-count when
phases are enabled; filter `s.phase!=="start"` (above) to count completed spans.
The firelab trace reader (`simulate:show` / `simulate:perf`) already drops
`phase:"start"` records, so enabling phases during a simulation does not skew
those views.

## Inspecting live durable-stream state (durable-streams test-ui)

Effect spans show *what the host did*; the durable streams show *what state
landed*. For "row written vs row observed" questions (see the DurableTable and
runtime-output boundaries below) it is often faster to look at the actual stream
rows in a live host than to read spans.

When `DURABLE_STREAMS_BASE_URL` is unset, `firegrid run`/`start`/`acp` start an
embedded `DurableStreamTestServer`. It binds **`127.0.0.1:4437`** and installs
`createRegistryHooks`, so every stream it creates is announced on a
`__registry__` stream. A durable-streams stream inspector pointed at that port
can then enumerate and read the host's live streams with no extra wiring.

The durable-streams project ships such an inspector at `examples/test-ui` (a
Vite app that hardcodes `http://<host>:4437` and subscribes to `__registry__`).
To use it against a live Firegrid host:

```bash
# 1. Run any Firegrid process — it serves the embedded store on :4437.
#    (e.g. the Zed ACP agent, or:)
pnpm firegrid -- acp --agent claude-acp --agent-protocol acp \
  --otel-file .firegrid/acp-trace.jsonl --cwd "$PWD" \
  -- npx -y @agentclientprotocol/claude-agent-acp@0.36.1

# 2. In a second terminal, launch the durable-streams test-ui (Vite, :3000).
#    From a checkout/vendored copy of durable-streams/examples/test-ui:
pnpm --filter @durable-streams/example-test-ui dev   # or: pnpm dev in that dir
# open http://localhost:3000
```

The sidebar lists the live streams from `__registry__` — e.g.
`firegrid-local.firegrid.host.<host>.workflow`,
`…runtimeOutput.context.<contextId>`, `…runtime`, and the per-context
`firegrid.runtime-context.state.<contextId>` rows. Click a stream to see its
JSON rows update live; the runtime-context `…output.N.after.0.M` keys make the
durable output-observation cursor visible as it advances.

Notes:
- The fixed `:4437` means only one embedded-server Firegrid process can run at a
  time (production attaches to an explicit `DURABLE_STREAMS_BASE_URL` and is
  unaffected). To inspect across restarts instead, run a standalone
  durable-streams server on `:4437` and point the host at it with
  `DURABLE_STREAMS_BASE_URL=http://localhost:4437`.
- The test-ui is a generic durable-streams viewer, not Firegrid-aware: it shows
  raw stream paths/rows, not Firegrid-semantic views.

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

- Provide `FiregridOtelLive` in the Firegrid host process.
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
