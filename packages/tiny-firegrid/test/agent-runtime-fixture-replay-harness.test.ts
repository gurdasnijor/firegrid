import { describe, expect, it } from "vitest"
import { Effect } from "effect"
import {
  replayHarnessFixtures,
  replayHarnessFuzzSeeds,
  runReplayHarness,
} from "../src/simulations/agent-runtime-fixture-replay-harness/replay.ts"

describe("agent runtime fixture replay harness", () => {
  it("firegrid-runtime-agent-event-pipeline.SOURCE_CONFORMANCE.1 defines the provider/session/transport/live-canary matrix before replay", () => {
    const matrix = replayHarnessFixtures.map(fixture =>
      `${fixture.provider}:${fixture.sessionMode}:${fixture.transport}:${fixture.liveCanary}`)
    expect(matrix).toContain("local-process:codec:ACP:false")
    expect(matrix).toContain("local-process:codec:stdio-jsonl:false")
    expect(matrix).toContain("effect-ai:codec:fake-mcp-provider:false")
    expect(matrix).toContain("local-process:raw:raw-byte-stream:false")
    expect(matrix).toContain("local-process:codec:ACP:true")
  })

  it("firegrid-runtime-agent-event-pipeline.SOURCE_CONFORMANCE.2 firegrid-runtime-agent-event-pipeline.SOURCE_CONFORMANCE.3 replays deterministic fixtures and named faults", async () => {
    const result = await Effect.runPromise(runReplayHarness)
    expect(result.matrixRows.filter(row => !row.skipped)).toHaveLength(5)
    expect(result.matrixRows.some(row => row.faultClass === "crash-mid-action")).toBe(true)
    expect(result.matrixRows.some(row => row.faultClass === "codec-double-advertisement")).toBe(true)
    expect(result.matrixRows.some(row => row.faultClass === "permission-gate-stall")).toBe(true)
    expect(result.unsupportedRows).toContain("live-canary-codex-acp")
  })

  it("firegrid-runtime-agent-event-pipeline.SOURCE_CONFORMANCE.4 runs every fuzz class across every deterministic fixture", async () => {
    const result = await Effect.runPromise(runReplayHarness)
    const deterministicFixtureCount = replayHarnessFixtures.filter(fixture => !fixture.liveCanary).length
    expect(replayHarnessFuzzSeeds).toHaveLength(12)
    expect(result.fuzzCases).toBe(deterministicFixtureCount * replayHarnessFuzzSeeds.length)
  })
})
