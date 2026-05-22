import { Effect, Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  makeCallableChannel,
  makeEgressChannel,
  RouteCompletionReceipt,
  terminalCompletion,
} from "../../src/channels/core.ts"
import {
  channelRouteDescriptor,
  channelRouteMetadata,
  channelRouteVerbsForDirection,
} from "../../src/channels/router.ts"

describe("channel router descriptors", () => {
  it("defines the protocol direction-to-verb matrix", () => {
    expect(channelRouteVerbsForDirection("ingress")).toEqual(["wait_for"])
    expect(channelRouteVerbsForDirection("egress")).toEqual(["send"])
    expect(channelRouteVerbsForDirection("call")).toEqual(["call"])
    expect(channelRouteVerbsForDirection("bidirectional")).toEqual([
      "send",
      "wait_for",
    ])
  })
})

describe("route completion metadata (tf-r6br)", () => {
  const egress = makeEgressChannel({
    target: "test.egress",
    schema: Schema.Struct({ value: Schema.Number }),
    append: () => Effect.void,
  })

  it("defaults a route's completion to acknowledgement", () => {
    expect(channelRouteMetadata(egress).completion).toEqual({
      mode: "acknowledgement",
    })
    expect(channelRouteDescriptor(egress).metadata.completion).toEqual({
      mode: "acknowledgement",
    })
  })

  it("surfaces a route-declared terminal completion contract in metadata", () => {
    const terminalCall = makeCallableChannel({
      target: "test.terminal",
      requestSchema: Schema.Struct({ id: Schema.String }),
      responseSchema: RouteCompletionReceipt,
      completion: terminalCompletion(),
      call: () => Effect.succeed({ _tag: "Done" as const }),
    })
    const completion = channelRouteMetadata(terminalCall).completion
    expect(completion.mode).toBe("terminal")
    // The terminal contract carries a receipt schema, not a caller flag.
    expect(completion).toHaveProperty("receiptSchema")
  })

  it("RouteCompletionReceipt decodes Done and Rejected terminal outcomes", () => {
    const decode = Schema.decodeUnknownSync(RouteCompletionReceipt)
    expect(decode({ _tag: "Done" })).toEqual({ _tag: "Done" })
    expect(decode({ _tag: "Done", detail: "end_turn" })).toEqual({
      _tag: "Done",
      detail: "end_turn",
    })
    expect(decode({ _tag: "Rejected", reason: "denied" })).toEqual({
      _tag: "Rejected",
      reason: "denied",
    })
    expect(() => decode({ _tag: "Pending" })).toThrow()
  })
})
