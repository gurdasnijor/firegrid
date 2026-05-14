// firegrid-host-context-authority.SCHEMA_STREAM_AUTHORITY.1
// firegrid-host-context-authority.SCHEMA_STREAM_AUTHORITY.2
// firegrid-host-context-authority.SCHEMA_STREAM_AUTHORITY.3
//
// Schema-encoded authority for host-owned Durable Streams prefixes.
//
// All product code that derives a host-owned stream URL goes through
// `Schema.encodeSync(HostStreamPrefixSchema)`. Layer constructors discover
// stream-authority fields via the `streamAuthority` annotation pipe so
// reviewers (and AST tests) can grep for "all stream authority fields"
// rather than scanning every layer constructor.

import { ParseResult, Schema, type SchemaAST } from "effect"

const streamAuthorityAnnotationId = Symbol.for(
  "@firegrid/protocol/launch/streamAuthority",
)

/**
 * Annotation pipe. Marks a Schema as carrying authority-bearing stream
 * fragment data so AST traversals can locate it without a separate
 * registry. Mirrors `DurableTable.primaryKey`'s annotation discipline.
 */
export const streamAuthority = <S extends Schema.Schema.Any>(schema: S): S =>
  schema.annotations({ [streamAuthorityAnnotationId]: true }) as S

export const isStreamAuthorityAst = (ast: SchemaAST.AST): boolean =>
  ast.annotations[streamAuthorityAnnotationId] === true

export const HostIdSchema = Schema.String.pipe(Schema.brand("HostId"))
export type HostId = Schema.Schema.Type<typeof HostIdSchema>

export const HostSessionIdSchema = Schema.String.pipe(Schema.brand("HostSessionId"))
export type HostSessionId = Schema.Schema.Type<typeof HostSessionIdSchema>

const HOST_STREAM_PREFIX_INFIX = ".firegrid.host."

/**
 * Structured form of a host stream prefix.
 *
 * A host stream prefix is an opaque wire string of shape
 * `${namespace}.firegrid.host.${hostId}`. The fixed infix makes the
 * decode lossless: `namespace` is everything before the last
 * occurrence of `.firegrid.host.` and `hostId` is everything after.
 *
 * Constraints:
 *  - namespace must be non-empty and must not itself contain
 *    `.firegrid.host.` (otherwise round-trip is ambiguous);
 *  - hostId must be a non-empty single segment (no `.`) so that
 *    operational suffixes (`.workflow`, `.runtimeIngress`, …) cannot
 *    collide with hostId byte sequences.
 */
export const HostStreamPrefixPartsSchema = Schema.Struct({
  namespace: Schema.String.pipe(
    Schema.filter((value) =>
      value.length > 0 && !value.includes(HOST_STREAM_PREFIX_INFIX)
        ? undefined
        : `host stream prefix namespace must be non-empty and not contain "${HOST_STREAM_PREFIX_INFIX}"`),
  ),
  hostId: HostIdSchema.pipe(
    Schema.filter((value) =>
      value.length > 0 && !value.includes(".")
        ? undefined
        : "host id must be a non-empty single segment with no '.'"),
  ),
})
export type HostStreamPrefixParts = Schema.Schema.Type<typeof HostStreamPrefixPartsSchema>

/**
 * Schema-encoded host stream prefix. Encoded side is `Schema.String`;
 * decoded side is `HostStreamPrefixPartsSchema`.
 *
 * The transform is the only sanctioned path between the structured
 * `{namespace, hostId}` shape and the wire string. Product code that
 * needs a wire string MUST go through `Schema.encodeSync` on this
 * schema (typically via the `makeHostStreamPrefix` helper below); the
 * fixed `.firegrid.host.` infix is not exported, and inline template
 * literals at use sites are forbidden.
 */
export const HostStreamPrefixSchema = Schema.transformOrFail(
  Schema.String,
  HostStreamPrefixPartsSchema,
  {
    strict: false,
    decode: (encoded, _options, ast) => {
      const idx = encoded.lastIndexOf(HOST_STREAM_PREFIX_INFIX)
      if (idx <= 0 || idx + HOST_STREAM_PREFIX_INFIX.length >= encoded.length) {
        return ParseResult.fail(
          new ParseResult.Type(
            ast,
            encoded,
            `host stream prefix must match {namespace}${HOST_STREAM_PREFIX_INFIX}{hostId}`,
          ),
        )
      }
      const namespace = encoded.slice(0, idx)
      const hostId = encoded.slice(idx + HOST_STREAM_PREFIX_INFIX.length)
      return ParseResult.succeed({
        namespace,
        hostId: hostId as HostId,
      })
    },
    encode: ({ namespace, hostId }) =>
      ParseResult.succeed(`${namespace}${HOST_STREAM_PREFIX_INFIX}${hostId}`),
  },
).pipe(streamAuthority)

/**
 * Wire-form (encoded) host stream prefix string. This is the type used
 * inside durable row schemas — durable rows hold the wire string, not
 * the parts struct, because @durable-streams/state validates rows by
 * Standard Schema decode and JSON-serializes the supplied value as-is.
 */
export type HostStreamPrefix = Schema.Schema.Encoded<typeof HostStreamPrefixSchema>

/**
 * Schema for the wire-form host stream prefix as it appears on rows.
 *
 * Layer constructors read this string off `CurrentHostSession` and
 * `RuntimeContext.host` and compose host-owned stream names via
 * `hostStreamName(...)`. The streamAuthority annotation marks the field
 * so reviewers and AST checks can locate it.
 */
export const HostStreamPrefixWireSchema = Schema.String.pipe(streamAuthority)

/**
 * Construct a host stream prefix wire string from structured parts.
 *
 * Validates the parts (namespace non-empty + infix-free, hostId
 * non-empty + dot-free) via the schema. Throws synchronously on
 * invalid parts; callers building a HostSessionRow should already have
 * validated identities, but the throw is intentional to surface
 * authority drift loudly.
 */
export const makeHostStreamPrefix = (
  parts: HostStreamPrefixParts,
): HostStreamPrefix => Schema.encodeSync(HostStreamPrefixSchema)(parts)

/**
 * Operational stream segments that derive from a host stream prefix.
 *
 * V1 enumerates the segments the proposal calls out. The closed set
 * keeps stream naming under schema authority and lets reviewers see
 * exactly which operational planes belong to a host.
 */
export type HostStreamSegment =
  | "runtimeIngress"
  | "runtimeOutput"
  | "workflow"
  | "durableTools"

/**
 * Append an operational segment to a host stream prefix, producing the
 * full host-owned stream name (e.g.
 * `firegrid-smoke.firegrid.host.host_abc.workflow`).
 *
 * This is the single sanctioned path from a host stream prefix to a
 * concrete stream name. Layer constructors that compose stream URLs
 * call this helper rather than concatenating strings inline.
 */
export const hostStreamName = (
  prefix: HostStreamPrefix,
  segment: HostStreamSegment,
): string => `${prefix}.${segment}`

/**
 * Global runtime control-plane stream name for a namespace. The
 * RuntimeContext index remains namespace-scoped, not host-scoped, so
 * cross-host context lookup does not depend on host directory state.
 */
export const namespaceRuntimeStreamName = (namespace: string): string =>
  `${namespace}.firegrid.runtime`

/**
 * Conceptual host session row. V1 does not persist a HostSession
 * durable table; the row is constructed at host boot and provided
 * through `CurrentHostSession`. Schema metadata still lives here so
 * future durable host directory work can adopt the same field shape
 * without renumbering.
 */
export const HostSessionRowSchema = Schema.Struct({
  hostId: HostIdSchema,
  hostSessionId: HostSessionIdSchema,
  status: Schema.Literal("running", "stopped"),
  startedAtMs: Schema.Number,
  streamPrefix: HostStreamPrefixWireSchema,
})
export type HostSessionRow = Schema.Schema.Type<typeof HostSessionRowSchema>

/**
 * RuntimeContext host binding. Carries the host id, the host-owned
 * stream prefix copied from the owning host session, and the bind
 * timestamp. `streamPrefix` is intentionally denormalized: a context
 * row is self-sufficient for prompt routing and MCP local-context
 * checks without joining through a host directory.
 */
export const RuntimeContextHostBindingSchema = Schema.Struct({
  hostId: HostIdSchema,
  streamPrefix: HostStreamPrefixWireSchema,
  boundAtMs: Schema.Number,
})
export type RuntimeContextHostBinding = Schema.Schema.Type<
  typeof RuntimeContextHostBindingSchema
>

/**
 * Build a HostSessionRow from inputs the host runtime owns. The
 * constructor goes through `makeHostStreamPrefix` so the wire string
 * comes from `HostStreamPrefixSchema` rather than from an inline
 * template literal at the call site.
 */
export const makeHostSessionRow = (input: {
  readonly hostId: HostId
  readonly hostSessionId: HostSessionId
  readonly namespace: string
  readonly startedAtMs: number
}): HostSessionRow => ({
  hostId: input.hostId,
  hostSessionId: input.hostSessionId,
  status: "running",
  startedAtMs: input.startedAtMs,
  streamPrefix: makeHostStreamPrefix({
    namespace: input.namespace,
    hostId: input.hostId,
  }),
})
