import { Effect, Stream } from "effect"

type WakeFinalizer = Effect.Effect<void>

// firegrid-remediation-hardening.DUP_DETECTION.5
export const wakeStream = (
  subscribe: (wake: () => void) => Effect.Effect<WakeFinalizer>,
): Stream.Stream<void> =>
  Stream.asyncScoped<void>(
    (emit) =>
      Effect.acquireRelease(
        Effect.flatMap(
          Effect.sync(() => () => {
            void emit.single(undefined)
          }),
          subscribe,
        ),
        (finalize) => finalize,
      ),
    { bufferSize: 1, strategy: "sliding" },
  )
