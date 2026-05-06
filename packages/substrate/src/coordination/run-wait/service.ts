import { DurableStream } from "@durable-streams/client"
import type { ChangeEvent } from "@durable-streams/state"
import { Context, Data, Duration, Effect, Either, Layer, Schema } from "effect"
import { appendChange } from "../../protocol/descriptors/append.ts"
import {
  readAuthoritativeRun,
  readJsonItems,
} from "../../state-store/retained-records.ts"
import {
  CompletionRowType,
  CompletionValue,
  decodeCompletionData,
  decodeProjectionMatchCompletionData,
  type ProjectionMatchCompletionData,
  TimerCompletionData,
  type TimerCompletionData as TimerCompletionDataValue,
} from "../../protocol/schema/rows.ts"
import {
  blockRun,
  foldCompletionRecords,
  isTerminalRun,
} from "../../protocol/state-machine.ts"
import {
  DurableWaits,
  DurableWaitsLive,
  workScopedAwakeableKey,
} from "../../execution/waits.ts"
import {
  CompletionId as toCompletionId,
  type CompletionId,
} from "./branded.ts"
import {
  CurrentWorkContext,
  type CurrentWorkContextValue,
} from "./context.ts"
import { TriggerMatchers, type ProjectionMatchTrigger } from "./triggers.ts"

// RunWait facade Effect-native runtime API.
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
// RunWaitTimeout is the only v1 tagged run-wait error and the v1
// facade does not raise it. Internal failures (stream writes, retained
// reads, run-block mistakes, missing matcher configuration) are defects,
// not typed errors. Public method signatures therefore expose an empty
// error channel.

// Module-local defect carrier. Not exported: hosts observe verification
// failures via Cause.isDie, not by importing this class.
class RunWaitVerificationError extends Data.TaggedError(
  "RunWaitVerificationError",
)<{
  readonly completionId: string
  readonly reason: string
}> {}

const decodeCompletion = Schema.decodeUnknownEither(CompletionValue)

const sameProjectionMatchTrigger = (
  left: ProjectionMatchTrigger,
  right: ProjectionMatchTrigger,
): boolean =>
  left._tag === right._tag &&
  left.label === right.label &&
  left.projectionKey === right.projectionKey &&
  left.matcherId === right.matcherId

const verificationError = (
  completionId: string,
  reason: string,
): RunWaitVerificationError =>
  new RunWaitVerificationError({ completionId, reason })

export interface RunWaitLayerConfig {
  readonly streamUrl: string
  readonly contentType?: string
}

export interface RunWaitUntilResult {
  readonly completionId: CompletionId
  readonly whenMs: number
}

// run-wait-primitives.RUN_WAIT_API.1
export interface RunWaitService {
  // run-wait-primitives.RUN_WAIT_API.3
  readonly sleep: (
    duration: Duration.DurationInput,
  ) => Effect.Effect<void, never, CurrentWorkContext>
  // run-wait-primitives.RUN_WAIT_API.2
  readonly for: (
    trigger: ProjectionMatchTrigger,
    options?: { readonly timeout?: Duration.DurationInput },
  ) => Effect.Effect<void, never, CurrentWorkContext | TriggerMatchers>
  // run-wait-primitives.RUN_WAIT_API.4
  readonly until: (
    when: Date | number,
    input?: unknown,
  ) => Effect.Effect<RunWaitUntilResult>
  // run-wait-primitives.RUN_WAIT_API.5
  readonly awakeable: (
    name: string,
  ) => Effect.Effect<never, never, CurrentWorkContext>
}

export class RunWait extends Context.Tag("substrate/RunWait")<
  RunWait,
  RunWaitService
>() {
  static layer = (config: RunWaitLayerConfig): Layer.Layer<RunWait> =>
    Layer.provide(RunWaitLive(config), DurableWaitsLive(config))
}

// run-wait-primitives.RUN_WAIT_API.6
export const RunWaitLive = (
  cfg: RunWaitLayerConfig,
): Layer.Layer<RunWait, never, DurableWaits> =>
  Layer.effect(RunWait, Effect.gen(function* () {
    const waits = yield* DurableWaits
    const contentType = cfg.contentType ?? "application/json"
    const stream = new DurableStream({ url: cfg.streamUrl, contentType })

    const append = (event: ChangeEvent) =>
      appendChange(
        stream,
        event,
        (cause) =>
          verificationError("block-row-append", String(cause)),
      )

    const readCurrentRun = (completionId: string) =>
      Effect.gen(function* () {
        const ctx = yield* CurrentWorkContext
        const current = yield* readAuthoritativeRun(cfg.streamUrl, ctx.workId).pipe(
          Effect.mapError((cause) =>
            verificationError(
              completionId,
              `retained run read failed: ${String(cause)}`,
            ),
          ),
        )
        return { ctx, current } as const
      })

    // choreography-facade.SUSPENSION.1
    // choreography-facade.SUSPENSION.3
    // Authoritative pre-block / post-write run state is derived from the
    // retained-run fold (readRetainedRunRecords + foldRunRecords). The
    // StreamDB latest-state read used elsewhere can disagree with the
    // authoritative fold under conflicting terminal records, so
    // run-wait suspension uses the same authority operators use for
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
      RunWaitVerificationError,
      CurrentWorkContext
    > =>
      Effect.gen(function* () {
        const { ctx, current } = yield* readCurrentRun(completionId)
        if (current === undefined) {
          return yield* verificationError(
            completionId,
            `current run ${ctx.workId} not found in retained records`,
          )
        }
        // Reject terminal runs explicitly so a completed/failed/cancelled
        // run is never re-blocked or reported as suspended.
        if (isTerminalRun(current.state)) {
          return yield* verificationError(
            completionId,
            `current run ${ctx.workId} is terminal (${current.state}); refusing to block`,
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
          return yield* verificationError(
            completionId,
            `current run ${ctx.workId} already blocked on ${current.blockedOnCompletionId}; refusing to re-point`,
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
              verificationError(
                completionId,
                `blockRun build failed: ${String(cause)}`,
              ),
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
              verificationError(
                completionId,
                `post-write retained run read failed: ${String(cause)}`,
              ),
          ),
        )
        if (
          verified === undefined ||
          verified.state !== "blocked" ||
          verified.blockedOnCompletionId !== completionId
        ) {
          return yield* verificationError(
            completionId,
            `post-write verification failed: state=${verified?.state} blockedOn=${verified?.blockedOnCompletionId}`,
          )
        }
        // choreography-facade.SUSPENSION.2
        // In-process suspension is signalled via Effect.interrupt only
        // after durable suspension is committed and verified.
        return yield* Effect.interrupt
      })

    const readAuthoritativeCompletion = (
      completionId: string,
    ): Effect.Effect<CompletionValue | undefined, RunWaitVerificationError> =>
      Effect.gen(function* () {
        const items = yield* readJsonItems(cfg.streamUrl).pipe(
          Effect.mapError(
            (cause) =>
              verificationError(
                completionId,
                `retained completion read failed: ${String(cause)}`,
              ),
          ),
        )
        const decoded = items
          .filter((event) => event.type === CompletionRowType)
          .map((event) => decodeCompletion(event.value))
        const failed = decoded.find(Either.isLeft)
        if (failed !== undefined && Either.isLeft(failed)) {
          return yield* verificationError(
            completionId,
            `retained completion decode failed: ${String(failed.left)}`,
          )
        }
        const records = decoded.flatMap((item) =>
          Either.isRight(item) && item.right.completionId === completionId
            ? [item.right]
            : [],
        )
        return foldCompletionRecords(completionId, records)
      })

    const decodeProjectionMatchData = (
      completion: CompletionValue,
    ): Effect.Effect<
      ProjectionMatchCompletionData,
      RunWaitVerificationError
    > =>
      decodeProjectionMatchCompletionData(
        completion.data,
        (cause) =>
          verificationError(
            completion.completionId,
            `projection-match completion data decode failed: ${String(cause)}`,
          ),
      )

    const decodeTimerData = (
      completion: CompletionValue,
    ): Effect.Effect<
      TimerCompletionDataValue,
      RunWaitVerificationError
    > =>
      decodeCompletionData(
        TimerCompletionData,
        (cause) =>
          verificationError(
            completion.completionId,
            `timer completion data decode failed: ${String(cause)}`,
          ),
      )(completion.data)

    type ExistingWaitDecision =
      | { readonly kind: "create" }
      | { readonly kind: "resume" }
      | { readonly kind: "suspend"; readonly completionId: string }

    const resolveExistingBlockedCompletion = (input: {
      readonly operation: string
      readonly expectedKind: CompletionValue["kind"]
      readonly validate: (
        ctx: CurrentWorkContextValue,
        completion: CompletionValue,
      ) => Effect.Effect<void, RunWaitVerificationError>
    }): Effect.Effect<
      ExistingWaitDecision,
      RunWaitVerificationError,
      CurrentWorkContext
    > =>
      Effect.gen(function* () {
        const { ctx, current } = yield* readCurrentRun(input.operation)
        if (current?.state !== "blocked") return { kind: "create" as const }

        const completionId = current.blockedOnCompletionId
        if (completionId === undefined) {
          return yield* verificationError(
            input.operation,
            `current run ${ctx.workId} is blocked without blockedOnCompletionId`,
          )
        }

        const completion = yield* readAuthoritativeCompletion(completionId)
        if (completion === undefined) {
          return yield* verificationError(
            completionId,
            `current run ${ctx.workId} is blocked on missing completion`,
          )
        }
        if (completion.kind !== input.expectedKind) {
          return yield* verificationError(
            completionId,
            `current run ${ctx.workId} is blocked on ${completion.kind}, not ${input.expectedKind}`,
          )
        }

        yield* input.validate(ctx, completion)
        if (completion.state === "resolved") return { kind: "resume" as const }
        if (completion.state === "pending") {
          return { kind: "suspend" as const, completionId }
        }
        return yield* verificationError(
          completionId,
          `current run ${ctx.workId} is blocked on terminal ${completion.state} completion`,
        )
      })

    const resolveExistingSleep = (
      durationMs: number,
    ) =>
      resolveExistingBlockedCompletion({
        operation: "sleep-resume",
        expectedKind: "timer",
        validate: (ctx, completion) =>
          Effect.gen(function* () {
            const data = yield* decodeTimerData(completion)
            // durable-waits-and-scheduling.SLEEP.6
            if (data.durationMs !== durationMs) {
              return yield* verificationError(
                completion.completionId,
                `current run ${ctx.workId} is blocked on a different timer duration`,
              )
            }
          }),
      })

    const resolveExistingWaitFor = (
      trigger: ProjectionMatchTrigger,
    ) =>
      resolveExistingBlockedCompletion({
        operation: "wait-for-resume",
        expectedKind: "projection_match",
        validate: (ctx, completion) =>
          Effect.gen(function* () {
            const data = yield* decodeProjectionMatchData(completion)
            // durable-waits-and-scheduling.WAIT_FOR.8
            if (!sameProjectionMatchTrigger(data.trigger, trigger)) {
              return yield* verificationError(
                completion.completionId,
                `current run ${ctx.workId} is blocked on a different projection-match trigger`,
              )
            }
          }),
      })

    const sleep: RunWaitService["sleep"] = (duration) =>
      Effect.gen(function* () {
        const durationMs = Duration.toMillis(Duration.decode(duration))
        const existing = yield* resolveExistingSleep(durationMs)
        if (existing.kind === "resume") {
          // choreography-facade.CHOREOGRAPHY_API.12
          return undefined
        }
        if (existing.kind === "suspend") {
          // choreography-facade.CHOREOGRAPHY_API.13
          return yield* blockAndSuspend(existing.completionId)
        }
        const result = yield* waits.sleep({ durationMs })
        return yield* blockAndSuspend(result.completionId)
      }).pipe(
        // choreography-facade.INSTRUMENTATION.1
        Effect.withSpan("substrate.run-wait.sleep"),
        // choreography-facade.ERRORS.4 — internal failures are defects.
        Effect.orDie,
      )

    const forTrigger: RunWaitService["for"] = (trigger, options) =>
      Effect.gen(function* () {
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
        const existing = yield* resolveExistingWaitFor(pmTrigger)
        if (existing.kind === "resume") {
          // choreography-facade.CHOREOGRAPHY_API.9
          return undefined
        }
        if (existing.kind === "suspend") {
          // choreography-facade.CHOREOGRAPHY_API.10
          return yield* blockAndSuspend(existing.completionId)
        }
        const result = yield* waits.waitFor({
          trigger: pmTrigger,
          ...(timeoutMs !== undefined ? { timeoutMs } : {}),
        })
        return yield* blockAndSuspend(result.completionId)
      }).pipe(
        Effect.withSpan("substrate.run-wait.wait_for"),
        Effect.orDie,
      )

    const until: RunWaitService["until"] = (when, input = {}) =>
      Effect.gen(function* () {
        const whenMs =
          typeof when === "number" ? when : when.getTime()
        const result = yield* waits.scheduleWork({
          whenMs,
          input,
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
        Effect.withSpan("substrate.run-wait.schedule_at"),
        Effect.orDie,
      )

    const awakeable: RunWaitService["awakeable"] = (name) =>
      Effect.gen(function* () {
        const ctx = yield* CurrentWorkContext
        // choreography-facade.CHOREOGRAPHY_API.8
        // v1 awaitAwakeable is work-scoped only; the workId comes from
        // CurrentWorkContext. Global awakeables remain on
        // DurableWaits.awakeableGlobal and are not re-exposed here.
        const result = yield* waits.awakeable({
          workId: ctx.workId,
          name,
        })
        // Sanity: workScopedAwakeableKey gives the same key DurableWaits
        // computed; importing it documents the equivalence.
        if (result.key !== workScopedAwakeableKey(ctx.workId, name)) {
          return yield* verificationError(
            result.completionId,
            "awakeable key shape unexpected",
          )
        }
        return yield* blockAndSuspend(result.completionId)
      }).pipe(
        Effect.withSpan("substrate.run-wait.awakeable"),
        Effect.orDie,
      )

    return { sleep, for: forTrigger, until, awakeable }
  }))
