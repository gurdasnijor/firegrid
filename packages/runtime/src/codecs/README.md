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

## Boundary Rules

- Put wire-format parsing, encoding, and protocol session contracts here.
- Keep durable commit behavior in `authorities/`.
- Keep pure cross-codec row shaping in `transforms/`.
- Do not re-export codec contracts from `events/`; import from this folder or
  its package barrel.
