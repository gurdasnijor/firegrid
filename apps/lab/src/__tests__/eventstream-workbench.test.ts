import { DurableStream } from "@durable-streams/client"
import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { Chunk, Effect, Stream } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  freshStreamUrl,
  startTestServer,
  stopTestServer,
} from "../../../../test-support/durable-streams-server.ts"
import {
  emitLabEvent,
  labEvents,
} from "../lab/LabEventStreamClient.ts"
import { makeLabEvent } from "../lab/lab-events.ts"

beforeAll(async () => {
  await startTestServer()
})

afterAll(async () => {
  await stopTestServer()
})

const here = dirname(fileURLToPath(import.meta.url))
const labRoot = resolve(here, "..", "lab")

interface LabEventStreamStateRow {
  readonly type: "firegrid.event"
  readonly key: string
  readonly value: {
    readonly _envelope: "firegrid/event@1"
    readonly stream: string
    readonly event: unknown
  }
  readonly headers: {
    readonly operation: "insert"
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null

const isLabEventStreamStateRow = (
  value: unknown,
): value is LabEventStreamStateRow => {
  if (!isObject(value) || !isObject(value.value) || !isObject(value.headers)) {
    return false
  }

  return (
    value.type === "firegrid.event" &&
    typeof value.key === "string" &&
    value.value._envelope === "firegrid/event@1" &&
    typeof value.value.stream === "string" &&
    value.headers.operation === "insert"
  )
}

describe("runtime-lab-inspector.WRITE_BOUNDARY.1 + firegrid-event-streams.CLIENT_API.1-.3 — typed lab EventStream workbench uses the Firegrid client", () => {
  it("emits through the lab helper and replays decoded events through the Stream-first helper", async () => {
    const streamUrl = freshStreamUrl("lab-eventstream-workbench")
    await DurableStream.create({
      url: streamUrl,
      contentType: "application/json",
    })
    const cfg = { streamUrl }
    const first = makeLabEvent({ message: "first", count: 1 })
    const second = makeLabEvent({ message: "second", count: 2 })

    await Effect.runPromise(emitLabEvent(cfg, first))
    await Effect.runPromise(emitLabEvent(cfg, second))
    const durable = new DurableStream({
      url: streamUrl,
      contentType: "application/json",
    })
    const response = await durable.stream<unknown>({
      offset: "-1",
      live: false,
    })
    const retained = await response.json<unknown>()

    const collected = await Effect.runPromise(
      labEvents(cfg).pipe(Stream.take(2), Stream.runCollect),
    )

    const row = retained[0]
    expect(isLabEventStreamStateRow(row)).toBe(true)
    if (!isLabEventStreamStateRow(row)) {
      throw new Error("expected typed lab EventStream state row")
    }
    expect(row.key.startsWith("firegrid.lab.events:")).toBe(true)
    expect(row).toEqual({
      type: "firegrid.event",
      key: row.key,
      value: {
        _envelope: "firegrid/event@1",
        stream: "firegrid.lab.events",
        event: first,
      },
      headers: { operation: "insert" },
    })
    expect(Chunk.toReadonlyArray(collected)).toEqual([first, second])
  })
})

describe("runtime-lab-inspector.NO_PRIVILEGED_LAB.2 — typed workbench does not bypass app-facing client APIs", () => {
  it("typed EventStream workbench imports client APIs only and does not raw-write or declare work", () => {
    const clientHelper = readFileSync(
      resolve(labRoot, "LabEventStreamClient.ts"),
      "utf8",
    )
    const panel = readFileSync(
      resolve(labRoot, "LabEventStreamPanel.tsx"),
      "utf8",
    )
    const descriptor = readFileSync(resolve(labRoot, "lab-events.ts"), "utf8")
    const combined = `${clientHelper}\n${panel}\n${descriptor}`

    expect(combined).toContain("@firegrid/client/firegrid")
    expect(combined).toContain("EventStreamClientLive")
    expect(combined).not.toContain("@firegrid/runtime")
    expect(combined).not.toContain("@firegrid/substrate")
    expect(combined).not.toContain("@firegrid/client\"")
    expect(combined).not.toContain("'@firegrid/client'")
    expect(combined).not.toContain("@durable-streams/client")
    expect(combined).not.toContain(".append(")
    expect(combined).not.toContain("work.declare")
    expect(clientHelper).toContain("client.emit(LabEvents")
    expect(clientHelper).toContain("client.events(LabEvents")
  })
})

describe("launchable-substrate-host.LAB_INSPECTOR.2, launchable-substrate-host.LAB_INSPECTOR.4, launchable-substrate-host.LAB_INSPECTOR.7 — raw inspector live follow lifecycle", () => {
  it("bridges raw Durable Streams follow through a scoped Effect Stream and cancels on React teardown", () => {
    const inspector = readFileSync(
      resolve(labRoot, "RawStreamInspector.tsx"),
      "utf8",
    )

    expect(inspector).toContain("Effect.runFork")
    expect(inspector).toContain("Fiber.interrupt")
    expect(inspector).toContain("Effect.acquireRelease")
    expect(inspector).toContain("response.cancel()")
    expect(inspector).toContain("Stream.asyncScoped")
    expect(inspector).toContain("subscribeJson")
    expect(inspector).toContain('strategy: "suspend"')
    expect(inspector).not.toContain("for await")
    expect(inspector).not.toContain(".jsonStream(")
    expect(inspector).not.toContain("cancelled")
  })
})
