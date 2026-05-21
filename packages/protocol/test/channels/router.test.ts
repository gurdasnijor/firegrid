import { describe, expect, it } from "vitest"
import {
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
