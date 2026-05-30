/**
 * Canonical RuntimeContext subscriber — as a workflow body.
 *
 * The most load-bearing Shape C subscriber today collapses into a
 * single `Workflow.make` body parked on `Workflow.suspend`, woken by
 * the signal primitive on every input arrival.
 *
 * The body:
 *   1. Spawns once via `Activity.make` (memoized across resumes /
 *      reconstruction). The Activity record IS the durable spawn
 *      evidence — no parallel `runs` row needed.
 *   2. Reads its own signals in `recordedAt` order to derive the
 *      input log. Each signal's payload is the input envelope
 *      `{ kind, payloadJson }`. On miss → `Workflow.suspend`. On hit →
 *      `Activity.make` to deliver the input (memoized return IS the
 *      durable evidence — no parallel `outputs` row needed).
 *   3. Returns when a kind === "terminal" signal is consumed. The
 *      engine records the return in `executions.finalResult` — no
 *      parallel `runs.exited` row needed.
 *
 * One execution per `(contextId, attempt)` via `idempotencyKey` —
 * kills the production TOCTOU that spawned two `claude-agent-acp`
 * processes for one logical session.
 */

import {
  Activity,
  Workflow,
  WorkflowEngine,
} from "@effect/workflow"
import { Effect, Ref, Schema } from "effect"
import { readSignalsFor, SignalTable } from "../signal.ts"

// ── Recording adapter (test stand-in for production codec/spawn) ────────────
//
// In production this would call the real ACP/stdio-jsonl codec
// `startOrAttach` and `sendCommand`. For the simulation it records
// invocations to a host-side Ref so tests can assert at-most-once.
// The Activity wraps the recorder call so engine memoization ensures
// the side effect runs exactly once across replays.

export interface RuntimeContextRecorderState {
  readonly spawns: ReadonlyArray<string>
  readonly sends: ReadonlyArray<{ readonly key: string; readonly value: string }>
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

export const SessionInputPayloadSchema = Schema.Struct({
  kind: Schema.Literal(
    "prompt",
    "permission-response",
    "tool-result",
    "peer-event",
    "scheduled-fire",
    "terminal",
  ),
  payloadJson: Schema.String,
})
export type SessionInputPayload = Schema.Schema.Type<typeof SessionInputPayloadSchema>

const sessionKey = (contextId: string, attempt: number): string =>
  `${contextId}:${attempt}`

const body = (recorder: RuntimeContextRecorder) =>
  (payload: RuntimeContextSessionPayload, executionId: string) =>
    Effect.gen(function*() {
      const instance = yield* WorkflowEngine.WorkflowInstance
      const signals = yield* SignalTable
      const key = sessionKey(payload.contextId, payload.attempt)

      // Spawn once per attempt (Activity-memoized; the engine activity
      // record IS the durable spawn evidence).
      yield* Activity.make({
        name: `unified.session.spawn/${key}`,
        success: Schema.Void,
        execute: recorder.recordSpawn(key),
      })

      // Iterate own signals. Each signal's payload is a session input
      // envelope; order is durable (recordedAt), so cursor positions
      // are stable across replay and per-position Activity memoization
      // holds.
      let consumed = 0
      let reachedTerminal = false
      while (!reachedTerminal) {
        const rows = yield* readSignalsFor(signals, executionId).pipe(Effect.orDie)
        if (consumed >= rows.length) {
          yield* Effect.annotateCurrentSpan({
            "firegrid.unified.body.decision": "suspend",
            "firegrid.unified.cursor": consumed,
          })
          yield* Workflow.suspend(instance)
          return yield* Effect.never
        }
        while (consumed < rows.length && !reachedTerminal) {
          const row = rows[consumed]!
          const input = JSON.parse(row.payloadJson) as SessionInputPayload
          const cursor = consumed
          yield* Activity.make({
            name: `unified.session.send/${key}/${cursor}`,
            success: Schema.Void,
            execute: recorder.recordSend(key, input.payloadJson),
          })
          consumed += 1
          if (input.kind === "terminal") reachedTerminal = true
        }
      }

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
