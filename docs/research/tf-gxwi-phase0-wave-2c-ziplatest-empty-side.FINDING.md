# tf-gxwi Phase 0 Wave-2C Finding: Stream.zipLatest Empty-Side Semantics

VERDICT: SOURCE-RESOLVED

`Stream.zipLatest(left, right)` requires both sides to produce an initial non-empty chunk before it can emit its first pair. If one side has not emitted yet, the combined stream does not emit; it waits for that side's first non-empty pull. If one side completes without ever producing a non-empty chunk, the combined stream completes without emitting any pair.

Source evidence:

- Public docs describe the steady-state behavior as combining an emission from either stream with the latest value from the other stream, which implies an existing latest value is needed: `repos/effect/packages/effect/src/Stream.ts:5907-5910`.
- The public export delegates `zipLatest` to `internal.zipLatest`: `repos/effect/packages/effect/src/Stream.ts:5937-5940`.
- `internal.zipLatest` is implemented through `zipLatestWith`: `repos/effect/packages/effect/src/internal/stream.ts:8282-8295`.
- `zipLatestWith` wraps each side's pull in `pullNonEmpty`, which recursively skips empty chunks and only succeeds with a non-empty chunk: `repos/effect/packages/effect/src/internal/stream.ts:8337-8344`.
- The initial phase races the two first non-empty pulls, but the winner is zipped with `Fiber.join` of the losing side before any output stream is constructed: `repos/effect/packages/effect/src/internal/stream.ts:8347-8359`. This means the first output waits for both sides.
- Only after both first non-empty chunks exist does it create the latest-value ref from `Chunk.unsafeLast(l)` and `Chunk.unsafeLast(r)`: `repos/effect/packages/effect/src/internal/stream.ts:8361-8365`.
- The first emitted chunk is derived by combining values from one initial chunk with `Chunk.unsafeLast` of the other initial chunk: `repos/effect/packages/effect/src/internal/stream.ts:8368-8372`.
- Subsequent emissions are one-sided only after initialization: `mergeEither(repeatEffectOption(left), repeatEffectOption(right))` updates the `latest` ref and pairs the arriving side with the stored latest value from the other side: `repos/effect/packages/effect/src/internal/stream.ts:8373-8392`.
- End-of-stream is represented as `Option.none` by `toPull`: `repos/effect/packages/effect/src/internal/stream.ts:7073-7083`, and `fromEffectOption` turns `Option.none` failure into an empty stream: `repos/effect/packages/effect/src/internal/stream.ts:3067-3072`. Therefore, if the missing side ends before producing an initial non-empty chunk, the combined stream ends without output.

Phase 1 implication:

Lane 1 must not rely on bare `Stream.zipLatest(runtimeInputStream, runtimeOutputStream)` if either side may be absent before the other side's first event. It must seed both sides with initial sentinels or use another proven shape, otherwise the first input-only or output-only event can stall until the other side emits.
