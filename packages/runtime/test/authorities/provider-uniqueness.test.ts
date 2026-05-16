import { describe, expect, it } from "vitest"
import {
  DurableWaitCompletionRowLookup,
  DurableWaitCompletionRows,
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

interface TestProviderEntry {
  readonly capability: object
  readonly provider: unknown
  readonly backingTable: string
}

const providerEntries = [
  {
    capability: RuntimeEventAppendAndGet,
    provider: RuntimeOutputJournalLayer,
    backingTable: "RuntimeOutputTable.events",
  },
  {
    capability: RuntimeAgentOutputRowSink,
    provider: RuntimeOutputJournalLayer,
    backingTable: "RuntimeOutputTable.events",
  },
  {
    capability: RuntimeOutputEvents,
    provider: RuntimeOutputJournalLayer,
    backingTable: "RuntimeOutputTable.events",
  },
  {
    capability: RuntimeAgentOutputEvents,
    provider: RuntimeOutputJournalLayer,
    backingTable: "RuntimeOutputTable.events",
  },
  {
    capability: RuntimeLogLineAppendAndGet,
    provider: RuntimeOutputJournalLayer,
    backingTable: "RuntimeOutputTable.logs",
  },
  {
    capability: RuntimeLogLineSink,
    provider: RuntimeOutputJournalLayer,
    backingTable: "RuntimeOutputTable.logs",
  },
  {
    capability: RuntimeOutputLogs,
    provider: RuntimeOutputJournalLayer,
    backingTable: "RuntimeOutputTable.logs",
  },
  {
    capability: RuntimeIngressAppendAndGet,
    provider: RuntimeIngressAppenderLayer,
    backingTable: "RuntimeIngressTable.inputs",
  },
  {
    capability: RuntimeIngressInputStream,
    provider: RuntimeIngressInputStreamLayer,
    backingTable: "RuntimeIngressTable.inputs",
  },
  {
    capability: RuntimeIngressDeliveryClaimAndComplete,
    provider: RuntimeIngressDeliveryTrackerLayer,
    backingTable: "RuntimeIngressTable.deliveries",
  },
  {
    capability: RuntimeIngressDeliveries,
    provider: RuntimeIngressDeliveryTrackerLayer,
    backingTable: "RuntimeIngressTable.deliveries",
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
  {
    capability: DurableWaitCompletionRows,
    provider: DurableWaitStoreLive,
    backingTable: "DurableToolsTable.completions",
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
})
