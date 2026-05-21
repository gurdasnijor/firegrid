/* eslint-disable local/no-fixed-polling -- bounded simulation driver loop over public session output. */
import {
  Firegrid,
  local,
} from "@firegrid/client-sdk/firegrid"
import { Effect, Schedule } from "effect"
import {
  linearWebhookCookbookRouteUrl,
  linearWebhookCookbookSecret,
  linearWebhookSource,
} from "./host.ts"

const encoder = new TextEncoder()
const verifiedWebhookFactChannelTarget = "firegrid.verifiedWebhooks"
const resultMarker = "LINEAR_WEBHOOK_COOKBOOK_RESULT"
const webhookId = "delivery_1"

const bytesToArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("")

const hmacSha256Hex = (
  secret: string,
  rawBody: Uint8Array,
): Effect.Effect<string, unknown> =>
  Effect.tryPromise(async () => {
    const key = await globalThis.crypto.subtle.importKey(
      "raw",
      bytesToArrayBuffer(encoder.encode(secret)),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    )
    const digest = await globalThis.crypto.subtle.sign(
      "HMAC",
      key,
      bytesToArrayBuffer(rawBody),
    )
    return bytesToHex(new Uint8Array(digest))
  })

const linearPayload = {
  action: "update",
  type: "Issue",
  actor: {
    id: "user_1",
    type: "user",
  },
  createdAt: "2026-05-20T00:00:00.000Z",
  data: {
    id: "issue_1",
    identifier: "TF-123",
  },
  url: "https://linear.app/team/issue/TF-123/example",
  updatedFrom: {
    title: "old title",
  },
  organizationId: "org_1",
  webhookTimestamp: 1_779_232_800_000,
  webhookId,
} as const

const waitInput = {
  channel: verifiedWebhookFactChannelTarget,
  match: {
    source: linearWebhookSource,
    eventType: "Issue.update",
    webhookId,
  },
  timeoutMs: 30_000,
} as const

const scriptedPlanner = `
import readline from "node:readline"
const waitInput = ${JSON.stringify(waitInput)}
const resultMarker = ${JSON.stringify(resultMarker)}
let issuedWait = false
const rl = readline.createInterface({ input: process.stdin })
const write = value => console.log(JSON.stringify(value))
rl.on("line", line => {
  const message = JSON.parse(line)
  if (message.type === "prompt" && !issuedWait) {
    issuedWait = true
    write({
      type: "tool_use",
      toolUseId: "linear-webhook-wait",
      name: "wait_for",
      input: waitInput,
    })
  }
  if (message.type === "tool_result" && message.toolUseId === "linear-webhook-wait") {
    write({
      type: "text",
      messageId: "linear-webhook-result",
      text: resultMarker + ":" + JSON.stringify(message.content),
    })
    write({
      type: "turn_complete",
      messageId: "linear-webhook-complete",
      stopReason: "end_turn",
    })
    process.exit(0)
  }
})
`

interface WebhookRouteResponse {
  readonly ok: boolean
  readonly status: number
  readonly text: string
}

const parseJsonUnknown = (text: string): Effect.Effect<unknown, unknown> =>
  Effect.try({
    try: () => JSON.parse(text) as unknown,
    catch: cause => cause,
  })

const postSignedLinearWebhook = (
  routeUrl: string,
): Effect.Effect<unknown, unknown> =>
  Effect.gen(function*() {
    const rawBody = encoder.encode(JSON.stringify(linearPayload))
    const signature = yield* hmacSha256Hex(linearWebhookCookbookSecret, rawBody)
    const response = yield* Effect.tryPromise({
      try: async (): Promise<WebhookRouteResponse> => {
        const response = await fetch(routeUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-linear-signature": signature,
            "linear-delivery": webhookId,
            authorization: "Bearer must-not-be-captured",
          },
          body: rawBody,
        })
        return {
          ok: response.ok,
          status: response.status,
          text: await response.text(),
        }
      },
      catch: cause => cause,
    })
    if (!response.ok) {
      return yield* Effect.fail(
        `webhook route failed ${response.status}: ${response.text}`,
      )
    }
    return response.text.length === 0 ? undefined : yield* parseJsonUnknown(response.text)
  })

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const parseResultMarker = (
  resultText: string,
): Effect.Effect<Record<string, unknown>, unknown> =>
  Effect.gen(function*() {
    const markerStart = resultText.indexOf(`${resultMarker}:`)
    if (markerStart < 0) {
      return yield* Effect.fail("missing result marker")
    }
    const parsed = yield* parseJsonUnknown(
      resultText.slice(markerStart + resultMarker.length + 1),
    )
    if (!isRecord(parsed)) {
      return yield* Effect.fail("result marker payload was not an object")
    }
    return parsed
  })

interface LinearWebhookCookbookResult {
  readonly contextId: string
  readonly routeUrl: string
  readonly observedToolInput: unknown
  readonly routeResponse: unknown
  readonly waitResult: unknown
  readonly resultText: string
  readonly sawWaitForCall: boolean
  readonly sawResultMarker: boolean
  readonly sawTurnComplete: boolean
}

export const linearWebhookCookbookDriver: Effect.Effect<
  LinearWebhookCookbookResult,
  unknown,
  Firegrid
> =
  Effect.gen(function*() {
    const firegrid = yield* Firegrid
    const routeUrl = yield* Effect.promise(() => linearWebhookCookbookRouteUrl)
      .pipe(
        Effect.timeoutFail({
          duration: "30 seconds",
          onTimeout: () => new Error("timed out waiting for Linear webhook route"),
        }),
      )
    const session = yield* firegrid.sessions.createOrLoad({
      externalKey: {
        source: "tiny-firegrid.linear-webhook-cookbook",
        id: `linear-webhook-${crypto.randomUUID()}`,
      },
      runtime: local.jsonl({
        argv: [globalThis.process.execPath, "--input-type=module", "-e", scriptedPlanner],
        agent: "linear-webhook-cookbook-scripted-planner",
        agentProtocol: "stdio-jsonl",
        cwd: globalThis.process.cwd(),
        runtimeContextMcp: { enabled: true },
      }),
      createdBy: "tiny-firegrid-simulation",
    })

    yield* session.prompt({
      payload:
        "Wait for the signed Linear webhook through firegrid.verifiedWebhooks, then report the tool result.",
      idempotencyKey: "linear-webhook-cookbook:prompt-1",
    }).pipe(
      Effect.retry(
        Schedule.intersect(
          Schedule.spaced("1000 millis"),
          Schedule.recurs(60),
        ),
      ),
    )
    yield* session.start()

    let afterSequence: number | undefined
    let observedToolInput: unknown
    let routeResponse: unknown
    let resultText = ""
    let sawWaitForCall = false
    let sawResultMarker = false
    let sawTurnComplete = false
    for (let iteration = 0; iteration < 24 && !sawResultMarker; iteration += 1) {
      const next = yield* session.wait.forAgentOutput({
        ...(afterSequence === undefined ? {} : { afterSequence }),
        timeoutMs: 10_000,
      })
      if (!next.matched) continue
      const observation = next.output
      afterSequence = observation.sequence
      const event = observation.event
      if (event._tag === "ToolUse" && event.part.name === "wait_for") {
        sawWaitForCall = true
        observedToolInput = event.part.params
        routeResponse = yield* postSignedLinearWebhook(routeUrl)
      }
      if (event._tag === "TextChunk") {
        resultText += event.part.delta
        if (resultText.includes(resultMarker)) sawResultMarker = true
      }
      if (event._tag === "TurnComplete") sawTurnComplete = true
    }

    if (!sawWaitForCall) return yield* Effect.fail("expected wait_for ToolUse")
    if (!sawResultMarker) {
      return yield* Effect.fail("expected Linear webhook result marker")
    }
    if (routeResponse === undefined) {
      return yield* Effect.fail("expected signed webhook route response")
    }
    const toolInputJson = JSON.stringify(observedToolInput)
    if (!toolInputJson.includes(verifiedWebhookFactChannelTarget)) {
      return yield* Effect.fail("wait_for input did not use firegrid.verifiedWebhooks")
    }
    if (
      toolInputJson.includes("verifiedWebhookFacts") ||
      toolInputJson.includes("linear.webhook")
    ) {
      return yield* Effect.fail("wait_for input leaked a backing table or product channel")
    }
    const waitResult = yield* parseResultMarker(resultText)
    if (waitResult.matched !== true || !isRecord(waitResult.event)) {
      return yield* Effect.fail("wait_for did not return a matched event")
    }
    if (
      waitResult.event.source !== linearWebhookSource ||
      waitResult.event.eventType !== "Issue.update" ||
      waitResult.event.webhookId !== webhookId ||
      waitResult.event.externalEventKey !== webhookId
    ) {
      return yield* Effect.fail("wait_for matched event did not carry the Linear fact scalars")
    }

    yield* Effect.annotateCurrentSpan({
      "firegrid.demo.linear_webhook.context_id": session.contextId,
      "firegrid.demo.linear_webhook.route_url": routeUrl,
      "firegrid.demo.linear_webhook.channel": verifiedWebhookFactChannelTarget,
      "firegrid.demo.linear_webhook.webhook_id": webhookId,
      "firegrid.demo.linear_webhook.saw_wait_for": sawWaitForCall,
      "firegrid.demo.linear_webhook.saw_result": sawResultMarker,
      "firegrid.demo.linear_webhook.event_type": String(waitResult.event.eventType),
    })

    return {
      contextId: session.contextId,
      routeUrl,
      observedToolInput,
      routeResponse,
      waitResult,
      resultText,
      sawWaitForCall,
      sawResultMarker,
      sawTurnComplete,
    }
  }).pipe(
    Effect.withSpan("firegrid.demo.linear_webhook.driver", {
      kind: "client",
    }),
  )
