import { Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  makeRuntimeControlRequestClaimRow,
  makeRuntimeControlRequestCompletionRow,
  makeRuntimeContextRequestRow,
  makeRuntimeStartRequestAck,
  makeRuntimeStartRequestRow,
  RuntimeControlRequestClaimRowSchema,
  RuntimeControlRequestCompletionRowSchema,
  RuntimeContextRequestRowSchema,
  RuntimeStartRequestAckSchema,
  RuntimeStartRequestRowSchema,
  runtimeContextRequestClaimId,
  runtimeContextRequestId,
  runtimeStartRequestClaimId,
  runtimeStartRequestId,
} from "../../src/launch/index.ts"

const runtime = {
  provider: "local-process" as const,
  config: { argv: ["node", "-e", "0"] },
}

describe("@firegrid/protocol launch control requests (TFIND-002/003)", () => {
  it("builds a context-create request with a deterministic id and no host binding", () => {
    const row = makeRuntimeContextRequestRow(
      { contextId: "ctx_ext_abc", runtime, createdBy: "client" },
      { createdAt: "2026-05-17T00:00:00.000Z" },
    )

    expect(row).toEqual({
      requestId: "req_ctx_ctx_ext_abc",
      contextId: "ctx_ext_abc",
      runtime,
      createdBy: "client",
      createdAt: "2026-05-17T00:00:00.000Z",
    })
    // The client-written request carries NO host binding.
    expect(row).not.toHaveProperty("host")
    expect(Schema.decodeUnknownSync(RuntimeContextRequestRowSchema)(row)).toEqual(row)
  })

  it("builds a start request that is a durable ask, not a run result", () => {
    const row = makeRuntimeStartRequestRow(
      { contextId: "ctx_ext_abc" },
      { createdAt: "2026-05-17T00:00:00.000Z" },
    )

    expect(row).toEqual({
      requestId: "req_start_ctx_ext_abc",
      contextId: "ctx_ext_abc",
      createdAt: "2026-05-17T00:00:00.000Z",
    })
    // Not a synchronous RuntimeStartResult: no exitCode/signal/activityAttempt.
    expect(row).not.toHaveProperty("exitCode")
    expect(Schema.decodeUnknownSync(RuntimeStartRequestRowSchema)(row)).toEqual(row)
  })

  it("ids are idempotent on contextId so re-issuing records one request", () => {
    expect(runtimeContextRequestId("ctx_ext_abc")).toBe(
      makeRuntimeContextRequestRow({ contextId: "ctx_ext_abc", runtime }).requestId,
    )
    expect(runtimeStartRequestId("ctx_ext_abc")).toBe(
      makeRuntimeStartRequestRow({ contextId: "ctx_ext_abc" }).requestId,
    )
    expect(runtimeContextRequestId("a/b c")).toBe("req_ctx_a_b_c")
  })

  it("builds deterministic host claim rows for per-window reconciliation", () => {
    const claim = makeRuntimeControlRequestClaimRow({
      requestKind: "context",
      requestId: "req_ctx_ctx_ext_abc",
      contextId: "ctx_ext_abc",
      hostId: "host_a",
      hostSessionId: "session-a",
      claimWindowStartedAtMs: 1_000,
      claimWindowExpiresAtMs: 61_000,
      claimedAtMs: 2_000,
    })
    const startClaim = makeRuntimeControlRequestClaimRow({
      ...claim,
      requestKind: "start",
    })

    expect(claim.claimId).toBe("ctx_req_claim:req_ctx_ctx_ext_abc:1000")
    expect(claim.claimId).toBe(runtimeContextRequestClaimId(claim.requestId, 1_000))
    expect(Schema.decodeUnknownSync(RuntimeControlRequestClaimRowSchema)(claim)).toEqual(claim)
    expect(startClaim.claimId).toBe("start_req_claim:req_ctx_ctx_ext_abc:1000")
    expect(startClaim.claimId).toBe(runtimeStartRequestClaimId(startClaim.requestId, 1_000))
    expect(Schema.decodeUnknownSync(RuntimeControlRequestClaimRowSchema)(startClaim)).toEqual(startClaim)
  })

  it("builds start completions and client-visible request acknowledgements", () => {
    const completion = makeRuntimeControlRequestCompletionRow({
      requestKind: "start",
      requestId: "req_start_ctx_ext_abc",
      contextId: "ctx_ext_abc",
      status: "succeeded",
      hostId: "host_a",
      completedAtMs: 12_000,
      activityAttempt: 1,
      exitCode: 0,
    })
    const ack = makeRuntimeStartRequestAck({
      requestId: "req_start_ctx_ext_abc",
      contextId: "ctx_ext_abc",
      inserted: true,
    })

    expect(Schema.decodeUnknownSync(RuntimeControlRequestCompletionRowSchema)(completion)).toEqual(completion)
    expect(Schema.decodeUnknownSync(RuntimeStartRequestAckSchema)(ack)).toEqual(ack)
    expect(completion).not.toHaveProperty("signal")
  })
})
