import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import {
  HostProgramGraph,
  HostProgramRuntime,
  SubstrateHostBoot,
  type HostProgramRuntimeService,
} from "../../index.ts"

// HostProgramRuntime — public-but-narrow contract
//
// HostProgramRuntime is exposed at the host root so callers writing
// their own host-program helpers can name the Tag in their R type.
// Its contract MUST stay narrow: streamUrl, contentType, processId,
// streamIdentity only. It must NOT carry the boot plan or any
// host-internal field — that would re-introduce the broad
// SubstrateHost surface the narrow Tag was created to avoid.
const ALLOWED_KEYS = new Set([
  "streamUrl",
  "contentType",
  "processId",
  "streamIdentity",
])

describe("HostProgramRuntime — narrow public contract", () => {
  it("the service materialized inside a graph layer exposes only streamUrl/contentType/processId/streamIdentity", async () => {
    let observed: HostProgramRuntimeService | undefined

    const ProbeGraph = HostProgramGraph.define({
      name: "probe",
      layer: Layer.scopedDiscard(
        Effect.gen(function* () {
          observed = yield* HostProgramRuntime
        }),
      ),
    })

    await Effect.runPromise(
      Effect.scoped(
        Effect.void.pipe(
          Effect.provide(
            SubstrateHostBoot.embeddedDev({
              streamName: "host-runtime-shape",
              program: ProbeGraph,
            }),
          ),
        ),
      ),
    )

    expect(observed).toBeDefined()
    if (observed === undefined) return
    // Allowed-keys-only check: every key on the materialized service
    // value must be one of the four whitelisted fields.
    for (const key of Object.keys(observed)) {
      expect(ALLOWED_KEYS.has(key)).toBe(true)
    }
    // Forbidden-keys explicit check — guard against drift toward
    // re-exposing host-internal state through this Tag.
    const forbidden = ["headers", "bootPlan", "profile"]
    for (const key of forbidden) {
      expect(key in observed).toBe(false)
    }
    // And the four fields are populated with sane values.
    expect(typeof observed.streamUrl).toBe("string")
    expect(observed.streamUrl.length).toBeGreaterThan(0)
    expect(typeof observed.contentType).toBe("string")
    expect(typeof observed.processId).toBe("string")
    expect(typeof observed.streamIdentity).toBe("object")
    expect(observed.streamIdentity.streamUrl).toBe(observed.streamUrl)
  })
})
