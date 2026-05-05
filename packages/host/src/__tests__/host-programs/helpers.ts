import { DurableStream } from "@durable-streams/client"
import {
  createPendingCompletion,
  rebuildProjection,
  type CompletionValue,
  type RunValue,
} from "@durable-agent-substrate/substrate"
import {
  freshStreamUrl,
  startTestServer,
  stopTestServer,
} from "../../../../../test-support/durable-streams-server.ts"

export { freshStreamUrl, startTestServer, stopTestServer }

export async function createSubstrateStream(label: string): Promise<string> {
  const url = freshStreamUrl(label)
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

export async function seedPendingProjectionMatch(
  url: string,
  completionId: string,
  description: unknown,
  options: { readonly deadlineAtMs?: number; readonly timeoutMs?: number } = {},
): Promise<void> {
  await appendEvent(
    url,
    createPendingCompletion({
      completionId,
      kind: "projection_match",
      data: {
        trigger: { kind: "projection_match", description },
        ...(options.deadlineAtMs !== undefined
          ? { deadlineAtMs: options.deadlineAtMs }
          : {}),
        ...(options.timeoutMs !== undefined
          ? { timeoutMs: options.timeoutMs }
          : {}),
      },
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
  let last: CompletionValue | undefined
  while (Date.now() - start < timeoutMs) {
    const snap = await rebuildProjection({ url })
    last = snap.completions.get(completionId)
    if (predicate(last)) return last
    await new Promise((r) => setTimeout(r, pollMs))
  }
  throw new Error(
    `waitForCompletionState timed out after ${timeoutMs}ms for ${completionId}; ` +
      `last seen state: ${last?.state}`,
  )
}

export async function waitForRunState(
  url: string,
  runId: string,
  predicate: (r: RunValue | undefined) => boolean,
  timeoutMs: number,
  pollMs = 50,
): Promise<RunValue | undefined> {
  const start = Date.now()
  let last: RunValue | undefined
  while (Date.now() - start < timeoutMs) {
    const snap = await rebuildProjection({ url })
    last = snap.runs.get(runId)
    if (predicate(last)) return last
    await new Promise((r) => setTimeout(r, pollMs))
  }
  throw new Error(
    `waitForRunState timed out after ${timeoutMs}ms for ${runId}; ` +
      `last seen state: ${last?.state}`,
  )
}

export async function snapshotRun(
  url: string,
  runId: string,
): Promise<RunValue | undefined> {
  const snap = await rebuildProjection({ url })
  return snap.runs.get(runId)
}

export async function snapshotCompletion(
  url: string,
  completionId: string,
): Promise<CompletionValue | undefined> {
  const snap = await rebuildProjection({ url })
  return snap.completions.get(completionId)
}
