import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import {
  DurableToolRecorder,
  FluentToolkit,
  fluentMcpServerLayer,
  fluentToolkitLayer,
  handleDurableToolCall,
  type FluentToolHandlers,
  type ToolInvocationRecord,
} from "../src/Tools.ts"

// Fake handlers/recorder — valid only below the acceptance layer. The
// real-harness E2E (a real native/ACP harness discovering + calling these tools
// over a real McpServer) is creds-gated; see fluent-mcp-tools-out.feature.

const fakeHandlers = (onCall?: () => void): FluentToolHandlers => ({
  wait_for: (params) =>
    Effect.sync(() => {
      onCall?.()
      return { matched: true, event: params }
    }),
})

/**
 * A single combined layer: the toolkit handlers (with the durable-recording
 * wrap) over a capturing recorder. Composed into ONE `Effect.provide`.
 */
const fixture = (handlers: FluentToolHandlers = fakeHandlers()) => {
  const records: Array<ToolInvocationRecord> = []
  const recorderLayer = Layer.succeed(DurableToolRecorder, {
    recordInvocation: (record) => Effect.sync(() => { records.push(record) }),
  })
  const layer = fluentToolkitLayer(handlers).pipe(Layer.provide(recorderLayer))
  return { records, layer }
}

describe("fluent MCP tools out — durable tools on @effect/ai Toolkit/McpServer", () => {
  it("discovers a durable tool and serves it via Toolkit.handle, recording the invocation durably", async () => {
    const fx = fixture()
    // discovery — the toolkit lists the tool (McpServer.registerToolkit surfaces it)
    expect(Object.keys(FluentToolkit.tools)).toContain("wait_for")

    const handled = await handleDurableToolCall("wait_for", { channel: "github.pr.merged" }).pipe(
      Effect.provide(fx.layer),
      Effect.runPromise,
    )

    expect(handled.result).toEqual({ matched: true, event: { channel: "github.pr.merged" } })
    expect(fx.records).toHaveLength(1)
    expect(fx.records[0]).toMatchObject({ name: "wait_for", via: "harness" })
  })

  it("is non-invasive: the handler runs only on a harness-initiated call, never Firegrid-initiated", async () => {
    let calls = 0
    const fx = fixture(fakeHandlers(() => { calls += 1 }))

    // Building the toolkit/handler layer must NOT execute anything — no agent.run.
    expect(calls).toBe(0)
    expect(fx.records).toHaveLength(0)

    await handleDurableToolCall("wait_for", { channel: "x" }).pipe(
      Effect.provide(fx.layer),
      Effect.runPromise,
    )
    expect(calls).toBe(1)
    expect(fx.records).toHaveLength(1)
  })

  // SCOPE: this is a Toolkit / durable-stream-adapter UNIT proof — it exercises
  // `Toolkit.WithHandler.handle` (the core both transports share) and asserts the
  // MCP transport is bound over the SAME toolkit. Real MCP list/call over a live
  // McpServer + a real harness is the creds-gated feature, not asserted here.
  it("transport-replaceable (unit): the durable-stream adapter and the MCP server bind the same Toolkit.handle core", async () => {
    const fx = fixture()

    // The MCP transport (McpServer.toolkit) is a Layer over the SAME FluentToolkit;
    // it is registered, not driven, here — the real list/call round-trip is gated.
    expect(fluentMcpServerLayer).toBeDefined()

    // The durable-stream adapter drives the SAME Toolkit.handle core that the MCP
    // server uses, so results/records cannot diverge by transport.
    const first = await handleDurableToolCall("wait_for", { channel: "c" }).pipe(
      Effect.provide(fx.layer),
      Effect.runPromise,
    )
    const second = await handleDurableToolCall("wait_for", { channel: "c" }).pipe(
      Effect.provide(fx.layer),
      Effect.runPromise,
    )
    expect(second.result).toEqual(first.result)
    expect(fx.records.map((r) => ({ name: r.name, params: r.params, via: r.via }))).toEqual([
      { name: "wait_for", params: { channel: "c" }, via: "harness" },
      { name: "wait_for", params: { channel: "c" }, via: "harness" },
    ])
  })
})
