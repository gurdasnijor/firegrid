import { Cause, Effect, Schema } from "effect"
import { readAuthoritativeRun } from "../retained-records.ts"
import { type DurableWaits } from "../waits.ts"
import {
  CompletionId as toCompletionId,
  WorkId as toWorkId,
  type CompletionId,
  type WorkId,
} from "./branded.ts"
import { CurrentWorkContext } from "./context.ts"
import type {
  ChoreographyOperation,
  ChoreographySuspension,
} from "./errors.ts"
import { Choreography, type ScheduleAtResult } from "./service.ts"
import {
  ChoreographyTrigger,
  type TriggerMatchers,
} from "./triggers.ts"

// choreography-facade.TOOL_BINDINGS.1
// choreography-facade.TOOL_BINDINGS.2
// choreography-facade.TOOL_BINDINGS.3
// choreography-facade.TOOL_BINDINGS.4
// choreography-facade.TOOL_BINDINGS.5
// choreography-facade.TOOL_BINDINGS.6
// choreography-facade.TOOL_BINDINGS.7
//
// ChoreographyTools is the substrate's neutral agent-tool binding
// harness. Tool bindings:
//   - share lowering with the runtime API by yielding `Choreography`;
//   - decode inputs with Effect Schema-derived schemas;
//   - never accept or return raw completion ids, run rows, claim ids,
//     stream URLs, or DSS envelopes;
//   - translate verified suspensions (Effect.interrupt) into a neutral
//     ChoreographySuspension value; non-suspending operations return
//     their substrate result (e.g. ScheduleAtResult).
// Tool descriptor formats and wire-result shapes remain adapter/profile
// owned; substrate ships only the neutral { name, inputSchema, handle }
// harness.

export interface ChoreographyToolBinding<I, O, R = never> {
  readonly name: string
  readonly inputSchema: Schema.Schema<I>
  readonly handle: (input: I) => Effect.Effect<O, never, R>
}

export interface ChoreographyToolsConfig {
  readonly streamUrl: string
  readonly contentType?: string
}

// choreography-facade.TOOL_BINDINGS.3
// Tool input schemas are Effect Schema values, decoded by the harness.
// They contain only serializable fields (matches TRIGGERS.3/.4 for the
// trigger payload).
export const SleepToolInput = Schema.Struct({
  durationMs: Schema.Number,
})
export type SleepToolInput = Schema.Schema.Type<typeof SleepToolInput>

export const WaitForToolInput = Schema.Struct({
  trigger: ChoreographyTrigger,
  timeoutMs: Schema.optional(Schema.Number),
})
export type WaitForToolInput = Schema.Schema.Type<typeof WaitForToolInput>

// choreography-facade.TOOL_BINDINGS.5
// schedule_me lowers to the substrate scheduleAt operation. Tool input
// uses an absolute millisecond timestamp (`atMs`) so the wire payload
// stays JSON-serializable; the substrate scheduleAt accepts Date | number.
export const ScheduleMeToolInput = Schema.Struct({
  atMs: Schema.Number,
  input: Schema.Unknown,
})
export type ScheduleMeToolInput = Schema.Schema.Type<typeof ScheduleMeToolInput>

export const AwakeableToolInput = Schema.Struct({
  name: Schema.String,
})
export type AwakeableToolInput = Schema.Schema.Type<typeof AwakeableToolInput>

export interface ChoreographyToolBindings {
  readonly sleep: ChoreographyToolBinding<
    SleepToolInput,
    ChoreographySuspension,
    Choreography | DurableWaits | CurrentWorkContext
  >
  readonly wait_for: ChoreographyToolBinding<
    WaitForToolInput,
    ChoreographySuspension,
    Choreography | DurableWaits | CurrentWorkContext | TriggerMatchers
  >
  // schedule_me is non-suspending: it does NOT depend on CurrentWorkContext.
  readonly schedule_me: ChoreographyToolBinding<
    ScheduleMeToolInput,
    ScheduleAtResult,
    Choreography | DurableWaits
  >
  readonly awaitable: ChoreographyToolBinding<
    AwakeableToolInput,
    ChoreographySuspension,
    Choreography | DurableWaits | CurrentWorkContext
  >
}

const observeBlockedCompletion = (
  cfg: ChoreographyToolsConfig,
  workId: string,
): Effect.Effect<CompletionId, never> =>
  Effect.gen(function* () {
    const run = yield* readAuthoritativeRun(cfg.streamUrl, workId)
    if (
      run === undefined ||
      run.state !== "blocked" ||
      run.blockedOnCompletionId === undefined
    ) {
      return yield* Effect.dieMessage(
        `tool harness: post-interrupt run ${workId} is not in blocked state (state=${run?.state})`,
      )
    }
    return toCompletionId(run.blockedOnCompletionId)
  }).pipe(Effect.orDie)

// Wrap a suspending Choreography call. The runtime call interrupts on
// successful suspension; the harness translates that interrupt into a
// neutral ChoreographySuspension by reading the authoritative retained-
// run fold for the just-blocked-on completion. Non-interrupt failure
// causes (defects from the choreography facade) propagate verbatim.
//
// choreography-facade.SUSPENSION.4
// Defends against host-cancellation-before-durable-blocking: if the host
// fiber is interrupted BEFORE the choreography call commits a new block
// row, an unguarded post-interrupt retained-fold read could observe a
// PRE-EXISTING blocked state from earlier suspension and falsely report
// it as a new ChoreographySuspension established by this call. The
// pre-call guard rejects any non-"started" authoritative run state, so
// successful suspension is reported only when this tool invocation
// actually drove the started→blocked transition.
const wrapSuspending = <R>(
  cfg: ChoreographyToolsConfig,
  operation: ChoreographyOperation,
  call: Effect.Effect<never, never, R>,
): Effect.Effect<ChoreographySuspension, never, R | CurrentWorkContext> =>
  Effect.gen(function* () {
    const ctx = yield* CurrentWorkContext
    const workId: WorkId = toWorkId(ctx.workId)

    // Pre-call authoritative run check. Per SUSPENSION.4, only a
    // started run is eligible to transition to blocked through this
    // tool invocation. Missing, terminal, or already-blocked runs die
    // here so a later interrupt cannot be translated into a spurious
    // ChoreographySuspension.
    const preCall = yield* readAuthoritativeRun(cfg.streamUrl, workId).pipe(
      Effect.orDie,
    )
    if (preCall === undefined) {
      return yield* Effect.dieMessage(
        `tool harness: ${operation} pre-call run ${workId} not found in retained records`,
      )
    }
    if (preCall.state !== "started") {
      return yield* Effect.dieMessage(
        `tool harness: ${operation} pre-call run ${workId} is not in state="started" (state=${preCall.state}); refusing to translate any later interrupt into a suspension`,
      )
    }

    return yield* call.pipe(
      Effect.matchCauseEffect({
        onSuccess: (): Effect.Effect<ChoreographySuspension> =>
          Effect.dieMessage(
            `tool harness: ${operation} returned without suspending; expected interrupt`,
          ),
        onFailure: (
          cause,
        ): Effect.Effect<ChoreographySuspension> => {
          if (!Cause.isInterruptedOnly(cause)) {
            // Defects from the facade (verification failures, etc.)
            // propagate as defects.
            return Effect.failCause(cause)
          }
          // choreography-facade.SUSPENSION.6
          // choreography-facade.SUSPENSION.7
          return Effect.gen(function* () {
            const completionId = yield* observeBlockedCompletion(
              cfg,
              workId,
            )
            const susp: ChoreographySuspension = {
              suspended: true,
              operation,
              workId,
              completionId,
            }
            return susp
          })
        },
      }),
    )
  })

export const ChoreographyTools = {
  make: (cfg: ChoreographyToolsConfig): ChoreographyToolBindings => {
    const sleep: ChoreographyToolBindings["sleep"] = {
      name: "sleep",
      inputSchema: SleepToolInput,
      handle: (input) =>
        Effect.gen(function* () {
          const choreo = yield* Choreography
          // choreography-facade.TOOL_BINDINGS.2
          // The tool handle calls the same Choreography.sleep lowering
          // the runtime API uses. Duration is recovered from the
          // serializable durationMs field.
          return yield* wrapSuspending(
            cfg,
            "sleep",
            choreo.sleep(input.durationMs),
          )
        }),
    }

    const wait_for: ChoreographyToolBindings["wait_for"] = {
      name: "wait_for",
      inputSchema: WaitForToolInput,
      handle: (input) =>
        Effect.gen(function* () {
          const choreo = yield* Choreography
          return yield* wrapSuspending(
            cfg,
            "wait_for",
            choreo.waitFor(
              input.trigger,
              input.timeoutMs !== undefined
                ? { timeout: input.timeoutMs }
                : undefined,
            ),
          )
        }),
    }

    const schedule_me: ChoreographyToolBindings["schedule_me"] = {
      name: "schedule_me",
      inputSchema: ScheduleMeToolInput,
      handle: (input) =>
        Effect.gen(function* () {
          const choreo = yield* Choreography
          // choreography-facade.TOOL_BINDINGS.5
          // schedule_me is a tool alias over substrate scheduleAt; it
          // does NOT block the current run and does NOT return a
          // ChoreographySuspension. It returns the substrate
          // ScheduleAtResult verbatim.
          return yield* choreo.scheduleAt({
            at: input.atMs,
            input: input.input,
          })
        }),
    }

    const awaitable: ChoreographyToolBindings["awaitable"] = {
      name: "awaitable",
      inputSchema: AwakeableToolInput,
      handle: (input) =>
        Effect.gen(function* () {
          const choreo = yield* Choreography
          return yield* wrapSuspending(
            cfg,
            "awakeable",
            choreo.awaitAwakeable({ name: input.name }),
          )
        }),
    }

    return { sleep, wait_for, schedule_me, awaitable }
  },
} as const
