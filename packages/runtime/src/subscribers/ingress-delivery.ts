import {
  type RuntimeIngressDeliveryRow,
  RuntimeIngressInputRowSchema,
  type RuntimeIngressInputRow,
} from "@firegrid/protocol/runtime-ingress"
import { Effect, Option, Schema, Stream } from "effect"
import {
  runtimeIngressSubscriberId,
  type RuntimeIngressDeliveryAuthorityService,
} from "../authorities/index.ts"
import {
  orderSequencedRuntimeIngressRows,
  runtimeIngressRowsToAgentInputEvents,
} from "../transforms/ingress-to-agent-input.ts"
import {
  type AgentInputEvent,
  type RuntimeSubscriberId,
} from "../events/index.ts"
import {
  asRuntimeContextError,
  mapRuntimeContextError,
  type RuntimeContextError,
} from "../host/errors.ts"
import type { SourceCollectionHandle } from "../waits/index.ts"

export { runtimeIngressSubscriberId }

const sequencedIngressRows = (
  source: SourceCollectionHandle,
  contextId: string,
): Stream.Stream<RuntimeIngressInputRow, RuntimeContextError> =>
  source.subscribe().pipe(
    Stream.mapEffect(row =>
      Schema.decodeUnknown(RuntimeIngressInputRowSchema)(row).pipe(
        mapRuntimeContextError(
          "runtime-ingress.codec.subscribe.decode",
          "failed to decode runtime ingress source row",
          contextId,
        ),
      )),
    Stream.filter(row =>
      row.contextId === contextId &&
      row.status === "sequenced" &&
      row.sequence !== undefined,
    ),
    orderSequencedRuntimeIngressRows,
    Stream.mapError(cause =>
      asRuntimeContextError(
        "runtime-ingress.codec.subscribe",
        "failed to subscribe to runtime ingress rows",
        contextId,
        cause,
      )),
  )

const claimedAgentInputRows = (options: {
  readonly deliveryAuthority: RuntimeIngressDeliveryAuthorityService["write"]
  readonly source: SourceCollectionHandle
  readonly contextId: string
  readonly subscriberId: RuntimeSubscriberId
}): Stream.Stream<{
  readonly row: RuntimeIngressInputRow
  readonly delivery: RuntimeIngressDeliveryRow
}, RuntimeContextError> =>
  sequencedIngressRows(options.source, options.contextId).pipe(
    Stream.mapEffect(row =>
      Effect.gen(function* () {
        const claimed = yield* options.deliveryAuthority.claimInput(
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
  readonly deliveryAuthority: RuntimeIngressDeliveryAuthorityService["write"]
  readonly source: SourceCollectionHandle
  readonly contextId: string
  readonly subscriberId: RuntimeSubscriberId
  readonly send: (event: AgentInputEvent) => Effect.Effect<void, unknown>
}): Effect.Effect<void, RuntimeContextError> =>
  claimedAgentInputRows(options).pipe(
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
          options.deliveryAuthority.recordCompleted(delivery).pipe(
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
