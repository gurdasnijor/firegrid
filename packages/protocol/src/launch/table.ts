import { DurableTable, type DurableTableService } from "effect-durable-operators"
import { ParseResult, Schema } from "effect"
import type { Either, SchemaAST } from "effect"
import {
  RuntimeInputIntentRowSchema,
} from "../runtime-ingress/schema.ts"
import {
  RuntimeControlRequestClaimRowSchema,
  RuntimeControlRequestCompletionRowSchema,
  RuntimeContextRequestRowSchema,
  RuntimeStartRequestRowSchema,
} from "./control-request.ts"
import {
  RuntimeContextIntentSchema,
  RuntimeOutputEventKeySchema,
  RuntimeOutputLogLineKeySchema,
  RuntimeRunEventKeySchema,
  runtimeEventFields,
  runtimeLogLineFields,
  runtimeRunEventFields,
  type RuntimeContext,
} from "./schema.ts"
import { RuntimeContextHostBindingSchema } from "./authority.ts"

const invalidPrimaryKey = (ast: SchemaAST.AST, encoded: string, message: string) =>
  ParseResult.fail(new ParseResult.Type(ast, encoded, message))

const isUnknownArray = (value: unknown): value is ReadonlyArray<unknown> =>
  Array.isArray(value)

const parsePrimaryKeyTuple = (
  encoded: string,
  arity: number,
  ast: SchemaAST.AST,
): Either.Either<ReadonlyArray<unknown>, ParseResult.ParseIssue> => {
  let parsed: unknown
  try {
    parsed = JSON.parse(encoded)
  } catch {
    return invalidPrimaryKey(ast, encoded, "primary key is not valid JSON")
  }
  if (!isUnknownArray(parsed) || parsed.length !== arity) {
    return invalidPrimaryKey(ast, encoded, `primary key must be a ${arity}-item JSON tuple`)
  }
  return ParseResult.succeed(parsed)
}

const isFiniteNumber = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value)

const decodeRuntimeOutputPrimaryKey = <Target extends "events" | "logs">(
  encoded: string,
  ast: SchemaAST.AST,
  expectedTarget: Target,
  message: string,
) =>
  ParseResult.flatMap(parsePrimaryKeyTuple(encoded, 4, ast), (parts) => {
    const contextId = parts[0]
    const activityAttempt = parts[1]
    const target = parts[2]
    const sequence = parts[3]
    if (
      typeof contextId !== "string" ||
      !isFiniteNumber(activityAttempt) ||
      target !== expectedTarget ||
      !isFiniteNumber(sequence)
    ) {
      return invalidPrimaryKey(ast, encoded, message)
    }
    return ParseResult.succeed({
      contextId,
      activityAttempt,
      target: expectedTarget,
      sequence,
    })
  })

const encodeRuntimeOutputPrimaryKey = (
  key: {
    readonly contextId: string
    readonly activityAttempt: number
    readonly target: "events" | "logs"
    readonly sequence: number
  },
) =>
  ParseResult.succeed(JSON.stringify([
    key.contextId,
    key.activityAttempt,
    key.target,
    key.sequence,
  ]))

const RuntimeRunEventPrimaryKeySchema = Schema.transformOrFail(
  Schema.String,
  RuntimeRunEventKeySchema,
  {
    strict: false,
    decode: (encoded: string, _options, ast) =>
      ParseResult.flatMap(parsePrimaryKeyTuple(encoded, 3, ast), (parts) => {
        const contextId = parts[0]
        const activityAttempt = parts[1]
        const status = parts[2]
        if (
          typeof contextId !== "string" ||
          !isFiniteNumber(activityAttempt) ||
          (status !== "started" && status !== "exited" && status !== "failed")
        ) {
          return invalidPrimaryKey(ast, encoded, "primary key tuple does not match RuntimeRunEventKey")
        }
        return ParseResult.succeed({
          contextId,
          activityAttempt,
          status,
        })
      }),
    encode: ({ contextId, activityAttempt, status }) =>
      ParseResult.succeed(JSON.stringify([contextId, activityAttempt, status])),
  },
)

const RuntimeOutputEventPrimaryKeySchema = Schema.transformOrFail(
  Schema.String,
  RuntimeOutputEventKeySchema,
  {
    strict: false,
    decode: (encoded: string, _options, ast) =>
      decodeRuntimeOutputPrimaryKey(
        encoded,
        ast,
        "events",
        "primary key tuple does not match RuntimeOutputEventKey",
      ),
    encode: encodeRuntimeOutputPrimaryKey,
  },
)

const RuntimeOutputLogLinePrimaryKeySchema = Schema.transformOrFail(
  Schema.String,
  RuntimeOutputLogLineKeySchema,
  {
    strict: false,
    decode: (encoded: string, _options, ast) =>
      decodeRuntimeOutputPrimaryKey(
        encoded,
        ast,
        "logs",
        "primary key tuple does not match RuntimeOutputLogLineKey",
      ),
    encode: encodeRuntimeOutputPrimaryKey,
  },
)

// firegrid-host-context-authority.RUNTIME_CONTEXT_HOST_AUTHORITY.1
// firegrid-host-context-authority.RUNTIME_CONTEXT_HOST_AUTHORITY.4
//
// Durable RuntimeContext rows carry the host binding inline so context
// lookup yields a row that is self-sufficient for prompt-routing and
// MCP local-context checks without joining through a host directory.
const RuntimeContextRowSchema = Schema.Struct({
  contextId: Schema.String.pipe(DurableTable.primaryKey),
  createdAt: Schema.String,
  createdBy: Schema.optional(Schema.String),
  runtime: RuntimeContextIntentSchema,
  host: RuntimeContextHostBindingSchema,
})

const RuntimeRunEventRowSchema = Schema.Struct({
  ...runtimeRunEventFields,
  runEventId: RuntimeRunEventPrimaryKeySchema.pipe(DurableTable.primaryKey),
})

const runtimeControlPlaneSchemas = {
  contexts: RuntimeContextRowSchema,
  runs: RuntimeRunEventRowSchema,
  inputIntents: RuntimeInputIntentRowSchema,
  contextRequests: RuntimeContextRequestRowSchema,
  startRequests: RuntimeStartRequestRowSchema,
  controlRequestClaims: RuntimeControlRequestClaimRowSchema,
  controlRequestCompletions: RuntimeControlRequestCompletionRowSchema,
} as const

const RuntimeEventRowSchema = Schema.Struct({
  ...runtimeEventFields,
  eventId: RuntimeOutputEventPrimaryKeySchema.pipe(DurableTable.primaryKey),
})

const RuntimeLogLineRowSchema = Schema.Struct({
  ...runtimeLogLineFields,
  logLineId: RuntimeOutputLogLinePrimaryKeySchema.pipe(DurableTable.primaryKey),
})

const runtimeOutputSchemas = {
  events: RuntimeEventRowSchema,
  logs: RuntimeLogLineRowSchema,
} as const

export class RuntimeControlPlaneTable extends DurableTable<RuntimeControlPlaneTable>()(
  "firegrid.runtime",
  runtimeControlPlaneSchemas,
) {}

export class RuntimeOutputTable extends DurableTable<RuntimeOutputTable>()(
  "firegrid.runtimeOutput",
  runtimeOutputSchemas,
) {}

export type RuntimeControlPlaneTableService = DurableTableService<typeof runtimeControlPlaneSchemas>
export type RuntimeOutputTableService = DurableTableService<typeof runtimeOutputSchemas>
export type RuntimeContextRow = RuntimeContext
export type RuntimeInputIntentRow = Schema.Schema.Type<typeof RuntimeInputIntentRowSchema>
export type RuntimeRunEventRow = Schema.Schema.Type<typeof RuntimeRunEventRowSchema>
export type RuntimeContextRequestRow = Schema.Schema.Type<typeof RuntimeContextRequestRowSchema>
export type RuntimeStartRequestRow = Schema.Schema.Type<typeof RuntimeStartRequestRowSchema>
export type RuntimeControlRequestClaimRow = Schema.Schema.Type<typeof RuntimeControlRequestClaimRowSchema>
export type RuntimeControlRequestCompletionRow = Schema.Schema.Type<typeof RuntimeControlRequestCompletionRowSchema>
export type RuntimeEventRow = Schema.Schema.Type<typeof RuntimeEventRowSchema>
export type RuntimeLogLineRow = Schema.Schema.Type<typeof RuntimeLogLineRowSchema>
