import { describe, expect, it } from "vitest"
import {
  RuntimeContextInsert,
  RuntimeContextRead,
  RuntimeContexts,
  RuntimeControlPlaneRecorderLive,
  RuntimeRuns,
  RuntimeRunAppendAndGet,
} from "../../src/tables/runtime-control-plane.ts"
import {
  RuntimeAgentOutputEvents,
  RuntimeAgentOutputEventsLayer,
} from "../../src/tables/runtime-output.ts"

interface TestProviderEntry {
  readonly capability: object
  readonly provider: unknown
  readonly backingTable: string
}

const providerEntries = [
  {
    capability: RuntimeAgentOutputEvents,
    provider: RuntimeAgentOutputEventsLayer,
    backingTable: "RuntimeOutputTable.events",
  },
  {
    capability: RuntimeContextInsert,
    provider: RuntimeControlPlaneRecorderLive,
    backingTable: "RuntimeControlPlaneTable.contexts",
  },
  {
    capability: RuntimeContextRead,
    provider: RuntimeControlPlaneRecorderLive,
    backingTable: "RuntimeControlPlaneTable.contexts",
  },
  {
    capability: RuntimeContexts,
    provider: RuntimeControlPlaneRecorderLive,
    backingTable: "RuntimeControlPlaneTable.contexts",
  },
  {
    capability: RuntimeRuns,
    provider: RuntimeControlPlaneRecorderLive,
    backingTable: "RuntimeControlPlaneTable.runs",
  },
  {
    capability: RuntimeRunAppendAndGet,
    provider: RuntimeControlPlaneRecorderLive,
    backingTable: "RuntimeControlPlaneTable.runs",
  },
] as const satisfies readonly TestProviderEntry[]

const canonicalCapabilityTags = [
  RuntimeAgentOutputEvents,
  RuntimeContextInsert,
  RuntimeContextRead,
  RuntimeContexts,
  RuntimeRuns,
  RuntimeRunAppendAndGet,
] as const

describe("runtime durable capability provider uniqueness", () => {
  it("firegrid-runtime-agent-event-pipeline.ENFORCEMENT.1 firegrid-runtime-agent-event-pipeline.ENFORCEMENT.5 maps each durable capability tag value to one real provider layer value", () => {
    const tags = providerEntries.map(entry => entry.capability)
    expect(tags).toEqual(canonicalCapabilityTags)
    expect(new Set(tags).size).toBe(tags.length)

    const outputEvents = providerEntries.find(entry =>
      entry.capability === RuntimeAgentOutputEvents,
    )
    expect(outputEvents?.provider).toBe(RuntimeAgentOutputEventsLayer)

    expect(outputEvents?.backingTable).toBe("RuntimeOutputTable.events")
  })
})
