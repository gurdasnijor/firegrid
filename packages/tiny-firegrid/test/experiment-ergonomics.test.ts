import {
  makeChannelTarget,
} from "@firegrid/protocol/channels"
import type { ChannelRouteMetadata } from "@firegrid/protocol/channels/router"
import { Effect, Exit, Schema } from "effect"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
  assertDurableRowExists,
  assertSpanExists,
  durableRowSource,
  loadExperimentArtifacts,
  participantPrompt,
  queryDurableRows,
  querySpans,
  requireAssertion,
} from "../src/experiment/index.ts"
import type { SpanRecord } from "../src/runner/trace.ts"

const simulateRunsRoot = path.resolve(
  fileURLToPath(new URL("../.simulate/runs/", import.meta.url)),
)

const span = (
  name: string,
  spanId: string,
  attributes: Record<string, unknown>,
): SpanRecord => ({
  name,
  traceId: "experiment-trace",
  spanId,
  kind: 0,
  startTime: [1_700_000_000, spanId === "span-1" ? 0 : 1_000_000],
  endTime: [1_700_000_000, spanId === "span-1" ? 500_000 : 2_000_000],
  duration: [0, spanId === "span-1" ? 500_000 : 1_000_000],
  status: { code: 0 },
  attributes,
  events: [],
  resource: {},
})

describe("tiny-firegrid experiment ergonomics", () => {
  it("public-experiment-ergonomics.PARTICIPANT_AUTHORING.2 public-experiment-ergonomics.PARTICIPANT_AUTHORING.3 builds descriptive channel prompts without exact JSON echo contracts", () => {
    const metadata: ChannelRouteMetadata = {
      target: makeChannelTarget("factory.artifacts"),
      direction: "bidirectional",
      verbs: ["send", "wait_for"],
      title: "Factory artifacts",
      description: "Share work products and observe completed work.",
      schema: {
        direction: "bidirectional",
        directions: ["ingress", "egress"],
        schema: Schema.Struct({
          id: Schema.String,
          kind: Schema.String,
        }),
        sourceClasses: ["static-source", "predicate-eligible"],
      },
    }

    const prompt = participantPrompt({
      role: "planner",
      task: "Coordinate implementation of the requested feature.",
      successCriteria: [
        "Produce a plan that another participant can act on.",
        "Use durable channels for handoffs when useful.",
      ],
      channels: [metadata],
    })

    expect(prompt).toContain("Role:")
    expect(prompt).toContain("factory.artifacts")
    expect(prompt).toContain("send, wait_for")
    expect(prompt).not.toContain("```json")
    expect(prompt).not.toContain("{\"channel\"")
    expect(prompt).not.toContain("\"payload\"")
  })

  it("public-experiment-ergonomics.NATIVE_ARTIFACTS.1 public-experiment-ergonomics.NATIVE_ARTIFACTS.2 public-experiment-ergonomics.NATIVE_ARTIFACTS.3 loads trace, show/perf, and named durable rows as native artifacts", async () => {
    const runId = `experiment-ergonomics-${Date.now()}`
    const runDir = path.join(simulateRunsRoot, runId)
    await mkdir(runDir, { recursive: true })
    await writeFile(
      path.join(runDir, "trace.jsonl"),
      [
        span("firegrid.channel.dispatch", "span-1", {
          "firegrid.side": "host",
          "firegrid.channel.target": "factory.artifacts",
          "firegrid.channel.verb": "send",
        }),
        span("firegrid.client.session.start", "span-2", {
          "firegrid.side": "sdk",
          "firegrid.session.id": "ctx_fixture",
        }),
      ].map(row => JSON.stringify(row)).join("\n") + "\n",
      "utf8",
    )

    const artifacts = await Effect.runPromise(
      loadExperimentArtifacts({
        runId,
        durableRows: [
          durableRowSource("factory.artifacts", Effect.succeed([
            { id: "artifact-1", kind: "plan" },
          ])),
        ],
      }),
    )

    expect(artifacts.tracePath).toBe(path.join(runDir, "trace.jsonl"))
    expect(artifacts.show).toContain("firegrid.channel.dispatch")
    expect(artifacts.perf.stdout).toContain("top self-time spans:")
    expect(artifacts.durableRows).toHaveLength(1)
    expect(querySpans(artifacts, {
      name: "firegrid.channel.dispatch",
      side: "host",
      attributes: {
        "firegrid.channel.target": "factory.artifacts",
      },
    })).toHaveLength(1)
    expect(queryDurableRows<{ readonly kind: string }>(
      artifacts,
      "factory.artifacts",
      row => row.kind === "plan",
    )).toHaveLength(1)
  })

  it("public-experiment-ergonomics.THIN_ASSERTIONS.1 public-experiment-ergonomics.THIN_ASSERTIONS.2 public-experiment-ergonomics.THIN_ASSERTIONS.3 reports failed artifact dimensions without verdict language", async () => {
    const artifacts = {
      spans: [
        span("firegrid.client.session.start", "span-1", {
          "firegrid.side": "sdk",
        }),
      ],
      durableRows: [
        {
          source: "factory.claims",
          rows: [{ id: "claim-1", status: "open" }],
        },
      ],
    }

    const spanResult = assertSpanExists(artifacts, {
      name: "firegrid.channel.dispatch",
    })
    const rowResult = assertDurableRowExists<{ readonly status: string }>(
      artifacts,
      "factory.claims",
      row => row.status === "closed",
    )

    expect(spanResult).toMatchObject({
      pass: false,
      dimension: "trace",
      matches: 0,
    })
    expect(rowResult).toMatchObject({
      pass: false,
      dimension: "durable-row",
      matches: 0,
    })
    expect(`${spanResult.message} ${rowResult.message}`).not.toMatch(
      /GREEN|YELLOW|INCONCLUSIVE/,
    )
    const exit = await Effect.runPromiseExit(requireAssertion(rowResult))
    expect(Exit.isFailure(exit)).toBe(true)
  })
})
