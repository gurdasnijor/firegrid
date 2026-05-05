import { describe, expect, it } from "vitest"
import * as SubstrateRoot from "../index.ts"
import * as SubstrateKernel from "../kernel/index.ts"

// firegrid-remediation-hardening.PUBLIC_SURFACES.2
// firegrid-remediation-hardening.PUBLIC_SURFACES.5
// firegrid-remediation-hardening.TEST_GUARDRAILS.1
// firegrid-architecture-boundary.SURFACE_AREA.1
describe("firegrid-remediation-hardening.PUBLIC_SURFACES — substrate root is curated", () => {
  it("exports only descriptor, facade, EventStream, and choreography vocabulary from the root", () => {
    const allowed = new Set([
      "AwakeableToolInput",
      "Choreography",
      "ChoreographyLive",
      "ChoreographyTimeout",
      "ChoreographyTools",
      "ChoreographyTrigger",
      "ChoreographyProjectionMatchTrigger",
      "CompletionId",
      "CurrentWorkContext",
      "EventStream",
      "MissingTriggerMatcherError",
      "Operation",
      "OperationHandle",
      "OwnerId",
      "Projection",
      "ProjectionLive",
      "ProjectionReadError",
      "ProjectionWaitTimeout",
      "ScheduleMeToolInput",
      "SleepToolInput",
      "TriggerMatchers",
      "WaitForToolInput",
      "Work",
      "WorkClaim",
      "WorkClaimError",
      "WorkClaimLive",
      "WorkId",
      "currentWorkContextLayer",
      "dispatchTrigger",
      "triggerMatchersLayer",
    ])
    expect(new Set(Object.keys(SubstrateRoot))).toEqual(allowed)
  })

  it("keeps raw kernel internals behind the explicit kernel subpath", () => {
    const root = SubstrateRoot as unknown as Record<string, unknown>
    const kernel = SubstrateKernel as unknown as Record<string, unknown>
    for (const symbol of [
      "CompletionProducer",
      "SubstrateProducerLive",
      "WorkProducer",
      "createPendingCompletion",
      "startRun",
      "completeRun",
      "failRun",
      "openSubstrateDb",
      "rebuildProjection",
      "readRetainedRunRecords",
      "processReadyWorkItem",
      "runTimerSubscriber",
      "DurableWaits",
      "RunValue",
      "CompletionValue",
      "substrateState",
      "EVENT_STREAM_ENVELOPE_TAG",
      "OPERATION_ENVELOPE_TAG",
      "makeEventStreamStateRow",
    ]) {
      expect(root[symbol]).toBeUndefined()
      expect(kernel[symbol]).toBeDefined()
    }
  })
})
