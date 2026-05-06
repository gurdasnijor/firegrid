import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import * as ClientSurface from "../index.ts"

const here = dirname(fileURLToPath(import.meta.url))
const clientRoot = resolve(here, "..")
const readClient = (path: string) =>
  readFileSync(resolve(clientRoot, path), "utf8")

// firegrid-remediation-hardening.PUBLIC_SURFACES.1
// firegrid-remediation-hardening.PUBLIC_SURFACES.2
// firegrid-remediation-hardening.TEST_GUARDRAILS.1
// firegrid-architecture-boundary.SURFACE_AREA.1
describe("firegrid-remediation-hardening.PUBLIC_SURFACES — client root exposes only Firegrid vocabulary", () => {
  it("the app-facing client root matches the Firegrid allowlist", () => {
    const allowed = new Set([
      "EventStream",
      "EventStreamAppendError",
      "EventStreamDecodeError",
      "EventStreamEncodeError",
      "EventStreamReadError",
      "FiregridClient",
      "FiregridClientLive",
      "Operation",
      "OperationCancelled",
      "OperationDecodeError",
      "OperationEncodeError",
      "OperationHandle",
      "OperationNotFound",
    ])
    expect(new Set(Object.keys(ClientSurface))).toEqual(allowed)
  })

  it("the @firegrid/client root surface contains no banned identifier vocabulary", () => {
    const banned = [
      // raw stream / DSS APIs
      "DurableStream",
      "createStateSchema",
      "openSubstrateDb",
      "rebuildProjection",
      "stream",
      // raw row builders
      "createPendingCompletion",
      "resolveCompletion",
      "rejectCompletion",
      "cancelCompletion",
      "startRun",
      "blockRun",
      "completeRun",
      "failRun",
      "cancelRun",
      "substrateState",
      "RunValue",
      "CompletionValue",
      "ClaimAttemptValue",
      // operator pipelines
      "Work",
      "WorkClaim",
      "WorkClaimLive",
      "processReadyWorkItem",
      // producer internals leaked
      "WorkProducer",
      "CompletionProducer",
      "SubstrateProducerLive",
      // legacy compatibility surface
      "SubstrateClient",
      "SubstrateClientLive",
      "SubstrateClientConfig",
      "SubstrateClientService",
      "DeclareWorkInput",
      "DeclareWorkResult",
      "SubstrateClientWork",
      "SubstrateWorkHandle",
      "WorkObservation",
      // wire helpers/constants belong to explicit descriptor/kernel subpaths
      "EVENT_STREAM_ENVELOPE_TAG",
      "EVENT_STREAM_ROW_TYPE",
      "OPERATION_ENVELOPE_TAG",
      "makeEventStreamEnvelope",
      "makeEventStreamStateRow",
      "eventStreamEnvelopeFromStateRow",
    ]
    const surface = Object.keys(ClientSurface)
    const offenders = banned.filter((b) => surface.includes(b))
    expect(offenders).toEqual([])
  })
})

// firegrid-remediation-hardening.PUBLIC_SURFACES.3
// firegrid-operation-messaging.APP_BOUNDARY.1
describe("firegrid-remediation-hardening.PUBLIC_SURFACES.3 — FiregridClient is the root client tag", () => {
  it("FiregridClient is a Context.Tag and FiregridClientLive is a callable Layer factory", () => {
    expect(typeof ClientSurface.FiregridClient).toBe("function")
    expect(typeof ClientSurface.FiregridClientLive).toBe("function")
    const layer = ClientSurface.FiregridClientLive({
      streamUrl: "http://example.invalid/substrate/none",
    })
    expect(layer).toBeTypeOf("object")
  })
})

// launchable-substrate-host.CLIENT_SURFACE.13
// v1 client choreography surface is intentionally NOT yet present at
// the root: scheduleAt lands in Slice 3, and sleep / waitFor /
// awaitAwakeable are server-side runtime primitives that never enter
// the client root.
describe("launchable-substrate-host.CLIENT_SURFACE.13 — v1 client root does not expose sleep / waitFor / awaitAwakeable", () => {
  it("the client root surface contains no run-internal choreography accessors", () => {
    const banned = ["sleep", "waitFor", "awaitAwakeable", "Choreography"]
    const surface = Object.keys(ClientSurface)
    const offenders = banned.filter((b) => surface.includes(b))
    expect(offenders).toEqual([])
  })
})

describe("firegrid-client-api.AUTHORITY_BOUNDARY.1, .2, .4, .5 — client source stays outside runtime and kernel authority", () => {
  it("the production client root does not import runtime, kernel, work producer, or internal work facade modules", () => {
    const root = readClient("index.ts")
    const operations = readClient("operations.ts")
    const service = readClient("service.ts")
    const eventStreams = readClient("event-streams.ts")
    const combined = `${root}\n${operations}\n${service}\n${eventStreams}`

    expect(combined).not.toContain("@firegrid/runtime")
    expect(combined).not.toContain("@firegrid/substrate/kernel")
    expect(combined).not.toContain("SubstrateClient")
    expect(combined).not.toContain("WorkProducer")
    expect(combined).not.toContain("SubstrateProducer")
    expect(combined).not.toContain("RunWait")
    expect(combined).not.toContain("Choreography")
    expect(combined).not.toContain("DurableWaitsLive")
    expect(combined).not.toContain("./internal/work-client")
    expect(combined).not.toContain("./internal/work-facet")
  })
})
