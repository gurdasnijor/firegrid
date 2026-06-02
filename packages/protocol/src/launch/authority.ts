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

import { Schema, type SchemaAST } from "effect"

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
const RUNTIME_OUTPUT_TABLE_NAME = "runtimeOutput"
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

export const HostStreamPrefixSchema = HostStreamPrefixWireSchema

/** Encode parts → branded wire host stream prefix. */
export const makeHostStreamPrefix = (
  parts: HostStreamPrefixParts,
): HostStreamPrefix => {
  const decoded = Schema.decodeSync(HostStreamPrefixPartsSchema)(parts)
  return Schema.decodeSync(HostStreamPrefixWireSchema)(
    `${decoded.namespace}${HOST_STREAM_PREFIX_INFIX}${decoded.hostId}`,
  )
}

const HOST_STREAM_SEGMENT_LITERALS = HostStreamSegmentSchema.literals

const validateHostStreamNameWire = (encoded: string): string | undefined => {
  const dot = encoded.lastIndexOf(".")
  if (dot <= 0 || dot === encoded.length - 1) {
    return "host stream name must be {prefix}.{segment}"
  }
  const prefixWire = encoded.slice(0, dot)
  const segmentWire = encoded.slice(dot + 1)
  if (!HOST_STREAM_SEGMENT_LITERALS.some(candidate => candidate === segmentWire)) {
    return "host stream name segment is not one of the supported literals"
  }
  return validateHostStreamPrefixWire(prefixWire)
}

export const HostStreamNameSchema = Schema.String.pipe(
  Schema.filter(validateHostStreamNameWire),
  streamAuthority,
)

/** Encode parts → host-owned stream name. */
export const hostStreamName = (
  prefix: HostStreamPrefix,
  segment: HostStreamSegment,
): string =>
  Schema.decodeSync(HostStreamNameSchema)(
    `${Schema.decodeSync(HostStreamPrefixWireSchema)(prefix)}.${Schema.decodeSync(HostStreamSegmentSchema)(segment)}`,
  )

const NAMESPACE_RUNTIME_SUFFIX = `.${FIREGRID_DURABLE_NAMESPACE}.${RUNTIME_TABLE_NAME}`

const NamespaceSchema = Schema.String.pipe(
  Schema.filter((value) =>
    value.length > 0 ? undefined : "namespace must be non-empty"),
)

export const NamespaceRuntimeStreamNameSchema = Schema.String.pipe(
  Schema.filter((encoded) =>
    encoded.endsWith(NAMESPACE_RUNTIME_SUFFIX)
      ? undefined
      : `namespace runtime stream must end with ${NAMESPACE_RUNTIME_SUFFIX}`),
  streamAuthority,
)

/** Encode namespace → namespace-scoped runtime stream name. */
export const namespaceRuntimeStreamName = (namespace: string): string =>
  Schema.decodeSync(NamespaceRuntimeStreamNameSchema)(
    `${Schema.decodeSync(NamespaceSchema)(namespace)}${NAMESPACE_RUNTIME_SUFFIX}`,
  )

export const namespaceRuntimeOutputStreamName = (namespace: string): string =>
  `${Schema.decodeSync(NamespaceSchema)(namespace)}.${FIREGRID_DURABLE_NAMESPACE}.${RUNTIME_OUTPUT_TABLE_NAME}`

const BaseDurableStreamUrlSchema = Schema.String.pipe(
  Schema.filter((value) => {
    if (value.length === 0) return "baseUrl must be non-empty"
    if (value.replace(/\/+$/, "").endsWith(STREAM_COLLECTION_PATH)) {
      return `baseUrl must be the Durable Streams service root or an Electric service-scoped root; bare ${STREAM_COLLECTION_PATH} is not accepted`
    }
    return undefined
  }),
)

const DurableStreamNameSchema = Schema.String.pipe(
  Schema.filter((value) =>
    value.length > 0 ? undefined : "streamName must be non-empty"),
)

export const DurableStreamUrlSchema = Schema.String.pipe(
  Schema.filter((value) =>
    value.includes(STREAM_PATH_INFIX)
      ? undefined
      : `durable stream URL must contain ${STREAM_PATH_INFIX}`),
)

/** Encode parts → Durable Streams stream URL. */
export const durableStreamUrl = (
  baseUrl: string,
  streamName: string,
): string => {
  const trimmed = Schema.decodeSync(BaseDurableStreamUrlSchema)(baseUrl).replace(/\/+$/, "")
  const separator = trimmed.includes(STREAM_PATH_INFIX) ? "/" : STREAM_PATH_INFIX
  return Schema.decodeSync(DurableStreamUrlSchema)(
    `${trimmed}${separator}${encodeURIComponent(Schema.decodeSync(DurableStreamNameSchema)(streamName))}`,
  )
}

/** Encode namespace + base URL → control-plane stream URL. */
export const runtimeControlPlaneStreamUrl = (input: {
  readonly baseUrl: string
  readonly namespace: string
}): string =>
  durableStreamUrl(input.baseUrl, namespaceRuntimeStreamName(input.namespace))

export const runtimeOutputStreamUrl = (input: {
  readonly baseUrl: string
  readonly namespace: string
}): string =>
  durableStreamUrl(input.baseUrl, namespaceRuntimeOutputStreamName(input.namespace))

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
