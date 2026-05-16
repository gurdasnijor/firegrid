import {
  type RuntimeIngressDeliveryRow,
  type RuntimeIngressInputRow,
} from "@firegrid/protocol/runtime-ingress"
import { Effect, Option, Stream } from "effect"
import { RuntimeIngressInputStream } from "../authorities/runtime-ingress-appender.ts"
import {
  RuntimeIngressDeliveryClaimAndComplete,
  runtimeIngressSubscriberId,
  type RuntimeIngressDeliveryClaimAndCompleteService,
} from "../authorities/runtime-ingress-delivery-tracker.ts"
import {
  runtimeIngressRowsToAgentInputEvents,
  sequencedRuntimeIngressRowsForContext,
} from "../transforms/ingress-to-agent-input.ts"
import {
  type AgentInputEvent,
  type RuntimeSubscriberId,
} from "../events/index.ts"
import {
  asRuntimeContextError,
  mapRuntimeContextError,
  type RuntimeContextError,
} from "../../runtime-errors.ts"

export { runtimeIngressSubscriberId }

interface RuntimeIngressDeliveryCapabilities {
  readonly deliveryTracker: RuntimeIngressDeliveryClaimAndCompleteService
  readonly ingressInputs: Stream.Stream<RuntimeIngressInputRow, unknown>
}

const sequencedIngressRows = (
  source: Stream.Stream<RuntimeIngressInputRow, unknown>,
  contextId: string,
): Stream.Stream<RuntimeIngressInputRow, RuntimeContextError> =>
  sequencedRuntimeIngressRowsForContext(
    source,
    contextId,
  ).pipe(
    Stream.mapError(cause =>
      asRuntimeContextError(
        "runtime-ingress.codec.subscribe",
        "failed to subscribe to runtime ingress rows",
        contextId,
        cause,
      )),
  )

const claimedAgentInputRows = (options: {
  readonly capabilities: RuntimeIngressDeliveryCapabilities
  readonly contextId: string
  readonly subscriberId: RuntimeSubscriberId
}): Stream.Stream<{
  readonly row: RuntimeIngressInputRow
  readonly delivery: RuntimeIngressDeliveryRow
}, RuntimeContextError> =>
  sequencedIngressRows(options.capabilities.ingressInputs, options.contextId).pipe(
    Stream.mapEffect(row =>
      Effect.gen(function* () {
        const claimed = yield* options.capabilities.deliveryTracker.claimInput(
          row,
          { subscriberId: options.subscriberId },
        ).pipe(
          mapRuntimeContextError(
            "runtime-ingress.codec.delivery.claim",
            "failed to claim runtime codec delivery row",
            options.contextId,
          ),
        )
        if (Option.isNone(claimed)) {
          return Option.none<{
            readonly row: RuntimeIngressInputRow
            readonly delivery: RuntimeIngressDeliveryRow
          }>()
        }
        return Option.some({ row, delivery: claimed.value })
      })),
    Stream.filterMap(value => value),
  )

export const runIngressDelivery = (options: {
  readonly contextId: string
  readonly subscriberId: RuntimeSubscriberId
  readonly send: (event: AgentInputEvent) => Effect.Effect<void, unknown>
}): Effect.Effect<
  void,
  RuntimeContextError,
  RuntimeIngressInputStream | RuntimeIngressDeliveryClaimAndComplete
> =>
  Effect.gen(function* () {
    const capabilities: RuntimeIngressDeliveryCapabilities = {
      deliveryTracker: yield* RuntimeIngressDeliveryClaimAndComplete,
      ingressInputs: yield* RuntimeIngressInputStream,
    }
    return yield* claimedAgentInputRows({ ...options, capabilities }).pipe(
      runtimeIngressRowsToAgentInputEvents(options.contextId),
      Stream.mapEffect(({ input, delivery }) =>
        options.send(input).pipe(
          Effect.mapError(cause =>
            asRuntimeContextError(
              "agent-codec.input.send",
              "failed to send runtime ingress input to agent codec",
              options.contextId,
              cause,
            )),
          Effect.zipRight(
            capabilities.deliveryTracker.recordCompleted(delivery).pipe(
              mapRuntimeContextError(
                "runtime-ingress.codec.delivery.complete",
                "failed to record completed runtime codec delivery row",
                options.contextId,
              ),
            ),
          ),
        )),
      Stream.runDrain,
    )
  })
