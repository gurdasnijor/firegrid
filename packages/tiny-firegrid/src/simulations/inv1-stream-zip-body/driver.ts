import {
  Firegrid,
  local,
} from "@firegrid/client-sdk/firegrid"
import { Clock, Effect, Schedule } from "effect"

/* eslint-disable local/no-fixed-polling -- empirical sim poll loop through the public client wait surface; methodology.md keeps this shape explicit. */

interface Inv1StreamZipBodyResult {
  readonly sessionId: string
  readonly sawFirstMarker: boolean
  readonly sawSecondMarker: boolean
  readonly sawPermissionRequest: boolean
  readonly permissionAllowed: boolean
  readonly observedTags: ReadonlyArray<string>
  readonly resultText: string
}

const claudeAcpArgv = [
  "npx",
  "-y",
  "@agentclientprotocol/claude-agent-acp@0.36.1",
] as const

const firstMarker = "FIREGRID_INV1_FIRST_READY"
const secondMarker = "FIREGRID_INV1_SECOND_DONE"

const firstPrompt = [
  "Respond with exactly this line and no other text:",
  firstMarker,
].join("\n")

const secondPrompt = [
  "Now respond with exactly this line and no other text:",
  secondMarker,
].join("\n")

export const inv1StreamZipBodyDriver: Effect.Effect<
  Inv1StreamZipBodyResult,
  unknown,
  Firegrid
> = Effect.gen(function*() {
  const firegrid = yield* Firegrid
  const session = yield* firegrid.sessions.createOrLoad({
    externalKey: {
      source: "tiny-firegrid",
      id: "inv1-stream-zip-body",
    },
    runtime: local.jsonl({
      argv: [...claudeAcpArgv],
      agent: "claude-acp",
      agentProtocol: "acp",
      cwd: globalThis.process.cwd(),
      envBindings: [
        { name: "ANTHROPIC_API_KEY", ref: "env:ANTHROPIC_API_KEY" },
      ],
    }),
    createdBy: "tiny-firegrid-simulation",
  })

  yield* session.prompt({
    payload: firstPrompt,
    idempotencyKey: "inv1-stream-zip-body:turn-1",
  }).pipe(
    Effect.retry(
      Schedule.intersect(
        Schedule.spaced("1000 millis"),
        Schedule.recurs(60),
      ),
    ),
  )
  yield* session.start()

  const deadline = (yield* Clock.currentTimeMillis) + 180_000
  let sawFirstMarker = false
  let sawSecondMarker = false
  let sawPermissionRequest = false
  let permissionAllowed = false
  let secondPromptSent = false
  let resultText = ""
  const observedTags = new Set<string>()

  while (!sawSecondMarker) {
    if ((yield* Clock.currentTimeMillis) >= deadline) {
      return yield* Effect.fail(new Error("timed out waiting for INV-1 second marker"))
    }
    const next = yield* session.wait.forAgentOutput({
      timeoutMs: 15_000,
    }).pipe(
      Effect.retry(
        Schedule.intersect(
          Schedule.spaced("1000 millis"),
          Schedule.recurs(5),
        ),
      ),
    )
    if (!next.matched) continue
    const event = next.output.event
    observedTags.add(event._tag)
    if (event._tag === "PermissionRequest") {
      sawPermissionRequest = true
      const decision = yield* session.permissions.respond({
        permissionRequestId: event.permissionRequestId,
        decision: { _tag: "Allow", optionId: "allow" },
      }).pipe(Effect.either)
      if (decision._tag === "Right") permissionAllowed = true
    }
    if (event._tag === "TextChunk") {
      resultText += event.part.delta
      if (!sawFirstMarker && resultText.includes(firstMarker)) {
        sawFirstMarker = true
      }
      if (resultText.includes(secondMarker)) {
        sawSecondMarker = true
      }
    }
    if (sawFirstMarker && !secondPromptSent) {
      yield* session.prompt({
        payload: secondPrompt,
        idempotencyKey: "inv1-stream-zip-body:turn-2",
      })
      secondPromptSent = true
    }
  }

  yield* Effect.sleep("1500 millis")

  return {
    sessionId: session.contextId,
    sawFirstMarker,
    sawSecondMarker,
    sawPermissionRequest,
    permissionAllowed,
    observedTags: [...observedTags].sort(),
    resultText,
  }
})

/* eslint-enable local/no-fixed-polling */
