import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const here = dirname(fileURLToPath(import.meta.url))
const labRoot = resolve(here, "..", "lab")

describe("runtime-lab-inspector.WRITE_BOUNDARY.1 + firegrid-event-streams.CLIENT_API.1-.3 — typed lab EventStream workbench uses the Firegrid client", () => {
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
