import { Workflow } from "@effect/workflow"
import { Effect, Exit, Schema } from "effect"

export const decodeWorkflowResult = (
  workflow: Workflow.Any,
  value: unknown,
): Effect.Effect<Workflow.Result<unknown, unknown>> =>
  Schema.decodeUnknown(Workflow.Result({
    success: workflow.successSchema,
    error: workflow.errorSchema,
  }))(value) as Effect.Effect<Workflow.Result<unknown, unknown>>

export const encodeWorkflowResult = (
  workflow: Workflow.Any,
  value: Workflow.Result<unknown, unknown>,
): Effect.Effect<unknown> =>
  Schema.encode(Workflow.Result({
    success: workflow.successSchema,
    error: workflow.errorSchema,
  }))(value as never) as Effect.Effect<unknown>

export const reviveExit = (value: unknown): Exit.Exit<unknown, unknown> => {
  const record = value as { _tag?: string; value?: unknown }
  if (record?._tag === "Success") return Exit.succeed(record.value)
  return value as Exit.Exit<unknown, unknown>
}

export const reviveEncodedResult = (value: unknown): Workflow.Result<unknown, unknown> => {
  const record = value as { _tag?: string; exit?: unknown }
  if (record._tag === "Suspended") {
    return new Workflow.Suspended({})
  }
  if (record._tag === "Complete") {
    return new Workflow.Complete({ exit: reviveExit(record.exit) })
  }
  return value as Workflow.Result<unknown, unknown>
}
