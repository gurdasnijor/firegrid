import { ConfigProvider, Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"
import { bootPlanFromConfig } from "../boot/from-config.js"

const provideConfig = (
  entries: Readonly<Record<string, string>>,
): Layer.Layer<never> =>
  Layer.setConfigProvider(ConfigProvider.fromMap(new Map(Object.entries(entries))))

const decode = (entries: Readonly<Record<string, string>>) =>
  Effect.runPromise(bootPlanFromConfig.pipe(Effect.provide(provideConfig(entries))))

// launchable-substrate-host.HOST_CONFIGURATION.4
// launchable-substrate-host.HOST_CONFIGURATION.5
// Boot plans can be decoded from Effect Config; missing stream URL
// selects embedded-dev mode.
describe("launchable-substrate-host.HOST_CONFIGURATION.5 — missing stream URL selects embedded-dev mode", () => {
  it("decoded plan with no SUBSTRATE_STREAM_URL is EmbeddedDevHost with default host/port/streamName", async () => {
    const plan = await decode({})
    expect(plan._tag).toBe("EmbeddedDevHost")
    if (plan._tag === "EmbeddedDevHost") {
      expect(plan.durableStreams.host).toBe("127.0.0.1")
      expect(plan.durableStreams.port).toBe(0)
      expect(plan.durableStreams.streamName).toBe("substrate")
      expect(plan.processId.startsWith("host:")).toBe(true)
    }
  })

  it("decoded plan honors SUBSTRATE_DS_HOST / SUBSTRATE_DS_PORT / SUBSTRATE_STREAM overrides", async () => {
    const plan = await decode({
      SUBSTRATE_DS_HOST: "0.0.0.0",
      SUBSTRATE_DS_PORT: "4437",
      SUBSTRATE_STREAM: "demo",
    })
    expect(plan._tag).toBe("EmbeddedDevHost")
    if (plan._tag === "EmbeddedDevHost") {
      expect(plan.durableStreams).toStrictEqual({
        host: "0.0.0.0",
        port: 4437,
        streamName: "demo",
      })
    }
  })
})

// launchable-substrate-host.HOST_CONFIGURATION.6
// Configured stream URL selects attached mode and does not start or
// own the remote Durable Streams process.
describe("launchable-substrate-host.HOST_CONFIGURATION.6 — configured SUBSTRATE_STREAM_URL selects attached mode", () => {
  it("decoded plan with SUBSTRATE_STREAM_URL is AttachedHost carrying the URL verbatim", async () => {
    const plan = await decode({
      SUBSTRATE_STREAM_URL: "http://example.invalid/v1/stream/substrate",
    })
    expect(plan._tag).toBe("AttachedHost")
    if (plan._tag === "AttachedHost") {
      expect(plan.streamUrl).toBe(
        "http://example.invalid/v1/stream/substrate",
      )
      expect(plan.processId.startsWith("host:")).toBe(true)
    }
  })
})

// launchable-substrate-host.HOST_CONFIGURATION.7
// Explicit SUBSTRATE_PROCESS_ID overrides the generated identity.
describe("launchable-substrate-host.HOST_CONFIGURATION.7 — explicit SUBSTRATE_PROCESS_ID overrides generated identity", () => {
  it("an explicit override is preserved on the resolved plan", async () => {
    const plan = await decode({
      SUBSTRATE_STREAM_URL: "http://example.invalid/v1/stream/x",
      SUBSTRATE_PROCESS_ID: "process-abc",
    })
    expect(plan.processId).toBe("process-abc")
  })
})
