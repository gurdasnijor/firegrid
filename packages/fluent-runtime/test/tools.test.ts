import { describe, expect, it } from "vitest"
import type { DurableToolCatalog, ToolInvocationRecord } from "../src/Tools.ts"
import { makeMcpToolTransport, makeToolGateway, makeToolTransport } from "../src/Tools.ts"

// Fake tool catalog/handlers — valid only below the acceptance layer. The
// real-harness E2E (a real native/ACP harness discovering + invoking the tools
// over a real transport) is creds-gated; see fluent-mcp-tools-out.feature.

interface HarnessFixture {
  readonly catalog: DurableToolCatalog
  readonly handlerCalls: () => number
  readonly records: ReadonlyArray<ToolInvocationRecord>
}

const makeFixture = (): HarnessFixture & {
  readonly recordInvocation: (r: ToolInvocationRecord) => void
} => {
  let handlerCalls = 0
  const records: Array<ToolInvocationRecord> = []
  const catalog: DurableToolCatalog = [
    {
      name: "wait_for",
      description: "Wait until a host-declared channel emits a matching row.",
      handler: (args) => {
        handlerCalls += 1
        return { matched: true, echo: args }
      },
    },
  ]
  return {
    catalog,
    handlerCalls: () => handlerCalls,
    records,
    recordInvocation: (r) => records.push(r),
  }
}

describe("fluent MCP tools out — non-invasive durable tool surface", () => {
  it("a real harness discovers a durable tool, invokes it via its own tool path, and the invocation is recorded durably", async () => {
    const fx = makeFixture()
    const gateway = makeToolGateway(fx.catalog, { recordInvocation: fx.recordInvocation })
    const transport = makeMcpToolTransport(gateway)

    // discovery — the harness "asks for tools"
    expect(transport.listTools()).toContain("wait_for")

    // invocation — through the harness's own tool-call path (transport.invokeTool)
    const result = await transport.invokeTool("wait_for", { channel: "github.pr.merged" })
    expect(result).toEqual({ matched: true, echo: { channel: "github.pr.merged" } })

    // recorded durably, with harness provenance
    expect(fx.records).toHaveLength(1)
    expect(fx.records[0]).toMatchObject({
      name: "wait_for",
      args: { channel: "github.pr.merged" },
      via: "harness",
      transport: "mcp-over-durable-streams",
    })
  })

  it("Firegrid does not drive an owned model loop: nothing runs until the harness invokes", async () => {
    const fx = makeFixture()
    const gateway = makeToolGateway(fx.catalog, { recordInvocation: fx.recordInvocation })
    const transport = makeMcpToolTransport(gateway)

    // Exposing the catalog must NOT initiate anything — no handler call, no
    // record, no agent.run. Firegrid only acts on a harness-initiated call.
    expect(fx.handlerCalls()).toBe(0)
    expect(fx.records).toHaveLength(0)

    // Exactly one handler run + one record per harness invocation — and the
    // gateway has no harness/loop reference by construction (can't force a call).
    await transport.invokeTool("wait_for", { channel: "x" })
    expect(fx.handlerCalls()).toBe(1)
    expect(fx.records).toHaveLength(1)
  })

  it("tool transport is replaceable: a different compatible transport over the same gateway yields identical semantics", async () => {
    const fx = makeFixture()
    const gateway = makeToolGateway(fx.catalog, { recordInvocation: fx.recordInvocation })

    const mcp = makeMcpToolTransport(gateway)
    const alt = makeToolTransport("grpc-over-durable-streams", gateway)

    const viaMcp = await mcp.invokeTool("wait_for", { channel: "c" })
    const viaAlt = await alt.invokeTool("wait_for", { channel: "c" })

    // Identical durable-tool semantics across transports …
    expect(viaAlt).toEqual(viaMcp)
    expect(alt.listTools()).toEqual(mcp.listTools())
    // … differing only in the recorded transport id (the replaceable part).
    expect(fx.records.map((r) => ({ name: r.name, args: r.args, result: r.result, via: r.via })))
      .toEqual([
        { name: "wait_for", args: { channel: "c" }, result: viaMcp, via: "harness" },
        { name: "wait_for", args: { channel: "c" }, result: viaAlt, via: "harness" },
      ])
    expect(fx.records.map((r) => r.transport)).toEqual([
      "mcp-over-durable-streams",
      "grpc-over-durable-streams",
    ])
  })

  it("an unknown tool name is rejected, not silently driven", async () => {
    const fx = makeFixture()
    const transport = makeMcpToolTransport(
      makeToolGateway(fx.catalog, { recordInvocation: fx.recordInvocation }),
    )
    await expect(transport.invokeTool("nope", {})).rejects.toThrow("unknown durable tool: nope")
    expect(fx.records).toHaveLength(0)
  })
})
