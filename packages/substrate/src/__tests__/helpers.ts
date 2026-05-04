import { DurableStream } from "@durable-streams/client"
import { DurableStreamTestServer } from "@durable-streams/server"
import type { ChangeEvent } from "@durable-streams/state"
import type {
  ClaimAttemptValue,
  CompletionValue,
  RunValue,
  TraceValue,
} from "../rows.js"
import { TraceRowType } from "../rows.js"
import { substrateState } from "../state-schema.js"

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

export function freshStreamUrl(label: string): string {
  if (!server) throw new Error("call startTestServer() in beforeAll first")
  return `${server.url}/substrate/${label}-${++counter}`
}

// durable-records-and-projections.SUBSTRATE_SCOPE.7 — typed event helpers per row family.
export const runEvent = {
  insert: (value: RunValue) => substrateState.runs.insert({ value }),
  upsert: (value: RunValue) => substrateState.runs.upsert({ value }),
  insertWithHeaders: (value: RunValue, headers: Record<string, string>) =>
    substrateState.runs.insert({ value, headers }),
  upsertWithHeaders: (value: RunValue, headers: Record<string, string>) =>
    substrateState.runs.upsert({ value, headers }),
}

export const completionEvent = {
  insert: (value: CompletionValue) => substrateState.completions.insert({ value }),
  upsert: (value: CompletionValue) => substrateState.completions.upsert({ value }),
}

export const claimAttemptEvent = {
  insert: (value: ClaimAttemptValue) =>
    substrateState.claimAttempts.insert({ value }),
}

// Trace is intentionally outside the canonical state schema (RECORDS.8),
// so it has no typed helper. Tests construct trace events directly here.
export const traceEvent = {
  insert: (value: TraceValue): ChangeEvent => ({
    type: TraceRowType,
    key: value.traceId,
    value,
    headers: { operation: "insert" },
  }),
}

export async function publishToStream(
  url: string,
  events: ReadonlyArray<ChangeEvent>,
): Promise<void> {
  const stream = await DurableStream.create({ url, contentType: "application/json" })
  for (const event of events) {
    await stream.append(JSON.stringify(event))
  }
  await stream.close()
}
