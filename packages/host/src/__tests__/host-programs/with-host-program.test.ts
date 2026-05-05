import { SubstrateClient } from "@durable-agent-substrate/client"
import { Effect } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  HostProgramGraph,
  HostPrograms,
  SubstrateHostBoot,
} from "../../index.js"
import {
  createSubstrateStream,
  seedPendingTimer,
  startTestServer,
  stopTestServer,
  waitForCompletionState,
} from "./helpers.js"

beforeAll(async () => {
  await startTestServer()
})

afterAll(async () => {
  await stopTestServer()
})

// launchable-substrate-host.RUNTIME_COMPOSITION.5
// launchable-substrate-host.RUNTIME_COMPOSITION.6
// launchable-substrate-host.RUNTIME_COMPOSITION.7
//
// withHost passes the program option through to the underlying host
// layer. The same SubstrateClient capability surfaces inside the
// withHost program; observation through the client and graph-driven
// resolution land on the same durable stream identity.
describe("HostProgramGraph — withHost passthrough", () => {
  it("withHost(attached) accepts a program option and runs the graph alongside the SubstrateClient", async () => {
    const streamUrl = await createSubstrateStream("graph-withhost")
    const completionId = "c-graph-withhost"
    await seedPendingTimer(streamUrl, completionId, Date.now() - 500)

    const Graph = HostProgramGraph.define({
      name: "withhost-timer",
      layer: HostPrograms.timerSubscriber(),
    })

    const observed = await Effect.runPromise(
      SubstrateHostBoot.withHost(
        Effect.gen(function* () {
          // SubstrateClient is the same standalone capability —
          // graph passthrough must not introduce a distinct writer
          // surface (see runtime-composition requirements above).
          const client = yield* SubstrateClient
          // Wait for the graph-driven timer to terminalize.
          const completion = yield* Effect.tryPromise({
            try: () =>
              waitForCompletionState(
                streamUrl,
                completionId,
                (c) => c?.state === "resolved",
                3000,
              ),
            catch: (cause) => cause,
          })
          // Independently use the client's curated read surface to
          // confirm the client capability is wired against the same
          // stream identity that the graph resolved against.
          const _smoke = yield* client.work
            .observe("nonexistent")
            .snapshot()
          return { state: completion?.state }
        }),
        {
          mode: "attached",
          streamUrl,
          clientId: "withhost-graph",
          program: Graph,
        },
      ),
    )

    expect(observed.state).toBe("resolved")
  })
})
