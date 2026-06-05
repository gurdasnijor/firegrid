import { Context, Data, Effect, Stream } from "effect"
import type { SessionId } from "./Domain.ts"

export type SubscriptionId = string
export type WorkerId = string
export type WakeId = string
export type StreamPath = string

export class FluentWorkerRuntimeError extends Data.TaggedError("FluentWorkerRuntimeError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

export class FluentWorkerClaimHeld extends Data.TaggedError("FluentWorkerClaimHeld")<{
  readonly holder: WorkerId
}> {}

export class FluentWorkerFenced extends Data.TaggedError("FluentWorkerFenced")<{
  readonly generation: number
}> {}

export type FluentWorkerSubscriptionError =
  | FluentWorkerRuntimeError
  | FluentWorkerClaimHeld
  | FluentWorkerFenced

export interface FluentWorkerWake {
  readonly subscriptionId: SubscriptionId
  readonly sessionId: SessionId
  readonly wakeId?: WakeId
}

export interface FluentWorkerLeaseStream {
  readonly path: StreamPath
  readonly ackedOffset: string
  readonly tailOffset: string
}

export interface FluentWorkerLease {
  readonly subscriptionId: SubscriptionId
  readonly workerId: WorkerId
  readonly token: string
  readonly wakeId: WakeId
  readonly generation: number
  readonly leaseTtlMs: number
  readonly streams: ReadonlyArray<FluentWorkerLeaseStream>
}

export interface FluentWorkerAck {
  readonly stream: StreamPath
  readonly offset: string
}

export interface FluentWorkerAckResult {
  readonly nextWake: boolean
}

export class FluentWorkerSubscriptions
  extends Context.Tag("@firegrid/fluent-runtime/Worker/FluentWorkerSubscriptions")<
    FluentWorkerSubscriptions,
    {
      readonly consumeWakeStream: (
        subscriptionId: SubscriptionId,
      ) => Stream.Stream<FluentWorkerWake, FluentWorkerRuntimeError>
      readonly claim: (
        subscriptionId: SubscriptionId,
        workerId: WorkerId,
      ) => Effect.Effect<FluentWorkerLease, FluentWorkerRuntimeError | FluentWorkerClaimHeld>
      readonly ack: (
        lease: FluentWorkerLease,
        acks: ReadonlyArray<FluentWorkerAck>,
        options: { readonly done: boolean },
      ) => Effect.Effect<FluentWorkerAckResult, FluentWorkerRuntimeError | FluentWorkerFenced>
      readonly release: (
        lease: FluentWorkerLease,
      ) => Effect.Effect<void, FluentWorkerRuntimeError | FluentWorkerFenced>
    }
  >() {}

export interface FluentWorkerMaterializedSession {
  readonly sessionId: SessionId
  readonly replaySource: "journal" | "snapshot"
  readonly events: ReadonlyArray<unknown>
  readonly state?: unknown
}

export type FluentWorkerDriveResult =
  | {
    readonly _tag: "Completed"
  }
  | {
    readonly _tag: "Suspended"
  }

export class FluentWorkerSessionDriver
  extends Context.Tag("@firegrid/fluent-runtime/Worker/FluentWorkerSessionDriver")<
    FluentWorkerSessionDriver,
    {
      readonly materialize: (
        wake: FluentWorkerWake,
        lease: FluentWorkerLease,
      ) => Effect.Effect<FluentWorkerMaterializedSession, FluentWorkerRuntimeError>
      readonly handleSession: (
        wake: FluentWorkerWake,
        lease: FluentWorkerLease,
        materialized: FluentWorkerMaterializedSession,
      ) => Effect.Effect<FluentWorkerDriveResult, FluentWorkerRuntimeError>
    }
  >() {}

export type FluentWorkerWakeResult =
  | {
    readonly _tag: "AlreadyClaimed"
    readonly holder: WorkerId
  }
  | {
    readonly _tag: "Completed"
    readonly lease: FluentWorkerLease
    readonly materialized: FluentWorkerMaterializedSession
    readonly acks: ReadonlyArray<FluentWorkerAck>
    readonly nextWake: boolean
  }
  | {
    readonly _tag: "Suspended"
    readonly lease: FluentWorkerLease
    readonly materialized: FluentWorkerMaterializedSession
  }
  | {
    readonly _tag: "AckFenced"
    readonly lease: FluentWorkerLease
    readonly materialized: FluentWorkerMaterializedSession
    readonly acks: ReadonlyArray<FluentWorkerAck>
    readonly generation: number
  }

export interface RunFluentWorkerInput {
  readonly subscriptionId: SubscriptionId
  readonly workerId: WorkerId
  readonly concurrency?: number
}

export type FluentWorkerRequirements = FluentWorkerSubscriptions | FluentWorkerSessionDriver

const tailAcks = (lease: FluentWorkerLease): ReadonlyArray<FluentWorkerAck> =>
  lease.streams.map((stream) => ({
    stream: stream.path,
    offset: stream.tailOffset,
  }))

export const handleFluentWorkerWake = Effect.fn("fluent_runtime.worker.handle_wake")(
  function* (
    wake: FluentWorkerWake,
    workerId: WorkerId,
  ) {
    const subscriptions = yield* FluentWorkerSubscriptions
    const driver = yield* FluentWorkerSessionDriver

    return yield* Effect.scoped(
      Effect.gen(function* () {
        const lease = yield* Effect.acquireRelease(
          subscriptions.claim(wake.subscriptionId, workerId).pipe(
            Effect.withSpan("fluent_runtime.worker.claim", {
              attributes: {
                "firegrid.session.id": wake.sessionId,
                "fluent_runtime.subscription.id": wake.subscriptionId,
                "fluent_runtime.worker.id": workerId,
              },
            }),
          ),
          (heldLease) => subscriptions.release(heldLease).pipe(Effect.ignore),
        )

        const drive = yield* Effect.gen(function* () {
          const materialized = yield* driver.materialize(wake, lease)
          const driveResult = yield* driver.handleSession(wake, lease, materialized)
          return { driveResult, materialized }
        }).pipe(
          Effect.withSpan("fluent_runtime.worker.drive", {
            attributes: {
              "firegrid.session.id": wake.sessionId,
              "fluent_runtime.subscription.id": wake.subscriptionId,
              "fluent_runtime.worker.id": workerId,
              "fluent_runtime.lease.generation": lease.generation,
            },
          }),
        )

        if (drive.driveResult._tag === "Suspended") {
          return {
            _tag: "Suspended",
            lease,
            materialized: drive.materialized,
          } satisfies FluentWorkerWakeResult
        }

        const acks = tailAcks(lease)
        const ackResult = yield* subscriptions.ack(lease, acks, { done: true }).pipe(
          Effect.map((result) => ({
            _tag: "Acked" as const,
            nextWake: result.nextWake,
          })),
          Effect.catchTag("FluentWorkerFenced", (fenced) =>
            Effect.succeed({
              _tag: "Fenced" as const,
              generation: fenced.generation,
            }),
          ),
          Effect.withSpan("fluent_runtime.worker.ack", {
            attributes: {
              "firegrid.session.id": wake.sessionId,
              "fluent_runtime.subscription.id": wake.subscriptionId,
              "fluent_runtime.worker.id": workerId,
              "fluent_runtime.lease.generation": lease.generation,
            },
          }),
        )

        if (ackResult._tag === "Fenced") {
          return {
            _tag: "AckFenced",
            lease,
            materialized: drive.materialized,
            acks,
            generation: ackResult.generation,
          } satisfies FluentWorkerWakeResult
        }

        return {
          _tag: "Completed",
          lease,
          materialized: drive.materialized,
          acks,
          nextWake: ackResult.nextWake,
        } satisfies FluentWorkerWakeResult
      }),
    ).pipe(
      Effect.catchTag("FluentWorkerClaimHeld", (held) =>
        Effect.succeed({
          _tag: "AlreadyClaimed" as const,
          holder: held.holder,
        }),
      ),
    )
  },
)

export const runFluentWorker = (
  input: RunFluentWorkerInput,
): Effect.Effect<void, FluentWorkerRuntimeError, FluentWorkerRequirements> =>
  Effect.gen(function* () {
    const subscriptions = yield* FluentWorkerSubscriptions
    const concurrency = input.concurrency ?? 1
    const semaphore = yield* Effect.makeSemaphore(concurrency)

    yield* subscriptions.consumeWakeStream(input.subscriptionId).pipe(
      Stream.mapEffect(
        (wake) => semaphore.withPermits(1)(handleFluentWorkerWake(wake, input.workerId)),
        {
          concurrency,
          unordered: true,
        },
      ),
      Stream.runDrain,
    )
  })
