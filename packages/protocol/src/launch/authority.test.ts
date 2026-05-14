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
  HostSessionRowSchema,
  HostStreamPrefixSchema,
  RuntimeContextHostBindingSchema,
  hostStreamName,
  isStreamAuthorityAst,
  makeHostSessionRow,
  makeHostStreamPrefix,
  type HostId,
  type HostSessionId,
} from "./authority.ts"

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
})
