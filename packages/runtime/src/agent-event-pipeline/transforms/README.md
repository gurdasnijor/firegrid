# Runtime Transforms

`transforms/` is reserved for pure stream and row-shaping operators shared by
pipeline components. It is intentionally empty after the live-owner cutover.

## Pipeline Fit

Transforms sit between event/row production and side-effecting consumers:

```txt
events/authorities -> transforms -> subscribers/codecs
```

They should be ordinary functions over Effect streams or rows. If a transform
needs durable writes, live process access, or host/session state, it belongs in
a subscriber, source, codec, or pipeline composition module instead.

Typical shape:

No current production transform remains here; runtime input decoding now lives
with host-sdk workflow/session ownership.

The transform keeps the same error and requirement channels it received. That
is the signal that it is pure stream shaping, not a subscriber or authority.
When a transform needs to change channels substantially, first check whether it
is really codec decoding or subscriber behavior.

## Boundary Rules

- Prefer plain `Stream` functions; use `Channel` only when first-class channel
  composition is actually needed.
- Do not introduce a Firegrid transform framework.
- Keep shared selection, ordering, decoding, or mapping logic here.
- Do not import host topology or own durable table providers.
