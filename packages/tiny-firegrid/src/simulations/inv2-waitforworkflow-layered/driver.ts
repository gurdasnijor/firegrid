/**
 * INV-2 PATH A AMENDMENT driver. Identical agent loop to the sibling sim
 * `inv2-waitforworkflow/driver.ts`; only the prompt/marker/MCP-server-name
 * differ so the two sims' agent outputs don't collide when comparing traces.
 */

import { Firegrid, local } from "@firegrid/client-sdk/firegrid"
import { Clock, Effect, Schedule } from "effect"
import {
  correlationIdA,
  correlationIdB,
  factEventTypeMatching,
  factSource,
  inv2LayeredMcpServerName,
  inv2LayeredMcpServerUrl,
  type Inv2LayeredHostOptions,
} from "./host.ts"

/* eslint-disable local/no-fixed-polling -- empirical sim poll loop through the public client wait surface; methodology.md keeps this shape explicit. */

interface Inv2LayeredDriverResult {
  readonly sessionId: string
  readonly observedToolNames: ReadonlyArray<string>
  readonly waitForCallCount: number
  readonly sawPermissionRequest: boolean
  readonly permissionsAllowed: number
  readonly sawResultMarker: boolean
  readonly sawTurnComplete: boolean
  readonly resultText: string
}

const claudeAcpArgv = [
  "npx",
  "-y",
  "@agentclientprotocol/claude-agent-acp@0.36.1",
] as const

const RESULT_MARKER = "FIREGRID_INV2_LAYERED_DONE"

const promptForTwoWaits = (): string => {
  return [
    "You have an MCP server attached named ",
    `\`${inv2LayeredMcpServerName}\` that exposes a single tool, \`wait_for\`.`,
    "",
    "Call `wait_for` TWICE in sequence (one after the other completes).",
    "",
    "First call — use these exact params:",
    JSON.stringify(
      {
        waitQuery: {
          source: { _tag: "CallerFact", stream: factSource },
          whereFields: {
            correlationId: correlationIdA,
            eventType: factEventTypeMatching,
          },
        },
        timeoutMs: 30000,
        executionKey: "inv2-layered-call-a",
      },
      null,
      2,
    ),
    "",
    "Second call — use these exact params:",
    JSON.stringify(
      {
        waitQuery: {
          source: { _tag: "CallerFact", stream: factSource },
          whereFields: {
            correlationId: correlationIdB,
            eventType: factEventTypeMatching,
          },
        },
        timeoutMs: 30000,
        executionKey: "inv2-layered-call-b",
      },
      null,
      2,
    ),
    "",
    `After both \`wait_for\` calls return, emit exactly one line: ${RESULT_MARKER}`,
    "and then stop. Do not call any other tool. Do not summarize, do not",
    "describe; just call the tool twice and emit the marker.",
  ].join("\n")
}

export const inv2LayeredDriver = (
  hostOptions: Inv2LayeredHostOptions,
): Effect.Effect<Inv2LayeredDriverResult, unknown, Firegrid> =>
  Effect.gen(function* () {
    const firegrid = yield* Firegrid
    const session = yield* firegrid.sessions.createOrLoad({
      externalKey: {
        source: "tiny-firegrid",
        id: "inv2-waitforworkflow-layered",
      },
      runtime: local.jsonl({
        argv: [...claudeAcpArgv],
        agent: "claude-acp",
        agentProtocol: "acp",
        cwd: globalThis.process.cwd(),
        envBindings: [
          { name: "ANTHROPIC_API_KEY", ref: "env:ANTHROPIC_API_KEY" },
        ],
        mcpServers: [
          {
            name: inv2LayeredMcpServerName,
            server: {
              type: "url",
              url: inv2LayeredMcpServerUrl(hostOptions),
            },
          },
        ],
      }),
      createdBy: "tiny-firegrid-simulation",
    })

    yield* session.prompt({
      payload: promptForTwoWaits(),
      idempotencyKey: "inv2-waitforworkflow-layered:turn-1",
    }).pipe(
      Effect.retry(
        Schedule.intersect(
          Schedule.spaced("1000 millis"),
          Schedule.recurs(60),
        ),
      ),
    )
    yield* session.start()

    const deadline = (yield* Clock.currentTimeMillis) + 240_000
    let afterSequence: number | undefined
    let waitForCallCount = 0
    let sawPermissionRequest = false
    let permissionsAllowed = 0
    let sawResultMarker = false
    let sawTurnComplete = false
    let resultText = ""
    const observedToolNames = new Set<string>()

    while (!sawResultMarker && !sawTurnComplete) {
      if ((yield* Clock.currentTimeMillis) >= deadline) break
      const next = yield* session.wait.forAgentOutput({
        ...(afterSequence === undefined ? {} : { afterSequence }),
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
      const observation = next.output
      afterSequence = observation.sequence
      const event = observation.event
      if (event._tag === "ToolUse") {
        observedToolNames.add(event.part.name)
        if (
          event.part.name === "wait_for" ||
          event.part.name.endsWith("__wait_for")
        ) {
          waitForCallCount += 1
        }
      }
      if (event._tag === "PermissionRequest") {
        sawPermissionRequest = true
        const decision = yield* session.permissions.respond({
          permissionRequestId: event.permissionRequestId,
          decision: { _tag: "Allow", optionId: "allow" },
        }).pipe(Effect.either)
        if (decision._tag === "Right") permissionsAllowed += 1
      }
      if (event._tag === "TextChunk") {
        resultText += event.part.delta
        if (resultText.includes(RESULT_MARKER)) sawResultMarker = true
      }
      if (event._tag === "TurnComplete") sawTurnComplete = true
    }

    return {
      sessionId: session.contextId,
      observedToolNames: [...observedToolNames].sort(),
      waitForCallCount,
      sawPermissionRequest,
      permissionsAllowed,
      sawResultMarker,
      sawTurnComplete,
      resultText,
    }
  })

/* eslint-enable local/no-fixed-polling */
