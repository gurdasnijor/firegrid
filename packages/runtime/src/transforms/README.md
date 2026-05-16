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

Typical shape:

```ts
export const sequencedRuntimeIngressRowsForContext = <E, R>(
  source: Stream.Stream<RuntimeIngressInputRow, E, R>,
  contextId: string,
): Stream.Stream<RuntimeIngressInputRow, E, R> =>
  source.pipe(
    Stream.filter(row => row.contextId === contextId),
    orderSequencedRuntimeIngressRows,
  )
```

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
