import { DurableStream } from "@durable-streams/client"
import type { ChangeEvent } from "@durable-streams/state"
import { Clock, Context, Data, Effect, Layer } from "effect"
import { appendChange } from "./descriptors/append.ts"
import type { CompletionKind, CompletionState, CompletionValue } from "./schema/rows.ts"
import { createPendingCompletion } from "./state-machine.ts"
import { rebuildProjection } from "./stream.ts"

// durable-waits-and-scheduling.AWAKEABLE_API.6
export function workScopedAwakeableKey(workId: string, name: string): string {
  return `awk:work:${workId}:${name}`
}

// durable-waits-and-scheduling.AWAKEABLE_API.7
export function globalAwakeableKey(namespace: string, name: string): string {
  if (namespace.length === 0) {
    throw new Error("global awakeable requires a non-empty namespace")
  }
  return `awk:global:${namespace}:${name}`
}

export interface SleepResult {
  readonly completionId: string
  readonly kind: CompletionKind
  readonly state: CompletionState
}

export interface WaitForResult {
  readonly completionId: string
  readonly kind: CompletionKind
  readonly state: CompletionState
}

export interface ScheduleWorkResult {
  readonly completionId: string
  readonly kind: CompletionKind
  readonly state: CompletionState
}

export interface AwakeableResult {
  readonly completionId: string
  readonly key: string
  readonly kind: CompletionKind
  readonly state: CompletionState
}

// durable-waits-and-scheduling.WAIT_FOR.1, .2 — typed projection-match trigger payload.
// effect-native-api.SCHEMA_FIRST.5 — trigger inputs compile to durable.completion variants.
export interface ProjectionMatchTrigger {
  readonly kind: "projection_match"
  readonly description: unknown
}

export interface SleepInput {
  readonly durationMs: number
}

export interface WaitForInput {
  readonly trigger: ProjectionMatchTrigger
  readonly timeoutMs?: number
}

export interface ScheduleWorkInput {
  readonly whenMs: number
  readonly input: unknown
  readonly workId?: string
}

export interface AwakeableInput {
  readonly workId: string
  readonly name: string
}

export interface AwakeableGlobalInput {
  readonly namespace: string
  readonly name: string
}

export class WaitsStreamError extends Data.TaggedError("WaitsStreamError")<{
  readonly cause: unknown
}> {}

export type WaitsError = WaitsStreamError

// Context.Tag service surface; instances are constructed via DurableWaitsLive(config).
export class DurableWaits extends Context.Tag("Substrate/DurableWaits")<
  DurableWaits,
  {
    // durable-waits-and-scheduling.SLEEP.1, .5 — pending timer completion only.
    readonly sleep: (input: SleepInput) => Effect.Effect<SleepResult, WaitsError>
    // durable-waits-and-scheduling.WAIT_FOR.1, .2 — pending projection_match completion only.
    readonly waitFor: (input: WaitForInput) => Effect.Effect<WaitForResult, WaitsError>
    // durable-waits-and-scheduling.SCHEDULE_WORK.1, .6 — pending scheduled_work completion only; no run declared.
    readonly scheduleWork: (
      input: ScheduleWorkInput,
    ) => Effect.Effect<ScheduleWorkResult, WaitsError>
    // durable-waits-and-scheduling.AWAKEABLE_API.4, .6, .8 — work-scoped key, idempotent.
    readonly awakeable: (
      input: AwakeableInput,
    ) => Effect.Effect<AwakeableResult, WaitsError>
    // durable-waits-and-scheduling.AWAKEABLE_API.5, .7, .8 — global namespaced key, idempotent.
    readonly awakeableGlobal: (
      input: AwakeableGlobalInput,
    ) => Effect.Effect<AwakeableResult, WaitsError>
  }
>() {}

import { randomUUID } from "node:crypto"

export interface DurableWaitsConfig {
  readonly streamUrl: string
  readonly contentType?: string
}

// effect-native-api.EFFECT_SERVICES.3 — config baked into the live layer factory.
// durable-waits-and-scheduling.PHASE_BOUNDARY.4 — APIs create completions only;
// they do NOT block runs or create continuations internally.
export const DurableWaitsLive = (
  config: DurableWaitsConfig,
): Layer.Layer<DurableWaits> =>
  Layer.effect(
    DurableWaits,
    Effect.gen(function* () {
      const contentType = config.contentType ?? "application/json"
      const stream = new DurableStream({ url: config.streamUrl, contentType })

      const append = (event: ChangeEvent) =>
        appendChange(stream, event, (cause) => new WaitsStreamError({ cause }))

      // durable-waits-and-scheduling.AWAKEABLE_API.8 — idempotent creation.
      // If a completion with this id is already in projection (any state),
      // return the existing record without appending.
      const findExisting = (
        completionId: string,
      ): Effect.Effect<CompletionValue | undefined, WaitsStreamError> =>
        Effect.gen(function* () {
          const snapshot = yield* Effect.tryPromise({
            try: () =>
              rebuildProjection({ url: config.streamUrl, contentType }),
            catch: (cause) => new WaitsStreamError({ cause }),
          })
          return snapshot.completions.get(completionId)
        })

      const createPendingAwakeable = (
        key: string,
        kind: "externally_resolved_awakeable",
      ) =>
        Effect.gen(function* () {
          const existing = yield* findExisting(key)
          if (existing !== undefined) {
            return {
              completionId: existing.completionId,
              key,
              kind: existing.kind,
              state: existing.state,
            }
          }
          const event = createPendingCompletion({ completionId: key, kind })
          yield* append(event)
          return {
            completionId: key,
            key,
            kind,
            state: "pending" as const,
          }
        })

      return {
        sleep: (input: SleepInput) =>
          Effect.gen(function* () {
            // durable-records-and-projections.RECORDS.4 — wall-clock timestamps
            // are data fields. We capture dueAtMs durably from Effect Clock so
            // tests can control time if needed.
            const nowMs = yield* Clock.currentTimeMillis
            const completionId = randomUUID()
            const event = createPendingCompletion({
              completionId,
              kind: "timer",
              data: { durationMs: input.durationMs, dueAtMs: nowMs + input.durationMs },
            })
            yield* append(event)
            return {
              completionId,
              kind: "timer" as const,
              state: "pending" as const,
            }
          }),

        waitFor: (input: WaitForInput) =>
          Effect.gen(function* () {
            const completionId = randomUUID()
            // durable-waits-and-scheduling.WAIT_FOR.7 — convert the timeout
            // DURATION to an absolute durable deadline at creation so the
            // projection-match subscriber can evaluate timeout eligibility
            // from the durable row alone (durable-subscribers.PROJECTION_MATCH_SUBSCRIBER.9).
            // Use Effect Clock so tests can control time.
            const nowMs = yield* Clock.currentTimeMillis
            const data: {
              trigger: ProjectionMatchTrigger
              timeoutMs?: number
              deadlineAtMs?: number
            } = {
              trigger: input.trigger,
              ...(input.timeoutMs !== undefined
                ? { timeoutMs: input.timeoutMs, deadlineAtMs: nowMs + input.timeoutMs }
                : {}),
            }
            const event = createPendingCompletion({
              completionId,
              kind: "projection_match",
              data,
            })
            yield* append(event)
            return {
              completionId,
              kind: "projection_match" as const,
              state: "pending" as const,
            }
          }),

        scheduleWork: (input: ScheduleWorkInput) =>
          Effect.gen(function* () {
            const completionId = randomUUID()
            const event = createPendingCompletion({
              completionId,
              kind: "scheduled_work",
              ...(input.workId !== undefined ? { workId: input.workId } : {}),
              data: { whenMs: input.whenMs, input: input.input },
            })
            yield* append(event)
            return {
              completionId,
              kind: "scheduled_work" as const,
              state: "pending" as const,
            }
          }),

        awakeable: (input: AwakeableInput) =>
          createPendingAwakeable(
            workScopedAwakeableKey(input.workId, input.name),
            "externally_resolved_awakeable",
          ),

        awakeableGlobal: (input: AwakeableGlobalInput) =>
          createPendingAwakeable(
            globalAwakeableKey(input.namespace, input.name),
            "externally_resolved_awakeable",
          ),
      }
    }),
  )
