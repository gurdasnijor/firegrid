import { describe, expect, it } from "vitest"
import {
  DurableWaitCompletionRowLookup,
  DurableWaitCompletionRows,
  DurableWaitCompletionRowUpsert,
  DurableWaitRows,
  DurableWaitRowLookup,
  DurableWaitRowUpsert,
  DurableWaitStoreLive,
} from "../../src/waits/internal/durable-wait-store.ts"
import {
  RuntimeContextInsert,
  RuntimeContextRead,
  RuntimeContexts,
  RuntimeControlPlaneRecorderLive,
  RuntimeRuns,
  RuntimeRunAppendAndGet,
} from "../../src/authorities/runtime-control-plane-recorder.ts"
import {
  RuntimeIngressAppendAndGet,
  RuntimeIngressAppenderLayer,
  RuntimeIngressInputStream,
  RuntimeIngressInputStreamLayer,
} from "../../src/agent-event-pipeline/authorities/runtime-ingress-appender.ts"
import {
  RuntimeIngressDeliveries,
  RuntimeIngressDeliveryClaimAndComplete,
  RuntimeIngressDeliveryTrackerLayer,
} from "../../src/agent-event-pipeline/authorities/runtime-ingress-delivery-tracker.ts"
import {
  RuntimeAgentOutputEvents,
  RuntimeAgentOutputRowSink,
  RuntimeEventAppendAndGet,
  RuntimeLogLineAppendAndGet,
  RuntimeLogLineSink,
  RuntimeOutputEvents,
  RuntimeOutputJournalLayer,
  RuntimeOutputLogs,
} from "../../src/agent-event-pipeline/authorities/runtime-output-journal.ts"
import { RuntimeAuthoritySourceNames } from "../../src/authorities/source-names.ts"

const runtimeOutputEventsSources = [
  RuntimeAuthoritySourceNames.runtimeOutputEvents,
  RuntimeAuthoritySourceNames.agentOutputEvents,
] as const

const runtimeOutputLogsSources = [
  RuntimeAuthoritySourceNames.runtimeOutputLogs,
] as const

const runtimeIngressInputSources = [
  RuntimeAuthoritySourceNames.runtimeIngressInputs,
] as const

const runtimeIngressDeliverySources = [
  RuntimeAuthoritySourceNames.runtimeIngressDeliveries,
] as const

const runtimeControlPlaneSources = [
  RuntimeAuthoritySourceNames.runtimeContexts,
  RuntimeAuthoritySourceNames.runtimeRuns,
] as const

const durableWaitSources = [
  RuntimeAuthoritySourceNames.durableWaits,
  RuntimeAuthoritySourceNames.durableWaitCompletions,
] as const

interface TestProviderEntry {
  readonly capability: object
  readonly provider: unknown
  readonly backingTable: string
  readonly dynamicSourceCollections: readonly string[]
}

const providerEntries = [
  {
    capability: RuntimeEventAppendAndGet,
    provider: RuntimeOutputJournalLayer,
    backingTable: "RuntimeOutputTable.events",
    dynamicSourceCollections: runtimeOutputEventsSources,
  },
  {
    capability: RuntimeAgentOutputRowSink,
    provider: RuntimeOutputJournalLayer,
    backingTable: "RuntimeOutputTable.events",
    dynamicSourceCollections: runtimeOutputEventsSources,
  },
  {
    capability: RuntimeOutputEvents,
    provider: RuntimeOutputJournalLayer,
    backingTable: "RuntimeOutputTable.events",
    dynamicSourceCollections: runtimeOutputEventsSources,
  },
  {
    capability: RuntimeAgentOutputEvents,
    provider: RuntimeOutputJournalLayer,
    backingTable: "RuntimeOutputTable.events",
    dynamicSourceCollections: runtimeOutputEventsSources,
  },
  {
    capability: RuntimeLogLineAppendAndGet,
    provider: RuntimeOutputJournalLayer,
    backingTable: "RuntimeOutputTable.logs",
    dynamicSourceCollections: runtimeOutputLogsSources,
  },
  {
    capability: RuntimeLogLineSink,
    provider: RuntimeOutputJournalLayer,
    backingTable: "RuntimeOutputTable.logs",
    dynamicSourceCollections: runtimeOutputLogsSources,
  },
  {
    capability: RuntimeOutputLogs,
    provider: RuntimeOutputJournalLayer,
    backingTable: "RuntimeOutputTable.logs",
    dynamicSourceCollections: runtimeOutputLogsSources,
  },
  {
    capability: RuntimeIngressAppendAndGet,
    provider: RuntimeIngressAppenderLayer,
    backingTable: "RuntimeIngressTable.inputs",
    dynamicSourceCollections: runtimeIngressInputSources,
  },
  {
    capability: RuntimeIngressInputStream,
    provider: RuntimeIngressInputStreamLayer,
    backingTable: "RuntimeIngressTable.inputs",
    dynamicSourceCollections: runtimeIngressInputSources,
  },
  {
    capability: RuntimeIngressDeliveryClaimAndComplete,
    provider: RuntimeIngressDeliveryTrackerLayer,
    backingTable: "RuntimeIngressTable.deliveries",
    dynamicSourceCollections: runtimeIngressDeliverySources,
  },
  {
    capability: RuntimeIngressDeliveries,
    provider: RuntimeIngressDeliveryTrackerLayer,
    backingTable: "RuntimeIngressTable.deliveries",
    dynamicSourceCollections: runtimeIngressDeliverySources,
  },
  {
    capability: RuntimeContextInsert,
    provider: RuntimeControlPlaneRecorderLive,
    backingTable: "RuntimeControlPlaneTable.contexts",
    dynamicSourceCollections: runtimeControlPlaneSources,
  },
  {
    capability: RuntimeContextRead,
    provider: RuntimeControlPlaneRecorderLive,
    backingTable: "RuntimeControlPlaneTable.contexts",
    dynamicSourceCollections: runtimeControlPlaneSources,
  },
  {
    capability: RuntimeContexts,
    provider: RuntimeControlPlaneRecorderLive,
    backingTable: "RuntimeControlPlaneTable.contexts",
    dynamicSourceCollections: runtimeControlPlaneSources,
  },
  {
    capability: RuntimeRuns,
    provider: RuntimeControlPlaneRecorderLive,
    backingTable: "RuntimeControlPlaneTable.runs",
    dynamicSourceCollections: runtimeControlPlaneSources,
  },
  {
    capability: RuntimeRunAppendAndGet,
    provider: RuntimeControlPlaneRecorderLive,
    backingTable: "RuntimeControlPlaneTable.runs",
    dynamicSourceCollections: runtimeControlPlaneSources,
  },
  {
    capability: DurableWaitRowLookup,
    provider: DurableWaitStoreLive,
    backingTable: "DurableToolsTable.waits",
    dynamicSourceCollections: durableWaitSources,
  },
  {
    capability: DurableWaitRowUpsert,
    provider: DurableWaitStoreLive,
    backingTable: "DurableToolsTable.waits",
    dynamicSourceCollections: durableWaitSources,
  },
  {
    capability: DurableWaitRows,
    provider: DurableWaitStoreLive,
    backingTable: "DurableToolsTable.waits",
    dynamicSourceCollections: durableWaitSources,
  },
  {
    capability: DurableWaitCompletionRowLookup,
    provider: DurableWaitStoreLive,
    backingTable: "DurableToolsTable.completions",
    dynamicSourceCollections: durableWaitSources,
  },
  {
    capability: DurableWaitCompletionRowUpsert,
    provider: DurableWaitStoreLive,
    backingTable: "DurableToolsTable.completions",
    dynamicSourceCollections: durableWaitSources,
  },
  {
    capability: DurableWaitCompletionRows,
    provider: DurableWaitStoreLive,
    backingTable: "DurableToolsTable.completions",
    dynamicSourceCollections: durableWaitSources,
  },
] as const satisfies readonly TestProviderEntry[]

const canonicalCapabilityTags = [
  RuntimeEventAppendAndGet,
  RuntimeAgentOutputRowSink,
  RuntimeOutputEvents,
  RuntimeAgentOutputEvents,
  RuntimeLogLineAppendAndGet,
  RuntimeLogLineSink,
  RuntimeOutputLogs,
  RuntimeIngressAppendAndGet,
  RuntimeIngressInputStream,
  RuntimeIngressDeliveryClaimAndComplete,
  RuntimeIngressDeliveries,
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
  DurableWaitCompletionRows,
] as const

describe("runtime durable capability provider uniqueness", () => {
  it("firegrid-runtime-boundary-reconciliation.WAITS_BOUNDARY.5 firegrid-runtime-boundary-reconciliation.WAITS_BOUNDARY.7 firegrid-runtime-boundary-reconciliation.WAITS_BOUNDARY.9 firegrid-runtime-boundary-reconciliation.WAITS_BOUNDARY.11 firegrid-runtime-agent-event-pipeline.ENFORCEMENT.1 firegrid-runtime-agent-event-pipeline.ENFORCEMENT.5 firegrid-runtime-agent-event-pipeline.ENFORCEMENT.5-1 maps each durable capability tag value to one real provider layer value", () => {
    const tags = providerEntries.map(entry => entry.capability)
    expect(tags).toEqual(canonicalCapabilityTags)
    expect(new Set(tags).size).toBe(tags.length)

    const outputSink = providerEntries.find(entry =>
      entry.capability === RuntimeAgentOutputRowSink,
    )
    expect(outputSink?.provider).toBe(RuntimeOutputJournalLayer)

    const ingressAppend = providerEntries.find(entry =>
      entry.capability === RuntimeIngressAppendAndGet,
    )
    expect(ingressAppend?.provider).toBe(RuntimeIngressAppenderLayer)
  })

  it("firegrid-runtime-agent-event-pipeline.AUTHORITIES.13 firegrid-runtime-agent-event-pipeline.AUTHORITIES.14 firegrid-runtime-agent-event-pipeline.ENFORCEMENT.6 firegrid-runtime-agent-event-pipeline.ENFORCEMENT.7 keeps provider uniqueness as test-local metadata over actual Effect values", () => {
    const sourceNames = providerEntries.flatMap(entry => entry.dynamicSourceCollections)
    expect(sourceNames).toContain(RuntimeAuthoritySourceNames.agentOutputEvents)
    expect(sourceNames).toContain(RuntimeAuthoritySourceNames.runtimeIngressInputs)
    expect(sourceNames).toContain(RuntimeAuthoritySourceNames.runtimeIngressDeliveries)
    expect(sourceNames).toContain(RuntimeAuthoritySourceNames.durableWaits)
    expect(sourceNames).toContain(RuntimeAuthoritySourceNames.durableWaitCompletions)

    const agentOutput = providerEntries.find(entry =>
      entry.capability === RuntimeAgentOutputEvents,
    )
    expect(agentOutput?.dynamicSourceCollections).toContain(
      RuntimeAuthoritySourceNames.agentOutputEvents,
    )
  })
})
