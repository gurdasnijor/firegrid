import { Cause, Effect, Layer } from "effect"
import type { FiregridHost } from "@firegrid/runtime/composition/host-live"
import type { TinyFiregridHostEnv } from "../../types.ts"
import { runOutputReplayOracle, type OracleResult } from "./oracle.ts"

// Host/driver handshake. The oracle is self-contained (clean-room: only
// `effect`), so all logic runs in the host layer and the driver simply awaits
// the published result -- mirroring the phase0-wave-2b sim. The oracle needs
// no Firegrid client, durable streams, or production runtime composition; the
// runner still captures every span under `firegrid.simulation.run`.
/* eslint-disable local/no-module-durable-cache -- simulation-local host/driver handshake; no durable state under test. */
let resolveResult: (result: OracleResult) => void
let rejectResult: (error: unknown) => void

export const phase0bOracleResult = new Promise<OracleResult>((resolve, reject) => {
  resolveResult = resolve
  rejectResult = reject
})
/* eslint-enable local/no-module-durable-cache */

const publishResult: Effect.Effect<void, unknown> =
  runOutputReplayOracle.pipe(
    Effect.matchCauseEffect({
      onFailure: cause =>
        Effect.sync(() => rejectResult(new Error(Cause.pretty(cause)))).pipe(
          Effect.zipRight(Effect.failCause(cause)),
        ),
      onSuccess: result => Effect.sync(() => resolveResult(result)),
    }),
  )

export const phase0bOracleHost = (
  _env: TinyFiregridHostEnv,
): Layer.Layer<FiregridHost, unknown> =>
  Layer.scopedDiscard(
    publishResult.pipe(
      Effect.onInterrupt(() =>
        Effect.sync(() => rejectResult(new Error("phase0b oracle host interrupted"))),
      ),
      Effect.withSpan("firegrid.phase0b.host"),
    ),
  ) as Layer.Layer<FiregridHost, unknown>
