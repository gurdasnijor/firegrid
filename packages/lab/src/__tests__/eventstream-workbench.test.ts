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

    const collected = await Effect.runPromise(
      labEvents(cfg).pipe(Stream.take(2), Stream.runCollect),
    )

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

    expect(combined).toContain("@durable-agent-substrate/client/firegrid")
    expect(combined).not.toContain("@firegrid/runtime")
    expect(combined).not.toContain("@durable-agent-substrate/substrate")
    expect(combined).not.toContain("@durable-streams/client")
    expect(combined).not.toContain(".append(")
    expect(combined).not.toContain("work.declare")
    expect(clientHelper).toContain("client.emit(LabEvents")
    expect(clientHelper).toContain("client.events(LabEvents")
  })
})
