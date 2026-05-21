# Runtime Agent Sources

`sources/` owns live resource acquisition for the agent event pipeline. A
source opens, scopes, and closes the outside-world handle that produces or
accepts bytes: a local process, stdin/stdout/stderr pipes, provider session
handle, or equivalent transport edge.

The conformance floor for this boundary is the tf-4cik.1 fixture replay and
fuzz matrix:

- `docs/research/tf-4cik.1-agent-runtime-conformance-matrix.md`
- `docs/research/tf-4cik.1-agent-runtime-fixture-replay.FINDING.md`
- `packages/tiny-firegrid/src/simulations/agent-runtime-fixture-replay-harness/`

This README is the source-author guide implied by that matrix. It implements
`firegrid-runtime-agent-event-pipeline.STAGES.2` and
`firegrid-runtime-agent-event-pipeline.SOURCE_CONFORMANCE.6`.

## Pipeline Fit

Sources are the first live edge of the runtime agent event pipeline:

```txt
sources -> codecs -> transforms -> channel bindings -> kernel
```

The source contract is intentionally narrow. A source returns live byte streams,
input sinks, or scoped handles that the next stage can consume. It does not
decode protocol messages, infer capability state, correlate tool ids, write
durable rows, own wait semantics, or persist provider credentials.

Durable state is not a source surface. Above the kernel, the public doorway is a
channel contract; inside the runtime, the kernel owns write-ownership, replay,
dedupe, and durable channel implementations. The migration-era "authority" tags
are kernel-internal commit points, not source-facing or app-facing APIs.

Typical byte-source shape:

```ts
export interface AgentByteStream {
  readonly stdin: Sink.Sink<void, Uint8Array, never, E>
  readonly stdout: Stream.Stream<Uint8Array, E, R>
  readonly stderr: Stream.Stream<Uint8Array, E, R>
}
```

Raw local-process delivery remains source-owned only where it writes bytes to a
live process stdin. Durable row selection and ordering belongs in
`transforms/`; durable commit, replay, and dedupe evidence belongs inside the
kernel and is reached through channel bindings.

## Boundary Rules

- Acquire live byte/process/provider resources here.
- Scope lifetime, cancellation, stdin close, stdout/stderr drain, stderr
  diagnostics, and process disconnect handling here.
- Return Effect `Stream`, `Sink`, scoped handles, or narrow acquisition Effects
  rather than durable table facades.
- Keep ACP, stdio-jsonl, fake provider, and future protocol normalization in
  `codecs/`.
- Keep protocol correlation in `codecs/`: Ready/capability state, tool id
  matching, PermissionRequest/PermissionResponse pairing, duplicate
  advertisements, malformed frame classification, and terminal protocol events.
- Keep pure row ordering, selection, and stream reshaping in `transforms/`.
- Keep durable writes, replay, dedupe, committed-row identity, and observation
  surfaces behind channel contracts and kernel-owned implementations.
- Keep app-facing provider configuration, credentials, and sandbox policy in
  host/config surfaces. Replay records must never contain literal provider
  secrets.

## Tested Matrix Rows

The source boundary is grounded in these tf-4cik.1 rows:

| Row | Provider | Mode | Codec / transport | What the source owns | What the source does not own |
| --- | --- | --- | --- | --- | --- |
| `acp-permission-tool-roundtrip` | `local-process` | codec | ACP | stdout/stderr byte-pipe acquisition and stdin write edge | ACP session update normalization, tool-use observation semantics, permission response correlation |
| `stdio-jsonl-client-result-roundtrip` | `local-process` | codec | stdio-jsonl | process stdin/stdout/stderr byte streams | JSON line decoding, ToolResult encoding, tool id correlation |
| `fake-mcp-provider-permission-gate` | `effect-ai` | codec | fake MCP/provider | live provider session acquisition without replaying credential material | provider request normalization, permission wait state, missing response classification |
| `restart-disconnect-after-committed-output` | `local-process` | raw | raw byte stream | early exit/disconnect reporting and terminal source evidence | committed output replay, dedupe, or protocol correlation |
| `codec-double-advertisement` | `local-process` | codec | stdio-jsonl | delivery of both byte frames exactly as observed | duplicate Ready/capability classification |
| `live-canary-codex-acp` | `local-process` | codec | ACP live canary | env-gated real child process acquisition | CI conformance. Deterministic fixture replay remains the floor. |

When adding a source, update the matrix before treating the source as supported.
The matrix row must name the `SandboxProvider`, session mode, codec/transport,
fault class, expected source boundary, expected codec boundary, durable
evidence, and live-canary status.

## Fault Classes A Source Must Survive

### Crash Mid-Action

The `restart-disconnect-after-committed-output` fixture proves that a source may
disconnect after output has already crossed the pipeline boundary. The source
must surface early exit or disconnect as terminal evidence and must not replay,
dedupe, or reinterpret committed output rows. Kernel-owned durable channel
implementation owns the committed-row identity and restart replay guarantee.

### Dropped Wait

The fuzz matrix includes missing permission responses and slow or hung
responses. A source must remain a live transport edge: it can report that stdin
closed, the process ended, or the provider handle stalled, but it must not own
wait matching or decide that a PermissionRequest has failed. Wait and
correlation outcomes belong to codecs, wait/channel bindings, or kernel durable
state.

### Codec Double-Advertisement

The `codec-double-advertisement` fixture sends two Ready frames. The source must
deliver both frames without inventing capability state. The codec owns the
decision that the first Ready is capability evidence and the second Ready is a
recoverable protocol fault.

### Permission-Gate Stall

The `fake-mcp-provider-permission-gate` fixture commits a PermissionRequest and
then withholds the matching PermissionResponse. The source owns live provider
session acquisition and must not leak credential literals into replayable
records. The codec or permission binding owns the PermissionRequest event, and
the durable wait/channel implementation owns stall evidence inside the kernel.

## Fuzz Invariants

The deterministic fuzz pass mutates replay byte/input boundaries. A conforming
source must preserve these invariants:

- Chunk splitting must not change decoded record order.
- Frame coalescing must not change decoded record order.
- stdout/stderr interleaving may add diagnostics, but must not mutate stdout
  payload bytes or normalized output records.
- Early process exit is source-owned terminal evidence.
- stdin close or EPIPE is source-owned write failure evidence.
- Malformed or incomplete JSON is codec-owned recoverable error evidence.
- Slow or hung responses are wait/codec timeout evidence, not source polling
  semantics.
- Duplicate tool ids are detected before durable ToolResult correlation can
  diverge; sources only deliver bytes or provider events.
- PermissionRequest without PermissionResponse is a permission-gate stall, not
  a source-level protocol verdict.
- Response after disconnect is replay/correlation evidence outside sources.
- Provider secret leakage is forbidden in replay records and durable-like
  artifacts.
- Restart/replay after a committed output row must not duplicate committed
  output identity; the kernel-owned durable channel implementation owns that
  guarantee.

## Codec / Transport Contract

Sources and codecs meet at transport boundaries, not product semantics.

- ACP and stdio-jsonl process sources provide stdin/stdout/stderr edges. The
  codec turns protocol frames into `AgentOutputEvent` values and encodes
  `AgentInputEvent` values back to transport input.
- Raw byte-stream sources preserve raw output observations. They do not create
  tool-use, permission, or capability semantics.
- Provider-backed sources acquire provider sessions and pass provider events to
  a codec or bridge. They do not persist credential material and do not make
  app-facing provider policy decisions.
- Live canary rows use real agent commands only when explicitly enabled by
  environment. They are compatibility signals, not CI conformance foundations.

If a proposed source needs in-memory protocol negotiation, capability state, or
request/response correlation to be correct, that state belongs in a codec or
bridge layer. The source may hold only the live resource needed to feed that
layer.

## Diagnosing Failures

Run the harness from tiny-firegrid:

```bash
pnpm --filter @firegrid/tiny-firegrid simulate:run agent-runtime-fixture-replay-harness
pnpm --filter @firegrid/tiny-firegrid simulate:show <run-id>
pnpm --filter @firegrid/tiny-firegrid simulate:perf <run-id>
```

The run prints a trace path under
`packages/tiny-firegrid/.simulate/runs/<run-id>/trace.jsonl`. Matrix rows and
fuzz cases emit spans under `firegrid.agent_runtime_fixture.*`; source failures
should be diagnosable by row id, fuzz class, fixture id, and trace span.

When a failure appears source-related, first classify whether it is actually:

- live acquisition/lifetime/write failure: source-owned;
- protocol decoding/correlation failure: codec-owned;
- durable replay/dedupe/commit failure: kernel-owned and exposed through a
  channel boundary;
- wait matching or permission continuation failure: wait/channel binding or
  kernel-owned;
- provider policy or secret handling failure: host/config-owned.

Only the first class should result in source implementation changes.
