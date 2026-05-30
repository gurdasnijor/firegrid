/**
 * Canonical RuntimeContext subscriber — as a workflow body.
 *
 * Under the unified kernel, the RuntimeContext lifecycle (the most
 * load-bearing Shape C subscriber today) collapses into a single
 * `Workflow.make` body parked on input arrival via `Workflow.suspend`,
 * with the kernel-owned write+arm controller re-arming on each input
 * append.
 *
 * The body:
 *   1. Spawns once via `Activity.make` (memoized across resumes /
 *      reconstruction). Records a `runs` row with `status="started"`.
 *   2. Loops a cursor over the input table. On miss → `Workflow.suspend`.
 *      On hit → `Activity.make` to emit an output row, advance cursor.
 *   3. On terminal input (kind === "terminal"), writes a `runs` row
 *      with `status="exited"` and returns.
 *
 * One execution per `(contextId, attempt)` via `idempotencyKey` —
 * kills the production TOCTOU that spawned two `claude-agent-acp`
 * processes for one logical session (the RCSW finding).
 *
 * Restart safety:
 *   - The spawn Activity is memoized; replay sees the existing activity
 *     row and skips the side effect.
 *   - The send Activity per cursor position is similarly memoized.
 *   - The cursor re-derives from `consumed`; suspend/resume returns the
 *     body to the same point in the loop with the same activities
 *     replayed.
 */

import {
  Activity,
  Workflow,
  WorkflowEngine,
} from "@effect/workflow"
import { Effect, Option, Ref, Schema } from "effect"
import { UnifiedTable, inputKey, runKey, outputKey } from "../tables.ts"

// ── Recording adapter (test stand-in for production codec/spawn) ────────────
//
// In production this would call the real ACP/stdio-jsonl codec
// `startOrAttach` and `sendCommand`. For the simulation it records
// invocations to a host-side Ref so tests can assert at-most-once.

export interface RuntimeContextRecorderState {
  readonly spawns: Array<string>
  readonly sends: Array<{ readonly key: string; readonly value: string }>
}

export interface RuntimeContextRecorder {
  readonly state: Ref.Ref<RuntimeContextRecorderState>
  readonly recordSpawn: (key: string) => Effect.Effect<void>
  readonly recordSend: (
    key: string,
    value: string,
  ) => Effect.Effect<void>
  readonly snapshot: Effect.Effect<RuntimeContextRecorderState>
}

export const makeRuntimeContextRecorder = (): Effect.Effect<RuntimeContextRecorder> =>
  Effect.gen(function*() {
    const state = yield* Ref.make<RuntimeContextRecorderState>({
      spawns: [],
      sends: [],
    })
    const recordSpawn = (key: string) =>
      Ref.update(state, (current) => ({
        ...current,
        spawns: [...current.spawns, key],
      }))
    const recordSend = (key: string, value: string) =>
      Ref.update(state, (current) => ({
        ...current,
        sends: [...current.sends, { key, value }],
      }))
    return {
      state,
      recordSpawn,
      recordSend,
      snapshot: Ref.get(state),
    }
  })

// ── Workflow ────────────────────────────────────────────────────────────────

export const RuntimeContextSessionPayloadSchema = Schema.Struct({
  contextId: Schema.String,
  attempt: Schema.Number,
})
export type RuntimeContextSessionPayload =
  Schema.Schema.Type<typeof RuntimeContextSessionPayloadSchema>

export const RuntimeContextSessionResultSchema = Schema.Struct({
  contextId: Schema.String,
  attempt: Schema.Number,
  inputsConsumed: Schema.Number,
  reachedTerminal: Schema.Boolean,
})

export const RuntimeContextSessionWorkflow = Workflow.make({
  name: "unified.runtime-context-session",
  payload: RuntimeContextSessionPayloadSchema,
  success: RuntimeContextSessionResultSchema,
  idempotencyKey: (p) => `${p.contextId}:${p.attempt}`,
})

const sessionKey = (contextId: string, attempt: number): string =>
  `${contextId}:${attempt}`

const now = (): string => new Date().toISOString()

const body = (recorder: RuntimeContextRecorder) =>
  (payload: RuntimeContextSessionPayload) =>
    Effect.gen(function*() {
      const instance = yield* WorkflowEngine.WorkflowInstance
      const table = yield* UnifiedTable
      const key = sessionKey(payload.contextId, payload.attempt)

      // Spawn once per attempt (Activity-memoized).
      yield* Activity.make({
        name: `unified.session.spawn/${key}`,
        success: Schema.Void,
        execute: Effect.gen(function*() {
          yield* recorder.recordSpawn(key)
          yield* table.runs.insertOrGet({
            runKey: runKey(payload.contextId, payload.attempt),
            contextId: payload.contextId,
            attempt: payload.attempt,
            status: "started",
            recordedAt: now(),
          }).pipe(Effect.orDie)
        }),
      })

      // Cursor-based input consumption loop. The body terminates ONLY
      // on a `kind === "terminal"` input — there's no exit count.
      // (Body-local `consumed` / `cursor` re-derive correctly across
      // Workflow.suspend / resume because the body restarts from the
      // top and Activity memoization replays previously-completed
      // sends.)
      let consumed = 0
      let cursor = 0
      let reachedTerminal = false
      while (!reachedTerminal) {
        const row = yield* table.inputs.get(
          inputKey(payload.contextId, cursor),
        ).pipe(Effect.orDie)
        if (Option.isNone(row)) {
          yield* Effect.annotateCurrentSpan({
            "firegrid.unified.body.decision": "suspend",
            "firegrid.unified.cursor": cursor,
          })
          yield* Workflow.suspend(instance)
          return yield* Effect.never
        }
        const input = row.value
        const isTerminal = input.kind === "terminal"
        yield* Activity.make({
          name: `unified.session.send/${key}/${cursor}`,
          success: Schema.Void,
          execute: Effect.gen(function*() {
            yield* recorder.recordSend(key, input.payloadJson)
            yield* table.outputs.insertOrGet({
              outputKey: outputKey(payload.contextId, cursor),
              contextId: payload.contextId,
              sequence: cursor,
              kind: isTerminal ? "terminated" : "text-chunk",
              payloadJson: input.payloadJson,
              emittedAt: now(),
            }).pipe(Effect.orDie)
          }),
        })
        consumed += 1
        cursor += 1
        if (isTerminal) reachedTerminal = true
      }

      // Terminal lifecycle row (durable terminal-after-settlement
      // evidence; per the shape-c-terminal-ordering finding).
      yield* table.runs.upsert({
        runKey: runKey(payload.contextId, payload.attempt),
        contextId: payload.contextId,
        attempt: payload.attempt,
        status: "exited",
        exitCode: 0,
        recordedAt: now(),
      }).pipe(Effect.orDie)

      return {
        contextId: payload.contextId,
        attempt: payload.attempt,
        inputsConsumed: consumed,
        reachedTerminal,
      }
    }).pipe(
      Effect.withSpan("firegrid.unified.session.body", {
        kind: "consumer",
        attributes: {
          "firegrid.context.id": payload.contextId,
          "firegrid.unified.attempt": payload.attempt,
        },
      }),
      Effect.orDie,
    )

export const buildRuntimeContextSessionLayer = (
  recorder: RuntimeContextRecorder,
) => RuntimeContextSessionWorkflow.toLayer(body(recorder))
