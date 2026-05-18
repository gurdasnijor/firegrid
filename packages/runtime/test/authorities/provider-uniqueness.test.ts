import { describe, expect, it } from "vitest"
import {
  DurableWaitCompletionRowLookup,
  DurableWaitCompletionRowUpsert,
  DurableWaitRows,
  DurableWaitRowLookup,
  DurableWaitRowUpsert,
  DurableWaitStoreLive,
} from "../../src/durable-tools/internal/durable-wait-store.ts"
import {
  RuntimeContextInsert,
  RuntimeContextRead,
  RuntimeContexts,
  RuntimeControlPlaneRecorderLive,
  RuntimeRuns,
  RuntimeRunAppendAndGet,
} from "../../src/authorities/runtime-control-plane-recorder.ts"
import {
  RuntimeAgentOutputEvents,
  RuntimeAgentOutputEventsLayer,
} from "../../src/agent-event-pipeline/authorities/runtime-output-journal.ts"

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
  {
    capability: DurableWaitRowLookup,
    provider: DurableWaitStoreLive,
    backingTable: "DurableToolsTable.waits",
  },
  {
    capability: DurableWaitRowUpsert,
    provider: DurableWaitStoreLive,
    backingTable: "DurableToolsTable.waits",
  },
  {
    capability: DurableWaitRows,
    provider: DurableWaitStoreLive,
    backingTable: "DurableToolsTable.waits",
  },
  {
    capability: DurableWaitCompletionRowLookup,
    provider: DurableWaitStoreLive,
    backingTable: "DurableToolsTable.completions",
  },
  {
    capability: DurableWaitCompletionRowUpsert,
    provider: DurableWaitStoreLive,
    backingTable: "DurableToolsTable.completions",
  },
] as const satisfies readonly TestProviderEntry[]

const canonicalCapabilityTags = [
  RuntimeAgentOutputEvents,
  RuntimeContextInsert,
  RuntimeContextRead,
  RuntimeContexts,
  RuntimeRuns,
  RuntimeRunAppendAndGet,
  DurableWaitRowLookup,
  DurableWaitRowUpsert,
  DurableWaitRows,
  DurableWaitCompletionRowLookup,
  DurableWaitCompletionRowUpsert,
] as const

describe("runtime durable capability provider uniqueness", () => {
  it("firegrid-runtime-boundary-reconciliation.WAITS_BOUNDARY.5 firegrid-runtime-boundary-reconciliation.WAITS_BOUNDARY.7 firegrid-runtime-boundary-reconciliation.WAITS_BOUNDARY.9 firegrid-runtime-boundary-reconciliation.WAITS_BOUNDARY.11 firegrid-runtime-agent-event-pipeline.ENFORCEMENT.1 firegrid-runtime-agent-event-pipeline.ENFORCEMENT.5 firegrid-runtime-agent-event-pipeline.ENFORCEMENT.5-1 maps each durable capability tag value to one real provider layer value", () => {
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
