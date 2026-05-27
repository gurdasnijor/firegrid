import { Activity, Workflow } from "@effect/workflow"
import { DurableStreamTestServer } from "@durable-streams/server"
import { Effect, Layer, Schema, Tracer } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { DurableStreamsWorkflowEngine } from "../../src/engine/durable-streams-workflow-engine.ts"
import { withActivityContract } from "../../src/engine/internal/contract-activity.ts"

// tf-vw29: prove the Activity.make span-attribute hook lands
// firegrid.seam.kind / firegrid.contract.id on the vendored `activity.name`
// span — the span families tf-mmh2 could not annotate from call sites.

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

interface RecordedSpan {
  readonly name: string
  readonly attributes: Map<string, unknown>
}

const makeRecordingTracer = (): {
  readonly layer: Layer.Layer<never>
  readonly spans: ReadonlyArray<RecordedSpan>
} => {
  const spans: Array<RecordedSpan> = []
  const tracer = Tracer.make({
    span(name, parent, context, links, startTime, kind, options) {
      const attributes = new Map<string, unknown>()
      if (options?.attributes) {
        for (const [key, value] of Object.entries(options.attributes)) {
          attributes.set(key, value)
        }
      }
      spans.push({ name, attributes })
      return {
        _tag: "Span",
        name,
        spanId: `span-${spans.length}`,
        traceId: "tf-vw29-trace",
        parent,
        context,
        status: { _tag: "Started", startTime },
        attributes,
        links,
        sampled: true,
        kind,
        end() {},
        attribute(key, value) {
          attributes.set(key, value)
        },
        event() {},
        addLinks() {},
      }
    },
    context(f) {
      return f()
    },
  })
  return { layer: Layer.setTracer(tracer), spans }
}

const spanNamed = (spans: ReadonlyArray<RecordedSpan>, name: string): RecordedSpan => {
  const found = spans.find(span => span.name === name)
  if (found === undefined) {
    throw new Error(
      `expected a span named ${name}; saw ${spans.map(s => s.name).join(", ")}`,
    )
  }
  return found
}

describe("Activity.make contract-attribute hook (tf-vw29)", () => {
  it("annotates the vendored activity.name span with a resolving contract.id", async () => {
    if (!baseUrl) throw new Error("server not started")
    const streamUrl = `${baseUrl}/v1/stream/vw29-${crypto.randomUUID()}`
    const { layer: tracerLayer, spans } = makeRecordingTracer()

    const contractId = "features/firegrid/firegrid-workflow-driven-runtime.feature.yaml"
    const AnnotatedActivity = withActivityContract(
      Activity.make({
        name: "vw29-annotated-activity",
        success: Schema.Number,
        execute: Effect.succeed(7),
      }),
      { seamKind: "durability", contractId },
    )
    // Control: an ordinary activity must NOT pick up the attributes.
    const PlainActivity = Activity.make({
      name: "vw29-plain-activity",
      success: Schema.Number,
      execute: Effect.succeed(9),
    })
    const HookWorkflow = Workflow.make({
      name: "vw29-hook-workflow",
      payload: Schema.Struct({ id: Schema.String }),
      success: Schema.Number,
      idempotencyKey: payload => payload.id,
    })
    const workflowLayer = HookWorkflow.toLayer(() =>
      Effect.gen(function*() {
        const a = yield* AnnotatedActivity
        const b = yield* PlainActivity
        return a + b
      }),
    )

    const result = await Effect.runPromise(
      Effect.scoped(
        HookWorkflow.execute({ id: "vw29" }).pipe(
          Effect.provide(
            (workflowLayer as Layer.Layer<never, unknown, unknown>).pipe(
              Layer.provideMerge(
                DurableStreamsWorkflowEngine.layer({ streamUrl }) as Layer.Layer<never, unknown, unknown>,
              ),
              Layer.provideMerge(tracerLayer),
            ),
          ),
        ) as Effect.Effect<number, unknown, never>,
      ),
    )

    expect(result).toBe(16)

    const annotated = spanNamed(spans, "vw29-annotated-activity")
    expect(annotated.attributes.get("firegrid.seam.kind")).toBe("durability")
    expect(annotated.attributes.get("firegrid.contract.id")).toBe(contractId)

    const plain = spanNamed(spans, "vw29-plain-activity")
    expect(plain.attributes.has("firegrid.seam.kind")).toBe(false)
    expect(plain.attributes.has("firegrid.contract.id")).toBe(false)
  })
})
