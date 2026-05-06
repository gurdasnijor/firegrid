import { DurableStream } from "@durable-streams/client"
import type { ChangeEvent } from "@durable-streams/state"
import { Context, Data, Duration, Effect, Layer } from "effect"
import { appendChange } from "../protocol/descriptors/append.ts"
import { readAuthoritativeRun } from "../retained-records.ts"
import {
  blockRun,
  isTerminalRun,
} from "../protocol/state-machine.ts"
import {
  DurableWaits,
  workScopedAwakeableKey,
} from "../execution/waits.ts"
import {
  CompletionId as toCompletionId,
  type CompletionId,
} from "./branded.ts"
import { CurrentWorkContext } from "./context.ts"
import {
  TriggerMatchers,
  type ChoreographyTrigger,
  type ProjectionMatchTrigger,
} from "./triggers.ts"

// Choreography facade Effect-native runtime API.
//
// choreography-facade.CHOREOGRAPHY_API.1
// choreography-facade.CHOREOGRAPHY_API.2
// choreography-facade.CHOREOGRAPHY_API.3
// choreography-facade.CHOREOGRAPHY_API.4
// choreography-facade.CHOREOGRAPHY_API.5
// choreography-facade.CHOREOGRAPHY_API.6
// choreography-facade.CHOREOGRAPHY_API.7
// choreography-facade.CHOREOGRAPHY_API.8
//
// choreography-facade.SUSPENSION.1
// choreography-facade.SUSPENSION.2
// Each suspending operation writes the durable completion and blocked-run
// rows BEFORE signalling in-process suspension, then verifies the durable
// blocked state via the authoritative retained-run fold, then triggers
// Effect.interrupt as the in-process suspension signal. scheduleAt is
// non-blocking and returns a value.
//
// choreography-facade.ERRORS.1
// choreography-facade.ERRORS.4
// ChoreographyTimeout is the only v1 tagged choreography error and the v1
// facade does not raise it. Internal failures (stream writes, retained
// reads, run-block mistakes, missing matcher configuration) are defects,
// not typed errors. Public method signatures therefore expose an empty
// error channel.

// Module-local defect carrier. Not exported: hosts observe verification
// failures via Cause.isDie, not by importing this class.
class ChoreographyVerificationError extends Data.TaggedError(
  "ChoreographyVerificationError",
)<{
  readonly completionId: string
  readonly reason: string
}> {}

export interface ChoreographyLiveConfig {
  readonly streamUrl: string
  readonly contentType?: string
}

export interface ScheduleAtResult {
  readonly completionId: CompletionId
  readonly whenMs: number
}

// Service method signatures preserve their dependency requirements in the
// returned Effect's R channel. ChoreographyLive itself is constructed
// without those dependencies, so a host can build a Choreography service
// from streamUrl alone and supply CurrentWorkContext / TriggerMatchers
// only at the call sites that need them.
//
// scheduleAt is intentionally narrower: it depends on DurableWaits only.
// A host running scheduleAt does NOT need CurrentWorkContext or
// TriggerMatchers in scope.
export interface ChoreographyService {
  // choreography-facade.CHOREOGRAPHY_API.2
  readonly sleep: (
    duration: Duration.DurationInput,
  ) => Effect.Effect<never, never, DurableWaits | CurrentWorkContext>
  // choreography-facade.CHOREOGRAPHY_API.3
  readonly waitFor: (
    trigger: ChoreographyTrigger,
    options?: { readonly timeout?: Duration.DurationInput },
  ) => Effect.Effect<
    never,
    never,
    DurableWaits | CurrentWorkContext | TriggerMatchers
  >
  // choreography-facade.CHOREOGRAPHY_API.4
  readonly scheduleAt: (input: {
    readonly at: Date | number
    readonly input: unknown
  }) => Effect.Effect<ScheduleAtResult, never, DurableWaits>
  // choreography-facade.CHOREOGRAPHY_API.5
  // choreography-facade.CHOREOGRAPHY_API.8
  readonly awaitAwakeable: (input: {
    readonly name: string
  }) => Effect.Effect<never, never, DurableWaits | CurrentWorkContext>
}

export class Choreography extends Context.Tag("substrate/Choreography")<
  Choreography,
  ChoreographyService
>() {}

// Live implementation. ChoreographyLive depends only on its config; no
// Effect services are required at layer construction. Each method yields
// the dependencies it actually needs from the surrounding Effect's R
// channel.
export const ChoreographyLive = (
  cfg: ChoreographyLiveConfig,
): Layer.Layer<Choreography> =>
  Layer.sync(Choreography, () => {
    const contentType = cfg.contentType ?? "application/json"
    const stream = new DurableStream({ url: cfg.streamUrl, contentType })

    const append = (event: ChangeEvent) =>
      appendChange(
        stream,
        event,
        (cause) =>
          new ChoreographyVerificationError({
            completionId: "block-row-append",
            reason: String(cause),
          }),
      )

    // choreography-facade.SUSPENSION.1
    // choreography-facade.SUSPENSION.3
    // Authoritative pre-block / post-write run state is derived from the
    // retained-run fold (readRetainedRunRecords + foldRunRecords). The
    // StreamDB latest-state read used elsewhere can disagree with the
    // authoritative fold under conflicting terminal records, so
    // choreography suspension uses the same authority operators use for
    // claims and terminalization.
    // Internal helper: block the current run on a completion, verify the
    // post-write state through the retained-run fold, then signal
    // suspension via Effect.interrupt. The runner downstream (Commit 3)
    // translates interrupt to a presentation only when this verification
    // has succeeded.
    const blockAndSuspend = (
      completionId: string,
    ): Effect.Effect<
      never,
      ChoreographyVerificationError,
      CurrentWorkContext
    > =>
      Effect.gen(function* () {
        const ctx = yield* CurrentWorkContext
        const current = yield* readAuthoritativeRun(cfg.streamUrl, ctx.workId).pipe(
          Effect.mapError(
            (cause) =>
              new ChoreographyVerificationError({
                completionId,
                reason: `retained run read failed: ${String(cause)}`,
              }),
          ),
        )
        if (current === undefined) {
          return yield* Effect.fail(
            new ChoreographyVerificationError({
              completionId,
              reason: `current run ${ctx.workId} not found in retained records`,
            }),
          )
        }
        // Reject terminal runs explicitly so a completed/failed/cancelled
        // run is never re-blocked or reported as suspended.
        if (isTerminalRun(current.state)) {
          return yield* Effect.fail(
            new ChoreographyVerificationError({
              completionId,
              reason: `current run ${ctx.workId} is terminal (${current.state}); refusing to block`,
            }),
          )
        }
        // choreography-facade.SUSPENSION.4
        // Make blocked-on-other-completion an explicit defect: a run
        // already suspended on a different completion is NOT re-pointed
        // and does NOT report a successful suspension on this call. This
        // does not depend on state-machine throwing.
        if (
          current.state === "blocked" &&
          current.blockedOnCompletionId !== completionId
        ) {
          return yield* Effect.fail(
            new ChoreographyVerificationError({
              completionId,
              reason: `current run ${ctx.workId} already blocked on ${current.blockedOnCompletionId}; refusing to re-point`,
            }),
          )
        }
        // Idempotent skip: already blocked on the same completion.
        if (
          !(
            current.state === "blocked" &&
            current.blockedOnCompletionId === completionId
          )
        ) {
          // current is "started" — append the durable.run blocked row.
          const event = yield* blockRun(current, {
            blockedOnCompletionId: completionId,
          }).pipe(
            Effect.mapError((cause) =>
              new ChoreographyVerificationError({
                completionId,
                reason: `blockRun build failed: ${String(cause)}`,
              }),
            ),
          )
          yield* append(event)
        }
        // choreography-facade.SUSPENSION.1
        // Verify the durable blocked-run state AFTER the write through the
        // authoritative retained-run fold.
        const verified = yield* readAuthoritativeRun(cfg.streamUrl, ctx.workId).pipe(
          Effect.mapError(
            (cause) =>
              new ChoreographyVerificationError({
                completionId,
                reason: `post-write retained run read failed: ${String(cause)}`,
              }),
          ),
        )
        if (
          verified === undefined ||
          verified.state !== "blocked" ||
          verified.blockedOnCompletionId !== completionId
        ) {
          return yield* Effect.fail(
            new ChoreographyVerificationError({
              completionId,
              reason: `post-write verification failed: state=${verified?.state} blockedOn=${verified?.blockedOnCompletionId}`,
            }),
          )
        }
        // choreography-facade.SUSPENSION.2
        // In-process suspension is signalled via Effect.interrupt only
        // after durable suspension is committed and verified.
        return yield* Effect.interrupt
      })

    const sleep: ChoreographyService["sleep"] = (duration) =>
      Effect.gen(function* () {
        const waits = yield* DurableWaits
        const durationMs = Duration.toMillis(Duration.decode(duration))
        const result = yield* waits.sleep({ durationMs })
        return yield* blockAndSuspend(result.completionId)
      }).pipe(
        // choreography-facade.INSTRUMENTATION.1
        Effect.withSpan("substrate.choreography.sleep"),
        // choreography-facade.ERRORS.4 — internal failures are defects.
        Effect.orDie,
      )

    const waitFor: ChoreographyService["waitFor"] = (trigger, options) =>
      Effect.gen(function* () {
        const waits = yield* DurableWaits
        const matchers = yield* TriggerMatchers
        // choreography-facade.TRIGGERS.5
        // choreography-facade.TRIGGERS.8
        // Presence-check the matcher at create time so misconfiguration
        // fails fast (as a defect, not a typed error) before any durable
        // row is written. The matcher itself is invoked later by the
        // host-wired projection-match subscriber.
        const pmTrigger: ProjectionMatchTrigger = trigger
        yield* matchers.lookup(pmTrigger.matcherId)

        const timeoutMs =
          options?.timeout !== undefined
            ? Duration.toMillis(Duration.decode(options.timeout))
            : undefined
        const result = yield* waits.waitFor({
          trigger: pmTrigger,
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        })
        return yield* blockAndSuspend(result.completionId)
      }).pipe(
        Effect.withSpan("substrate.choreography.wait_for"),
        Effect.orDie,
      )

    const scheduleAt: ChoreographyService["scheduleAt"] = (input) =>
      Effect.gen(function* () {
        const waits = yield* DurableWaits
        const whenMs =
          typeof input.at === "number" ? input.at : input.at.getTime()
        const result = yield* waits.scheduleWork({
          whenMs,
          input: input.input,
        })
        // choreography-facade.CHOREOGRAPHY_API.4
        // scheduleAt is fire-and-forget for the calling run. We do NOT
        // call blockAndSuspend; the current fiber continues with the
        // scheduled-work result. Downstream resolution is the
        // scheduled-work subscriber's responsibility.
        return {
          completionId: toCompletionId(result.completionId),
          whenMs,
        }
      }).pipe(
        Effect.withSpan("substrate.choreography.schedule_at"),
        Effect.orDie,
      )

    const awaitAwakeable: ChoreographyService["awaitAwakeable"] = (input) =>
      Effect.gen(function* () {
        const waits = yield* DurableWaits
        const ctx = yield* CurrentWorkContext
        // choreography-facade.CHOREOGRAPHY_API.8
        // v1 awaitAwakeable is work-scoped only; the workId comes from
        // CurrentWorkContext. Global awakeables remain on
        // DurableWaits.awakeableGlobal and are not re-exposed here.
        const result = yield* waits.awakeable({
          workId: ctx.workId,
          name: input.name,
        })
        // Sanity: workScopedAwakeableKey gives the same key DurableWaits
        // computed; importing it documents the equivalence.
        if (result.key !== workScopedAwakeableKey(ctx.workId, input.name)) {
          return yield* Effect.fail(
            new ChoreographyVerificationError({
              completionId: result.completionId,
              reason: "awakeable key shape unexpected",
            }),
          )
        }
        return yield* blockAndSuspend(result.completionId)
      }).pipe(
        Effect.withSpan("substrate.choreography.awakeable"),
        Effect.orDie,
      )

    return { sleep, waitFor, scheduleAt, awaitAwakeable }
  })
