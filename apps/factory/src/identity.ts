import { ParseResult, Schema } from "effect"
import type { SchemaAST } from "effect"

const invalidKey = (
  ast: SchemaAST.AST,
  encoded: string,
  message: string,
) => ParseResult.fail(new ParseResult.Type(ast, encoded, message))

const isTwoPartTuple = (
  value: unknown,
): value is readonly [unknown, unknown] =>
  Array.isArray(value) && value.length === 2

const parseTwoStringTuple = (
  encoded: string,
  ast: SchemaAST.AST,
  keyName: string,
) => {
  let parsed: unknown
  try {
    parsed = JSON.parse(encoded)
  } catch {
    return invalidKey(ast, encoded, `${keyName} is not valid JSON`)
  }
  if (!isTwoPartTuple(parsed)) {
    return invalidKey(ast, encoded, `${keyName} must be a 2-item JSON tuple`)
  }
  const first = parsed[0]
  const second = parsed[1]
  if (typeof first !== "string" || typeof second !== "string") {
    return invalidKey(ast, encoded, `${keyName} tuple parts must be strings`)
  }
  return ParseResult.succeed([first, second] as const)
}

const idSuffixFromCanonicalKey = (encodedKey: string): string =>
  Buffer.from(encodedKey, "utf8").toString("base64url")

const FactoryRunKeyPartsSchema = Schema.Tuple(
  Schema.String,
  Schema.String,
)

export const FactoryRunKeySchema = Schema.transformOrFail(
  Schema.String,
  FactoryRunKeyPartsSchema,
  {
    strict: false,
    decode: (encoded, _options, ast) =>
      parseTwoStringTuple(encoded, ast, "FactoryRunKey"),
    encode: ([source, externalEntityKey]) =>
      ParseResult.succeed(JSON.stringify([source, externalEntityKey])),
  },
)

const isCanonicalFactoryRunKey = (encoded: string): boolean => {
  const decoded = Schema.decodeUnknownEither(FactoryRunKeySchema)(encoded)
  if (decoded._tag === "Left") return false
  return Schema.encodeSync(FactoryRunKeySchema)(decoded.right) === encoded
}

export const FactoryRunKeyStringSchema = Schema.String.pipe(
  Schema.filter(encoded =>
    isCanonicalFactoryRunKey(encoded)
      ? undefined
      : "FactoryRunKey must be the canonical encoded tuple"),
)

const PermissionResolutionKeyPartsSchema = Schema.Tuple(
  Schema.String,
  Schema.String,
)

export const PermissionResolutionKeySchema = Schema.transformOrFail(
  Schema.String,
  PermissionResolutionKeyPartsSchema,
  {
    strict: false,
    decode: (encoded, _options, ast) =>
      parseTwoStringTuple(encoded, ast, "PermissionResolutionKey"),
    encode: ([contextId, permissionRequestId]) =>
      ParseResult.succeed(JSON.stringify([contextId, permissionRequestId])),
  },
)

export const factoryRunIdentityFor = (input: {
  readonly source: string
  readonly externalEntityKey: string
}) => {
  const factoryRunKey = Schema.encodeSync(FactoryRunKeySchema)([
    input.source,
    input.externalEntityKey,
  ])
  const suffix = idSuffixFromCanonicalKey(factoryRunKey)
  return {
    factoryRunKey,
    subscriberId: `dark-factory:${suffix}`,
    plannerContextId: `ctx_factory_${suffix}`,
  }
}

export const permissionResolutionIdentityFor = (input: {
  readonly contextId: string
  readonly permissionRequestId: string
}) => {
  const externalEventKey = Schema.encodeSync(PermissionResolutionKeySchema)([
    input.contextId,
    input.permissionRequestId,
  ])
  return {
    factKey: ["darkFactory.permission", externalEventKey] as const,
    externalEventKey,
    inputId: `dark-factory:permission:${idSuffixFromCanonicalKey(externalEventKey)}`,
  }
}
