import { DurableStream } from "@durable-streams/client"
import { DurableStreamTestServer } from "@durable-streams/server"
import {
  createPendingCompletion,
  rebuildProjection,
  type CompletionValue,
} from "@durable-agent-substrate/substrate"

// Slice 5 host-runner tests use an externally-managed
// DurableStreamTestServer so we can SEED durable state before the
// host scope opens. This is the only way to assert the "startup
// catch-up" behaviour cleanly: SubstrateHostBoot.embeddedDev starts
// its own server inside the layer scope, which makes pre-scope
// seeding impossible. SubstrateHostBoot.attached against this server
// reproduces the production attached-mode wiring.

let server: DurableStreamTestServer | undefined
let counter = 0

export async function startTestServer(): Promise<DurableStreamTestServer> {
  if (!server) {
    server = new DurableStreamTestServer({ port: 0 })
    await server.start()
  }
  return server
}

export async function stopTestServer(): Promise<void> {
  await server?.stop()
  server = undefined
}

export async function freshSubstrateStream(label: string): Promise<string> {
  if (!server) throw new Error("call startTestServer() in beforeAll first")
  const url = `${server.url}/substrate/host-${label}-${++counter}`
  await DurableStream.create({ url, contentType: "application/json" })
  return url
}

export async function appendEvent(url: string, event: unknown): Promise<void> {
  const stream = new DurableStream({ url, contentType: "application/json" })
  await stream.append(JSON.stringify(event))
}

export async function seedPendingTimer(
  url: string,
  completionId: string,
  dueAtMs: number,
): Promise<void> {
  await appendEvent(
    url,
    createPendingCompletion({
      completionId,
      kind: "timer",
      data: { durationMs: Math.max(0, dueAtMs - Date.now()), dueAtMs },
    }),
  )
}

export async function seedPendingScheduledWork(
  url: string,
  completionId: string,
  whenMs: number,
  input: unknown,
): Promise<void> {
  await appendEvent(
    url,
    createPendingCompletion({
      completionId,
      kind: "scheduled_work",
      data: { whenMs, input },
    }),
  )
}

export async function waitForCompletionState(
  url: string,
  completionId: string,
  predicate: (c: CompletionValue | undefined) => boolean,
  timeoutMs: number,
  pollMs = 50,
): Promise<CompletionValue | undefined> {
  const start = Date.now()
  let lastSnapshotCompletion: CompletionValue | undefined
  while (Date.now() - start < timeoutMs) {
    const snap = await rebuildProjection({ url })
    lastSnapshotCompletion = snap.completions.get(completionId)
    if (predicate(lastSnapshotCompletion)) return lastSnapshotCompletion
    await new Promise((r) => setTimeout(r, pollMs))
  }
  throw new Error(
    `waitForCompletionState timed out after ${timeoutMs}ms for ${completionId}; ` +
      `last seen state: ${lastSnapshotCompletion?.state}`,
  )
}

export async function snapshotCompletion(
  url: string,
  completionId: string,
): Promise<CompletionValue | undefined> {
  const snap = await rebuildProjection({ url })
  return snap.completions.get(completionId)
}
