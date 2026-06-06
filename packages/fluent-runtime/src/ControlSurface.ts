import { Context, Effect, Layer } from "effect"
import type { HeadResult, ProducerAppendResult } from "effect-durable-streams"
import type {
  SessionEvent,
  SessionEventAppended,
  SessionId,
} from "./Domain.ts"
import {
  FluentStore,
  type FluentRuntimeError,
} from "./Store.ts"

export const addressedInputEventName = "fluent.control.input.addressed" as const

export interface SendAddressedInputInput {
  readonly entityId: SessionId
  readonly inputId: string
  readonly input: unknown
}

export interface SendAddressedInputResult {
  readonly entityId: SessionId
  readonly eventName: typeof addressedInputEventName
  readonly write: ProducerAppendResult
  readonly delivery: "post_append_boundary"
}

export interface EntityProjection {
  readonly entityId: SessionId
  readonly events: ReadonlyArray<SessionEvent>
  readonly head: HeadResult
  readonly addressedInputs: number
  readonly lastAddressedInput: unknown
}

export class FluentControlSurface extends Context.Tag(
  "@firegrid/fluent-runtime/ControlSurface/FluentControlSurface",
)<FluentControlSurface, {
  readonly sendAddressedInput: (
    input: SendAddressedInputInput,
  ) => Effect.Effect<SendAddressedInputResult, FluentRuntimeError>
  readonly readEntity: (
    entityId: SessionId,
  ) => Effect.Effect<EntityProjection, FluentRuntimeError>
  readonly headEntity: (
    entityId: SessionId,
  ) => Effect.Effect<HeadResult, FluentRuntimeError>
}>() {}

const addressedInputs = (
  events: ReadonlyArray<SessionEvent>,
): ReadonlyArray<SessionEventAppended> =>
  events.filter((event): event is SessionEventAppended =>
    event.type === "session.event_appended" &&
    "name" in event &&
    event.name === addressedInputEventName,
  )

const encodeSegment = (segment: string): string => encodeURIComponent(segment)

const inputProducerId = (
  input: SendAddressedInputInput,
): string =>
  [
    "fluent-control-surface",
    "input",
    encodeSegment(input.entityId),
    encodeSegment(input.inputId),
  ].join("/")

export const FluentControlSurfaceLive = Layer.effect(
  FluentControlSurface,
  Effect.gen(function*() {
    const store = yield* FluentStore

    return {
      sendAddressedInput: (input) =>
        store.appendSessionEventFenced({
          sessionId: input.entityId,
          name: addressedInputEventName,
          payload: {
            entityId: input.entityId,
            inputId: input.inputId,
            input: input.input,
          },
          fence: {
            producerId: inputProducerId(input),
            epoch: 0,
            seq: 0,
          },
        }).pipe(
          Effect.map(result => ({
            entityId: input.entityId,
            eventName: addressedInputEventName,
            write: result.write,
            delivery: "post_append_boundary" as const,
          })),
          Effect.tap(result =>
            Effect.annotateCurrentSpan({
              "firegrid.entity.id": input.entityId,
              "fluent_runtime.control.input_id": input.inputId,
              "fluent_runtime.control.event_name": addressedInputEventName,
              "fluent_runtime.control.append_result": result.write._tag,
              "fluent_runtime.control.append_offset": result.write.offset,
              "fluent_runtime.control.delivery": result.delivery,
              "fluent_runtime.control.handler_invoked": false,
            }),
          ),
          Effect.withSpan("fluent_runtime.control_surface.send", {
            attributes: {
              "firegrid.entity.id": input.entityId,
              "fluent_runtime.control.input_id": input.inputId,
              "fluent_runtime.control.event_name": addressedInputEventName,
              "fluent_runtime.control.delivery": "post_append_boundary",
            },
          }),
        ),
      readEntity: (entityId) =>
        Effect.gen(function*() {
          const events = yield* store.collectSession(entityId)
          const head = yield* store.headSession(entityId)
          const inputs = addressedInputs(events)
          const last = inputs[inputs.length - 1]
          return {
            entityId,
            events,
            head,
            addressedInputs: inputs.length,
            lastAddressedInput: last?.payload,
          }
        }).pipe(
          Effect.tap(projection =>
            Effect.annotateCurrentSpan({
              "firegrid.entity.id": entityId,
              "fluent_runtime.control.projection.events": projection.events.length,
              "fluent_runtime.control.projection.addressed_inputs": projection.addressedInputs,
              "fluent_runtime.control.projection.offset": projection.head.offset,
              "fluent_runtime.control.projection.stream_closed": projection.head.streamClosed,
            }),
          ),
          Effect.withSpan("fluent_runtime.control_surface.read", {
            attributes: { "firegrid.entity.id": entityId },
          }),
        ),
      headEntity: (entityId) =>
        store.headSession(entityId).pipe(
          Effect.tap(head =>
            Effect.annotateCurrentSpan({
              "firegrid.entity.id": entityId,
              "fluent_runtime.control.head.offset": head.offset,
              "fluent_runtime.control.head.stream_closed": head.streamClosed,
            }),
          ),
          Effect.withSpan("fluent_runtime.control_surface.head", {
            attributes: { "firegrid.entity.id": entityId },
          }),
        ),
    }
  }),
)
