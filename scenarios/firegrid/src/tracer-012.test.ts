import {
  readRetainedJson,
} from "@firegrid/durable-streams/log"
import {
  Firegrid,
  local,
} from "@firegrid/client"
import type {
  RuntimeJournalEvent,
} from "@firegrid/protocol/launch"
import {
  appendRuntimeIngress,
  FiregridRuntimeHostLive,
  startRuntime,
} from "@firegrid/runtime"
import {
  RuntimeIngressRowSchema,
  type RuntimeIngressRow,
} from "@firegrid/runtime/runtime-ingress"
import { Effect, Schema } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  startFiregridScenarioHarness,
  type FiregridScenarioHarness,
} from "./scenario-harness.ts"

let harness: FiregridScenarioHarness | undefined

beforeEach(async () => {
  harness = await startFiregridScenarioHarness()
})

afterEach(async () => {
  await harness?.stop()
  harness = undefined
})

const createStreamUrl = async (name: string): Promise<string> => {
  if (!harness) throw new Error("scenario harness not started")
  return harness.createStreamUrl(name)
}

const runWithFiregrid = <A, E>(
  options: {
    readonly controlPlaneStreamUrl: string
    readonly dataPlaneStreamUrl: string
  },
  effect: Effect.Effect<A, E, Firegrid>,
): Promise<A> => {
  if (!harness) throw new Error("scenario harness not started")
  return harness.runWithFiregrid(options, effect)
}

const stdinEchoAgent = `
const chunks = []
process.stdin.setEncoding("utf8")
process.stdin.on("data", chunk => chunks.push(chunk))
process.stdin.on("end", () => {
  const text = chunks.join("").trim()
  for (const line of text.length === 0 ? [] : text.split(/\\n+/)) {
    console.log(JSON.stringify({ type: "assistant", text: "ingress:" + line }))
  }
})
`

describe("firegrid tracer 012 runtime ingress", () => {
  it("firegrid-agent-ingress.INGRESS.1 firegrid-agent-ingress.INGRESS.2 firegrid-agent-ingress.INGRESS.3 firegrid-agent-ingress.INGRESS.4 firegrid-agent-ingress.INGRESS.5 firegrid-agent-ingress.DELIVERY.1 firegrid-agent-ingress.DELIVERY.2 firegrid-agent-ingress.DELIVERY.3 firegrid-agent-ingress.DELIVERY.4 firegrid-agent-ingress.HOST.1 firegrid-agent-ingress.HOST.2 firegrid-agent-ingress.HOST.3 firegrid-agent-ingress.SUBSCRIBERS.1 firegrid-agent-ingress.SUBSCRIBERS.2 firegrid-agent-ingress.SUBSCRIBERS.3 firegrid-agent-ingress.BOUNDARY.1 firegrid-agent-ingress.BOUNDARY.2 firegrid-agent-ingress.BOUNDARY.3 firegrid-agent-ingress.BOUNDARY.4 firegrid-agent-ingress.BOUNDARY.5 delivers durable ingress once to local process stdin and journals output", async () => {
    const controlPlaneStreamUrl = await createStreamUrl("tracer-012-runtime-control")
    const dataPlaneStreamUrl = await createStreamUrl("tracer-012-runtime-output")
    const workflowStreamUrl = await createStreamUrl("tracer-012-workflow")
    const runtimeIngressStreamUrl = await createStreamUrl("tracer-012-runtime-ingress")

    const handle = await runWithFiregrid(
      { controlPlaneStreamUrl, dataPlaneStreamUrl },
      Effect.gen(function* () {
        const firegrid = yield* Firegrid
        return yield* firegrid.launch({
          runtime: local.jsonl({
            argv: [process.execPath, "--input-type=module", "-e", stdinEchoAgent],
          }),
        })
      }),
    )

    const host = FiregridRuntimeHostLive({
      streams: {
        workflow: workflowStreamUrl,
        controlPlane: controlPlaneStreamUrl,
        runtimeOutput: dataPlaneStreamUrl,
        runtimeIngress: runtimeIngressStreamUrl,
      },
    })

    const initial = await Effect.runPromise(
      appendRuntimeIngress({
        contextId: handle.contextId,
        kind: "message",
        authoredBy: "client",
        payload: [{ type: "text", text: "start here" }],
        idempotencyKey: "tracer-012-initial",
        metadata: { source: "scenario", phase: "initial" },
      }).pipe(Effect.provide(host)),
    )
    const followUp = await Effect.runPromise(
      appendRuntimeIngress({
        contextId: handle.contextId,
        kind: "message",
        authoredBy: "client",
        payload: [{ type: "text", text: "continue once" }],
        idempotencyKey: "tracer-012-continue",
        metadata: { source: "scenario" },
      }).pipe(Effect.provide(host)),
    )
    const duplicate = await Effect.runPromise(
      appendRuntimeIngress({
        contextId: handle.contextId,
        kind: "message",
        authoredBy: "client",
        payload: [{ type: "text", text: "continue once duplicate" }],
        idempotencyKey: "tracer-012-continue",
      }).pipe(Effect.provide(host)),
    )

    expect(duplicate.ingressId).toBe(followUp.ingressId)

    const result = await Effect.runPromise(
      startRuntime({
        contextId: handle.contextId,
      }).pipe(Effect.provide(host)),
    )

    expect(result).toMatchObject({
      contextId: handle.contextId,
      exitCode: 0,
    })

    const runtimeJournal = await Effect.runPromise(
      readRetainedJson<RuntimeJournalEvent>({ streamUrl: dataPlaneStreamUrl }),
    )
    const stdout = runtimeJournal
      .flatMap(event => event.type === "firegrid.runtime.output.stdout" ? [event.event] : [])
      .filter(event => event.contextId === handle.contextId)

    expect(stdout.map(event => event.raw)).toEqual([
      "{\"type\":\"assistant\",\"text\":\"ingress:start here\"}",
      "{\"type\":\"assistant\",\"text\":\"ingress:continue once\"}",
    ])

    const ingressRows = await Effect.runPromise(
      readRetainedJson<unknown>({ streamUrl: runtimeIngressStreamUrl }).pipe(
        Effect.map(rows =>
          rows.map(row => Schema.decodeUnknownSync(RuntimeIngressRowSchema)(row))),
      ),
    )
    const requested = ingressRows.filter((row): row is Extract<
      RuntimeIngressRow,
      { readonly type: "firegrid.runtime_ingress.requested" }
    > => row.type === "firegrid.runtime_ingress.requested")
    const delivered = ingressRows.filter((row): row is Extract<
      RuntimeIngressRow,
      { readonly type: "firegrid.runtime_ingress.delivered" }
    > => row.type === "firegrid.runtime_ingress.delivered")

    expect(requested).toHaveLength(2)
    expect(requested.map(row => row.ingressId)).toEqual([
      initial.ingressId,
      followUp.ingressId,
    ])
    expect(requested[0]).toMatchObject({
      contextId: handle.contextId,
      ingressId: initial.ingressId,
      kind: "message",
      authoredBy: "client",
      idempotencyKey: "tracer-012-initial",
    })
    expect(requested[1]).toMatchObject({
      contextId: handle.contextId,
      ingressId: followUp.ingressId,
      kind: "message",
      authoredBy: "client",
      idempotencyKey: "tracer-012-continue",
    })
    expect(delivered).toEqual([
      expect.objectContaining({
        contextId: handle.contextId,
        ingressId: initial.ingressId,
        provider: "local-process",
      }),
      expect.objectContaining({
        contextId: handle.contextId,
        ingressId: followUp.ingressId,
        provider: "local-process",
      }),
    ])
  })
})
