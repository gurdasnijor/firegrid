/**
 * ConsumerCheckpointStore — durable per-subscriber claim/completion records.
 *
 * Implements:
 *  - effect-durable-operators.CONSUMER.2 — checkpoint storage is a service
 *    Layer, not caller-owned fold code.
 *
 * v0 ships a single backend: durable-streams-backed checkpoint rows. The
 * Layer materializes the checkpoint stream using
 * `effect-durable-streams.snapshotThenFollow`, which gives a deterministic
 * catch-up signal at acquire time — `read` is safe to call immediately after
 * Layer acquisition because the snapshot has been fully drained before
 * acquire returns.
 *
 * Future backends are different Layers satisfying this same service tag —
 * never different `DurableConsumer.run` parameters. v0 does not expose
 * alternate backends.
 */

import type { HttpClient } from "@effect/platform"
import { DurableStream } from "effect-durable-streams"
import {
  Context,
  Effect,
  HashMap,
  Layer,
  Option,
  Ref,
  Schema,
  type Scope,
  Stream,
} from "effect"
import { CheckpointError } from "./Errors.ts"

// ---------------------------------------------------------------------------
// Public record shape (kept small — schema is owned by DurableConsumer per
// SDD §Checkpoint Semantics; callers cannot parameterize it in v0).
// ---------------------------------------------------------------------------

export interface CheckpointRecord {
  readonly subscriberId: string
  readonly key: string
  readonly claimedAt: Option.Option<string>
  readonly completedAt: Option.Option<string>
}

const CheckpointRow = Schema.Struct({
  subscriberId: Schema.String,
  key: Schema.String,
  claimedAt: Schema.optional(Schema.String),
  completedAt: Schema.optional(Schema.String),
})
type CheckpointRow = Schema.Schema.Type<typeof CheckpointRow>

const compositeKey = (subscriberId: string, key: string) =>
  `${subscriberId}::${key}`

const recordOf = (row: CheckpointRow): CheckpointRecord => ({
  subscriberId: row.subscriberId,
  key: row.key,
  claimedAt: Option.fromNullable(row.claimedAt),
  completedAt: Option.fromNullable(row.completedAt),
})

// ---------------------------------------------------------------------------
// Service tag
// ---------------------------------------------------------------------------

// The producer used by `ConsumerCheckpointStoreLive` is acquired at Layer
// construction (inside the layer's HttpClient/Scope). Its `append` does
// NOT require HttpClient at call time — the layer fronts the HTTP fiber
// with a bounded in-memory queue. So `writeClaim`/`writeCompletion` here
// have `R: never`; callers don't need to wire HttpClient through their
// process effect just to record a checkpoint.
export class ConsumerCheckpointStore extends Context.Tag(
  "effect-durable-operators/ConsumerCheckpointStore",
)<
  ConsumerCheckpointStore,
  {
    readonly read: (
      subscriberId: string,
      key: string,
    ) => Effect.Effect<Option.Option<CheckpointRecord>, CheckpointError>
    readonly writeClaim: (
      subscriberId: string,
      key: string,
    ) => Effect.Effect<void, CheckpointError>
    readonly writeCompletion: (
      subscriberId: string,
      key: string,
    ) => Effect.Effect<void, CheckpointError>
  }
>() {}

// ---------------------------------------------------------------------------
// Live Layer — `effect-durable-streams.snapshotThenFollow` backed.
// ---------------------------------------------------------------------------

interface LiveOptions {
  readonly streamOptions: {
    readonly endpoint: DurableStream.Endpoint
    readonly producerId: string
  }
}

export const ConsumerCheckpointStoreLive = (
  opts: LiveOptions,
): Layer.Layer<
  ConsumerCheckpointStore,
  CheckpointError | DurableStream.ReadError,
  HttpClient.HttpClient | Scope.Scope
> =>
  Layer.scoped(
    ConsumerCheckpointStore,
    Effect.gen(function* () {
      const bound = DurableStream.define({
        endpoint: opts.streamOptions.endpoint,
        schema: CheckpointRow,
      })

      // Deterministic catch-up: `snapshotThenFollow` returns ONLY after the
      // server's catch-up read has completed. We fold the snapshot into the
      // in-memory map BEFORE acquire returns, so any subsequent `read` sees
      // retained checkpoints immediately.
      const { snapshot, live } = yield* bound.snapshotThenFollow.pipe(
        Effect.mapError((cause) =>
          new CheckpointError({
            subscriberId: "(snapshot)",
            key: "(snapshot)",
            cause,
          }),
        ),
      )

      const stateRef = yield* Ref.make(
        HashMap.empty<string, CheckpointRow>(),
      )
      for (const row of snapshot) {
        yield* Ref.update(stateRef, (m) =>
          HashMap.set(m, compositeKey(row.subscriberId, row.key), row),
        )
      }

      // Live follow-on: keep the in-memory map in sync with future appends.
      // Failures on the live fiber are captured (not silently dropped) so
      // subsequent `read` calls surface a typed error rather than returning
      // a stale view. The fiber is scoped to the layer so it's torn down
      // on release.
      const liveFailure =
        yield* Ref.make<Option.Option<CheckpointError>>(Option.none())
      yield* Stream.runForEach(live, (row) =>
        Ref.update(stateRef, (m) =>
          HashMap.set(m, compositeKey(row.subscriberId, row.key), row),
        ),
      ).pipe(
        Effect.catchAll((cause) =>
          Ref.set(
            liveFailure,
            Option.some(
              new CheckpointError({
                subscriberId: "(live-follow)",
                key: "(live-follow)",
                cause,
              }),
            ),
          ),
        ),
        Effect.forkScoped,
      )

      const producer = yield* bound
        .producer({ producerId: opts.streamOptions.producerId, autoClaim: true })
        .pipe(
          Effect.mapError((cause) =>
            new CheckpointError({
              subscriberId: "(producer)",
              key: "(producer)",
              cause,
            }),
          ),
        )

      const writeRow = (
        subscriberId: string,
        key: string,
        next: CheckpointRow,
      ) =>
        producer.append(next).pipe(
          Effect.tap(() =>
            Ref.update(stateRef, (m) =>
              HashMap.set(m, compositeKey(subscriberId, key), next),
            ),
          ),
          Effect.mapError((cause) =>
            new CheckpointError({ subscriberId, key, cause }),
          ),
          Effect.asVoid,
        )

      const writeMarked = (
        subscriberId: string,
        key: string,
        mark: "claim" | "complete",
      ) =>
        Effect.flatMap(Ref.get(stateRef), (m) => {
          const prevValue = Option.getOrUndefined(
            HashMap.get(m, compositeKey(subscriberId, key)),
          )
          const stamp = new Date().toISOString()
          const next: CheckpointRow = {
            subscriberId,
            key,
            // Preserve the existing timestamp on the OTHER mark; replace
            // (or set) the timestamp for the mark we're writing.
            ...(mark === "claim"
              ? { claimedAt: prevValue?.claimedAt ?? stamp }
              : prevValue?.claimedAt !== undefined
                ? { claimedAt: prevValue.claimedAt }
                : {}),
            ...(mark === "complete"
              ? { completedAt: stamp }
              : prevValue?.completedAt !== undefined
                ? { completedAt: prevValue.completedAt }
                : {}),
          }
          return writeRow(subscriberId, key, next)
        })

      // Surface any captured live-follow failure on read/write so callers
      // see a typed error rather than a silently-stale view.
      const guard = <A>(eff: Effect.Effect<A, CheckpointError>) =>
        Effect.flatMap(Ref.get(liveFailure), (opt) =>
          Option.isSome(opt) ? Effect.fail(opt.value) : eff,
        )

      return ConsumerCheckpointStore.of({
        read: (subscriberId, key) =>
          guard(
            Effect.map(Ref.get(stateRef), (m) =>
              Option.map(
                HashMap.get(m, compositeKey(subscriberId, key)),
                recordOf,
              ),
            ),
          ),
        writeClaim: (subscriberId, key) =>
          guard(writeMarked(subscriberId, key, "claim")),
        writeCompletion: (subscriberId, key) =>
          guard(writeMarked(subscriberId, key, "complete")),
      })
    }),
  )
