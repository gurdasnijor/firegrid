// firegrid-host-context-authority.SCHEMA_STREAM_AUTHORITY.1
// firegrid-host-context-authority.SCHEMA_STREAM_AUTHORITY.3
// firegrid-host-context-authority.RUNTIME_CONTEXT_PRIMITIVES.4
//
// Schema-level encoder/decoder coverage for host stream authority.
// Asserts the schema is the single source of truth for the wire form
// and that AST discovery via the streamAuthority annotation works for
// the same fields product code reads off rows.

import { Either, Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  DurableStreamUrlSchema,
  HostSessionRowSchema,
  HostStreamNameSchema,
  HostStreamPrefixSchema,
  HostStreamPrefixWireSchema,
  NamespaceRuntimeStreamNameSchema,
  RuntimeContextIntentStreamNameSchema,
  RuntimeContextOutputStreamNameSchema,
  RuntimeContextHostBindingSchema,
  durableStreamUrl,
  hostOwnedStreamUrl,
  hostStreamName,
  isStreamAuthorityAst,
  makeHostSessionRow,
  makeHostStreamPrefix,
  namespaceRuntimeStreamName,
  runtimeControlPlaneStreamUrl,
  runtimeContextIntentStreamName,
  runtimeContextOutputStreamName,
  runtimeContextOutputStreamUrl,
  type HostId,
  type HostSessionId,
} from "../../src/launch/authority.ts"

describe("HostStreamPrefixSchema", () => {
  it("firegrid-host-context-authority.SCHEMA_STREAM_AUTHORITY.1 encodes parts into ${namespace}.firegrid.host.${hostId}", () => {
    const encoded = makeHostStreamPrefix({
      namespace: "firegrid-smoke",
      hostId: "host_abc" as HostId,
    })
    expect(encoded).toBe("firegrid-smoke.firegrid.host.host_abc")
  })

  it("firegrid-host-context-authority.SCHEMA_STREAM_AUTHORITY.1 round-trips wire string back to parts", () => {
    const wire = "firegrid-smoke.firegrid.host.host_abc"
    const decoded = Schema.decodeUnknownSync(HostStreamPrefixSchema)(wire)
    expect(decoded).toEqual({
      namespace: "firegrid-smoke",
      hostId: "host_abc",
    })
  })

  it("firegrid-host-context-authority.SCHEMA_STREAM_AUTHORITY.3 rejects empty namespace or empty hostId", () => {
    const empty = Schema.decodeUnknownEither(HostStreamPrefixSchema)(".firegrid.host.host_abc")
    expect(Either.isLeft(empty)).toBe(true)
    const trailing = Schema.decodeUnknownEither(HostStreamPrefixSchema)("ns.firegrid.host.")
    expect(Either.isLeft(trailing)).toBe(true)
  })

  it("firegrid-host-context-authority.SCHEMA_STREAM_AUTHORITY.3 rejects hostId containing a dot", () => {
    const result = Schema.encodeUnknownEither(HostStreamPrefixSchema)({
      namespace: "ns",
      hostId: "host.with.dot",
    })
    expect(Either.isLeft(result)).toBe(true)
  })

  it("firegrid-host-context-authority.SCHEMA_STREAM_AUTHORITY.3 encode rejects an empty namespace", () => {
    const result = Schema.encodeUnknownEither(HostStreamPrefixSchema)({
      namespace: "",
      hostId: "host_abc",
    })
    expect(Either.isLeft(result)).toBe(true)
  })

  it("firegrid-host-context-authority.SCHEMA_STREAM_AUTHORITY.3 encode rejects a namespace containing the reserved infix", () => {
    const result = Schema.encodeUnknownEither(HostStreamPrefixSchema)({
      namespace: "ns.firegrid.host.evil",
      hostId: "host_abc",
    })
    expect(Either.isLeft(result)).toBe(true)
  })

  it("firegrid-host-context-authority.SCHEMA_STREAM_AUTHORITY.3 encode rejects an empty hostId", () => {
    const result = Schema.encodeUnknownEither(HostStreamPrefixSchema)({
      namespace: "ns",
      hostId: "",
    })
    expect(Either.isLeft(result)).toBe(true)
  })

  it("firegrid-host-context-authority.SCHEMA_STREAM_AUTHORITY.1 accepts a dotted namespace and produces a schema-valid wire prefix", () => {
    const prefix = makeHostStreamPrefix({
      namespace: "ns.with.dots",
      hostId: "host_abc" as HostId,
    })
    expect(prefix).toBe("ns.with.dots.firegrid.host.host_abc")
    // Round-trips through the wire validator (no `Either.left`).
    expect(Schema.decodeUnknownSync(HostStreamPrefixWireSchema)(prefix)).toBe(prefix)
  })
})

describe("hostStreamName", () => {
  it("firegrid-host-context-authority.SCHEMA_STREAM_AUTHORITY.2 appends operational segment to the encoded prefix", () => {
    const prefix = makeHostStreamPrefix({
      namespace: "ns",
      hostId: "host_xyz" as HostId,
    })
    expect(hostStreamName(prefix, "workflow")).toBe("ns.firegrid.host.host_xyz.workflow")
    expect(hostStreamName(prefix, "runtimeIngress")).toBe("ns.firegrid.host.host_xyz.runtimeIngress")
  })
})

describe("makeHostSessionRow", () => {
  it("firegrid-host-context-authority.RUNTIME_CONTEXT_HOST_AUTHORITY.3 fills streamPrefix through the schema-encoded authority", () => {
    const row = makeHostSessionRow({
      hostId: "host_1" as HostId,
      hostSessionId: "hs_1" as HostSessionId,
      namespace: "ns",
      startedAtMs: 1_700_000_000_000,
    })
    expect(row.streamPrefix).toBe("ns.firegrid.host.host_1")
    expect(row.status).toBe("running")
    expect(row.startedAtMs).toBe(1_700_000_000_000)
  })

  it("firegrid-host-context-authority.SCHEMA_STREAM_AUTHORITY.3 the produced row round-trips through HostSessionRowSchema", () => {
    const row = makeHostSessionRow({
      hostId: "host_1" as HostId,
      hostSessionId: "hs_1" as HostSessionId,
      namespace: "ns",
      startedAtMs: 1_700_000_000_000,
    })
    const decoded = Schema.decodeUnknownSync(HostSessionRowSchema)(row)
    expect(decoded).toEqual(row)
  })
})

describe("streamAuthority annotation", () => {
  it("firegrid-host-context-authority.SCHEMA_STREAM_AUTHORITY.1 marks HostStreamPrefixSchema AST as authority-bearing", () => {
    expect(isStreamAuthorityAst(HostStreamPrefixSchema.ast)).toBe(true)
  })

  it("firegrid-host-context-authority.SCHEMA_STREAM_AUTHORITY.1 marks the streamPrefix field of HostSessionRowSchema", () => {
    const fieldSchema = HostSessionRowSchema.fields.streamPrefix
    expect(isStreamAuthorityAst(fieldSchema.ast)).toBe(true)
  })

  it("firegrid-host-context-authority.SCHEMA_STREAM_AUTHORITY.1 marks RuntimeContext.host.streamPrefix", () => {
    const fieldSchema = RuntimeContextHostBindingSchema.fields.streamPrefix
    expect(isStreamAuthorityAst(fieldSchema.ast)).toBe(true)
  })

  it("firegrid-host-context-authority.SCHEMA_STREAM_AUTHORITY.1 marks HostStreamNameSchema and NamespaceRuntimeStreamNameSchema", () => {
    expect(isStreamAuthorityAst(HostStreamNameSchema.ast)).toBe(true)
    expect(isStreamAuthorityAst(NamespaceRuntimeStreamNameSchema.ast)).toBe(true)
    expect(isStreamAuthorityAst(RuntimeContextOutputStreamNameSchema.ast)).toBe(true)
  })
})

describe("HostStreamPrefixWireSchema", () => {
  it("firegrid-host-context-authority.SCHEMA_STREAM_AUTHORITY.3 rejects a wire string that does not match the canonical shape", () => {
    const result = Schema.decodeUnknownEither(HostStreamPrefixWireSchema)("not-a-prefix")
    expect(Either.isLeft(result)).toBe(true)
  })

  it("firegrid-host-context-authority.SCHEMA_STREAM_AUTHORITY.3 accepts a valid wire string and round-trips on encode", () => {
    const wire = "ns.firegrid.host.host_abc"
    const decoded = Schema.decodeUnknownSync(HostStreamPrefixWireSchema)(wire)
    expect(decoded).toBe(wire)
    expect(Schema.encodeSync(HostStreamPrefixWireSchema)(decoded)).toBe(wire)
  })
})

describe("HostStreamNameSchema", () => {
  it("firegrid-host-context-authority.SCHEMA_STREAM_AUTHORITY.2 encodes parts into ${prefix}.${segment}", () => {
    const prefix = makeHostStreamPrefix({ namespace: "ns", hostId: "host_abc" as HostId })
    expect(
      Schema.encodeSync(HostStreamNameSchema)({ prefix, segment: "workflow" }),
    ).toBe("ns.firegrid.host.host_abc.workflow")
  })

  it("firegrid-host-context-authority.SCHEMA_STREAM_AUTHORITY.2 decodes a stream name into structured parts", () => {
    const decoded = Schema.decodeUnknownSync(HostStreamNameSchema)("ns.firegrid.host.host_abc.runtimeOutput")
    expect(decoded).toEqual({
      prefix: "ns.firegrid.host.host_abc",
      segment: "runtimeOutput",
    })
  })

  it("firegrid-host-context-authority.SCHEMA_STREAM_AUTHORITY.3 rejects a stream name with an unknown segment", () => {
    const result = Schema.decodeUnknownEither(HostStreamNameSchema)("ns.firegrid.host.host_abc.bogus")
    expect(Either.isLeft(result)).toBe(true)
  })

  it("firegrid-host-context-authority.SCHEMA_STREAM_AUTHORITY.3 rejects a stream name whose prefix is malformed", () => {
    const result = Schema.decodeUnknownEither(HostStreamNameSchema)("not-a-prefix.workflow")
    expect(Either.isLeft(result)).toBe(true)
  })
})

describe("NamespaceRuntimeStreamNameSchema", () => {
  it("firegrid-host-context-authority.SCHEMA_STREAM_AUTHORITY.2 encodes namespace into the canonical control-plane stream name", () => {
    expect(namespaceRuntimeStreamName("ns")).toBe("ns.firegrid.runtime")
  })

  it("firegrid-host-context-authority.SCHEMA_STREAM_AUTHORITY.2 decodes the canonical control-plane stream name back to namespace parts", () => {
    expect(
      Schema.decodeUnknownSync(NamespaceRuntimeStreamNameSchema)("ns.firegrid.runtime"),
    ).toEqual({ namespace: "ns" })
  })

  it("firegrid-host-context-authority.SCHEMA_STREAM_AUTHORITY.3 rejects a wire string that does not end with .firegrid.runtime", () => {
    const result = Schema.decodeUnknownEither(NamespaceRuntimeStreamNameSchema)("ns.firegrid.workflow")
    expect(Either.isLeft(result)).toBe(true)
  })
})

describe("RuntimeContextOutputStreamNameSchema", () => {
  it("firegrid-host-context-authority.SCHEMA_STREAM_AUTHORITY.2 encodes per-context output side-channel stream names", () => {
    const prefix = makeHostStreamPrefix({ namespace: "ns", hostId: "host_abc" as HostId })
    expect(runtimeContextOutputStreamName({
      prefix,
      contextId: "ctx.with/slash",
    })).toBe("ns.firegrid.host.host_abc.runtimeOutput.context.ctx.with%2Fslash")
  })

  it("firegrid-host-context-authority.SCHEMA_STREAM_AUTHORITY.2 decodes per-context output side-channel stream names", () => {
    expect(
      Schema.decodeUnknownSync(RuntimeContextOutputStreamNameSchema)(
        "ns.firegrid.host.host_abc.runtimeOutput.context.ctx.with%2Fslash",
      ),
    ).toEqual({
      prefix: "ns.firegrid.host.host_abc",
      contextId: "ctx.with/slash",
    })
  })

  it("firegrid-host-context-authority.SCHEMA_STREAM_AUTHORITY.2 keeps marker-like text inside encoded context ids", () => {
    const prefix = makeHostStreamPrefix({ namespace: "ns", hostId: "host_abc" as HostId })
    const contextId = "ctx.runtimeOutput.context.child"
    expect(Schema.decodeUnknownSync(RuntimeContextOutputStreamNameSchema)(
      runtimeContextOutputStreamName({ prefix, contextId }),
    )).toEqual({ prefix, contextId })
  })

  it("firegrid-host-context-authority.SCHEMA_STREAM_AUTHORITY.3 rejects malformed per-context output names", () => {
    const result = Schema.decodeUnknownEither(RuntimeContextOutputStreamNameSchema)(
      "ns.firegrid.host.host_abc.runtimeOutput.context.",
    )
    expect(Either.isLeft(result)).toBe(true)
  })
})

describe("RuntimeContextIntentStreamNameSchema", () => {
  // tf-r06u.33: per-context intent (ingress) stream the edge appends to and
  // the host intent-observer (tf-r06u.42) tails. Mirrors the output codec.
  it("encodes per-context intent stream names (URI-encoding the contextId)", () => {
    const prefix = makeHostStreamPrefix({ namespace: "ns", hostId: "host_abc" as HostId })
    expect(runtimeContextIntentStreamName({
      prefix,
      contextId: "ctx.with/slash",
    })).toBe("ns.firegrid.host.host_abc.runtimeIngress.context.ctx.with%2Fslash")
  })

  it("round-trips encode -> decode", () => {
    const prefix = makeHostStreamPrefix({ namespace: "ns", hostId: "host_abc" as HostId })
    const contextId = "ctx_ext_WyJicm9va2hhdmVu"
    expect(Schema.decodeUnknownSync(RuntimeContextIntentStreamNameSchema)(
      runtimeContextIntentStreamName({ prefix, contextId }),
    )).toEqual({ prefix, contextId })
  })

  it("is marked as stream authority", () => {
    expect(isStreamAuthorityAst(RuntimeContextIntentStreamNameSchema.ast)).toBe(true)
  })

  it("rejects malformed per-context intent names", () => {
    expect(
      Either.isLeft(
        Schema.decodeUnknownEither(RuntimeContextIntentStreamNameSchema)(
          "ns.firegrid.host.host_abc.runtimeIngress.context.",
        ),
      ),
    ).toBe(true)
  })

  it("does NOT collide with the output stream name for the same context", () => {
    const prefix = makeHostStreamPrefix({ namespace: "ns", hostId: "host_abc" as HostId })
    const contextId = "ctx_ext_abc"
    expect(runtimeContextIntentStreamName({ prefix, contextId })).not.toBe(
      runtimeContextOutputStreamName({ prefix, contextId }),
    )
  })
})

describe("DurableStreamUrlSchema", () => {
  it("firegrid-host-context-authority.SCHEMA_STREAM_AUTHORITY.2 prepends /v1/stream/ to the service root and percent-encodes the stream name", () => {
    expect(durableStreamUrl("http://h", "ns.firegrid.runtime")).toBe(
      "http://h/v1/stream/ns.firegrid.runtime",
    )
    expect(durableStreamUrl("http://h", "ns/seg with space")).toBe(
      "http://h/v1/stream/ns%2Fseg%20with%20space",
    )
  })

  it("firegrid-host-context-authority.SCHEMA_STREAM_AUTHORITY.4 appends stream names to Electric service-scoped roots", () => {
    expect(
      durableStreamUrl(
        "https://api.electric-sql.cloud/v1/stream/svc-example",
        "ns.firegrid.runtime",
      ),
    ).toBe("https://api.electric-sql.cloud/v1/stream/svc-example/ns.firegrid.runtime")
    expect(
      Schema.decodeUnknownSync(DurableStreamUrlSchema)(
        "https://api.electric-sql.cloud/v1/stream/svc-example/ns.firegrid.runtime",
      ),
    ).toEqual({
      baseUrl: "https://api.electric-sql.cloud/v1/stream/svc-example",
      streamName: "ns.firegrid.runtime",
    })
  })

  it("firegrid-host-context-authority.SCHEMA_STREAM_AUTHORITY.3 rejects a bare /v1/stream base URL", () => {
    const result = Schema.encodeUnknownEither(DurableStreamUrlSchema)({
      baseUrl: "http://h/v1/stream/",
      streamName: "ns.firegrid.runtime",
    })
    expect(Either.isLeft(result)).toBe(true)
  })

  it("firegrid-host-context-authority.SCHEMA_STREAM_AUTHORITY.3 rejects decoding a URL that does not include /v1/stream/", () => {
    const result = Schema.decodeUnknownEither(DurableStreamUrlSchema)("http://h/elsewhere/foo")
    expect(Either.isLeft(result)).toBe(true)
  })
})

describe("runtimeControlPlaneStreamUrl + hostOwnedStreamUrl", () => {
  it("firegrid-host-context-authority.SCHEMA_STREAM_AUTHORITY.2 control-plane URL goes through namespaceRuntimeStreamName + durableStreamUrl", () => {
    expect(
      runtimeControlPlaneStreamUrl({ baseUrl: "http://h", namespace: "ns" }),
    ).toBe("http://h/v1/stream/ns.firegrid.runtime")
  })

  it("firegrid-host-context-authority.SCHEMA_STREAM_AUTHORITY.2 host-owned URL chains hostStreamName + durableStreamUrl", () => {
    const prefix = makeHostStreamPrefix({ namespace: "ns", hostId: "host_abc" as HostId })
    expect(
      hostOwnedStreamUrl({ baseUrl: "http://h", prefix, segment: "workflow" }),
    ).toBe("http://h/v1/stream/ns.firegrid.host.host_abc.workflow")
  })

  it("firegrid-host-context-authority.SCHEMA_STREAM_AUTHORITY.2 per-context output URL chains runtimeContextOutputStreamName + durableStreamUrl", () => {
    const prefix = makeHostStreamPrefix({ namespace: "ns", hostId: "host_abc" as HostId })
    expect(
      runtimeContextOutputStreamUrl({ baseUrl: "http://h", prefix, contextId: "ctx/1" }),
    ).toBe("http://h/v1/stream/ns.firegrid.host.host_abc.runtimeOutput.context.ctx%252F1")
  })
})
