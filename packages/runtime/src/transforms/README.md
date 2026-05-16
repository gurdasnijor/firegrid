# Runtime Transforms

`transforms/` owns pure stream and row-shaping operators shared by pipeline
components.

## Pipeline Fit

Transforms sit between event/row production and side-effecting consumers:

```txt
events/authorities -> transforms -> subscribers/codecs
```

They should be ordinary functions over Effect streams or rows. If a transform
needs durable writes, live process access, or host/session state, it belongs in
a subscriber, source, codec, or pipeline composition module instead.

## Boundary Rules

- Prefer plain `Stream` functions; use `Channel` only when first-class channel
  composition is actually needed.
- Do not introduce a Firegrid transform framework.
- Keep shared selection, ordering, decoding, or mapping logic here.
- Do not import host topology or own durable table providers.
