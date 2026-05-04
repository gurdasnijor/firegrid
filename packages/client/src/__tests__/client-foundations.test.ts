import { describe, expect, it } from "vitest"
import * as ClientSurface from "../index.js"

// launchable-substrate-host.CLIENT_SURFACE.7
// The client root must not expose raw stream append, raw StreamDB
// collections, raw durable row builders, or raw Durable Streams State
// envelopes. This guard pins the v1 export surface against accidental
// expansion.
describe("launchable-substrate-host.CLIENT_SURFACE.7 — client root does not expose raw stream / row-builder / DSS escape hatches", () => {
  it("the @durable-agent-substrate/client root surface contains no banned identifier vocabulary", () => {
    const banned = [
      // raw stream / DSS APIs
      "DurableStream",
      "createStateSchema",
      "openSubstrateDb",
      "rebuildProjection",
      "stream",
      // raw row builders
      "createPendingCompletion",
      "resolveCompletion",
      "rejectCompletion",
      "cancelCompletion",
      "startRun",
      "blockRun",
      "completeRun",
      "failRun",
      "cancelRun",
      "substrateState",
      "RunValue",
      "CompletionValue",
      "ClaimAttemptValue",
      // operator pipelines
      "Work",
      "WorkClaim",
      "WorkClaimLive",
      "processReadyWorkItem",
      // producer internals leaked
      "WorkProducer",
      "CompletionProducer",
      "SubstrateProducerLive",
    ]
    const surface = Object.keys(ClientSurface)
    const offenders = banned.filter((b) => surface.includes(b))
    expect(offenders).toEqual([])
  })
})

// launchable-substrate-host.CLIENT_SURFACE.2
// launchable-substrate-host.PACKAGING.7
// The v1 client root surface is Effect-native: SubstrateClient is a
// Context.Tag and SubstrateClientLive is a Layer factory. This test
// pins both shapes.
describe("launchable-substrate-host.CLIENT_SURFACE.2 — first substrate client surface is Effect-native", () => {
  it("SubstrateClient is a Context.Tag and SubstrateClientLive is a callable Layer factory", () => {
    expect(typeof ClientSurface.SubstrateClient).toBe("function")
    expect(typeof ClientSurface.SubstrateClientLive).toBe("function")
    const layer = ClientSurface.SubstrateClientLive({
      streamUrl: "http://example.invalid/substrate/none",
      clientId: "smoke",
    })
    expect(layer).toBeTypeOf("object")
  })
})

// launchable-substrate-host.CLIENT_SURFACE.13
// v1 client choreography surface is intentionally NOT yet present at
// the root: scheduleAt lands in Slice 3, and sleep / waitFor /
// awaitAwakeable are server-side runtime primitives that never enter
// the client root.
describe("launchable-substrate-host.CLIENT_SURFACE.13 — v1 client root does not expose sleep / waitFor / awaitAwakeable", () => {
  it("the client root surface contains no run-internal choreography accessors", () => {
    const banned = ["sleep", "waitFor", "awaitAwakeable", "Choreography"]
    const surface = Object.keys(ClientSurface)
    const offenders = banned.filter((b) => surface.includes(b))
    expect(offenders).toEqual([])
  })
})
