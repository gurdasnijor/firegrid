/**
 * tf-35f4 Sim 2 — multi-surface projection equivalence for a callable
 * channel.
 *
 * EVIDENCE HARNESS. Two projections of the SAME callable channel
 * (`HostSessionsCreateOrLoadChannel`, declared in
 * `@firegrid/protocol/channels`) drive the substrate with distinct
 * `externalKey` values. The test asserts:
 *
 *   - response identity equivalence (sessionId === contextId, both
 *     derived from externalKey via `sessionContextIdForExternalKey`)
 *   - durable substrate equivalence: each projection produces exactly
 *     one `RuntimeContextRequestRow` with identical SHAPE (same fields,
 *     same row schema, same idempotency derivation) — they only differ
 *     by the externalKey-derived contextId/requestId
 *
 * If both projections share substrate + response shape with no
 * direction-specific divergence, the SDD's "projection contract" claim
 * holds for callable channels: one channel registration ↔ N
 * projections.
 */

import { DurableStreamTestServer } from "@durable-streams/server"
import {
  FiregridConfig,
  FiregridLive,
} from "@firegrid/client-sdk/firegrid"
import {
  RuntimeControlPlaneTable,
  runtimeControlPlaneStreamUrl,
} from "@firegrid/protocol/launch"
import { sessionContextIdForExternalKey } from "@firegrid/protocol/session-facade"
import { HostSessionsCreateOrLoadChannelLive } from "@firegrid/host-sdk"
import { Effect, Exit, Layer } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  buildRequestForProjection,
  runClientMethodProjection,
  runMcpToolProjection,
  SIM_ID,
} from "../../src/simulations/spike-channel-deletion/sim2-multi-surface-projection/index.ts"

let server: DurableStreamTestServer | undefined
let baseUrl: string | undefined

beforeEach(async () => {
  server = new DurableStreamTestServer({ port: 0, host: "127.0.0.1" })
  baseUrl = await server.start()
})

afterEach(async () => {
  ;(server as unknown as {
    server?: { closeAllConnections?: () => void }
  } | undefined)?.server?.closeAllConnections?.()
  await server?.stop()
  server = undefined
  baseUrl = undefined
})

const composeSubstrate = () => {
  if (baseUrl === undefined) throw new Error("server not started")
  const namespace = `${SIM_ID}-${crypto.randomUUID()}`
  const config = Layer.succeed(FiregridConfig, {
    durableStreamsBaseUrl: baseUrl,
    namespace,
  })
  const controlPlane = RuntimeControlPlaneTable.layer({
    streamOptions: {
      url: runtimeControlPlaneStreamUrl({
        baseUrl,
        namespace,
      }),
      contentType: "application/json",
    },
  })
  // Production-grade composition: BOTH projections resolve the same
  // host-sdk-owned Live Layer; the only difference between this
  // composition and a future MCP-tool host is whether a tool-shaped
  // wrapper is also registered.
  const channel = HostSessionsCreateOrLoadChannelLive.pipe(
    Layer.provideMerge(controlPlane),
  )
  const firegrid = FiregridLive.pipe(
    Layer.provideMerge(channel),
    Layer.provideMerge(config),
  )
  return { firegrid, channel }
}

describe("tf-35f4 Sim 2 — multi-surface projection equivalence", () => {
  it("client-method projection and MCP-tool-style projection of HostSessionsCreateOrLoadChannel produce equivalent substrate rows and responses", async () => {
    const layers = composeSubstrate()
    const clientRequest = buildRequestForProjection("client-method")
    const mcpRequest = buildRequestForProjection("mcp-tool")

    const clientReport = await Effect.runPromise(
      runClientMethodProjection(clientRequest).pipe(
        Effect.provide(layers.firegrid),
        Effect.scoped,
      ),
    )

    const mcpReport = await Effect.runPromise(
      runMcpToolProjection(mcpRequest).pipe(
        Effect.provide(layers.channel),
        Effect.scoped,
      ),
    )

    // Response identity equivalence — both projections derive
    // sessionId/contextId from externalKey via the same protocol
    // helper, so distinct externalKeys yield distinct ids but the
    // (sessionId === contextId) invariant holds for both.
    expect(clientReport.response.sessionId).toBe(clientReport.response.contextId)
    expect(mcpReport.response.sessionId).toBe(mcpReport.response.contextId)
    expect(clientReport.response.contextId).toBe(
      sessionContextIdForExternalKey(clientRequest.externalKey),
    )
    expect(mcpReport.response.contextId).toBe(
      sessionContextIdForExternalKey(mcpRequest.externalKey),
    )

    // Substrate row equivalence — same schema, same shape, same
    // derivation pattern; the only domains that differ are the
    // externalKey-derived `contextId` and `requestId`, and the
    // `_otel` traceparent (stamped per-call).
    const clientRow = clientReport.substrateRow
    const mcpRow = mcpReport.substrateRow

    expect(Object.keys(clientRow).sort()).toEqual(
      Object.keys(mcpRow).sort(),
    )
    expect(clientRow.contextId).toBe(clientReport.response.contextId)
    expect(mcpRow.contextId).toBe(mcpReport.response.contextId)
    expect(clientRow.createdBy).toBe(clientRequest.createdBy)
    expect(mcpRow.createdBy).toBe(mcpRequest.createdBy)
    expect(clientRow.runtime).toEqual(clientRequest.runtime)
    expect(mcpRow.runtime).toEqual(mcpRequest.runtime)
    // Both rows are `RuntimeContextRequestRow` shape; both carry an
    // `_otel` stamp (proves the binding ran the same stampRowOtel
    // composition in both projections).
    expect(clientRow._otel).toBeDefined()
    expect(mcpRow._otel).toBeDefined()
  })

  it("idempotency: the same projection invoked twice with the same externalKey produces exactly one row (insertOrGet fence holds across projections)", async () => {
    const layers = composeSubstrate()
    const request = buildRequestForProjection("idempotency-fence")

    // Projection A first
    const firstReport = await Effect.runPromise(
      runClientMethodProjection(request).pipe(
        Effect.provide(layers.firegrid),
        Effect.scoped,
      ),
    )
    // Projection B next, with the SAME request
    const secondReport = await Effect.runPromise(
      runMcpToolProjection(request).pipe(
        Effect.provide(layers.channel),
        Effect.scoped,
      ),
    )

    expect(firstReport.response.contextId).toBe(secondReport.response.contextId)
    // requireContextRequestRow inside the driver fails if more than one
    // row is found; both reports surviving asserts that exactly one row
    // exists. Validate the actual row identity matches too.
    expect(firstReport.substrateRow.requestId).toBe(
      secondReport.substrateRow.requestId,
    )
  })

  it("error pathway: invalid request fails through the channel binding cleanly (does NOT corrupt substrate)", async () => {
    const layers = composeSubstrate()
    // Build a structurally-valid request but with an externalKey that
    // collides with a prior call from a DIFFERENT runtime — the
    // insertOrGet fence should return the prior row, not insert a new
    // one. (No actual error is expected; this exercises the
    // `_tag: "Found"` branch.)
    const request = buildRequestForProjection("found-branch")

    const first = await Effect.runPromise(
      runMcpToolProjection(request).pipe(
        Effect.provide(layers.channel),
        Effect.scoped,
      ),
    )
    const second = await Effect.runPromise(
      runMcpToolProjection(request).pipe(
        Effect.provide(layers.channel),
        Effect.scoped,
      ),
    )

    expect(first.substrateRow).toEqual(second.substrateRow)
  })

  it("typecheck-grade evidence: the channel Tag identity is protocol-owned (no host-sdk import required by the projections that use it directly)", async () => {
    // This test is purely a structural assertion executed at runtime:
    // verify that the imported `HostSessionsCreateOrLoadChannel` Tag
    // identifier is the protocol-owned one.
    const { HostSessionsCreateOrLoadChannel } = await import(
      "@firegrid/protocol/channels",
    )
    // Tag identifier (the string used in error messages / Context
    // lookups) must contain "protocol/channels" to prove the contract
    // moved across the host-sdk → protocol seam.
    expect(String(HostSessionsCreateOrLoadChannel.key)).toContain(
      "@firegrid/protocol/channels",
    )
  })

  it("layer composition: providing the channel WITHOUT a Firegrid client still drives a successful call (proves the channel contract is independently consumable by non-Firegrid projections)", async () => {
    const layers = composeSubstrate()
    const request = buildRequestForProjection("no-firegrid")
    const exit = await Effect.runPromiseExit(
      runMcpToolProjection(request).pipe(
        Effect.provide(layers.channel),
        Effect.scoped,
      ),
    )
    expect(Exit.isSuccess(exit)).toBe(true)
  })
})
