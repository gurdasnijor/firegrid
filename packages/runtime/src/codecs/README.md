# Runtime Codecs

`codecs/` normalizes protocol wire formats into runtime event shapes. Codecs
know protocol negotiation, launch flags, message correlation, and how to send
protocol-specific input back to an active agent session.

## Pipeline Fit

Codecs sit between live byte/session sources and normalized events:

```txt
sources -> codecs -> events
```

They produce and consume runtime event contracts, but they do not own durable
tables, subscriber dispatch, or host topology. Per-session capabilities such as
`toolUseMode` are reported by the active codec session after construction or
negotiation; callers should not infer them from codec class names.

Core shape:

```ts
export interface AgentSession {
  readonly toolUseMode: AgentToolUseMode
  readonly send: (event: AgentInputEvent) => Effect.Effect<void, AgentCodecError>
  readonly outputs: Stream.Stream<AgentOutputEvent, AgentCodecError>
}

export interface AgentCodec {
  readonly kind: string
  readonly capabilities: AgentCapabilities
  readonly open: (
    bytes: AgentByteStream,
    options: AgentCodecOpenOptions,
  ) => Effect.Effect<AgentSession, AgentCodecError, Scope.Scope>
}
```

The session is the active protocol capability. `send` is how runtime
composition delivers normalized input back to the agent; `outputs` is how the
pipeline observes normalized agent output. Durable routing is outside this
interface.

`toolUseMode` is per session:

- `observation_only`: tool-shaped output is telemetry only;
- `client_result_roundtrip`: subscriber tool routing may claim `ToolUse` rows;
- `control_channel_request_response`: protocol requests use their own
  request/response path.

## Boundary Rules

- Put wire-format parsing, encoding, and protocol session contracts here.
- Keep durable commit behavior in `authorities/`.
- Keep pure cross-codec row shaping in `transforms/`.
- Do not re-export codec contracts from `events/`; import from this folder or
  its package barrel.
