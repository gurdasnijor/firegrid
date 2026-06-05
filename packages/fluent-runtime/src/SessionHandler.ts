import { Effect, Layer, type Context } from "effect"
import type {
  AgentAdapter,
  SpawnOptions,
  StreamEnvelope,
  User,
} from "./Adapter.ts"
import { createBridge } from "./Bridge.ts"
import type { SessionEvent, SessionEventAppended } from "./Domain.ts"
import {
  FluentStore,
  type AppendSessionEventFencedResult,
  type FluentRuntimeError,
} from "./Store.ts"
import {
  FluentWorkerRuntimeError,
  FluentWorkerSessionDriver,
  type FluentWorkerDriveResult,
  type FluentWorkerLease,
  type FluentWorkerMaterializedSession,
  type FluentWorkerWake,
} from "./Worker.ts"

export interface FluentSessionSuspension {
  readonly waitId: string
  readonly predicate: string
  readonly afterOffset: string
  readonly self?: unknown
  readonly reason?: string
}

export type FluentSessionDriveOutcome =
  | {
    readonly _tag: "Completed"
    readonly result: unknown
  }
  | {
    readonly _tag: "Suspended"
    readonly suspension: FluentSessionSuspension
  }

export interface FluentSessionJournalService {
  readonly events: ReadonlyArray<SessionEvent>
  readonly history: ReadonlyArray<StreamEnvelope>
}

export interface FluentSessionFencedWriterService {
  readonly append: (
    name: string,
    payload: unknown,
  ) => Effect.Effect<AppendSessionEventFencedResult, FluentWorkerRuntimeError>
}

export interface FluentSessionWakeService {
  readonly wake: FluentWorkerWake
  readonly lease: FluentWorkerLease
}

export interface FluentSessionAdapterService {
  readonly adapter: AgentAdapter
  readonly spawnOptions: SpawnOptions
  readonly user?: User
}

export interface FluentSessionDriveServices {
  readonly journal: FluentSessionJournalService
  readonly fencedWriter: FluentSessionFencedWriterService
  readonly wake: FluentSessionWakeService
  readonly adapter: FluentSessionAdapterService
}

export interface FluentSessionDriveHarnessInput {
  readonly wake: FluentWorkerWake
  readonly lease: FluentWorkerLease
  readonly materialized: FluentWorkerMaterializedSession
  readonly services: FluentSessionDriveServices
}

export type FluentSessionDriveHarness = (
  input: FluentSessionDriveHarnessInput,
) => Effect.Effect<FluentSessionDriveOutcome, FluentWorkerRuntimeError>

export interface FluentSessionHandlerConfig {
  readonly adapter: AgentAdapter
  readonly spawnOptions:
    | SpawnOptions
    | ((input: {
      readonly wake: FluentWorkerWake
      readonly lease: FluentWorkerLease
      readonly materialized: FluentWorkerMaterializedSession
    }) => SpawnOptions)
  readonly user?: User
  readonly driveHarness?: FluentSessionDriveHarness
}

const mapStoreError = (
  message: string,
) =>
  (cause: FluentRuntimeError): FluentWorkerRuntimeError =>
    new FluentWorkerRuntimeError({ message, cause })

const toWorkerRuntimeError = (
  message: string,
) =>
  (cause: unknown): FluentWorkerRuntimeError =>
    new FluentWorkerRuntimeError({ message, cause })

const encodeProducerSegment = (value: string): string =>
  encodeURIComponent(value)

const sessionHandlerProducerId = (
  wake: FluentWorkerWake,
  lease: FluentWorkerLease,
): string =>
  [
    "fluent-runtime",
    "session-handler",
    encodeProducerSegment(wake.sessionId),
    encodeProducerSegment(wake.wakeId ?? lease.wakeId),
    encodeProducerSegment(lease.workerId),
  ].join("/")

const isSessionEventAppended = (
  event: unknown,
): event is SessionEventAppended =>
  typeof event === "object" &&
  event !== null &&
  (event as { readonly type?: unknown }).type === "session.event_appended"

const isStreamEnvelope = (
  value: unknown,
): value is StreamEnvelope => {
  if (typeof value !== "object" || value === null) return false
  const direction = (value as { readonly direction?: unknown }).direction
  return direction === "user" || direction === "agent" || direction === "bridge"
}

const streamHistoryFromEvents = (
  events: ReadonlyArray<unknown>,
): ReadonlyArray<StreamEnvelope> =>
  events.flatMap((event) =>
    isSessionEventAppended(event) &&
      event.name === "adapter.envelope" &&
      isStreamEnvelope(event.payload)
      ? [event.payload]
      : [],
  )

const isObjectRecord = (
  value: unknown,
): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null

const parkingSignalFromEnvelope = (
  envelope: StreamEnvelope,
  fallbackAfterOffset: string,
): FluentSessionSuspension | undefined => {
  if (envelope.direction !== "agent" || !isObjectRecord(envelope.raw)) return undefined
  if (envelope.raw.type !== "firegrid.park") return undefined
  const waitId = envelope.raw.waitId
  const predicate = envelope.raw.predicate
  if (typeof waitId !== "string" || typeof predicate !== "string") return undefined
  const afterOffset = typeof envelope.raw.afterOffset === "string"
    ? envelope.raw.afterOffset
    : fallbackAfterOffset
  return {
    waitId,
    predicate,
    afterOffset,
    ...(Object.hasOwn(envelope.raw, "self") ? { self: envelope.raw.self } : {}),
    ...(typeof envelope.raw.reason === "string" ? { reason: envelope.raw.reason } : {}),
  }
}

const defaultSuspension = (
  wake: FluentWorkerWake,
  lease: FluentWorkerLease,
): FluentSessionSuspension => ({
  waitId: `wake:${wake.wakeId ?? lease.wakeId}`,
  predicate: "external_harness_pending",
  afterOffset: lease.streams[0]?.tailOffset ?? "-1",
  reason: "adapter did not observe a terminal turn event",
})

const spawnOptionsFor = (
  config: FluentSessionHandlerConfig,
  input: {
    readonly wake: FluentWorkerWake
    readonly lease: FluentWorkerLease
    readonly materialized: FluentWorkerMaterializedSession
  },
): SpawnOptions =>
  typeof config.spawnOptions === "function"
    ? config.spawnOptions(input)
    : config.spawnOptions

export const driveHarnessOverAdapter = (
  input: FluentSessionDriveHarnessInput,
): Effect.Effect<FluentSessionDriveOutcome, FluentWorkerRuntimeError> =>
  Effect.gen(function* () {
    const recorded: Array<StreamEnvelope> = []
    const bridge = createBridge(input.services.adapter.adapter, {
      history: input.services.journal.history,
      spawnOptions: input.services.adapter.spawnOptions,
      ...(input.services.adapter.user === undefined ? {} : { user: input.services.adapter.user }),
      recordEnvelope: (envelope) => {
        recorded.push(envelope)
      },
    })

    yield* Effect.tryPromise({
      try: () => bridge.start(),
      catch: toWorkerRuntimeError("Failed to drive fluent session harness through adapter"),
    })

    yield* Effect.forEach(
      recorded,
      (envelope) =>
        input.services.fencedWriter.append("adapter.envelope", envelope),
      { discard: true },
    )

    const parking = recorded
      .map((envelope) => parkingSignalFromEnvelope(
        envelope,
        input.lease.streams[0]?.tailOffset ?? "-1",
      ))
      .find((suspension) => suspension !== undefined)
    if (parking !== undefined) {
      return { _tag: "Suspended" as const, suspension: parking }
    }

    const terminal = recorded.find((envelope) =>
      envelope.direction === "agent" &&
      isObjectRecord(envelope.raw) &&
      input.services.adapter.adapter.isTurnComplete(envelope.raw),
    )
    if (terminal !== undefined) {
      return { _tag: "Completed" as const, result: terminal.raw }
    }

    return {
      _tag: "Suspended" as const,
      suspension: defaultSuspension(input.wake, input.lease),
    }
  }).pipe(
    Effect.withSpan("fluent_runtime.session_handler.drive_harness", {
      attributes: {
        "firegrid.session.id": input.wake.sessionId,
        "fluent_runtime.subscription.id": input.wake.subscriptionId,
        "fluent_runtime.lease.generation": input.lease.generation,
        "fluent_runtime.adapter.type": input.services.adapter.adapter.agentType,
      },
    }),
  )

export const makeFluentSessionDriver = (
  config: FluentSessionHandlerConfig,
  store: Context.Tag.Service<typeof FluentStore>,
): Context.Tag.Service<typeof FluentWorkerSessionDriver> => ({
  materialize: (wake, lease) =>
    store.collectSession(wake.sessionId).pipe(
      Effect.map((events) => ({
        sessionId: wake.sessionId,
        replaySource: "journal" as const,
        events,
      })),
      Effect.mapError(mapStoreError("Failed to materialize fluent session state")),
      Effect.withSpan("fluent_runtime.session_handler.materialize", {
        attributes: {
          "firegrid.session.id": wake.sessionId,
          "fluent_runtime.subscription.id": wake.subscriptionId,
          "fluent_runtime.worker.id": lease.workerId,
          "fluent_runtime.lease.generation": lease.generation,
        },
      }),
    ),
  handleSession: (wake, lease, materialized) =>
    Effect.gen(function* () {
      let seq = 0
      const producerId = sessionHandlerProducerId(wake, lease)
      const fencedWriter: FluentSessionFencedWriterService = {
        append: (name, payload) =>
          store.appendSessionEventFenced({
            sessionId: wake.sessionId,
            name,
            payload,
            fence: {
              producerId,
              epoch: lease.generation,
              seq: seq++,
            },
          }).pipe(
            Effect.mapError(mapStoreError(`Failed to append session handler event ${name}`)),
          ),
      }
      const services: FluentSessionDriveServices = {
        journal: {
          events: materialized.events as ReadonlyArray<SessionEvent>,
          history: streamHistoryFromEvents(materialized.events),
        },
        fencedWriter,
        wake: { wake, lease },
        adapter: {
          adapter: config.adapter,
          spawnOptions: spawnOptionsFor(config, { wake, lease, materialized }),
          ...(config.user === undefined ? {} : { user: config.user }),
        },
      }
      const driveHarness = config.driveHarness ?? driveHarnessOverAdapter
      const outcome = yield* driveHarness({
        wake,
        lease,
        materialized,
        services,
      })
      if (outcome._tag === "Suspended") {
        yield* fencedWriter.append("handler.suspended", {
          wakeId: wake.wakeId ?? lease.wakeId,
          suspension: outcome.suspension,
        })
        return { _tag: "Suspended" as const } satisfies FluentWorkerDriveResult
      }
      yield* fencedWriter.append("handler.completed", {
        wakeId: wake.wakeId ?? lease.wakeId,
        result: outcome.result,
      })
      return { _tag: "Completed" as const } satisfies FluentWorkerDriveResult
    }).pipe(
      Effect.withSpan("fluent_runtime.session_handler.handle", {
        attributes: {
          "firegrid.session.id": wake.sessionId,
          "fluent_runtime.subscription.id": wake.subscriptionId,
          "fluent_runtime.worker.id": lease.workerId,
          "fluent_runtime.lease.generation": lease.generation,
        },
      }),
    ),
})

export const FluentSessionDriverLive = (
  config: FluentSessionHandlerConfig,
): Layer.Layer<FluentWorkerSessionDriver, never, FluentStore> =>
  Layer.effect(
    FluentWorkerSessionDriver,
    Effect.map(FluentStore, (store) => makeFluentSessionDriver(config, store)),
  )
