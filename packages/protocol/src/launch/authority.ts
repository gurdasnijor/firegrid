// firegrid-host-context-authority.SCHEMA_STREAM_AUTHORITY.1
// firegrid-host-context-authority.SCHEMA_STREAM_AUTHORITY.2
// firegrid-host-context-authority.SCHEMA_STREAM_AUTHORITY.3
//
// Schema-encoded authority for host-owned Durable Streams prefixes,
// stream names, and URLs. One canonical Schema per authority string;
// helper functions are `Schema.encodeSync` wrappers — never independent
// template-literal constructors. The `streamAuthority` annotation pipe
// marks each schema so AST traversals can locate authority-bearing
// fields, mirroring `DurableTable.primaryKey`'s annotation discipline.

import { ParseResult, Schema, type SchemaAST } from "effect"

const streamAuthorityAnnotationId = Symbol.for(
  "@firegrid/protocol/launch/streamAuthority",
)

export const streamAuthority = <S extends Schema.Schema.Any>(schema: S): S =>
  schema.annotations({ [streamAuthorityAnnotationId]: true }) as S

export const isStreamAuthorityAst = (ast: SchemaAST.AST): boolean =>
  ast.annotations[streamAuthorityAnnotationId] === true

export const HostIdSchema = Schema.String.pipe(Schema.brand("HostId"))
export type HostId = Schema.Schema.Type<typeof HostIdSchema>

export const HostSessionIdSchema = Schema.String.pipe(Schema.brand("HostSessionId"))
export type HostSessionId = Schema.Schema.Type<typeof HostSessionIdSchema>

const HOST_STREAM_PREFIX_INFIX = ".firegrid.host."
const FIREGRID_DURABLE_NAMESPACE = "firegrid"
const RUNTIME_TABLE_NAME = "runtime"
const STREAM_PATH_INFIX = "/v1/stream/"

/**
 * Operational stream segments that derive from a host stream prefix.
 * Closed `Schema.Literal` set; `HostStreamNameSchema` decodes through
 * this schema rather than maintaining a parallel array of strings.
 */
export const HostStreamSegmentSchema = Schema.Literal(
  "runtimeIngress",
  "runtimeOutput",
  "workflow",
  "durableTools",
)
export type HostStreamSegment = Schema.Schema.Type<typeof HostStreamSegmentSchema>

/**
 * `${namespace}.firegrid.host.${hostId}` wire form, validated +
 * branded. Single canonical authority declaration for the host stream
 * prefix: rows hold this branded string, layer constructors read it
 * off `CurrentHostSession`, and the `streamAuthority` annotation
 * marks the schema for AST discovery.
 *
 * Format constraints (single source — the filter):
 *  - the wire string MUST contain `.firegrid.host.` exactly once;
 *  - namespace (left of the infix) MUST be non-empty;
 *  - hostId (right of the infix) MUST be non-empty and dot-free so
 *    operational segments like `.workflow` cannot collide.
 */
const validateHostStreamPrefixWire = (
  value: string,
): string | undefined => {
  const first = value.indexOf(HOST_STREAM_PREFIX_INFIX)
  if (first <= 0) {
    return `host stream prefix must contain "${HOST_STREAM_PREFIX_INFIX}" with a non-empty namespace prefix`
  }
  const last = value.lastIndexOf(HOST_STREAM_PREFIX_INFIX)
  if (first !== last) {
    return `host stream prefix must contain "${HOST_STREAM_PREFIX_INFIX}" exactly once`
  }
  const hostId = value.slice(last + HOST_STREAM_PREFIX_INFIX.length)
  if (hostId.length === 0) {
    return "host stream prefix hostId must be non-empty"
  }
  if (hostId.includes(".")) {
    return "host stream prefix hostId must be a single dot-free segment"
  }
  return undefined
}

export const HostStreamPrefixWireSchema = Schema.String.pipe(
  Schema.filter(validateHostStreamPrefixWire),
  Schema.brand("HostStreamPrefix"),
  streamAuthority,
)
export type HostStreamPrefix = Schema.Schema.Type<typeof HostStreamPrefixWireSchema>

const HostStreamPrefixPartsSchema = Schema.Struct({
  namespace: Schema.String,
  hostId: HostIdSchema,
})
type HostStreamPrefixParts = Schema.Schema.Type<typeof HostStreamPrefixPartsSchema>

/**
 * Bidirectional codec between the branded wire form and structured
 * `{namespace, hostId}` parts. `Schema.encodeSync` on this schema is
 * the only sanctioned path from parts to wire — `makeHostStreamPrefix`
 * is the public wrapper.
 */
export const HostStreamPrefixSchema = Schema.transformOrFail(
  HostStreamPrefixWireSchema,
  HostStreamPrefixPartsSchema,
  {
    strict: false,
    decode: (validated) => {
      const idx = validated.indexOf(HOST_STREAM_PREFIX_INFIX)
      return ParseResult.succeed({
        namespace: validated.slice(0, idx),
        hostId: validated.slice(idx + HOST_STREAM_PREFIX_INFIX.length) as HostId,
      })
    },
    encode: ({ namespace, hostId }) =>
      ParseResult.succeed(
        `${namespace}${HOST_STREAM_PREFIX_INFIX}${hostId}` as HostStreamPrefix,
      ),
  },
).pipe(streamAuthority)

/** Encode parts → branded wire host stream prefix. */
export const makeHostStreamPrefix = (
  parts: HostStreamPrefixParts,
): HostStreamPrefix =>
  // `Schema.encodeSync(HostStreamPrefixSchema)` returns the encoded
  // form of the composed transform, which TypeScript widens to
  // `string`. Re-decode through the branded wire schema to recover
  // the brand without duplicating the validator.
  Schema.decodeSync(HostStreamPrefixWireSchema)(
    Schema.encodeSync(HostStreamPrefixSchema)(parts),
  )

const HostStreamNamePartsSchema = Schema.Struct({
  prefix: HostStreamPrefixWireSchema,
  segment: HostStreamSegmentSchema,
})

/**
 * Bidirectional codec for `${prefix}.${segment}` host-owned stream
 * names. Decode parses the last dot, decodes the right-hand side
 * through `HostStreamSegmentSchema`, and decodes the left-hand side
 * through `HostStreamPrefixWireSchema` — no parallel segment array.
 */
const HOST_STREAM_SEGMENT_LITERALS = HostStreamSegmentSchema.literals

export const HostStreamNameSchema = Schema.transformOrFail(
  Schema.String,
  HostStreamNamePartsSchema,
  {
    strict: false,
    decode: (encoded, _options, ast) => {
      const dot = encoded.lastIndexOf(".")
      if (dot <= 0 || dot === encoded.length - 1) {
        return ParseResult.fail(
          new ParseResult.Type(
            ast,
            encoded,
            "host stream name must be {prefix}.{segment}",
          ),
        )
      }
      const prefixWire = encoded.slice(0, dot)
      const segmentWire = encoded.slice(dot + 1)
      const segmentMatch = HOST_STREAM_SEGMENT_LITERALS.find(
        (candidate) => candidate === segmentWire,
      )
      if (segmentMatch === undefined) {
        return ParseResult.fail(
          new ParseResult.Type(
            ast,
            encoded,
            "host stream name segment is not one of the supported literals",
          ),
        )
      }
      const prefixValidation = validateHostStreamPrefixWire(prefixWire)
      if (prefixValidation !== undefined) {
        return ParseResult.fail(
          new ParseResult.Type(ast, encoded, prefixValidation),
        )
      }
      return ParseResult.succeed({
        prefix: prefixWire as HostStreamPrefix,
        segment: segmentMatch,
      })
    },
    encode: ({ prefix, segment }) =>
      ParseResult.succeed(`${prefix}.${segment}`),
  },
).pipe(streamAuthority)

/** Encode parts → host-owned stream name. */
export const hostStreamName = (
  prefix: HostStreamPrefix,
  segment: HostStreamSegment,
): string => Schema.encodeSync(HostStreamNameSchema)({ prefix, segment })

const NAMESPACE_RUNTIME_SUFFIX = `.${FIREGRID_DURABLE_NAMESPACE}.${RUNTIME_TABLE_NAME}`

const NamespaceRuntimeStreamNamePartsSchema = Schema.Struct({
  namespace: Schema.String.pipe(
    Schema.filter((value) =>
      value.length > 0 ? undefined : "namespace must be non-empty"),
  ),
})

/**
 * Bidirectional codec for the namespace-scoped runtime control-plane
 * stream name `{namespace}.{firegrid}.{runtime}` (composed via the
 * private suffix constant). The RuntimeContext index is
 * namespace-scoped (not host-scoped) so cross-host lookup does not
 * depend on host directory state.
 */
export const NamespaceRuntimeStreamNameSchema = Schema.transformOrFail(
  Schema.String,
  NamespaceRuntimeStreamNamePartsSchema,
  {
    strict: false,
    decode: (encoded, _options, ast) => {
      if (!encoded.endsWith(NAMESPACE_RUNTIME_SUFFIX)) {
        return ParseResult.fail(
          new ParseResult.Type(
            ast,
            encoded,
            `namespace runtime stream must end with ${NAMESPACE_RUNTIME_SUFFIX}`,
          ),
        )
      }
      return ParseResult.succeed({
        namespace: encoded.slice(0, -NAMESPACE_RUNTIME_SUFFIX.length),
      })
    },
    encode: ({ namespace }) =>
      ParseResult.succeed(`${namespace}${NAMESPACE_RUNTIME_SUFFIX}`),
  },
).pipe(streamAuthority)

/** Encode namespace → namespace-scoped runtime stream name. */
export const namespaceRuntimeStreamName = (namespace: string): string =>
  Schema.encodeSync(NamespaceRuntimeStreamNameSchema)({ namespace })

const DurableStreamUrlPartsSchema = Schema.Struct({
  baseUrl: Schema.String.pipe(
    Schema.filter((value) => {
      if (value.length === 0) return "baseUrl must be non-empty"
      if (value.includes(STREAM_PATH_INFIX)) {
        return `baseUrl must be the Durable Streams service root; it must not contain ${STREAM_PATH_INFIX}`
      }
      return undefined
    }),
  ),
  streamName: Schema.String.pipe(
    Schema.filter((value) =>
      value.length > 0 ? undefined : "streamName must be non-empty"),
  ),
})

/**
 * Bidirectional codec for a Durable Streams stream URL. The encoder
 * always appends `/v1/stream/` to the trimmed base URL — callers
 * configure `durableStreamsBaseUrl` as the service root, not as a
 * pre-built stream path. Strict by design; mixed shapes are rejected.
 */
export const DurableStreamUrlSchema = Schema.transformOrFail(
  Schema.String,
  DurableStreamUrlPartsSchema,
  {
    strict: false,
    decode: (encoded, _options, ast) => {
      const idx = encoded.lastIndexOf(STREAM_PATH_INFIX)
      if (idx < 0) {
        return ParseResult.fail(
          new ParseResult.Type(
            ast,
            encoded,
            `durable stream URL must contain ${STREAM_PATH_INFIX}`,
          ),
        )
      }
      const baseUrl = encoded.slice(0, idx)
      const encodedName = encoded.slice(idx + STREAM_PATH_INFIX.length)
      if (encodedName.length === 0) {
        return ParseResult.fail(
          new ParseResult.Type(
            ast,
            encoded,
            `durable stream URL must carry a stream name after ${STREAM_PATH_INFIX}`,
          ),
        )
      }
      return ParseResult.succeed({
        baseUrl,
        streamName: decodeURIComponent(encodedName),
      })
    },
    encode: ({ baseUrl, streamName }) => {
      const trimmed = baseUrl.replace(/\/+$/, "")
      return ParseResult.succeed(
        `${trimmed}${STREAM_PATH_INFIX}${encodeURIComponent(streamName)}`,
      )
    },
  },
)

/** Encode parts → Durable Streams stream URL. */
export const durableStreamUrl = (
  baseUrl: string,
  streamName: string,
): string =>
  Schema.encodeSync(DurableStreamUrlSchema)({ baseUrl, streamName })

/** Encode namespace + base URL → control-plane stream URL. */
export const runtimeControlPlaneStreamUrl = (input: {
  readonly baseUrl: string
  readonly namespace: string
}): string =>
  durableStreamUrl(input.baseUrl, namespaceRuntimeStreamName(input.namespace))

/** Encode prefix + segment + base URL → host-owned stream URL. */
export const hostOwnedStreamUrl = (input: {
  readonly baseUrl: string
  readonly prefix: HostStreamPrefix
  readonly segment: HostStreamSegment
}): string =>
  durableStreamUrl(input.baseUrl, hostStreamName(input.prefix, input.segment))

/**
 * Conceptual host session row. V1 does not persist a HostSession
 * durable table; the row is constructed at host boot and provided
 * through `CurrentHostSession`. Schema metadata still lives here so
 * future durable host directory work can adopt the same field shape.
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
 * comes from `HostStreamPrefixSchema`.
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
