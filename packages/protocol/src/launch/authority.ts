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
const STREAM_COLLECTION_PATH = "/v1/stream"
const STREAM_PATH_INFIX = `${STREAM_COLLECTION_PATH}/`

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
 * Per-field invariants for the host stream prefix. Extracted so both
 * the wire-form schema and the structured parts schema enforce the
 * same authority constraints — encode and decode paths cannot drift.
 */
const namespaceInvariant = (value: string): string | undefined => {
  if (value.length === 0) {
    return "host stream prefix namespace must be non-empty"
  }
  if (value.includes(HOST_STREAM_PREFIX_INFIX)) {
    return `host stream prefix namespace must not contain "${HOST_STREAM_PREFIX_INFIX}"`
  }
  return undefined
}

const hostIdSegmentInvariant = (value: string): string | undefined => {
  if (value.length === 0) {
    return "host stream prefix hostId must be non-empty"
  }
  if (value.includes(".")) {
    return "host stream prefix hostId must be a single dot-free segment"
  }
  return undefined
}

/**
 * Constrained host-id schema for the in-prefix host id segment. The
 * dot-free / non-empty invariants live on the schema so encode-time
 * misuse fails through the same path as decode-time validation, not
 * only when the wire validator runs.
 */
export const HostIdSegmentSchema = HostIdSchema.pipe(
  Schema.filter(hostIdSegmentInvariant),
)
export type HostIdSegment = Schema.Schema.Type<typeof HostIdSegmentSchema>

/**
 * Constrained namespace schema for the in-prefix namespace segment.
 */
const HostStreamPrefixNamespaceSchema = Schema.String.pipe(
  Schema.filter(namespaceInvariant),
)

/**
 * `${namespace}.firegrid.host.${hostId}` wire form, validated +
 * branded. Single canonical authority declaration for the host stream
 * prefix: rows hold this branded string, layer constructors read it
 * off `CurrentHostSession`, and the `streamAuthority` annotation
 * marks the schema for AST discovery.
 *
 * Format constraints (single source — the field invariants above):
 *  - the wire string MUST contain `.firegrid.host.` exactly once;
 *  - namespace (left of the infix) MUST satisfy `namespaceInvariant`;
 *  - hostId (right of the infix) MUST satisfy `hostIdSegmentInvariant`.
 */
const validateHostStreamPrefixWire = (
  value: string,
): string | undefined => {
  const first = value.indexOf(HOST_STREAM_PREFIX_INFIX)
  if (first < 0) {
    return `host stream prefix must contain "${HOST_STREAM_PREFIX_INFIX}"`
  }
  const last = value.lastIndexOf(HOST_STREAM_PREFIX_INFIX)
  if (first !== last) {
    return `host stream prefix must contain "${HOST_STREAM_PREFIX_INFIX}" exactly once`
  }
  const namespace = value.slice(0, first)
  const hostId = value.slice(last + HOST_STREAM_PREFIX_INFIX.length)
  return namespaceInvariant(namespace) ?? hostIdSegmentInvariant(hostId)
}

export const HostStreamPrefixWireSchema = Schema.String.pipe(
  Schema.filter(validateHostStreamPrefixWire),
  Schema.brand("HostStreamPrefix"),
  streamAuthority,
)
export type HostStreamPrefix = Schema.Schema.Type<typeof HostStreamPrefixWireSchema>

const HostStreamPrefixPartsSchema = Schema.Struct({
  namespace: HostStreamPrefixNamespaceSchema,
  hostId: HostIdSegmentSchema,
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

const RuntimeContextOutputStreamNamePartsSchema = Schema.Struct({
  prefix: HostStreamPrefixWireSchema,
  contextId: Schema.String.pipe(
    Schema.filter((value) =>
      value.length > 0 ? undefined : "runtime output contextId must be non-empty"),
  ),
})

const RuntimeContextWorkflowStreamNamePartsSchema = Schema.Struct({
  namespace: Schema.String.pipe(
    Schema.filter((value) =>
      value.length > 0 ? undefined : "runtime context workflow namespace must be non-empty"),
  ),
  contextId: Schema.String.pipe(
    Schema.filter((value) =>
      value.length > 0 ? undefined : "runtime context workflow contextId must be non-empty"),
  ),
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

const RUNTIME_CONTEXT_OUTPUT_STREAM_MARKER = ".runtimeOutput.context."
const RUNTIME_CONTEXT_WORKFLOW_STREAM_MARKER = `.${FIREGRID_DURABLE_NAMESPACE}.context.`
const RUNTIME_CONTEXT_WORKFLOW_STREAM_SUFFIX = ".workflow"

export const RuntimeContextOutputStreamNameSchema = Schema.transformOrFail(
  Schema.String,
  RuntimeContextOutputStreamNamePartsSchema,
  {
    strict: false,
    decode: (encoded, _options, ast) => {
      const marker = encoded.indexOf(RUNTIME_CONTEXT_OUTPUT_STREAM_MARKER)
      if (marker <= 0 || marker === encoded.length - RUNTIME_CONTEXT_OUTPUT_STREAM_MARKER.length) {
        return ParseResult.fail(
          new ParseResult.Type(
            ast,
            encoded,
            "runtime context output stream name must be {prefix}.runtimeOutput.context.{contextId}",
          ),
        )
      }
      const prefixWire = encoded.slice(0, marker)
      const contextIdWire = encoded.slice(marker + RUNTIME_CONTEXT_OUTPUT_STREAM_MARKER.length)
      const prefixValidation = validateHostStreamPrefixWire(prefixWire)
      if (prefixValidation !== undefined) {
        return ParseResult.fail(
          new ParseResult.Type(ast, encoded, prefixValidation),
        )
      }
      let contextId: string
      try {
        contextId = decodeURIComponent(contextIdWire)
      } catch {
        return ParseResult.fail(
          new ParseResult.Type(ast, encoded, "runtime output contextId is not valid URI encoding"),
        )
      }
      if (contextId.length === 0) {
        return ParseResult.fail(
          new ParseResult.Type(ast, encoded, "runtime output contextId must be non-empty"),
        )
      }
      return ParseResult.succeed({
        prefix: prefixWire as HostStreamPrefix,
        contextId,
      })
    },
    encode: ({ prefix, contextId }) =>
      ParseResult.succeed(
        `${prefix}${RUNTIME_CONTEXT_OUTPUT_STREAM_MARKER}${encodeURIComponent(contextId)}`,
      ),
  },
).pipe(streamAuthority)

export const RuntimeContextWorkflowStreamNameSchema = Schema.transformOrFail(
  Schema.String,
  RuntimeContextWorkflowStreamNamePartsSchema,
  {
    strict: false,
    decode: (encoded, _options, ast) => {
      const marker = encoded.indexOf(RUNTIME_CONTEXT_WORKFLOW_STREAM_MARKER)
      if (
        marker <= 0 ||
        !encoded.endsWith(RUNTIME_CONTEXT_WORKFLOW_STREAM_SUFFIX) ||
        marker === encoded.length - RUNTIME_CONTEXT_WORKFLOW_STREAM_MARKER.length -
          RUNTIME_CONTEXT_WORKFLOW_STREAM_SUFFIX.length
      ) {
        return ParseResult.fail(
          new ParseResult.Type(
            ast,
            encoded,
            "runtime context workflow stream name must be {namespace}.firegrid.context.{contextId}.workflow",
          ),
        )
      }
      const namespace = encoded.slice(0, marker)
      const contextIdWire = encoded.slice(
        marker + RUNTIME_CONTEXT_WORKFLOW_STREAM_MARKER.length,
        -RUNTIME_CONTEXT_WORKFLOW_STREAM_SUFFIX.length,
      )
      if (namespace.length === 0) {
        return ParseResult.fail(
          new ParseResult.Type(ast, encoded, "runtime context workflow namespace must be non-empty"),
        )
      }
      let contextId: string
      try {
        contextId = decodeURIComponent(contextIdWire)
      } catch {
        return ParseResult.fail(
          new ParseResult.Type(ast, encoded, "runtime context workflow contextId is not valid URI encoding"),
        )
      }
      if (contextId.length === 0) {
        return ParseResult.fail(
          new ParseResult.Type(ast, encoded, "runtime context workflow contextId must be non-empty"),
        )
      }
      return ParseResult.succeed({ namespace, contextId })
    },
    encode: ({ namespace, contextId }) =>
      ParseResult.succeed(
        `${namespace}${RUNTIME_CONTEXT_WORKFLOW_STREAM_MARKER}${encodeURIComponent(contextId)}${RUNTIME_CONTEXT_WORKFLOW_STREAM_SUFFIX}`,
      ),
  },
).pipe(streamAuthority)

export const runtimeContextOutputStreamName = (input: {
  readonly prefix: HostStreamPrefix
  readonly contextId: string
}): string =>
  Schema.encodeSync(RuntimeContextOutputStreamNameSchema)(input)

// Per-context INTENT (ingress) stream — the poll-only edge appends prompt /
// permission-response intents here; the host intent-observer (tf-r06u.42)
// tails it. Mirrors the output-stream codec so the name is derived from one
// authority, never hand-built (edge-auth `open` mints the handle, .42 tails
// the same name — they cannot drift). Brookhaven consumer-contract §2/§7.1.
const RUNTIME_CONTEXT_INTENT_STREAM_MARKER = ".runtimeIngress.context."

const RuntimeContextIntentStreamNamePartsSchema = Schema.Struct({
  prefix: HostStreamPrefixWireSchema,
  contextId: Schema.String.pipe(
    Schema.filter((value) =>
      value.length > 0 ? undefined : "runtime intent contextId must be non-empty"),
  ),
})

export const RuntimeContextIntentStreamNameSchema = Schema.transformOrFail(
  Schema.String,
  RuntimeContextIntentStreamNamePartsSchema,
  {
    strict: false,
    decode: (encoded, _options, ast) => {
      const marker = encoded.indexOf(RUNTIME_CONTEXT_INTENT_STREAM_MARKER)
      if (marker <= 0 || marker === encoded.length - RUNTIME_CONTEXT_INTENT_STREAM_MARKER.length) {
        return ParseResult.fail(
          new ParseResult.Type(
            ast,
            encoded,
            "runtime context intent stream name must be {prefix}.runtimeIngress.context.{contextId}",
          ),
        )
      }
      const prefixWire = encoded.slice(0, marker)
      const contextIdWire = encoded.slice(marker + RUNTIME_CONTEXT_INTENT_STREAM_MARKER.length)
      const prefixValidation = validateHostStreamPrefixWire(prefixWire)
      if (prefixValidation !== undefined) {
        return ParseResult.fail(
          new ParseResult.Type(ast, encoded, prefixValidation),
        )
      }
      let contextId: string
      try {
        contextId = decodeURIComponent(contextIdWire)
      } catch {
        return ParseResult.fail(
          new ParseResult.Type(ast, encoded, "runtime intent contextId is not valid URI encoding"),
        )
      }
      if (contextId.length === 0) {
        return ParseResult.fail(
          new ParseResult.Type(ast, encoded, "runtime intent contextId must be non-empty"),
        )
      }
      return ParseResult.succeed({
        prefix: prefixWire as HostStreamPrefix,
        contextId,
      })
    },
    encode: ({ prefix, contextId }) =>
      ParseResult.succeed(
        `${prefix}${RUNTIME_CONTEXT_INTENT_STREAM_MARKER}${encodeURIComponent(contextId)}`,
      ),
  },
).pipe(streamAuthority)

export const runtimeContextIntentStreamName = (input: {
  readonly prefix: HostStreamPrefix
  readonly contextId: string
}): string =>
  Schema.encodeSync(RuntimeContextIntentStreamNameSchema)(input)

export const runtimeContextWorkflowStreamName = (input: {
  readonly namespace: string
  readonly contextId: string
}): string =>
  Schema.encodeSync(RuntimeContextWorkflowStreamNameSchema)(input)

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
      if (value.replace(/\/+$/, "").endsWith(STREAM_COLLECTION_PATH)) {
        return `baseUrl must be the Durable Streams service root or an Electric service-scoped root; bare ${STREAM_COLLECTION_PATH} is not accepted`
      }
      return undefined
    }),
  ),
  streamName: Schema.String.pipe(
    Schema.filter((value) =>
      value.length > 0 ? undefined : "streamName must be non-empty"),
  ),
})

const decodeDurableStreamUrlParts = (
  encoded: string,
  ast: SchemaAST.AST,
) => {
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
  const path = encoded.slice(idx + STREAM_PATH_INFIX.length)
  if (path.length === 0) {
    return ParseResult.fail(
      new ParseResult.Type(
        ast,
        encoded,
        `durable stream URL must carry a stream name after ${STREAM_PATH_INFIX}`,
      ),
    )
  }
  const serviceSeparator = path.startsWith("svc-") ? path.indexOf("/") : -1
  if (serviceSeparator > 0) {
    return ParseResult.succeed({
      baseUrl: encoded.slice(0, idx + STREAM_PATH_INFIX.length + serviceSeparator),
      streamName: decodeURIComponent(path.slice(serviceSeparator + 1)),
    })
  }
  return ParseResult.succeed({
    baseUrl: encoded.slice(0, idx),
    streamName: decodeURIComponent(path),
  })
}

/**
 * Bidirectional codec for a Durable Streams stream URL. The encoder
 * appends `/v1/stream/` to generic service roots and appends `/` to
 * Electric Cloud service-scoped roots shaped as `/v1/stream/<service>`.
 * Callers still configure a root, not a pre-built stream URL.
 */
export const DurableStreamUrlSchema = Schema.transformOrFail(
  Schema.String,
  DurableStreamUrlPartsSchema,
  {
    strict: false,
    decode: (encoded, _options, ast) => decodeDurableStreamUrlParts(encoded, ast),
    encode: ({ baseUrl, streamName }) => {
      const trimmed = baseUrl.replace(/\/+$/, "")
      const separator = trimmed.includes(STREAM_PATH_INFIX)
        ? "/"
        : STREAM_PATH_INFIX
      return ParseResult.succeed(
        `${trimmed}${separator}${encodeURIComponent(streamName)}`,
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

export const runtimeContextOutputStreamUrl = (input: {
  readonly baseUrl: string
  readonly prefix: HostStreamPrefix
  readonly contextId: string
}): string =>
  durableStreamUrl(input.baseUrl, runtimeContextOutputStreamName({
    prefix: input.prefix,
    contextId: input.contextId,
  }))

export const runtimeContextWorkflowStreamUrl = (input: {
  readonly baseUrl: string
  readonly namespace: string
  readonly contextId: string
}): string =>
  durableStreamUrl(input.baseUrl, runtimeContextWorkflowStreamName({
    namespace: input.namespace,
    contextId: input.contextId,
  }))

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
