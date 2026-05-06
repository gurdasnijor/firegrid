import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const here = dirname(fileURLToPath(import.meta.url))
const labRoot = resolve(here, "..", "lab")

describe("runtime-lab-inspector.WRITE_BOUNDARY.1 + firegrid-event-streams.CLIENT_API.1-.3 — typed lab EventStream workbench uses the Firegrid client", () => {
  it("firegrid-client-api.LAB_COMPATIBILITY.1 and .4 — typed workbench UI depends on a lab-local client seam", () => {
    const seam = readFileSync(resolve(labRoot, "LabClient.ts"), "utf8")
    const eventPanel = readFileSync(
      resolve(labRoot, "LabEventStreamPanel.tsx"),
      "utf8",
    )
    const operationPanel = readFileSync(
      resolve(labRoot, "LabOperationPanel.tsx"),
      "utf8",
    )
    const app = readFileSync(resolve(labRoot, "App.tsx"), "utf8")
    const descriptor = readFileSync(resolve(labRoot, "lab-events.ts"), "utf8")
    const combined = `${seam}\n${eventPanel}\n${operationPanel}\n${app}\n${descriptor}`
    const reactComponents = `${eventPanel}\n${operationPanel}\n${app}`

    expect(app).toContain("Production client readiness surface")
    expect(app).toContain("stream source:")
    expect(app).toContain("uses LabClient seam")
    expect(app).toContain("Read-only raw stream inspector")
    expect(app).toContain("not a client")
    expect(app).toContain("<LabOperationPanel streamUrl={streamUrl} />")
    expect(app).toContain("<LabEventStreamPanel streamUrl={streamUrl} />")
    expect(app).toContain("<RawStreamInspector streamUrl={streamUrl} />")
    expect(eventPanel).toContain("./LabClient.ts")
    expect(operationPanel).toContain("./LabClient.ts")
    expect(reactComponents).not.toContain("@firegrid/client")
    expect(reactComponents).not.toContain("./LabEventStreamClient.ts")
    expect(seam).toContain("@firegrid/client")
    expect(seam).toContain("FiregridClientLive")
    expect(seam).toContain("yield* FiregridClient")
    expect(seam).toContain("client.emit(LabEvents")
    expect(seam).toContain("client.events(LabEvents")
    expect(seam).toContain("Operation.define")
    expect(seam).toContain("client.send(LabEchoOperation")
    expect(seam).toContain("client.call(LabEchoOperation")
    expect(seam).toContain("client.result(")
    expect(seam).toContain(".observe(LabEchoOperation")
    expect(operationPanel).toContain("Wait for result")
    expect(operationPanel).toContain("Call and wait")
    expect(operationPanel).toContain("waiting for attached runtime result")
    expect(operationPanel).toContain("never invent a")
    expect(operationPanel).toContain("completed response in the lab")
    expect(seam).not.toContain("@firegrid/client/event-streams")
    expect(descriptor).toContain("@firegrid/client")
    expect(reactComponents).not.toContain("@firegrid/client")
    expect(combined).not.toContain("@firegrid/runtime")
    expect(combined).not.toContain("@firegrid/substrate")
    expect(combined).not.toContain("@firegrid/substrate/kernel")
    expect(combined).not.toContain("@durable-streams/client")
    expect(combined).not.toContain("new DurableStream")
    expect(combined).not.toContain(".append(")
    expect(combined).not.toContain(".write(")
    expect(combined).not.toContain("work.declare")
    expect(combined).not.toContain("processReadyWorkItem")
    expect(combined).not.toContain("claimRun")
    expect(combined).not.toContain("terminalize")
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
