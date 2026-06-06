import {
  discoverFluentControlClient,
} from "@firegrid/client-sdk/fluent-control"
import { FiregridConfig } from "@firegrid/client-sdk/config"
import { Effect, Schedule } from "effect"

const entityId = "session-1"
const inputId = "control-input-1"
const secondInputId = "control-input-2"
const surfaceId = "fluent-control-surface-send-read"
const addressedInputEventName = "fluent.control.input.addressed"

const entityPath = (namespace: string): string =>
  [
    namespace,
    "sessions",
    entityId,
  ].map(encodeURIComponent).join("/")

interface ControlSurfaceObservation {
  readonly sendResult: string
  readonly duplicateResult: string
  readonly secondSendResult: string
  readonly projectionAddressedInputs: number
  readonly projectionOffset: string
  readonly headOffset: string
  readonly durableEvents: number
  readonly durableAddressedInputs: number
  readonly nextOffset: string
  readonly streamClosed: boolean
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const readEntityStream = (
  baseUrl: string,
  namespace: string,
): Effect.Effect<{
  readonly events: number
  readonly addressedInputs: number
  readonly nextOffset: string
  readonly streamClosed: boolean
}, Error> =>
  Effect.tryPromise({
    try: async () => {
      const response = await fetch(`${baseUrl}/v1/stream/${entityPath(namespace)}?offset=-1`)
      if (!response.ok) {
        throw new Error(`read entity stream failed with ${response.status}: ${await response.text()}`)
      }
      const body: unknown = await response.json()
      if (!Array.isArray(body)) {
        throw new Error("entity stream returned a non-array payload")
      }
      const events = body.filter(isRecord)
      const addressedInputs = events.filter(event =>
        event["type"] === "session.event_appended" &&
        event["name"] === addressedInputEventName &&
        isRecord(event["payload"]),
      )
      return {
        events: events.length,
        addressedInputs: addressedInputs.length,
        nextOffset: response.headers.get("stream-next-offset") ?? "",
        streamClosed: response.headers.get("stream-closed") === "true",
      }
    },
    catch: cause => cause instanceof Error ? cause : new Error(String(cause)),
  })

const retryClient = (
  baseUrl: string,
  namespace: string,
) =>
  Effect.tryPromise({
    try: () =>
      discoverFluentControlClient({
        durableStreamsBaseUrl: baseUrl,
        namespace,
        surfaceId,
      }),
    catch: cause => cause instanceof Error ? cause : new Error(String(cause)),
  }).pipe(
    Effect.retry({
      // Discovery waits for the host-served ingress URL; the driver still causes send/read/head.
      // eslint-disable-next-line local/no-fixed-polling
      schedule: Schedule.spaced("100 millis").pipe(
        // eslint-disable-next-line local/no-fixed-polling
        Schedule.intersect(Schedule.recurs(50)),
      ),
    }),
  )

export const driver: Effect.Effect<ControlSurfaceObservation, Error, FiregridConfig> =
  Effect.gen(function*() {
    const config = yield* FiregridConfig
    if (config.durableStreamsBaseUrl === undefined || config.namespace === undefined) {
      return yield* Effect.fail(
        new Error("fluent-control-surface-send-read requires durableStreamsBaseUrl and namespace"),
      )
    }

    const client = yield* retryClient(config.durableStreamsBaseUrl, config.namespace)
    const send = yield* Effect.tryPromise({
      try: () =>
        client.send({
          entityId,
          inputId,
          input: {
            body: "hello fluent control surface",
            addressedTo: entityId,
          },
        }),
      catch: cause => cause instanceof Error ? cause : new Error(String(cause)),
    })
    const duplicate = yield* Effect.tryPromise({
      try: () =>
        client.send({
          entityId,
          inputId,
          input: {
            body: "duplicate should be idempotent",
            addressedTo: entityId,
          },
        }),
      catch: cause => cause instanceof Error ? cause : new Error(String(cause)),
    })
    const second = yield* Effect.tryPromise({
      try: () =>
        client.send({
          entityId,
          inputId: secondInputId,
          input: {
            body: "second addressed input",
            addressedTo: entityId,
          },
        }),
      catch: cause => cause instanceof Error ? cause : new Error(String(cause)),
    })
    const projection = yield* Effect.tryPromise({
      try: () => client.read(entityId),
      catch: cause => cause instanceof Error ? cause : new Error(String(cause)),
    })
    const head = yield* Effect.tryPromise({
      try: () => client.head(entityId),
      catch: cause => cause instanceof Error ? cause : new Error(String(cause)),
    })
    const durable = yield* readEntityStream(config.durableStreamsBaseUrl, config.namespace)
    const observation = {
      sendResult: send.appendResult,
      duplicateResult: duplicate.appendResult,
      secondSendResult: second.appendResult,
      projectionAddressedInputs: projection.addressedInputs,
      projectionOffset: projection.head.offset,
      headOffset: head.offset,
      durableEvents: durable.events,
      durableAddressedInputs: durable.addressedInputs,
      nextOffset: durable.nextOffset,
      streamClosed: durable.streamClosed,
    }
    yield* Effect.annotateCurrentSpan({
      "fluent_control_surface.send_result": observation.sendResult,
      "fluent_control_surface.duplicate_result": observation.duplicateResult,
      "fluent_control_surface.second_send_result": observation.secondSendResult,
      "fluent_control_surface.projection_addressed_inputs": observation.projectionAddressedInputs,
      "fluent_control_surface.projection_offset": observation.projectionOffset,
      "fluent_control_surface.head_offset": observation.headOffset,
      "fluent_control_surface.events": observation.durableEvents,
      "fluent_control_surface.addressed_inputs": observation.durableAddressedInputs,
      "fluent_control_surface.next_offset": observation.nextOffset,
      "fluent_control_surface.stream_closed": observation.streamClosed,
    })
    return observation
  }).pipe(
    Effect.withSpan("firelab.fluent_control_surface_send_read.driver", {
      attributes: {
        "firegrid.bead": "tf-gfd7.1",
        "firegrid.simulation.intent": "fluent-control-surface-send-read",
      },
    }),
  )
