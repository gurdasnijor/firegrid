import { Effect } from "effect"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as EventPlanePublic from "../event-plane/index.ts"
import * as SubstrateRoot from "../index.ts"
import * as SubstrateKernel from "../kernel/index.ts"
import * as ProjectionCompat from "../projection.ts"
import * as ReadyWorkCompat from "../projection/ready-work.ts"
import * as ProjectionServiceCompat from "../projection-service.ts"
import * as RetainedCompat from "../retained-records.ts"
import * as StreamCompat from "../stream.ts"
import * as ReadModelProjection from "../read-models/projection.ts"
import * as ReadModelReadyWork from "../read-models/ready-work.ts"
import * as ReadModelProjectionService from "../read-models/projection-service.ts"
import * as StateStoreRetained from "../state-store/retained-records.ts"
import * as StateStoreStream from "../state-store/stream.ts"

// firegrid-remediation-hardening.PUBLIC_SURFACES.2
// firegrid-remediation-hardening.PUBLIC_SURFACES.5
// firegrid-remediation-hardening.TEST_GUARDRAILS.1
// firegrid-architecture-boundary.SURFACE_AREA.1
describe("firegrid-remediation-hardening.PUBLIC_SURFACES — substrate root is curated", () => {
  it("exports only descriptor, facade, EventStream, and run-wait vocabulary from the root", () => {
    const allowed = new Set([
      "CompletionId",
      "CurrentWorkContext",
      "EventStream",
      "MissingTriggerMatcherError",
      "Operation",
      "OperationHandle",
      "OwnerId",
      "Projection",
      "ProjectionMatchTrigger",
      "ProjectionLive",
      "ProjectionReadError",
      "ProjectionWaitTimeout",
      "RunWait",
      "TriggerMatchers",
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

  it("run-wait-primitives.RUN_WAIT_API.1, run-wait-primitives.BOUNDARY.2, run-wait-primitives.BOUNDARY.3, run-wait-primitives.BOUNDARY.5 — RunWait exposes only app-facing primitive methods and a Layer constructor", () => {
    expect(typeof SubstrateRoot.RunWait.layer).toBe("function")
    const methodNames = Object.keys(
      SubstrateRoot.RunWait.of({
        for: () => Effect.void,
        sleep: () => Effect.void,
        until: () =>
          Effect.succeed({
            completionId: SubstrateRoot.CompletionId("completion"),
            whenMs: 0,
          }),
        awakeable: () => Effect.never,
      }),
    )
    expect(methodNames).toStrictEqual(["for", "sleep", "until", "awakeable"])
    for (const forbidden of [
      "append",
      "blockRun",
      "completionId",
      "createPendingCompletion",
      "runId",
      "streamUrl",
    ]) {
      expect(methodNames).not.toContain(forbidden)
    }
  })
})

describe("client-event-plane-registration.EVENT_PLANE_DEFINITION.5 — EventPlane public subpath", () => {
  it("exports EventPlane through @firegrid/substrate/event-plane without bloating the curated root", () => {
    const packageJson = JSON.parse(
      readFileSync(join(import.meta.dirname, "../../package.json"), "utf8"),
    ) as {
      readonly exports?: Record<
        string,
        { readonly types: string; readonly default: string }
      >
    }

    expect(packageJson.exports?.["./event-plane"]).toEqual({
      types: "./dist/event-plane/index.d.ts",
      default: "./dist/event-plane/index.js",
    })
    expect("EventPlane" in SubstrateRoot).toBe(false)
    expect(typeof EventPlanePublic.EventPlane.define).toBe("function")
    expect(typeof EventPlanePublic.EventPlane.layer).toBe("function")
  })

  it("client-event-plane-registration.BOUNDARY.6 — EventPlane exposes stateful plane services while EventStream remains the root lightweight descriptor surface", () => {
    const eventPlaneSymbols = Object.keys(EventPlanePublic)
    expect(eventPlaneSymbols).toEqual(
      expect.arrayContaining([
        "EventPlane",
        "PlaneProducerError",
        "PlaneProducerUnknownTypeError",
        "PlaneProducerValidationError",
        "PlaneProjectionReadError",
        "PlaneProjectionWaitTimeout",
      ]),
    )
    expect(SubstrateRoot.EventStream).toBeDefined()
    for (const forbidden of [
      "DurableStream",
      "appendChange",
      "acquirePlaneDb",
      "buildPlaneProjectionFromDb",
      "collectionsByType",
      "makePlaneProducer",
      "substrateState",
    ]) {
      expect(eventPlaneSymbols).not.toContain(forbidden)
    }
  })
})

describe("W4B substrate state-store/read-model paths", () => {
  it("keeps compatibility exports wired to the semantic implementation modules", () => {
    expect(ProjectionCompat.FOLD_VERSION).toBe(ReadModelProjection.FOLD_VERSION)
    expect(ProjectionCompat.snapshotFromDb).toBe(ReadModelProjection.snapshotFromDb)
    expect(ProjectionServiceCompat.buildProjectionCore).toBe(
      ReadModelProjectionService.buildProjectionCore,
    )
    expect(ReadyWorkCompat.deriveReadyWork).toBe(ReadModelReadyWork.deriveReadyWork)

    expect(StreamCompat.openStreamDb).toBe(StateStoreStream.openStreamDb)
    expect(StreamCompat.acquireStreamDb).toBe(StateStoreStream.acquireStreamDb)
    expect(StreamCompat.rebuildProjection).toBe(StateStoreStream.rebuildProjection)

    expect(RetainedCompat.RetainedReadError).toBe(
      StateStoreRetained.RetainedReadError,
    )
    expect(RetainedCompat.readRetainedRunRecords).toBe(
      StateStoreRetained.readRetainedRunRecords,
    )
    expect(RetainedCompat.readAuthoritativeRun).toBe(
      StateStoreRetained.readAuthoritativeRun,
    )
  })
})
