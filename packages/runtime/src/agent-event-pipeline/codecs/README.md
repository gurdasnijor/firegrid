# Runtime Codecs

`codecs/` provides scoped protocol sessions that normalize protocol wire
formats into runtime event shapes. A codec module owns protocol negotiation,
launch flags, message correlation, and protocol-specific input delivery for one
active `AgentSession`.

Some codecs are pure stream codecs: they translate byte frames to normalized
events and encode normalized input back to frames without protocol-owned live
state beyond framing. Other codecs are stateful protocol-session codecs: they
own a scoped live connection, negotiated session id, request correlation, and
in-flight continuations required by the protocol. ACP is stateful because the
SDK client connection owns `session/new`, `sessionUpdate`, and live
`requestPermission` promises.
`firegrid-runtime-agent-event-pipeline.STAGES.3-10`

## Pipeline Fit

Codecs sit between live byte/session sources and normalized events:

```txt
sources -> codecs -> events
```

They produce and consume runtime event contracts, but they do not own durable
tables, subscriber dispatch, or host topology. Per-session capabilities such as
`toolUseMode` are reported by the active codec session after construction or
negotiation; callers should not infer them from codec class names.

Stateful protocol-session codecs may own scoped live protocol
connection/correlation state. They may not own durable rows, host topology,
subscriber lifecycle, or durable permission state. Live codec state does not
survive session restart. If a protocol process dies after a normalized event is
journaled but before a live protocol response is delivered, replay must create a
new live protocol continuation rather than resuming the old in-memory promise.
`firegrid-runtime-agent-event-pipeline.STAGES.3-10`

Core shape:

```ts
export class AgentSession extends Context.Tag(
  "@firegrid/runtime/AgentSession",
)<AgentSession, {
  readonly meta: AgentCodecMeta
  readonly toolUseMode: AgentToolUseMode
  readonly send: (event: AgentInputEvent) => Effect.Effect<void, AgentCodecError>
  readonly outputs: Stream.Stream<AgentOutputEvent, AgentCodecError>
}>() {}

export const AcpSessionLive = (
  bytes: AgentByteStream,
  options: AcpSessionOptions,
): Layer.Layer<AgentSession, AgentCodecError, IdGenerator.IdGenerator>
```

The `AgentSession` service is the active protocol capability. `send` is how
runtime composition delivers normalized input back to the agent; `outputs` is
how the pipeline observes normalized agent output. Durable routing is outside
this interface.

`toolUseMode` is per session:

- `observation_only`: tool-shaped output is telemetry only;
- `client_result_roundtrip`: subscriber tool routing may claim `ToolUse` rows;
- `control_channel_request_response`: protocol requests use their own
  request/response path.

ACP reports `observation_only` for tool calls. ACP-specific launch state is
explicit on `AcpSessionLive(bytes, options)`: ACP tool execution is supplied
through `options.mcpServers`/MCP or by tools owned inside the ACP agent process,
and ACP `sessionUpdate.tool_call` / `tool_call_update` events are observations.
The ACP codec supports permission request/response as a live control-channel
continuation, but it does not accept subscriber-produced `ToolResult` input.
`firegrid-runtime-agent-event-pipeline.TOOL_DISPATCH.7`
`firegrid-runtime-agent-event-pipeline.TOOL_DISPATCH.9`

## Boundary Rules

- Put wire-format parsing, encoding, and protocol session contracts here.
- Keep durable commit behavior in `authorities/`.
- Keep pure cross-codec row shaping in `transforms/`.
- Keep durable permission state outside codecs; codec permission continuations
  are live protocol promises only.
- Do not re-export codec contracts from `events/`; import from this folder or
  its package barrel.
