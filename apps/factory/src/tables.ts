import { ParseResult, Schema } from "effect"
import type { SchemaAST } from "effect"
import {
  DurableTable,
  type DurableTableHeaders,
  type DurableTableLayerOptions,
  type DurableTableService,
} from "effect-durable-operators"
import { FactoryRunKeyStringSchema } from "./identity.ts"

const invalidKey = (
  ast: SchemaAST.AST,
  encoded: string,
  message: string,
) => ParseResult.fail(new ParseResult.Type(ast, encoded, message))

const parseTwoPartTuple = (
  encoded: string,
  ast: SchemaAST.AST,
) => {
  let parsed: unknown
  try {
    parsed = JSON.parse(encoded)
  } catch {
    return invalidKey(ast, encoded, "DarkFactoryFactKey is not valid JSON")
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) {
    return invalidKey(
      ast,
      encoded,
      "DarkFactoryFactKey must be a 2-item JSON tuple",
    )
  }
  const tuple = parsed as ReadonlyArray<unknown>
  const source = tuple[0]
  const externalEventKey = tuple[1]
  if (typeof source !== "string" || typeof externalEventKey !== "string") {
    return invalidKey(
      ast,
      encoded,
      "DarkFactoryFactKey tuple must be [source, externalEventKey]",
    )
  }
  return ParseResult.succeed([source, externalEventKey] as const)
}

export const DarkFactoryFactKeySchema = Schema.Tuple(
  Schema.String,
  Schema.String,
)
export type DarkFactoryFactKey = Schema.Schema.Type<
  typeof DarkFactoryFactKeySchema
>

export const DarkFactoryFactKeyEncoded = Schema.transformOrFail(
  Schema.String,
  DarkFactoryFactKeySchema,
  {
    strict: false,
    decode: (encoded, _options, ast) => parseTwoPartTuple(encoded, ast),
    encode: ([source, externalEventKey]) =>
      ParseResult.succeed(JSON.stringify([source, externalEventKey])),
  },
)

export const DarkFactoryTriggerSchema = Schema.Struct({
  source: Schema.String.pipe(Schema.minLength(1)),
  externalEventKey: Schema.String.pipe(Schema.minLength(1)),
  externalEntityKey: Schema.String.pipe(Schema.minLength(1)),
  eventType: Schema.String.pipe(Schema.minLength(1)),
  correlationId: Schema.optional(Schema.String.pipe(Schema.minLength(1))),
  repoHint: Schema.optional(Schema.String.pipe(Schema.minLength(1))),
  linear: Schema.optional(Schema.Struct({
    issueId: Schema.optional(Schema.String),
    identifier: Schema.optional(Schema.String),
    url: Schema.optional(Schema.String),
    title: Schema.optional(Schema.String),
    description: Schema.optional(Schema.String),
    state: Schema.optional(Schema.String),
  })),
  payload: Schema.optional(Schema.Unknown),
}).annotations({
  identifier: "firegrid.darkFactory.trigger",
  title: "Dark factory trigger",
})
export type DarkFactoryTrigger = Schema.Schema.Type<
  typeof DarkFactoryTriggerSchema
>

export const DarkFactoryFactSchema = Schema.Struct({
  factKey: DarkFactoryFactKeyEncoded.pipe(DurableTable.primaryKey),
  source: Schema.String,
  externalEventKey: Schema.String,
  externalEntityKey: Schema.String,
  eventType: Schema.String,
  factoryRunKey: Schema.optional(Schema.String),
  contextId: Schema.optional(Schema.String),
  correlationId: Schema.optional(Schema.String),
  createdAt: Schema.String,
  payload: Schema.Unknown,
})
export type DarkFactoryFact = Schema.Schema.Type<
  typeof DarkFactoryFactSchema
>

export const DarkFactoryRunStatusSchema = Schema.Literal(
  "accepted",
  "planner_started",
  "waiting_permission",
  "resumed",
  "done",
  "failed",
)
export type DarkFactoryRunStatus = Schema.Schema.Type<
  typeof DarkFactoryRunStatusSchema
>

export const DarkFactoryRunSchema = Schema.Struct({
  factoryRunKey: FactoryRunKeyStringSchema.pipe(DurableTable.primaryKey),
  subscriberId: Schema.String,
  source: Schema.String,
  externalEntityKey: Schema.String,
  plannerContextId: Schema.String,
  acceptedFactKey: DarkFactoryFactKeySchema,
  status: DarkFactoryRunStatusSchema,
  createdAt: Schema.String,
  updatedAt: Schema.String,
  correlationId: Schema.optional(Schema.String),
  repoHint: Schema.optional(Schema.String),
  linearIssueId: Schema.optional(Schema.String),
  linearIdentifier: Schema.optional(Schema.String),
  linearUrl: Schema.optional(Schema.String),
  lastPermissionRequestId: Schema.optional(Schema.String),
  lastRuntimeSequence: Schema.optional(Schema.Number),
})
export type DarkFactoryRun = Schema.Schema.Type<
  typeof DarkFactoryRunSchema
>

const darkFactorySchemas = {
  facts: DarkFactoryFactSchema,
  runs: DarkFactoryRunSchema,
} as const

export class DarkFactoryTable extends DurableTable(
  "darkFactory",
  darkFactorySchemas,
)<DarkFactoryTable>() {}

export type DarkFactoryTableService = DurableTableService<
  typeof darkFactorySchemas
>

interface DarkFactoryTableOptions {
  readonly streamUrl: string
  readonly headers?: DurableTableHeaders
  readonly txTimeoutMs?: number
}

export const darkFactoryTableLayerOptions = (
  options: DarkFactoryTableOptions,
): DurableTableLayerOptions => ({
  streamOptions: {
    url: options.streamUrl,
    contentType: "application/json",
    ...(options.headers === undefined ? {} : { headers: options.headers }),
  },
  txTimeoutMs: options.txTimeoutMs ?? 2_000,
})
