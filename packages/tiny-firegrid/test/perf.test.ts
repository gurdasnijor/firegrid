import { describe, expect, it } from "vitest"
import {
  analyzePerf,
  formatPerfOutput,
} from "../src/runner/perf.ts"
import type { SpanRecord } from "../src/runner/trace.ts"

const span = (
  name: string,
  spanId: string,
  startSeconds: number,
  endSeconds: number,
): SpanRecord => ({
  name,
  traceId: "trace-fixture",
  spanId,
  kind: 0,
  startTime: [startSeconds, 0],
  endTime: [endSeconds, 0],
  duration: [endSeconds - startSeconds, 0],
  status: { code: 0 },
  attributes: {},
  events: [],
  resource: {},
})

describe("simulate:perf formatter", () => {
  it("firegrid-observability.TINY_FIREGRID_SIMULATIONS.12 routes finding drafts to stderr output only without subprocess execution", () => {
    const report = analyzePerf(
      [
        span("fixture.first", "span-1", 1_700_000_000, 1_700_000_001),
        span("fixture.second", "span-2", 1_700_000_010, 1_700_000_011),
      ],
      {
        top: 15,
        idleThresholdMs: 1_000,
        findingThresholdMs: 2_000,
      },
      "fixture-perf-idle-gap",
      "/fixture/trace.jsonl",
    )

    const output = formatPerfOutput(report, {
      findingDraft: true,
      findingThresholdMs: 2_000,
    })

    expect(output.stdout).toContain("top self-time spans:")
    expect(output.stdout).toContain("idle gaps:")
    expect(output.stdout).not.toContain("## Finding Source: simulate:perf idle gap regression")
    expect(output.stdout).not.toContain("Threshold: 2000ms")
    expect(output.stderr).toContain("## Finding Source: simulate:perf idle gap regression")
    expect(output.stderr).toContain("Threshold: 2000ms")
  })

  it("firegrid-observability.TINY_FIREGRID_SIMULATIONS.12 suppresses finding drafts unless explicitly requested", () => {
    const report = analyzePerf(
      [
        span("fixture.first", "span-1", 1_700_000_000, 1_700_000_001),
        span("fixture.second", "span-2", 1_700_000_010, 1_700_000_011),
      ],
      {
        top: 15,
        idleThresholdMs: 1_000,
        findingThresholdMs: 2_000,
      },
      "fixture-perf-idle-gap",
      "/fixture/trace.jsonl",
    )

    const output = formatPerfOutput(report, {
      findingDraft: false,
      findingThresholdMs: 2_000,
    })

    expect(output.stdout).toContain("idle gaps:")
    expect(output.stderr).toBeUndefined()
  })
})
