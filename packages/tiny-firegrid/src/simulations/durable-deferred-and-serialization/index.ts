import { defineSimulation } from "../../types.ts"
import { durableDeferredAndSerializationDriver } from "./driver.ts"
import { durableDeferredAndSerializationHost } from "./host.ts"

export default defineSimulation({
  id: "durable-deferred-and-serialization",
  description:
    "Workbench (tf-ogoj): gathers trace data for the SDD §2 simplifying "
    + "hypothesis. H1 drives a standard DurableDeferred await-once round-trip on "
    + "the real DurableStreamsWorkflowEngine (deferred.result/.done spans). H2 "
    + "fires concurrent same-contextId inputs to probe whether idempotencyKey+"
    + "cursor serializes or races. The driver uses only @firegrid/client-sdk; the "
    + "host composes the real FiregridRuntime factory and overrides only the "
    + "inbound session-input channels. The trace is the deliverable (no verdict "
    + "object); the prose finding interprets confirm/reject per hypothesis.",
  host: durableDeferredAndSerializationHost,
  driver: durableDeferredAndSerializationDriver,
})
