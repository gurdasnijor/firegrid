import { WorkflowEngine } from "@effect/workflow"
import type { RuntimeContext } from "@firegrid/protocol/launch"
import {
  RuntimeIngressInputRowSchema,
  makeRuntimeIngressInputRow,
  type RuntimeIngressInputRow,
  type RuntimeIngressRequest,
} from "@firegrid/protocol/runtime-ingress"
import type { RowOtelContext } from "@firegrid/protocol/otel"
import {
  WorkflowEngineTable,
} from "@firegrid/runtime/workflow-engine"
import { Cause, Clock, Effect, Either, Exit, Match, Schema } from "effect"
import {
  runtimeContextWorkflowExecutionId,
} from "./internal/runtime-context-helpers.ts"
import {
  RuntimeContextWorkflowNative,
  runtimeInputDeferredFor,
  runtimeInputDeferredName,
} from "./runtime-context-workflow-core.ts"

const workflowEngineTable: Effect.Effect<
  WorkflowEngineTable["Type"],
  never,
  WorkflowEngineTable
> = WorkflowEngineTable

const workflowEngine: Effect.Effect<
  WorkflowEngine.WorkflowEngine["Type"],
  never,
  WorkflowEngine.WorkflowEngine
> = WorkflowEngine.WorkflowEngine

const reviveExit = (value: unknown): Exit.Exit<unknown, unknown> => {
  const record = value as {
    readonly _tag?: string
    readonly value?: unknown
    readonly cause?: unknown
  }
  if (record?._tag === "Success") return Exit.succeed(record.value)
  if (record?._tag === "Failure") {
    const cause = record.cause as {
      readonly _tag?: string
      readonly failure?: unknown
      readonly defect?: unknown
    }
    return Exit.failCause(
      cause?._tag === "Fail"
        ? Cause.fail(cause.failure)
        : cause?._tag === "Die"
        ? Cause.die(cause.defect)
        : record.cause as Cause.Cause<unknown>,
    )
  }
  return value as Exit.Exit<unknown, unknown>
}

const decodeStoredInputRow = (
  value: unknown,
): ReadonlyArray<RuntimeIngressInputRow> =>
  Exit.match(reviveExit(value), {
    onFailure: () => [],
    onSuccess: success =>
      Match.value(Schema.decodeUnknownEither(RuntimeIngressInputRowSchema)(success)).pipe(
        Match.when(Either.isRight, decoded => [decoded.right]),
        Match.orElse(() => []),
      ),
  })

const runtimeInputRowsForContext = (
  table: WorkflowEngineTable["Type"],
  contextId: string,
): Effect.Effect<ReadonlyArray<RuntimeIngressInputRow>, unknown> =>
  table.deferreds.query((coll) =>
    coll.toArray
      .filter(row =>
        row.executionId === runtimeContextWorkflowExecutionId(contextId) &&
        row.deferredName.startsWith(`runtime-context/${contextId}/input/`))
      .flatMap(row => decodeStoredInputRow(row.exit))
      .filter(row => row.contextId === contextId)).pipe(
        Effect.withSpan("firegrid.host.runtime_input.deferred.rows_for_context", {
          kind: "internal",
          attributes: {
            "firegrid.context.id": contextId,
          },
        }),
      )

export const appendRuntimeInputDeferred = (
  request: RuntimeIngressRequest,
  context: RuntimeContext,
  // Optional trace context propagated from the originating intent row. The
  // sequencer copies it onto the sequenced ingress row so the reactive_loop
  // input handler can parent back to the client.prompt producer span.
  intentOtel?: RowOtelContext,
): Effect.Effect<
  RuntimeIngressInputRow,
  Error,
  WorkflowEngine.WorkflowEngine | WorkflowEngineTable
> => {
  const append: Effect.Effect<
    RuntimeIngressInputRow,
    Error,
    WorkflowEngine.WorkflowEngine | WorkflowEngineTable
  > = Effect.gen(function*() {
    const pending = makeRuntimeIngressInputRow(request)
    if (pending.contextId !== context.contextId) {
      return yield* Effect.fail(new Error(
        `runtime ingress context mismatch: expected ${context.contextId}, got ${pending.contextId}`,
      ))
    }

    const table = yield* workflowEngineTable
    const existingRows = yield* runtimeInputRowsForContext(table, context.contextId)
    const existing = existingRows.find(row => row.inputId === pending.inputId)
    if (existing !== undefined) return existing

    const nextSequence = existingRows.reduce(
      (max, row) =>
        row.sequence === undefined ? max : Math.max(max, row.sequence + 1),
      0,
    )
    const sequenced: RuntimeIngressInputRow = {
      ...pending,
      status: "sequenced",
      sequence: nextSequence,
      sequencedAt: new Date(yield* Clock.currentTimeMillis).toISOString(),
      ...(intentOtel === undefined ? {} : { _otel: intentOtel }),
    }
    const engine = yield* workflowEngine
    const deferredName = runtimeInputDeferredName(context.contextId, nextSequence)
    yield* engine.deferredDone(
      runtimeInputDeferredFor(context.contextId, nextSequence),
      {
        workflowName: RuntimeContextWorkflowNative.name,
        executionId: runtimeContextWorkflowExecutionId(context.contextId),
        deferredName,
        exit: Exit.succeed(sequenced),
      },
    )
    yield* Effect.annotateCurrentSpan({
      "firegrid.input.sequence": nextSequence,
    })
    return sequenced
  }).pipe(
    Effect.mapError(cause =>
      cause instanceof Error
        ? cause
        : new Error("failed appending runtime input deferred", { cause })),
    Effect.withSpan("firegrid.host.runtime_input.deferred.append", {
      kind: "internal",
      attributes: {
        "firegrid.context.id": context.contextId,
        "firegrid.input.id": request.inputId,
      },
    }),
  )
  return append
}
