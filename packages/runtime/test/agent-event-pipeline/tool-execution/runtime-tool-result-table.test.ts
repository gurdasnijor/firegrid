import { DurableStreamTestServer } from "@durable-streams/server"
import { Prompt } from "@effect/ai"
import { Effect } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  RuntimeToolResultTable,
  runtimeToolResultAtMostOnce,
  runtimeToolResultKey,
  runtimeToolResultLookup,
  runtimeToolResultTableLayer,
} from "../../../src/agent-event-pipeline/tool-execution/runtime-tool-result-table.ts"
import type { ToolResultEvent } from "../../../src/agent-event-pipeline/events/index.ts"

// Shape C tool result identity (tf-28b8 / #676): at-most-once is owned by the
// `tool:<contextId>:<toolUseId>` durable row, NOT by Activity/workflow memo.

const toolResult = (toolUseId: string, value: string): ToolResultEvent => ({
  _tag: "ToolResult",
  part: Prompt.toolResultPart({
    id: toolUseId,
    name: "echo",
    result: { value },
    isFailure: false,
    providerExecuted: false,
  }),
})

// DurableTable.layer leaks `any` through its R channel; the test's outer
// Effect therefore types as `Effect<A, E, any>` once a table-tag yield is
// composed with `Layer.provide(tableLayer)`. Narrow the unsafe `any` back to
// `never` at the test's run boundary so the assertion still typechecks under
// exactOptionalPropertyTypes. This mirrors the eslint-disable in
// host-sdk/src/host/runtime-context-workflow-support.ts.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const runRuntime = <A, E>(effect: Effect.Effect<A, E, any>): Promise<A> =>
  Effect.runPromise(effect as Effect.Effect<A, E, never>)

describe("runtimeToolResultAtMostOnce", () => {
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

  const streamUrl = () =>
    `${baseUrl}/v1/stream/runtime-tool-result-${crypto.randomUUID()}`

  const layerFor = (url: string) =>
    runtimeToolResultTableLayer({
      streamOptions: { url, contentType: "application/json" },
      txTimeoutMs: 2_000,
    })

  it("fences an external effect to exactly one execution across re-deliveries", async () => {
    const url = streamUrl()
    let sideEffectRuns = 0
    const program = Effect.gen(function*() {
      const table = yield* RuntimeToolResultTable
      // Three deliveries of the same toolUseId — only the first runs the
      // external effect; the subsequent two short-circuit on the durable row.
      const outcomes: Array<ToolResultEvent> = []
      for (let i = 0; i < 3; i += 1) {
        const result = yield* runtimeToolResultAtMostOnce(table, {
          contextId: "ctx-1",
          toolUseId: "tool-1",
          toolName: "echo",
          runEffect: Effect.sync(() => {
            sideEffectRuns += 1
            return toolResult("tool-1", "first-run")
          }),
        })
        outcomes.push(result)
      }
      return outcomes
    }).pipe(Effect.provide(layerFor(url)))

    const outcomes = await runRuntime(Effect.scoped(program))
    expect(sideEffectRuns).toBe(1)
    expect(outcomes).toHaveLength(3)
    // Every outcome carries the row's recorded result — the same ToolResult
    // value the first execution produced. tf-28b8 C3 invariant.
    outcomes.forEach(outcome => {
      expect(outcome._tag).toBe("ToolResult")
      expect(outcome.part.id).toBe("tool-1")
    })
  })

  it("survives reconstruction: a fresh layer over the same stream URL returns the recorded result without running the effect", async () => {
    const url = streamUrl()
    let sideEffectRuns = 0
    const runEffect = Effect.sync(() => {
      sideEffectRuns += 1
      return toolResult("tool-restart", "first-run")
    })

    // Gen 1 — writes the durable row.
    const gen1 = await runRuntime(
      Effect.scoped(
        Effect.flatMap(RuntimeToolResultTable, table =>
          runtimeToolResultAtMostOnce(table, {
            contextId: "ctx-1",
            toolUseId: "tool-restart",
            toolName: "echo",
            runEffect,
          })).pipe(Effect.provide(layerFor(url))),
      ),
    )
    expect(sideEffectRuns).toBe(1)
    expect(gen1.part.id).toBe("tool-restart")

    // Gen 2 — fresh layer over the same URL, runEffect would re-run the side
    // effect if invoked; the durable row short-circuits before that happens.
    const gen2 = await runRuntime(
      Effect.scoped(
        Effect.flatMap(RuntimeToolResultTable, table =>
          runtimeToolResultAtMostOnce(table, {
            contextId: "ctx-1",
            toolUseId: "tool-restart",
            toolName: "echo",
            runEffect: Effect.sync(() => {
              sideEffectRuns += 1
              return toolResult("tool-restart", "MUST_NOT_RUN")
            }),
          })).pipe(Effect.provide(layerFor(url))),
      ),
    )
    expect(sideEffectRuns).toBe(1) // unchanged — second runEffect never invoked
    expect(gen2.part.id).toBe("tool-restart")
  }, 20_000)

  it("lookup returns the recorded ToolResultEvent verbatim", async () => {
    const url = streamUrl()
    await runRuntime(
      Effect.scoped(
        Effect.flatMap(RuntimeToolResultTable, table =>
          runtimeToolResultAtMostOnce(table, {
            contextId: "ctx-lookup",
            toolUseId: "tool-lookup",
            toolName: "echo",
            runEffect: Effect.succeed(toolResult("tool-lookup", "ok")),
          })).pipe(Effect.provide(layerFor(url))),
      ),
    )

    const found = await runRuntime(
      Effect.scoped(
        Effect.flatMap(RuntimeToolResultTable, table =>
          runtimeToolResultLookup(table, "ctx-lookup", "tool-lookup")).pipe(
          Effect.provide(layerFor(url)),
        ),
      ),
    )
    expect(found._tag).toBe("Some")
    if (found._tag === "Some") {
      expect(found.value.part.id).toBe("tool-lookup")
    }

    const missing = await runRuntime(
      Effect.scoped(
        Effect.flatMap(RuntimeToolResultTable, table =>
          runtimeToolResultLookup(table, "ctx-lookup", "tool-other")).pipe(
          Effect.provide(layerFor(url)),
        ),
      ),
    )
    expect(missing._tag).toBe("None")
  })

  it("runtimeToolResultKey is stable", () => {
    expect(runtimeToolResultKey("ctx", "tool-1")).toBe("tool:ctx:tool-1")
  })
})
