import { describe, expect, it } from "vitest"
import {
  RuntimeAuthorityRegistry,
  RuntimeAuthorityRegistryByCollection,
} from "./registry.ts"
import { RuntimeAuthoritySourceNames } from "./source-names.ts"
import { runtimeIngressSubscriberId } from "./runtime-ingress-delivery-tracker.ts"

describe("runtime authority registry", () => {
  it("firegrid-runtime-agent-event-pipeline.ENFORCEMENT.1 maps each runtime-owned collection family to one authority", () => {
    const families = RuntimeAuthorityRegistry.map(entry => entry.collectionFamily)
    expect(new Set(families).size).toBe(families.length)
    expect(families).toEqual([
      "RuntimeOutputTable.events",
      "RuntimeOutputTable.logs",
      "RuntimeIngressTable.inputs",
      "RuntimeIngressTable.deliveries",
      "RuntimeControlPlaneTable.contexts",
      "RuntimeControlPlaneTable.runs",
      "DurableToolsTable.waits",
      "DurableToolsTable.completions",
    ])

    expect(RuntimeAuthorityRegistryByCollection.get("RuntimeIngressTable.inputs")?.authorityModule)
      .toBe("packages/runtime/src/authorities/runtime-ingress-appender.ts")
    expect(RuntimeAuthorityRegistryByCollection.get("RuntimeOutputTable.events")?.writeApi)
      .toContain("RuntimeOutputJournal.agentOutputSink")
  })

  it("firegrid-runtime-agent-event-pipeline.AUTHORITIES.8 firegrid-runtime-agent-event-pipeline.AUTHORITIES.9 declares read/observation SourceCollectionHandle names", () => {
    const sourceNames = RuntimeAuthorityRegistry.flatMap(entry => entry.readSourceCollections)
    expect(sourceNames).toContain(RuntimeAuthoritySourceNames.agentOutputEvents)
    expect(sourceNames).toContain(RuntimeAuthoritySourceNames.runtimeIngressInputs)
    expect(sourceNames).toContain(RuntimeAuthoritySourceNames.runtimeIngressDeliveries)
    expect(sourceNames).toContain(RuntimeAuthoritySourceNames.durableWaits)
    expect(sourceNames).toContain(RuntimeAuthoritySourceNames.durableWaitCompletions)
  })

  it("firegrid-runtime-agent-event-pipeline.AUTHORITIES.4-2 creates runtime ingress subscriber ids with the required namespace", () => {
    expect(runtimeIngressSubscriberId("stdio-jsonl", "codec"))
      .toBe("runtime-ingress:stdio-jsonl:codec")
  })
})
