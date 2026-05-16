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

## Boundary Rules

- Keep schema, event, and envelope definitions here.
- Keep protocol-specific wire parsing in `codecs/`.
- Keep byte/source acquisition in `sources/`.
- Do not define wrapper abstractions over `Stream`, `Sink`, `Effect`, or
  `Layer`.
- Avoid compatibility re-exports that create cycles with `codecs/` or
  `sources/`.
