/**
 * Composite primary key for verified webhook facts.
 *
 * Implements:
 *  - firegrid-verified-webhook-ingest.FACTS.2
 */

import { ParseResult, Schema } from "effect"
import type { SchemaAST } from "effect"
import { VerifiedWebhookFactKeySchema } from "@firegrid/protocol/verified-webhook"

export {
  VerifiedWebhookFactKeySchema,
  type VerifiedWebhookFactKey,
} from "@firegrid/protocol/verified-webhook"

const invalidFactKey = (
  ast: SchemaAST.AST,
  encoded: string,
  message: string,
) => ParseResult.fail(new ParseResult.Type(ast, encoded, message))

const parseJsonTuple = (
  encoded: string,
  ast: SchemaAST.AST,
) => {
  let parsed: unknown
  try {
    parsed = JSON.parse(encoded)
  } catch {
    return invalidFactKey(ast, encoded, "VerifiedWebhookFactKey is not valid JSON")
  }
  if (!Array.isArray(parsed) || parsed.length !== 2) {
    return invalidFactKey(
      ast,
      encoded,
      "VerifiedWebhookFactKey must be a 2-item JSON tuple",
    )
  }
  return ParseResult.succeed(parsed as ReadonlyArray<unknown>)
}

export const VerifiedWebhookFactKeyEncoded = Schema.transformOrFail(
  Schema.String,
  VerifiedWebhookFactKeySchema,
  {
    strict: false,
    decode: (encoded: string, _options, ast) =>
      ParseResult.flatMap(parseJsonTuple(encoded, ast), (parts) => {
        const source = parts[0]
        const externalEventKey = parts[1]
        if (typeof source !== "string" || typeof externalEventKey !== "string") {
          return invalidFactKey(
            ast,
            encoded,
            "VerifiedWebhookFactKey tuple must be [source, externalEventKey] of strings",
          )
        }
        return ParseResult.succeed([source, externalEventKey])
      }),
    encode: ([source, externalEventKey]) =>
      ParseResult.succeed(JSON.stringify([source, externalEventKey])),
  },
)
