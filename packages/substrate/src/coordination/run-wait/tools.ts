import { Cause, Effect, Schema } from "effect"
import { readAuthoritativeRun } from "../../state-store/retained-records.ts"
import {
  CompletionId as toCompletionId,
  WorkId as toWorkId,
  type CompletionId,
  type WorkId,
} from "./branded.ts"
import { CurrentWorkContext } from "./context.ts"
import type {
  RunWaitOperation,
  RunWaitSuspension,
} from "./errors.ts"
import { RunWait, type RunWaitUntilResult } from "./service.ts"
import {
  RunWaitTrigger,
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
// RunWaitTools is the substrate's neutral agent-tool binding
// harness. Tool bindings:
//   - share lowering with the runtime API by yielding `RunWait`;
//   - decode inputs with Effect Schema-derived schemas;
//   - never accept or return raw completion ids, run rows, claim ids,
//     stream URLs, or DSS envelopes;
//   - translate verified suspensions (Effect.interrupt) into a neutral
//     RunWaitSuspension value; non-suspending operations return
//     their substrate result (e.g. ScheduleAtResult).
// Tool descriptor formats and wire-result shapes remain adapter/profile
// owned; substrate ships only the neutral { name, inputSchema, handle }
// harness.

export interface RunWaitToolBinding<I, O, R = never> {
  readonly name: string
  readonly inputSchema: Schema.Schema<I>
  readonly handle: (input: I) => Effect.Effect<O, never, R>
}

export interface RunWaitToolsConfig {
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
  trigger: RunWaitTrigger,
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

export interface RunWaitToolBindings {
  readonly sleep: RunWaitToolBinding<
    SleepToolInput,
    RunWaitSuspension,
    RunWait | CurrentWorkContext
  >
  readonly wait_for: RunWaitToolBinding<
    WaitForToolInput,
    RunWaitSuspension,
    RunWait | CurrentWorkContext | TriggerMatchers
  >
  // schedule_me is non-suspending: it does NOT depend on CurrentWorkContext.
  readonly schedule_me: RunWaitToolBinding<
    ScheduleMeToolInput,
    RunWaitUntilResult,
    RunWait
  >
  readonly awaitable: RunWaitToolBinding<
    AwakeableToolInput,
    RunWaitSuspension,
    RunWait | CurrentWorkContext
  >
}

const observeBlockedCompletion = (
  cfg: RunWaitToolsConfig,
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

// Wrap a suspending RunWait call. The runtime call interrupts on
// successful suspension; the harness translates that interrupt into a
// neutral RunWaitSuspension by reading the authoritative retained-
// run fold for the just-blocked-on completion. Non-interrupt failure
// causes (defects from the run-wait facade) propagate verbatim.
//
// choreography-facade.SUSPENSION.4
// Defends against host-cancellation-before-durable-blocking: if the host
// fiber is interrupted BEFORE the run-wait call commits a new block
// row, an unguarded post-interrupt retained-fold read could observe a
// PRE-EXISTING blocked state from earlier suspension and falsely report
// it as a new RunWaitSuspension established by this call. The
// pre-call guard rejects any non-"started" authoritative run state, so
// successful suspension is reported only when this tool invocation
// actually drove the started→blocked transition.
const wrapSuspending = <R>(
  cfg: RunWaitToolsConfig,
  operation: RunWaitOperation,
  call: Effect.Effect<unknown, never, R>,
): Effect.Effect<RunWaitSuspension, never, R | CurrentWorkContext> =>
  Effect.gen(function* () {
    const ctx = yield* CurrentWorkContext
    const workId: WorkId = toWorkId(ctx.workId)

    // Pre-call authoritative run check. Per SUSPENSION.4, only a
    // started run is eligible to transition to blocked through this
    // tool invocation. Missing, terminal, or already-blocked runs die
    // here so a later interrupt cannot be translated into a spurious
    // RunWaitSuspension.
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
        onSuccess: (): Effect.Effect<RunWaitSuspension> =>
          Effect.dieMessage(
            `tool harness: ${operation} returned without suspending; expected interrupt`,
          ),
        onFailure: (
          cause,
        ): Effect.Effect<RunWaitSuspension> => {
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
            const susp: RunWaitSuspension = {
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

export const RunWaitTools = {
  make: (cfg: RunWaitToolsConfig): RunWaitToolBindings => {
    const sleep: RunWaitToolBindings["sleep"] = {
      name: "sleep",
      inputSchema: SleepToolInput,
      handle: (input) =>
        Effect.gen(function* () {
          const wait = yield* RunWait
          // choreography-facade.TOOL_BINDINGS.2
          // The tool handle calls the same RunWait.sleep lowering
          // the runtime API uses. Duration is recovered from the
          // serializable durationMs field.
          return yield* wrapSuspending(
            cfg,
            "sleep",
            wait.sleep(input.durationMs),
          )
        }),
    }

    const wait_for: RunWaitToolBindings["wait_for"] = {
      name: "wait_for",
      inputSchema: WaitForToolInput,
      handle: (input) =>
        Effect.gen(function* () {
          const wait = yield* RunWait
          return yield* wrapSuspending(
            cfg,
            "wait_for",
            wait.for(
              input.trigger,
              input.timeoutMs !== undefined
                ? { timeout: input.timeoutMs }
                : undefined,
            ),
          )
        }),
    }

    const schedule_me: RunWaitToolBindings["schedule_me"] = {
      name: "schedule_me",
      inputSchema: ScheduleMeToolInput,
      handle: (input) =>
        Effect.gen(function* () {
          const wait = yield* RunWait
          // choreography-facade.TOOL_BINDINGS.5
          // schedule_me is a tool alias over substrate scheduleAt; it
          // does NOT block the current run and does NOT return a
          // RunWaitSuspension. It returns the substrate
          // ScheduleAtResult verbatim.
          return yield* wait.until(input.atMs, input.input)
        }),
    }

    const awaitable: RunWaitToolBindings["awaitable"] = {
      name: "awaitable",
      inputSchema: AwakeableToolInput,
      handle: (input) =>
        Effect.gen(function* () {
          const wait = yield* RunWait
          return yield* wrapSuspending(
            cfg,
            "awakeable",
            wait.awakeable(input.name),
          )
        }),
    }

    return { sleep, wait_for, schedule_me, awaitable }
  },
} as const
