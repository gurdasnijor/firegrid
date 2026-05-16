# Runtime Events

`events/` owns normalized runtime event contracts, branded cross-stage
identities, and runtime envelope encode/decode helpers.

## Pipeline Fit

Events are the typed vocabulary shared by codecs, transforms, authorities, and
subscribers:

```txt
codecs -> events -> transforms/authorities/subscribers
```

This folder should describe what crossed a runtime boundary, not decide where
it is stored or what side effect follows.

Event contracts are data and schema:

```ts
type AgentOutputEvent =
  | { readonly _tag: "ToolUse"; readonly part: Prompt.ToolCallPart }
  | { readonly _tag: "PermissionRequest"; readonly request: PermissionRequest }
  | { readonly _tag: "Terminated"; readonly evidence: RuntimeTerminalEvidence }
```

Envelope helpers live here because durable output rows carry encoded runtime
event evidence, and subscribers need decoded observation types without touching
raw JSON:

```ts
encodeRuntimeAgentOutputEnvelope(event)
decodeRuntimeAgentOutputEnvelope(row.raw)
runtimeAgentOutputObservationFromRow(row)
```

The event layer does not know whether a row is a dispatch candidate. That is a
codec/session capability decision (`toolUseMode`) consumed by subscribers.

## Boundary Rules

- Keep schema, event, and envelope definitions here.
- Keep protocol-specific wire parsing in `codecs/`.
- Keep byte/source acquisition in `sources/`.
- Do not define wrapper abstractions over `Stream`, `Sink`, `Effect`, or
  `Layer`.
- Avoid compatibility re-exports that create cycles with `codecs/` or
  `sources/`.
