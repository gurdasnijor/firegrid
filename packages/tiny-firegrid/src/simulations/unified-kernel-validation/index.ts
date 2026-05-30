import { defineSimulation } from "../../types.ts"
import { unifiedKernelValidationDriver } from "./driver.ts"
import { unifiedKernelValidationHost } from "./host.ts"

export default defineSimulation({
  id: "unified-kernel-validation",
  description:
    "Validates that the entire firegrid product surface (spawn / input / "
    + "tool / permission / scheduled / webhook / peer event / terminal) "
    + "can be delivered from three primitives: @effect/workflow, "
    + "effect-durable-operators' DurableTable, and the durable Signal "
    + "primitive defined locally (standard durable-execution capability — "
    + "Temporal Signals / Restate Awakeables / SFN task tokens). Drives "
    + "13 runtime probes (signal happy path + crash recovery + bounded "
    + "ownership; session lifecycle + memoized spawn + crash recovery; "
    + "permission roundtrip; tool dispatch idempotency; scheduled prompts; "
    + "webhook ingest + observer; webhook bad-HMAC rejection; peer event + "
    + "observer; end-to-end product surface) through the real "
    + "DurableStreamsWorkflowEngine, then runs 12 structural collapse-"
    + "invariant scans over the simulation source asserting absence of "
    + "every retired Shape C / DurableDeferred-mailbox pattern. Acts as a "
    + "clean-room rebuild base: take this folder and you can delete the "
    + "production subscriber surface and rebuild on top.",
  host: unifiedKernelValidationHost,
  driver: unifiedKernelValidationDriver,
})
