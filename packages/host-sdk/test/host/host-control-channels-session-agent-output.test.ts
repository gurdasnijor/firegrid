// Wave C amendment: focused host-sdk test that proves HostControlChannelsLive
// composes after #703 added `SessionAgentOutputChannel` as a service
// requirement on `RuntimeHostControlChannelsLive`.
//
// Before the host-sdk amendment, this test fails at runtime with
// "Service not found: firegrid/protocol/channels/session.agent_output"
// because `packages/host-sdk/src/host/channels/host-control/index.ts` only
// provided snapshot channels into `RuntimeHostControlChannelsLive`.
//
// The amendment provides `SessionAgentOutputChannelLive` (which needs
// `RuntimeHostConfig + CurrentHostSession`) into the wrapper, so the public
// `HostControlChannelsLive` composes with a real `RuntimeControlPlaneTable +
// RuntimeHostConfig + CurrentHostSession` substrate.

import { DurableStreamTestServer } from "@durable-streams/server"
import {
  CurrentHostSession,
  makeHostSessionRow,
  RuntimeControlPlaneTable,
  runtimeControlPlaneStreamUrl,
  type HostId,
  type HostSessionId,
} from "@firegrid/protocol/launch"
import {
  SessionAgentOutputChannelTarget,
} from "@firegrid/protocol/channels"
import { HostPlaneChannelRouter } from "@firegrid/runtime/channels"
import { Effect, Layer } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { HostControlChannelsLive } from "../../src/host/channels/host-control/index.ts"
import { RuntimeHostConfig } from "../../src/host/config.ts"

let server: DurableStreamTestServer | undefined
let baseUrl: string | undefined

beforeEach(async () => {
  server = new DurableStreamTestServer({ port: 0, host: "127.0.0.1" })
  baseUrl = await server.start()
})

afterEach(async () => {
  await server?.stop()
  server = undefined
  baseUrl = undefined
})

const controlPlaneLayer = (namespace: string) =>
  RuntimeControlPlaneTable.layer({
    streamOptions: {
      url: runtimeControlPlaneStreamUrl({ baseUrl: baseUrl!, namespace }),
      contentType: "application/json",
    },
  })

const hostConfigLayer = (namespace: string) =>
  Layer.succeed(RuntimeHostConfig, {
    durableStreamsBaseUrl: baseUrl!,
    namespace,
  } as RuntimeHostConfig["Type"])

const hostSessionLayer = (namespace: string) =>
  Layer.succeed(
    CurrentHostSession,
    makeHostSessionRow({
      hostId: `host_${crypto.randomUUID()}` as HostId,
      hostSessionId: `hs_${crypto.randomUUID()}` as HostSessionId,
      namespace,
      startedAtMs: 1_700_000_000_000,
    }),
  )

describe("HostControlChannelsLive — session.agent_output composition (#703 amendment)", () => {
  it("composes HostPlaneChannelRouter with real RuntimeControlPlaneTable + RuntimeHostConfig + CurrentHostSession + SessionAgentOutputChannelLive", async () => {
    const namespace = `host-control-saorl-${crypto.randomUUID()}`

    const metadata = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const router = yield* HostPlaneChannelRouter
          return router.metadata
        }).pipe(
          Effect.provide(
            HostControlChannelsLive.pipe(
              Layer.provideMerge(controlPlaneLayer(namespace)),
              Layer.provideMerge(hostConfigLayer(namespace)),
              Layer.provideMerge(hostSessionLayer(namespace)),
            ),
          ),
        ),
      ),
    )

    // Wave C exit criterion: the host-plane router exposed by
    // `HostControlChannelsLive` advertises `session.agent_output` with the
    // `wait_for` ingress verb. The metadata being non-empty here also
    // proves the wrapper composed (the pre-amendment build failed at
    // runtime resolving `SessionAgentOutputChannel`).
    const entry = metadata.find(
      (m) => String(m.target) === String(SessionAgentOutputChannelTarget),
    )
    expect(entry).toBeDefined()
    expect(entry?.direction).toBe("ingress")
    expect(entry?.verbs).toContain("wait_for")
  })
})
