import { Effect } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  freshStreamUrl,
  startTestServer,
  stopTestServer,
} from "./helpers.ts"
import { FiregridRuntime, FiregridRuntimeBoot } from "../index.ts"

beforeAll(async () => {
  await startTestServer()
})

afterAll(async () => {
  await stopTestServer()
})

// firegrid-runtime-process.RUNTIME_PACKAGE.2
// firegrid-runtime-process.BINARIES.3
// firegrid-runtime-process.BINARIES.6
//
// Attached mode joins an existing Durable Streams endpoint (the
// test uses a package-local integration server as a stand-in for any
// already-running endpoint) and does NOT start or own a remote
// process. Attached-mode env at the binary boundary is
// DURABLE_STREAMS_URL; the library API takes the URL as an
// explicit value.
describe("firegrid-runtime-process — attached mode joins an existing Durable Streams endpoint without owning the remote process", () => {
  it("the FiregridRuntime service exposes the supplied streamUrl unchanged and reports bootMode=attached", async () => {
    const url = freshStreamUrl("attached-host")

    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* FiregridRuntime
          return {
            bootMode: host.bootMode,
            streamUrl: host.streamIdentity.streamUrl,
            processId: host.processId,
          }
        }).pipe(
          Effect.provide(
            FiregridRuntimeBoot.attached({
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
    // a FiregridRuntime resolved against an unprovisioned URL therefore
    // still resolves successfully (host startup does not depend on the
    // remote endpoint being initialized).
    const url = freshStreamUrl("attached-no-create")
    const observed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* FiregridRuntime
          return host.streamIdentity.streamUrl
        }).pipe(
          Effect.provide(FiregridRuntimeBoot.attached({ streamUrl: url })),
        ),
      ),
    )
    expect(observed).toBe(url)
  })
})
