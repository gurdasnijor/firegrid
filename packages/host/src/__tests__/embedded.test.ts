import { rebuildProjection } from "@durable-agent-substrate/substrate"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import { SubstrateHost, SubstrateHostBoot } from "../index.ts"

// launchable-substrate-host.HOST_PROCESS.1
// launchable-substrate-host.HOST_PROCESS.8
// launchable-substrate-host.HOST_CONFIGURATION.1
// launchable-substrate-host.HOST_CONFIGURATION.5
//
// The embedded-dev host launches a local DurableStreamTestServer for
// the duration of the SubstrateHostLive scope and pre-creates the
// substrate stream so reads find a valid endpoint. Scope finalization
// stops the server. Process-signal-driven shutdown is a higher-runtime
// concern that lands with the withHost helper in a later slice and
// is NOT claimed by this test.
describe("launchable-substrate-host.HOST_PROCESS.1 — embedded-dev host launches a local Durable Streams endpoint", () => {
  it("embedded-dev mode creates a substrate stream at a fresh URL during the scope and the scope completes (the embedded server is torn down on Effect-scoped finalization)", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* SubstrateHost
          expect(host.bootMode).toBe("embedded-dev")
          expect(host.streamIdentity.streamName).toBe("substrate-host-test")
          expect(host.streamIdentity.host).toBe("127.0.0.1")
          // OS-assigned port (port=0 → real port reflected on the
          // running server).
          expect(host.streamIdentity.port).toBeGreaterThan(0)
          // Within the scope, the substrate stream exists and a
          // rebuild succeeds (empty snapshot is acceptable).
          const snap = yield* Effect.tryPromise({
            try: () => rebuildProjection({ url: host.streamIdentity.streamUrl }),
            catch: (cause) => cause,
          })
          expect(snap.runs.size).toBe(0)
        }).pipe(
          Effect.provide(
            SubstrateHostBoot.embeddedDev({
              streamName: "substrate-host-test",
            }),
          ),
        ),
      ),
    )
    // The runPromise resolving without timeout is itself the proof
    // that scope finalization (server stop) ran cleanly. Validating
    // that subsequent HTTP reads fail is not portable across the
    // server's connection-handling behaviour and is out of scope here.
  })
})

// launchable-substrate-host.HOST_CONFIGURATION.7
// Default-generated process id is exposed on the SubstrateHost service.
describe("launchable-substrate-host.HOST_CONFIGURATION.7 — generated process id is reflected on the SubstrateHost service", () => {
  it("embedded-dev SubstrateHost exposes a host:-prefixed process id by default", async () => {
    const id = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* SubstrateHost
          return host.processId
        }).pipe(
          Effect.provide(
            SubstrateHostBoot.embeddedDev({ streamName: "id-default" }),
          ),
        ),
      ),
    )
    expect(id.startsWith("host:")).toBe(true)
  })

  it("explicit processId overrides the generated identity", async () => {
    const id = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const host = yield* SubstrateHost
          return host.processId
        }).pipe(
          Effect.provide(
            SubstrateHostBoot.embeddedDev({
              streamName: "id-override",
              processId: "process-explicit",
            }),
          ),
        ),
      ),
    )
    expect(id).toBe("process-explicit")
  })
})
