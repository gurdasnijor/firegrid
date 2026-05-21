import {
  Firegrid,
  local,
} from "@firegrid/client-sdk/firegrid"
import {
  Clock,
  Effect,
  Schedule,
} from "effect"
import {
  driverResultMarker,
  durableChannelsReflectedCreateOrLoad,
  durableChannelsSyncAsyncEnv,
  mailboxChannelTarget,
} from "./host.ts"

/* eslint-disable local/no-fixed-polling -- empirical sim poll loop through the public client wait surface. */

interface SyncModeResult {
  readonly sessionId: string
  readonly contextId: string
  readonly barrierCentralized: boolean
}

interface AsyncModeResult {
  readonly channel: string
  readonly sentCount: number
  readonly sawWaitForCall: boolean
  readonly sawSendCalls: number
  readonly matchedId: string
  readonly matchedKind: string
  readonly matchedShard: string
}

interface DurableChannelsSyncAsyncResult {
  readonly verdict: "GREEN" | "YELLOW" | "RED"
  readonly sync: SyncModeResult
  readonly async: AsyncModeResult
}

const waitToolUseId = "tf-lfxs-wait"
const sendOneToolUseId = "tf-lfxs-send-1"
const sendTwoToolUseId = "tf-lfxs-send-2"

const deterministicAgentSource = (channel: string): string => `
const readline = require("node:readline")

const waitToolUseId = ${JSON.stringify(waitToolUseId)}
const sendOneToolUseId = ${JSON.stringify(sendOneToolUseId)}
const sendTwoToolUseId = ${JSON.stringify(sendTwoToolUseId)}
const channel = ${JSON.stringify(channel)}
const marker = ${JSON.stringify(driverResultMarker)}

const emit = value => {
  process.stdout.write(JSON.stringify(value) + "\\n")
}

const seenResults = new Map()

const maybeFinish = () => {
  if (
    !seenResults.has(waitToolUseId) ||
    !seenResults.has(sendOneToolUseId) ||
    !seenResults.has(sendTwoToolUseId)
  ) {
    return
  }
  const waitResult = seenResults.get(waitToolUseId)
  const content = waitResult && waitResult.content ? waitResult.content : {}
  const matched = content.event
    ? content.event
    : content.output && content.output.event
      ? content.output.event
      : content.output
        ? content.output
    : {}
  emit({
    type: "text",
    text: marker + " " + JSON.stringify({
      matchedId: matched.id,
      matchedKind: matched.kind,
      matchedShard: matched.shard,
      sentCount: 2
    })
  })
  emit({ type: "turn_complete", finishReason: "stop" })
  setTimeout(() => process.exit(0), 10)
}

let prompted = false
const rl = readline.createInterface({
  input: process.stdin,
  crlfDelay: Infinity
})

rl.on("line", line => {
  let event
  try {
    event = JSON.parse(line)
  } catch (_error) {
    return
  }

  if (event.type === "prompt" && !prompted) {
    prompted = true
    emit({
      type: "tool_use",
      toolUseId: sendOneToolUseId,
      name: "send",
      input: {
        channel,
        payload: {
          id: "mailbox-1",
          kind: "candidate.ready",
          shard: "alpha",
          body: "tf-lfxs mailbox-1"
        }
      }
    })
    emit({
      type: "tool_use",
      toolUseId: sendTwoToolUseId,
      name: "send",
      input: {
        channel,
        payload: {
          id: "mailbox-2",
          kind: "candidate.ready",
          shard: "beta",
          body: "tf-lfxs mailbox-2"
        }
      }
    })
    setTimeout(() => {
      emit({
        type: "tool_use",
        toolUseId: waitToolUseId,
        name: "wait_for",
        input: {
          channel,
          match: { id: "mailbox-2" },
          timeoutMs: 5000
        }
      })
    }, 50)
    return
  }

  if (event.type === "tool_result") {
    seenResults.set(event.toolUseId, event)
    maybeFinish()
  }
})
`

const markerPayload = (text: string): Record<string, unknown> | undefined => {
  const index = text.indexOf(driverResultMarker)
  if (index < 0) return undefined
  const json = text.slice(index + driverResultMarker.length).trim()
  if (json.length === 0) return undefined
  const parsed = JSON.parse(json) as unknown
  return typeof parsed === "object" && parsed !== null
    ? parsed as Record<string, unknown>
    : undefined
}

const stringField = (
  record: Record<string, unknown> | undefined,
  key: string,
): string =>
  typeof record?.[key] === "string" ? record[key] : ""

const runDriver = Effect.gen(function*() {
  const firegrid = yield* Firegrid
  const env = yield* Effect.promise(() => durableChannelsSyncAsyncEnv)
  const externalId = `sync-async-${env.runId}`

  const handle = yield* durableChannelsReflectedCreateOrLoad(env, {
    externalKey: {
      source: "tiny-firegrid.tf-lfxs",
      id: externalId,
    },
    runtime: local.jsonl({
      argv: [
        globalThis.process.execPath,
        "-e",
        deterministicAgentSource(mailboxChannelTarget),
      ],
      agent: "tf-lfxs-sync-async-agent",
      agentProtocol: "stdio-jsonl",
      cwd: globalThis.process.cwd(),
    }),
    createdBy: "tiny-firegrid-simulation",
  })
  const session = yield* firegrid.sessions.attach({
    sessionId: handle.sessionId,
  })
  yield* session.prompt({
    payload: "tf-lfxs drive sync createOrLoad then async send/wait_for",
    idempotencyKey: `tf-lfxs:${env.runId}:turn-1`,
  }).pipe(
    Effect.retry(
      Schedule.intersect(
        Schedule.spaced("1000 millis"),
        Schedule.recurs(60),
      ),
    ),
  )
  yield* session.start()

  const deadline = (yield* Clock.currentTimeMillis) + 120_000
  let sawWaitForCall = false
  let sawSendCalls = 0
  let sawTerminated = false
  let resultText = ""
  let resultPayload: Record<string, unknown> | undefined

  while (
    resultPayload === undefined &&
    !sawTerminated &&
    (yield* Clock.currentTimeMillis) < deadline
  ) {
    const next = yield* session.wait.forAgentOutput({ timeoutMs: 10_000 })
    if (!next.matched) continue

    const event = next.output.event
    if (event._tag === "ToolUse") {
      if (event.part.name === "wait_for") sawWaitForCall = true
      if (event.part.name === "send") sawSendCalls += 1
    }
    if (event._tag === "TextChunk") {
      resultText += event.part.delta
      resultPayload = markerPayload(resultText) ?? resultPayload
    }
    if (event._tag === "Terminated") sawTerminated = true
  }

  if (!sawWaitForCall) {
    return yield* Effect.fail(new Error("agent did not call wait_for"))
  }
  if (sawSendCalls !== 2) {
    return yield* Effect.fail(
      new Error(`agent emitted ${sawSendCalls} send calls; expected 2`),
    )
  }
  if (resultPayload === undefined) {
    return yield* Effect.fail(new Error("agent did not emit result marker"))
  }
  if (
    stringField(resultPayload, "matchedId") !== "mailbox-2" ||
    stringField(resultPayload, "matchedKind") !== "candidate.ready" ||
    stringField(resultPayload, "matchedShard") !== "beta"
  ) {
    return yield* Effect.fail(
      new Error(`wait_for matched unexpected payload: ${JSON.stringify(resultPayload)}`),
    )
  }

  const result: DurableChannelsSyncAsyncResult = {
    verdict: "GREEN",
    sync: {
      sessionId: session.sessionId,
      contextId: session.contextId,
      barrierCentralized: true,
    },
    async: {
      channel: mailboxChannelTarget,
      sentCount: typeof resultPayload?.sentCount === "number"
        ? resultPayload.sentCount
        : 0,
      sawWaitForCall,
      sawSendCalls,
      matchedId: stringField(resultPayload, "matchedId"),
      matchedKind: stringField(resultPayload, "matchedKind"),
      matchedShard: stringField(resultPayload, "matchedShard"),
    },
  }

  // firegrid-durable-channels-sync-async-spike.SYNC_HANDSHAKE.1
  // firegrid-durable-channels-sync-async-spike.SYNC_HANDSHAKE.2
  // firegrid-durable-channels-sync-async-spike.SYNC_HANDSHAKE.3
  // firegrid-durable-channels-sync-async-spike.ASYNC_MAILBOX.1
  // firegrid-durable-channels-sync-async-spike.ASYNC_MAILBOX.2
  // firegrid-durable-channels-sync-async-spike.ASYNC_MAILBOX.3
  // firegrid-durable-channels-sync-async-spike.VERDICT.1
  // firegrid-durable-channels-sync-async-spike.VERDICT.3
  yield* Effect.annotateCurrentSpan({
    "firegrid.tf_lfxs.verdict": result.verdict,
    "firegrid.tf_lfxs.sync.session_id": result.sync.sessionId,
    "firegrid.tf_lfxs.sync.context_id": result.sync.contextId,
    "firegrid.tf_lfxs.sync.barrier_centralized":
      result.sync.barrierCentralized,
    "firegrid.tf_lfxs.async.channel": result.async.channel,
    "firegrid.tf_lfxs.async.sent_count": result.async.sentCount,
    "firegrid.tf_lfxs.async.saw_wait_for": result.async.sawWaitForCall,
    "firegrid.tf_lfxs.async.saw_send_calls": result.async.sawSendCalls,
    "firegrid.tf_lfxs.async.matched_id": result.async.matchedId,
    "firegrid.tf_lfxs.async.matched_kind": result.async.matchedKind,
    "firegrid.tf_lfxs.async.matched_shard": result.async.matchedShard,
  })

  return result
}).pipe(
  Effect.withSpan("firegrid.tf_lfxs.durable_channels_sync_async.driver", {
    kind: "client",
  }),
)

export const durableChannelsSyncAsyncDriver: Effect.Effect<
  DurableChannelsSyncAsyncResult,
  unknown,
  Firegrid
> = runDriver

/* eslint-enable local/no-fixed-polling */
