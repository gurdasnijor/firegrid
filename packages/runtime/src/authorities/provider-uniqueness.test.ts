import { describe, expect, it } from "vitest"
import {
  DurableWaitForMatching,
  DurableWaitAppendAndGet,
  DurableWaitCompletionAppendAndGet,
  DurableWaitStoreLive,
} from "./durable-wait-store.ts"
import {
  RuntimeContextInsert,
  RuntimeContextRead,
  RuntimeContexts,
  RuntimeControlPlaneRecorderLive,
  RuntimeRuns,
  RuntimeRunAppendAndGet,
} from "./runtime-control-plane-recorder.ts"
import {
  RuntimeIngressAppendAndGet,
  RuntimeIngressAppenderLayer,
  RuntimeIngressInputStream,
  RuntimeIngressInputStreamLayer,
} from "./runtime-ingress-appender.ts"
import {
  RuntimeIngressDeliveries,
  RuntimeIngressDeliveryClaimAndComplete,
  RuntimeIngressDeliveryTrackerLayer,
} from "./runtime-ingress-delivery-tracker.ts"
import {
  RuntimeAgentOutputEvents,
  RuntimeAgentOutputRowSink,
  RuntimeEventAppendAndGet,
  RuntimeLogLineAppendAndGet,
  RuntimeLogLineSink,
  RuntimeOutputEvents,
  RuntimeOutputJournalLayer,
  RuntimeOutputLogs,
} from "./runtime-output-journal.ts"
import { RuntimeAuthoritySourceNames } from "./source-names.ts"
import { DurableToolsWaitForLive } from "../waits/DurableToolsWaitFor.ts"

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
    capability: DurableWaitAppendAndGet,
    provider: DurableWaitStoreLive,
    backingTable: "DurableToolsTable.waits",
    dynamicSourceCollections: durableWaitSources,
  },
  {
    capability: DurableWaitCompletionAppendAndGet,
    provider: DurableWaitStoreLive,
    backingTable: "DurableToolsTable.completions",
    dynamicSourceCollections: durableWaitSources,
  },
  {
    capability: DurableWaitForMatching,
    provider: DurableToolsWaitForLive,
    backingTable: "DurableToolsTable",
    dynamicSourceCollections: durableWaitSources,
  },
] as const satisfies readonly TestProviderEntry[]

describe("runtime durable capability provider uniqueness", () => {
  it("firegrid-runtime-agent-event-pipeline.ENFORCEMENT.1 firegrid-runtime-agent-event-pipeline.ENFORCEMENT.5 firegrid-runtime-agent-event-pipeline.ENFORCEMENT.5-1 maps each durable capability tag value to one real provider layer value", () => {
    const tags = providerEntries.map(entry => entry.capability)
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
