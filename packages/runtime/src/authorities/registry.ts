import { RuntimeAuthoritySourceNames } from "./source-names.ts"

export interface RuntimeAuthorityRegistryEntry {
  readonly collectionFamily: string
  readonly authorityModule: string
  readonly writeApi: readonly string[]
  readonly readSourceCollections: readonly string[]
}

export const RuntimeAuthorityRegistry = [
  {
    collectionFamily: "RuntimeOutputTable.events",
    authorityModule: "packages/runtime/src/authorities/runtime-output-journal.ts",
    writeApi: ["RuntimeOutputJournal.writeEvent", "RuntimeOutputJournal.agentOutputSink"],
    readSourceCollections: [
      RuntimeAuthoritySourceNames.runtimeOutputEvents,
      RuntimeAuthoritySourceNames.agentOutputEvents,
    ],
  },
  {
    collectionFamily: "RuntimeOutputTable.logs",
    authorityModule: "packages/runtime/src/authorities/runtime-output-journal.ts",
    writeApi: ["RuntimeOutputJournal.writeLog", "RuntimeOutputJournal.logSink"],
    readSourceCollections: [RuntimeAuthoritySourceNames.runtimeOutputLogs],
  },
  {
    collectionFamily: "RuntimeIngressTable.inputs",
    authorityModule: "packages/runtime/src/authorities/runtime-ingress-appender.ts",
    writeApi: ["RuntimeIngressAppender.append"],
    readSourceCollections: [RuntimeAuthoritySourceNames.runtimeIngressInputs],
  },
  {
    collectionFamily: "RuntimeIngressTable.deliveries",
    authorityModule: "packages/runtime/src/authorities/runtime-ingress-delivery-tracker.ts",
    writeApi: [
      "RuntimeIngressDeliveryTracker.claimInput",
      "RuntimeIngressDeliveryTracker.recordCompleted",
    ],
    readSourceCollections: [RuntimeAuthoritySourceNames.runtimeIngressDeliveries],
  },
  {
    collectionFamily: "RuntimeControlPlaneTable.contexts",
    authorityModule: "packages/runtime/src/authorities/runtime-control-plane-recorder.ts",
    writeApi: ["RuntimeControlPlaneRecorder.insertLocalContext"],
    readSourceCollections: [RuntimeAuthoritySourceNames.runtimeContexts],
  },
  {
    collectionFamily: "RuntimeControlPlaneTable.runs",
    authorityModule: "packages/runtime/src/authorities/runtime-control-plane-recorder.ts",
    writeApi: [
      "RuntimeControlPlaneRecorder.recordStarted",
      "RuntimeControlPlaneRecorder.recordExited",
      "RuntimeControlPlaneRecorder.recordFailed",
    ],
    readSourceCollections: [RuntimeAuthoritySourceNames.runtimeRuns],
  },
  {
    collectionFamily: "DurableToolsTable.waits",
    authorityModule: "packages/runtime/src/authorities/durable-wait-store.ts",
    writeApi: ["DurableWaitStore.upsertWait"],
    readSourceCollections: [RuntimeAuthoritySourceNames.durableWaits],
  },
  {
    collectionFamily: "DurableToolsTable.completions",
    authorityModule: "packages/runtime/src/authorities/durable-wait-store.ts",
    writeApi: ["DurableWaitStore.upsertCompletion"],
    readSourceCollections: [RuntimeAuthoritySourceNames.durableWaitCompletions],
  },
] as const satisfies readonly RuntimeAuthorityRegistryEntry[]

export const RuntimeAuthorityRegistryByCollection = new Map(
  RuntimeAuthorityRegistry.map(entry => [entry.collectionFamily, entry]),
)
