/**
 * INV-2 driver: launches claude-agent-acp with the sim-local custom MCP
 * server attached via `mcpServers` (NOT the runtime-context MCP), prompts
 * the agent to call `wait_for` TWICE against CallerFact stream rows that
 * have already been seeded by the host, and records the run outcome.
 *
 * Each `wait_for` call is dispatched as a nested WaitForWorkflow execution
 * by the sim's custom MCP tool handler.
 */

import { Firegrid, local } from "@firegrid/client-sdk/firegrid"
import { Clock, Effect, Schedule } from "effect"
import {
  correlationIdA,
  correlationIdB,
  factEventTypeMatching,
  factSource,
  inv2WaitForWorkflowMcpServerName,
  inv2WaitForWorkflowMcpServerUrl,
  type Inv2HostOptions,
} from "./host.ts"

/* eslint-disable local/no-fixed-polling -- empirical sim poll loop through the public client wait surface; methodology.md keeps this shape explicit. */

interface Inv2DriverResult {
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

const RESULT_MARKER = "FIREGRID_INV2_DONE"

const promptForTwoWaits = (hostOptions: Inv2HostOptions): string => {
  const _url = inv2WaitForWorkflowMcpServerUrl(hostOptions)
  return [
    "You have an MCP server attached named ",
    `\`${inv2WaitForWorkflowMcpServerName}\` that exposes a single tool, \`wait_for\`.`,
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
        executionKey: "inv2-call-a",
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
        executionKey: "inv2-call-b",
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

export const inv2WaitForWorkflowDriver = (
  hostOptions: Inv2HostOptions,
): Effect.Effect<Inv2DriverResult, unknown, Firegrid> =>
  Effect.gen(function* () {
    const firegrid = yield* Firegrid
    const session = yield* firegrid.sessions.createOrLoad({
      externalKey: {
        source: "tiny-firegrid",
        id: "inv2-waitforworkflow",
      },
      runtime: local.jsonl({
        argv: [...claudeAcpArgv],
        agent: "claude-acp",
        agentProtocol: "acp",
        cwd: globalThis.process.cwd(),
        envBindings: [
          { name: "ANTHROPIC_API_KEY", ref: "env:ANTHROPIC_API_KEY" },
        ],
        // INV-2 deliberately does NOT use runtimeContextMcp (production
        // wait_for path). The custom sim MCP server below is the only
        // tool surface the agent sees.
        mcpServers: [
          {
            name: inv2WaitForWorkflowMcpServerName,
            server: {
              type: "url",
              url: inv2WaitForWorkflowMcpServerUrl(hostOptions),
            },
          },
        ],
      }),
      createdBy: "tiny-firegrid-simulation",
    })

    yield* session.prompt({
      payload: promptForTwoWaits(hostOptions),
      idempotencyKey: "inv2-waitforworkflow:turn-1",
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
