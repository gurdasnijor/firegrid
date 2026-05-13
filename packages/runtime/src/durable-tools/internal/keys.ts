/**
 * Composite primary key encoding for durable-tools tables.
 *
 * Implements:
 *  - firegrid-durable-tools.BOUNDARIES.6 — Schema.transformOrFail to a JSON
 *    tuple, with ParseResult.fail on malformed input. Mirrors the strict
 *    composite-key pattern in `packages/protocol/src/launch/table.ts`. The
 *    `RuntimeInputDeliveryKey` separator pattern is intentionally not
 *    extended here.
 */

import { ParseResult, Schema } from "effect"
import type { SchemaAST } from "effect"

const invalidWaitKey = (
  ast: SchemaAST.AST,
  encoded: string,
  message: string,
) => ParseResult.fail(new ParseResult.Type(ast, encoded, message))

const parseJsonTuple = (
  encoded: string,
  arity: number,
  ast: SchemaAST.AST,
) => {
  let parsed: unknown
  try {
    parsed = JSON.parse(encoded)
  } catch {
    return invalidWaitKey(ast, encoded, "WaitKey is not valid JSON")
  }
  if (!Array.isArray(parsed) || parsed.length !== arity) {
    return invalidWaitKey(
      ast,
      encoded,
      `WaitKey must be a ${arity}-item JSON tuple`,
    )
  }
  return ParseResult.succeed(parsed as ReadonlyArray<unknown>)
}

export const WaitKeySchema = Schema.Struct({
  executionId: Schema.String,
  name: Schema.String,
})
export type WaitKey = Schema.Schema.Type<typeof WaitKeySchema>

export const WaitKeyEncoded = Schema.transformOrFail(
  Schema.String,
  WaitKeySchema,
  {
    strict: false,
    decode: (encoded: string, _options, ast) =>
      ParseResult.flatMap(parseJsonTuple(encoded, 2, ast), (parts) => {
        const executionId = parts[0]
        const name = parts[1]
        if (typeof executionId !== "string" || typeof name !== "string") {
          return invalidWaitKey(
            ast,
            encoded,
            "WaitKey tuple must be [executionId, name] of strings",
          )
        }
        return ParseResult.succeed({ executionId, name })
      }),
    encode: ({ executionId, name }) =>
      ParseResult.succeed(JSON.stringify([executionId, name])),
  },
)
