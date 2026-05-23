// Effect-form adapter over the pure ingress-row decoder in
// `packages/runtime/src/transforms/decode-ingress-row.ts` (Shape C cutover
// physical target tree). The pure decoder returns `Either`, which in
// `effect@3` is a subtype of `Effect`, so this re-export keeps the
// Effect-form symbol stable for callers that compose with
// `.pipe(Effect.mapError)` / `Effect.gen`.
//
// Deletion blocker: this shim drops when the remaining `.pipe(Effect.mapError(...))`
// callers (runtime-context body, tiny-firegrid host) migrate to
// `Either.mapLeft` / direct Effect-subtype use over the transforms/ symbol
// directly. Tracked under the Wave 2 RuntimeContext body removal lanes
// (docs/architecture/2026-05-22-shape-c-legacy-deletion-map.md §Lane A).

import type { Effect } from "effect"
import type { RuntimeIngressInputRow } from "@firegrid/protocol/runtime-ingress"
import type { AgentInputEvent } from "../../agent-event-pipeline/events/index.ts"
import { agentInputEventFromRuntimeIngressRow as decodeAgentInputEventEither } from "../../transforms/decode-ingress-row.ts"
import type { RuntimeIngressAgentInputTransformError } from "../../transforms/decode-ingress-row.ts"

export const agentInputEventFromRuntimeIngressRow = (
  row: RuntimeIngressInputRow,
): Effect.Effect<AgentInputEvent, RuntimeIngressAgentInputTransformError> =>
  // `Either<A, E>` IS an `Effect<A, E>` subtype in effect@3; the pure decoder's
  // return value satisfies the Effect-form signature directly.
  decodeAgentInputEventEither(row)
