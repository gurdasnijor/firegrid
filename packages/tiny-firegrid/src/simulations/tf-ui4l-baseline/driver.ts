import { Firegrid } from "@firegrid/client-sdk/firegrid"
import { Effect } from "effect"

/**
 * tf-ui4l/INV-6 sub-sims: the workflow execution lives in the host layer
 * (it owns `durableStreamsBaseUrl` + `namespace` + `stopSignal`, none of
 * which the driver can see). Driver here is a "yield Firegrid then block"
 * shape so the runner type-checks; host completes the simulation by
 * signaling `stopSignal` when the workflow finishes.
 *
 * This intentionally bypasses claude-agent-acp (per OLA-2026-05-20 Q1
 * fallback: per-channel wait_for routing requires ChannelRegistry —
 * tf-lawq, blocked on tf-auuv). The comparison measures workflow-body
 * shape, not LLM tool-call lowering.
 */
export const tfUi4lBaselineDriver: Effect.Effect<void, never, Firegrid> =
  Effect.gen(function*() {
    yield* Firegrid // satisfy type; client unused by this sim
    yield* Effect.never
  })
