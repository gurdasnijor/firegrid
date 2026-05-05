import { DurableStream } from "@durable-streams/client"
import {
  SubstrateClient,
  SubstrateClientLive,
} from "@durable-agent-substrate/client"
import { rebuildProjection } from "@durable-agent-substrate/substrate"
import { Effect } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  freshStreamUrl,
  startTestServer,
  stopTestServer,
} from "../../../../test-support/durable-streams-server.ts"
import {
  SubstrateHost,
  SubstrateHostBoot,
  type WithHostOptions,
} from "../index.ts"
import * as HostRoot from "../index.ts"

beforeAll(async () => {
  await startTestServer()
})

afterAll(async () => {
  await stopTestServer()
})

async function createAttachedStream(label: string): Promise<string> {
  const url = freshStreamUrl(label)
  await DurableStream.create({ url, contentType: "application/json" })
  return url
}

// launchable-substrate-host.PACKAGING.6
//
// SubstrateHostBoot exposes thin constructors for attached,
// attachedFromConfig, embeddedDev, bootPlanFromConfig, and
// withHost-style composition. The structural assertion below pins
// "withHost is present and callable" without locking the constructor
// list against future additions — it asserts required keys are
// present, not that the set is exactly these.
describe("launchable-substrate-host.PACKAGING.6 — SubstrateHostBoot.withHost is a thin constructor", () => {
  it("SubstrateHostBoot.withHost is callable and lives alongside the existing constructors", () => {
    const required = [
      "attached",
      "embeddedDev",
      "attachedFromConfig",
      "bootPlanFromConfig",
      "withHost",
    ]
    for (const key of required) {
      expect(key in SubstrateHostBoot).toBe(true)
    }
    expect(typeof SubstrateHostBoot.withHost).toBe("function")
    expect(SubstrateHostBoot.withHost.length).toBeGreaterThanOrEqual(2)
  })

  it("the host root re-exports the WithHostOptions caller-facing type", () => {
    // Type-level only: structural use compiles even though the value
    // is never inspected at runtime. Pinning that the export name is
    // present in the host root surface.
    const opts: WithHostOptions = {
      mode: "attached",
      streamUrl: "http://example.invalid/substrate/none",
      clientId: "noop",
    }
    expect(opts.clientId).toBe("noop")
  })
})

// launchable-substrate-host.RUNTIME_COMPOSITION.5
// launchable-substrate-host.RUNTIME_COMPOSITION.6
//
// Embedded-dev composition: withHost composes the host and client
// layers in one Effect scope, starts an embedded DurableStreamTestServer
// for the duration of that scope, derives the client streamUrl from
// the resolved host streamIdentity, and lets the program declare
// work and read it back through the same SubstrateClient handle.
describe("launchable-substrate-host.RUNTIME_COMPOSITION.5 — withHost composes host and client in one Effect scope (embedded-dev)", () => {
  it("a program inside withHost can declareWork via SubstrateClient and read the run back through the same client", async () => {
    const observed = await Effect.runPromise(
      SubstrateHostBoot.withHost(
        Effect.gen(function* () {
          const client = yield* SubstrateClient
          const declared = yield* client.work.declare({
            input: { kind: "demo" },
          })
          const run = yield* client.work.observe(declared.workId).snapshot()
          return { workId: declared.workId, run }
        }),
        {
          streamName: "with-host-embedded",
          clientId: "with-host-tests",
        },
      ),
    )
    expect(typeof observed.workId).toBe("string")
    expect(observed.workId.length).toBeGreaterThan(0)
    expect(observed.run?.state).toBe("started")
    expect(observed.run?.data).toStrictEqual({ kind: "demo" })
  })

  it("withHost also provides SubstrateHost so the program can read the resolved streamIdentity for diagnostics", async () => {
    const streamIdentity = await Effect.runPromise(
      SubstrateHostBoot.withHost(
        Effect.gen(function* () {
          const host = yield* SubstrateHost
          return host.streamIdentity
        }),
        {
          streamName: "with-host-identity",
          clientId: "with-host-tests",
        },
      ),
    )
    expect(streamIdentity.streamName).toBe("with-host-identity")
    expect(typeof streamIdentity.streamUrl).toBe("string")
    expect(streamIdentity.streamUrl.length).toBeGreaterThan(0)
  })
})

// launchable-substrate-host.RUNTIME_COMPOSITION.7
// launchable-substrate-host.CLIENT_COMPATIBILITY.4
//
// Same SubstrateClient capability inside withHost as standalone:
// against a single externally-managed DurableStreamTestServer
// stream, a write performed through the standalone SubstrateClientLive
// is observable inside a withHost-attached program through that
// program's withHost-provided SubstrateClient — the durable state is
// the meeting point, not any client identity.
describe("launchable-substrate-host.CLIENT_COMPATIBILITY.4 — withHost-provided SubstrateClient is the same capability as standalone", () => {
  it("a run declared via standalone SubstrateClientLive is observable through withHost in attached mode against the same stream", async () => {
    const streamUrl = await createAttachedStream("with-host-attached")

    // Step 1: declare via standalone client — this is the canonical
    // SubstrateClient capability, untouched by host composition.
    const standaloneResult = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* SubstrateClient
        return yield* client.work.declare({ input: { source: "standalone" } })
      }).pipe(
        Effect.provide(
          SubstrateClientLive({ streamUrl, clientId: "standalone-id" }),
        ),
      ),
    )

    // Step 2: observe via withHost-attached client. The capability
    // must be the same: the run lands in durable state and any
    // SubstrateClient.observe(workId) snapshot returns it,
    // regardless of which client emitted the write.
    const observedRun = await Effect.runPromise(
      SubstrateHostBoot.withHost(
        Effect.gen(function* () {
          const client = yield* SubstrateClient
          return yield* client.work.observe(standaloneResult.workId).snapshot()
        }),
        {
          mode: "attached",
          streamUrl,
          clientId: "withhost-id",
        },
      ),
    )

    expect(observedRun?.state).toBe("started")
    expect(observedRun?.data).toStrictEqual({ source: "standalone" })

    // And in reverse: a withHost-declared run is observable through
    // standalone in the same fashion. This proves writer/reader
    // symmetry across the two SubstrateClient instances.
    const withHostResult = await Effect.runPromise(
      SubstrateHostBoot.withHost(
        Effect.gen(function* () {
          const client = yield* SubstrateClient
          return yield* client.work.declare({ input: { source: "withhost" } })
        }),
        {
          mode: "attached",
          streamUrl,
          clientId: "withhost-id",
        },
      ),
    )
    const standaloneObserve = await Effect.runPromise(
      Effect.gen(function* () {
        const client = yield* SubstrateClient
        return yield* client.work.observe(withHostResult.workId).snapshot()
      }).pipe(
        Effect.provide(
          SubstrateClientLive({ streamUrl, clientId: "standalone-id" }),
        ),
      ),
    )
    expect(standaloneObserve?.state).toBe("started")
    expect(standaloneObserve?.data).toStrictEqual({ source: "withhost" })
  })
})

// launchable-substrate-host.RUNTIME_COMPOSITION.7
//
// withHost does not introduce a distinct writer API: the host root
// surface continues to expose no new client-shaped Tag, no extra
// declare/observe entry point, and no separate writer namespace.
// Asserted as a banned-name guard (analogous to the client root's
// banned-identifier surface test) rather than an exact-equal check
// that locks the surface forever.
describe("launchable-substrate-host.RUNTIME_COMPOSITION.7 — withHost does not introduce a distinct writer API on the host root", () => {
  it("the @durable-agent-substrate/host root surface contains no new client/writer Tag or shadow API", () => {
    const banned = [
      // distinct/shadow client capabilities
      "SubstrateHostClient",
      "WithHostClient",
      "HostSubstrateClient",
      "withHostClient",
      "declareWork",
      "ClientFactory",
      // re-exports of substrate-internal writers must not leak here
      "WorkProducer",
      "CompletionProducer",
      "SubstrateProducerLive",
    ]
    const surface = Object.keys(HostRoot)
    const offenders = banned.filter((b) => surface.includes(b))
    expect(offenders).toEqual([])
  })
})

// launchable-substrate-host.NO_CONTROL_PLANE.1
//
// withHost adds no host mutation endpoint, listener, port, or
// network/HTTP shape. The return value is an Effect, not a server
// handle, and the host root surface contains no server/listen/port/
// http/router/endpoint-style names.
describe("launchable-substrate-host.NO_CONTROL_PLANE.1 — withHost exposes no host mutation endpoint or network listener", () => {
  it("withHost(...) returns an Effect, not a server / listener / port handle", () => {
    // Effect values are objects with the Effect symbol on the
    // prototype chain; we don't assert that exact symbol here, but we
    // assert what withHost is NOT: it does not return a function with
    // listen()/close()/address() handles, a port number, or a URL.
    const result: unknown = SubstrateHostBoot.withHost(Effect.void, {
      streamName: "with-host-shape",
      clientId: "with-host-tests",
    })
    expect(typeof result).toBe("object")
    expect(result).not.toBeNull()
    const obj = result as Record<string, unknown>
    expect(typeof obj.listen).not.toBe("function")
    expect(typeof obj.close).not.toBe("function")
    expect(typeof obj.address).not.toBe("function")
    expect("port" in obj).toBe(false)
    expect("url" in obj).toBe(false)
  })

  it("the @durable-agent-substrate/host root surface has no server/listen/port/http/router/endpoint-style export", () => {
    const bannedSubstrings = [
      "Server",
      "Listener",
      "Listen",
      "Port",
      "Http",
      "HTTP",
      "Router",
      "Endpoint",
      "Fastify",
      "Express",
      "Diagnostics",
    ]
    const surface = Object.keys(HostRoot)
    const offenders = surface.filter((name) =>
      bannedSubstrings.some((b) => name.includes(b)),
    )
    expect(offenders).toEqual([])
  })
})

// Inert withHost no-op guard: a withHost program that does nothing
// must not append durable rows to the substrate stream. This is a
// no-accidental-write check on the helper itself; the broader host
// diagnostics no-mutation property remains a deferred concern for
// a future slice that actually owns a diagnostics surface.
describe("withHost — inert program leaves the durable stream untouched", () => {
  it("an Effect.void program inside withHost (attached) does not append rows to the substrate stream", async () => {
    const streamUrl = await createAttachedStream("with-host-inert")

    const before = await rebuildProjection({ url: streamUrl })
    expect(before.runs.size).toBe(0)
    expect(before.completions.size).toBe(0)
    expect(before.claimAttempts.size).toBe(0)

    await Effect.runPromise(
      SubstrateHostBoot.withHost(Effect.void, {
        mode: "attached",
        streamUrl,
        clientId: "inert",
      }),
    )

    const after = await rebuildProjection({ url: streamUrl })
    expect(after.runs.size).toBe(0)
    expect(after.completions.size).toBe(0)
    expect(after.claimAttempts.size).toBe(0)
  })
})

// Effect-scoped finalization: two sequential withHost runs (each with
// its own embedded DurableStreamTestServer) both complete cleanly.
// We do NOT assert that the second run gets a different OS-assigned
// port (port reuse can happen). The proof is that both scopes open,
// produce a usable host+client, and tear down without leaking — if
// the embedded server were not stopped between runs the second
// runPromise would hang or fail, and if a runner fiber held the
// scope open the test would hit the vitest timeout.
describe("withHost — sequential embedded-dev runs both complete cleanly", () => {
  it("two embedded-dev withHost runs back-to-back each provide a usable host+client and finalize", async () => {
    for (let i = 0; i < 2; i += 1) {
      const result = await Effect.runPromise(
        SubstrateHostBoot.withHost(
          Effect.gen(function* () {
            const host = yield* SubstrateHost
            const client = yield* SubstrateClient
            const declared = yield* client.work.declare({
              input: { iteration: i },
            })
            return {
              streamUrl: host.streamIdentity.streamUrl,
              workId: declared.workId,
            }
          }),
          {
            streamName: `with-host-sequential-${i}`,
            clientId: "with-host-tests",
          },
        ),
      )
      expect(typeof result.streamUrl).toBe("string")
      expect(result.streamUrl.length).toBeGreaterThan(0)
      expect(typeof result.workId).toBe("string")
    }
  })
})
