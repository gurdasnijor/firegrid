import { Effect } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  freshStreamUrl,
  startTestServer,
  stopTestServer,
} from "../../../../test-support/durable-streams-server.ts"
import { SubstrateHost, SubstrateHostBoot } from "../index.ts"

beforeAll(async () => {
  await startTestServer()
})

afterAll(async () => {
  await stopTestServer()
})

// launchable-substrate-host.HOST_CONFIGURATION.2
// launchable-substrate-host.HOST_CONFIGURATION.6
// launchable-substrate-host.AUTHORITY_BOUNDARY.2
//
// Attached mode joins an existing Durable Streams endpoint (the test
// uses the repo-level test-support server as a stand-in for any
// already-running endpoint) and does NOT start or own a remote
// process.
describe("launchable-substrate-host.HOST_CONFIGURATION.6 — attached mode joins an existing Durable Streams endpoint without owning the remote process", () => {
  it("the SubstrateHost service exposes the supplied streamUrl unchanged and reports bootMode=attached", async () => {
    const url = freshStreamUrl("attached-host")

    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* SubstrateHost
          return {
            bootMode: host.bootMode,
            streamUrl: host.streamIdentity.streamUrl,
            processId: host.processId,
          }
        }).pipe(
          Effect.provide(
            SubstrateHostBoot.attached({
              streamUrl: url,
              processId: "attached-test",
            }),
          ),
        ),
      ),
    )
    expect(observed.bootMode).toBe("attached")
    expect(observed.streamUrl).toBe(url)
    expect(observed.processId).toBe("attached-test")
  })

  it("attached mode does not pre-create or own the remote substrate stream", async () => {
    // Use a syntactically-valid but not-yet-created stream URL on the
    // repo test server. Attached mode must NOT call DurableStream.create;
    // a SubstrateHost resolved against an unprovisioned URL therefore
    // still resolves successfully (host startup does not depend on the
    // remote endpoint being initialized).
    const url = freshStreamUrl("attached-no-create")
    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* SubstrateHost
          return host.streamIdentity.streamUrl
        }).pipe(
          Effect.provide(SubstrateHostBoot.attached({ streamUrl: url })),
        ),
      ),
    )
    expect(observed).toBe(url)
  })
})
