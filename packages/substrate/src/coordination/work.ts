import { Context, Data, Effect, type Exit, Layer, Option, Stream } from "effect"
import { IdGen, IdGenLive } from "../id-gen.ts"
import { attemptClaim } from "../execution/claims.ts"

// ergonomic-facade.CLAIMED_WORK_API.1, .2, .3, .4, .5, .6, .7, .8, .9, .10
// Effect-native claimed-work facade. A `Stream` of candidate work items
// flows through `Work.claimedBy -> Work.perform -> Work.recordOutcome ->
// Work.runScoped`. Handler is invoked only after the durable claim is
// observed as the winner. The facade does not expose raw claim folds or
// retained-record helpers as the normal path.

export class WorkClaimError extends Data.TaggedError(
  "substrate/WorkClaimError",
)<{
  readonly workId: string
  readonly cause: unknown
}> {}

export interface Claimed<A> {
  readonly value: A
  readonly workId: string
  readonly claimId: string
  readonly ownerId: string
}

export interface Performed<A, B, E> {
  readonly claim: Claimed<A>
  readonly exit: Exit.Exit<B, E>
}

export interface Recorded<A, B, E> {
  readonly claim: Claimed<A>
  readonly exit: Exit.Exit<B, E>
}

// Public union — `lost` is a normal pipeline outcome, not an error
// (silent drop in `Work.claimedBy`). Surfaced as a service value so tests
// can stub deterministic outcomes.
export type ClaimAttemptOutcome =
  | { readonly kind: "won"; readonly claimId: string }
  | {
      readonly kind: "lost"
      readonly winnerOwnerId: string
      readonly winnerClaimId: string
    }

export interface WorkClaimService {
  readonly attempt: (input: {
    readonly workId: string
    readonly ownerId: string
  }) => Effect.Effect<ClaimAttemptOutcome, WorkClaimError>
}

export class WorkClaim extends Context.Tag("substrate/WorkClaim")<
  WorkClaim,
  WorkClaimService
>() {}

export interface WorkClaimLiveConfig {
  readonly streamUrl: string
  readonly contentType?: string
}

// Live implementation routes through the shared internal claim helper used
// by the kernel's `processReadyWorkItem`. One implementation, two callers.
// firegrid-remediation-hardening.EFFECT_CONSISTENCY.5
// IdGen is captured at layer-build time so the WorkClaim service surface
// keeps `R = never` for callers; tests inject deterministic IDs by
// composing a different IdGen layer at the substrate root.
export const WorkClaimLive = (
  cfg: WorkClaimLiveConfig,
): Layer.Layer<WorkClaim> =>
  Layer.effect(
    WorkClaim,
    Effect.map(IdGen, (idGen) => ({
      attempt: (input) =>
        attemptClaim({
          streamUrl: cfg.streamUrl,
          ...(cfg.contentType !== undefined ? { contentType: cfg.contentType } : {}),
          workId: input.workId,
          ownerId: input.ownerId,
        }).pipe(
          Effect.provideService(IdGen, idGen),
          Effect.map(({ claimId, winner }): ClaimAttemptOutcome =>
            winner.claimId === claimId
              ? { kind: "won", claimId }
              : {
                  kind: "lost",
                  winnerOwnerId: winner.ownerId,
                  winnerClaimId: winner.claimId,
                },
          ),
          Effect.mapError(
            (cause) => new WorkClaimError({ workId: input.workId, cause }),
          ),
        ),
    })),
  ).pipe(Layer.provide(IdGenLive))

// ergonomic-facade.CLAIMED_WORK_API.3, .5, .8, .10
// Stream operator: for each candidate, attempt the durable claim and
// emit a `Claimed<A>` only when this owner won. Lost claims are silently
// filtered (a normal non-error outcome).
const claimedBy =
  <A>(ownerId: string, keyOf: (value: A) => string) =>
  <E, R>(
    source: Stream.Stream<A, E, R>,
  ): Stream.Stream<Claimed<A>, E | WorkClaimError, R | WorkClaim> =>
    source.pipe(
      Stream.mapEffect((value) =>
        Effect.gen(function* () {
          const claim = yield* WorkClaim
          const workId = keyOf(value)
          const outcome = yield* claim.attempt({ workId, ownerId })
          if (outcome.kind === "lost") {
            return Option.none<Claimed<A>>()
          }
          return Option.some<Claimed<A>>({
            value,
            workId,
            claimId: outcome.claimId,
            ownerId,
          })
        }),
      ),
      Stream.filterMap((opt) => opt),
    )

// ergonomic-facade.CLAIMED_WORK_API.4, .7, .8, .10
// effect-native-api.OPERATOR_PROGRAMS.10
// Stream operator: invoke the user's handler for a Claimed item and
// capture handler success / typed failure / interruption as an
// `Exit.Exit<B, E2>` so `recordOutcome` always observes one Exit per
// invoked handler. The handler runs interruptibly via `restore(...)`;
// only the `Effect.exit` capture itself is uninterruptible. The
// downstream recorder remains interruptible — we do not create an
// unbounded uninterruptible region that would block shutdown. If the
// recorder is interrupted mid-shutdown, the work returns to ready on
// the next start and may be re-performed (at-least-once at the
// recorder boundary; substrate first-valid-terminal authority resolves
// duplicates).
const perform =
  <A, B, E2, R2>(handler: (value: A) => Effect.Effect<B, E2, R2>) =>
  <E1, R1>(
    source: Stream.Stream<Claimed<A>, E1, R1>,
  ): Stream.Stream<Performed<A, B, E2>, E1, R1 | R2> =>
    source.pipe(
      Stream.mapEffect((claim) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.exit(restore(handler(claim.value))).pipe(
            Effect.map(
              (exit): Performed<A, B, E2> => ({ claim, exit }),
            ),
          ),
        ),
      ),
    )

// ergonomic-facade.CLAIMED_WORK_API.6
// Stream operator: hand the (value, exit) pair to the user's recorder.
// Recorder is the domain seam — substrate provides no default kernel
// recorder through the facade. The recorder is ordinary Effect code;
// its dependencies are preserved in R.
const recordOutcome =
  <A, B, E2, ER, RR>(
    recorder: (value: A, exit: Exit.Exit<B, E2>) => Effect.Effect<void, ER, RR>,
  ) =>
  <E1, R1>(
    source: Stream.Stream<Performed<A, B, E2>, E1, R1>,
  ): Stream.Stream<Recorded<A, B, E2>, E1 | ER, R1 | RR> =>
    source.pipe(
      Stream.mapEffect((p) =>
        recorder(p.claim.value, p.exit).pipe(
          Effect.as<Recorded<A, B, E2>>({ claim: p.claim, exit: p.exit }),
        ),
      ),
    )

// ergonomic-facade.CLAIMED_WORK_API.10
// effect-native-api.EFFECT_SERVICES.9
// Drain the pipeline. Caller forks under their own scope (Effect.forkScoped)
// so subscriptions and StreamDB resources are released when the caller's
// scope closes.
const runScoped = <A, E, R>(
  source: Stream.Stream<A, E, R>,
): Effect.Effect<void, E, R> => Stream.runDrain(source)

export const Work = {
  claimedBy,
  perform,
  recordOutcome,
  runScoped,
} as const
