import { describe, expect, it } from "vitest"
import * as RuntimeRoot from "../src/index.ts"
import * as ControlPlane from "../src/control-plane/index.ts"
import * as RuntimeOutput from "../src/agent-event-pipeline/authorities/runtime-output-public.ts"

// tf-bffo boundary enforcement: "channels are the only doorway".
//
// The control-plane authority write-owner tags and the agent-output journal
// internals are kernel internals — the commit points for durable collection
// families. Code ABOVE the substrate boundary (apps, client-sdk, cli) reaches
// durable state through CHANNELS, never through these service doors. They must
// therefore NOT appear on the broad public surface (`@firegrid/runtime`), even
// though internal host composition still wires them through the
// `@firegrid/runtime/control-plane` and `@firegrid/runtime/runtime-output`
// subpaths.
describe("@firegrid/runtime public surface boundary", () => {
  const kernelInternals = [
    "RuntimeControlPlaneRecorderLive",
    "RuntimeContextInsert",
    "RuntimeContextInsertLive",
    "RuntimeContexts",
    "RuntimeContextRead",
    "RuntimeLocalContextResolver",
    "RuntimeRuns",
    "RuntimeRunAppendAndGet",
    "RuntimeAgentOutputAfterEvents",
    "RuntimeAgentOutputEvents",
    "RuntimeAgentOutputEventsLayer",
    "RuntimeAuthorityAgentOutputObservation",
  ] as const

  it("does not expose kernel write-owner authority tags on the root barrel", () => {
    const surface = RuntimeRoot as Record<string, unknown>
    for (const name of kernelInternals) {
      expect(
        name in surface,
        `@firegrid/runtime must not export kernel internal "${name}" — above-box code reaches durable state through channels, not authority tags`,
      ).toBe(false)
    }
  })

  it("keeps the internal composition path working through the control-plane subpath", () => {
    const controlPlane = ControlPlane as Record<string, unknown>
    expect(controlPlane.RuntimeContextInsert).toBeDefined()
    expect(controlPlane.RuntimeControlPlaneRecorderLive).toBeDefined()
    expect(controlPlane.RuntimeRuns).toBeDefined()
  })

  it("keeps the internal observation read working through the runtime-output subpath", () => {
    const runtimeOutput = RuntimeOutput as Record<string, unknown>
    expect(runtimeOutput.RuntimeAgentOutputAfterEvents).toBeDefined()
  })
})
