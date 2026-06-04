/**
 * factory-capstone driver — drives the capstone factory loop PURELY over
 * `@firegrid/client-sdk/mcp` (tf-ll90.8.4). No firegrid.ts client: the host owns
 * the gateway RuntimeContext carrying the claude-acp factory-loop agent (see
 * ./host.ts). The driver provisions ONE child session via `session_new` (it
 * inherits the gateway's claude-acp runtime + host-resolved runtime-context MCP),
 * prompts it with the factory-loop instructions via `session_prompt` (a task that
 * may suspend on an `input_required` permission round-trip — auto-answered Allow),
 * then watches the child's agent output for the terminal / finding marker.
 *
 * The factory loop itself (wait_for darkFactory.facts → session_new delegate →
 * session_prompt → approval gate → review/signoff) is executed BY THE AGENT
 * through the public Firegrid MCP tool surface; the driver only seeds the prompt
 * and observes markers. `FiregridConfig` is the only client-sdk import.
 *
 * Creds-gated: absent ANTHROPIC_API_KEY the capstone is structurally blocked.
 */

import { FiregridConfig } from "@firegrid/client-sdk/config"
import {
  makeFiregridMcpClient,
  type FiregridMcpSessionHandle,
} from "@firegrid/client-sdk/mcp"
import { Config, Duration, Effect, Option, Stream } from "effect"

// Airgapped driver — MIRRORS ./host.ts literals (kept in sync).
const gatewayContextId = "session:tiny-firegrid:factory-capstone-gateway"
const streamId = "factory-capstone"

const markerTerminal = "FACTORY_CAPSTONE_TERMINAL"
const markerFinding = "FACTORY_CAPSTONE_FINDING"

const anthropicKeyConfig = Config.redacted("ANTHROPIC_API_KEY").pipe(
  Config.option,
)

const promptForFactoryLoop = [
  "Drive the factory capstone loop using only the Firegrid MCP tools available in this ACP session.",
  "Do not inspect files. Do not call execute, call, or send for shell/file work.",
  "",
  "Required trace shape:",
  "1. Call wait_for with exactly { event: { channel: \"darkFactory.facts\", match: { eventType: \"factory.trigger.accepted\" }, timeoutMs: 30000 } }. Do not include a prompt field.",
  "2. After wait_for returns matched:true, continue in the same turn and create or load a delegated Firegrid session with session_new.",
  "3. Prompt that delegated session with session_prompt to draft a reviewed action plan for the trigger.",
  "4. Request operator approval before merge-signoff; continue when the ACP permission gate is approved.",
  "5. Review the delegated result and write a merge-signoff decision.",
  "",
  `When the loop reaches reviewed-action signoff, write one line beginning with ${markerTerminal}.`,
  `If any step is not expressible through the public Firegrid tool surface, write one line beginning with ${markerFinding} and name the missing surface.`,
].join("\n")

// Auto-approve every `input_required` permission round-trip on the prompt task
// (the MCP equivalent of the old `session.permissions.autoApprove("allow")`).
const autoApprovePermissions = (
  session: FiregridMcpSessionHandle,
  taskId: string,
) =>
  session.taskStates(taskId).pipe(
    Stream.takeWhile(task =>
      task.status === "working" || task.status === "input_required"),
    Stream.filter(task => task.status === "input_required"),
    Stream.runForEach(() =>
      session.respondToPermission(taskId, { _tag: "Allow" }).pipe(
        Effect.ignore,
      )),
    Effect.catchAllCause(() => Effect.void),
  )

const waitForMarker = (session: FiregridMcpSessionHandle) =>
  Effect.gen(function*() {
    let afterSequence: number | undefined
    let text = ""
    let outputCount = 0
    let permissionRequests = 0
    let timedOut = false
    let sawTerminal = false
    let sawFinding = false
    const outputTags: Array<string> = []

    while (
      !sawTerminal &&
      !sawFinding &&
      outputCount < 80 &&
      !timedOut
    ) {
      const next = yield* session.wait.forAgentOutput({
        ...(afterSequence === undefined ? {} : { afterSequence }),
        timeoutMs: 15_000,
      })
      if (!next.matched) {
        timedOut = true
      } else {
        afterSequence = next.output.sequence
        outputCount += 1
        outputTags.push(next.output._tag)
        if (next.output._tag === "PermissionRequest") {
          permissionRequests += 1
        }
        if (next.output._tag === "TextChunk") {
          text += next.output.event.part.delta
          sawTerminal = text.includes(markerTerminal)
          sawFinding = text.includes(markerFinding)
        }
        if (next.output._tag === "TurnComplete" || next.output._tag === "Terminated") {
          timedOut = !sawTerminal && !sawFinding
        }
      }
    }

    return {
      outputCount,
      permissionRequests,
      outputTags: outputTags.join(","),
      textLength: text.length,
      timedOut,
      sawTerminal,
      sawFinding,
      lastSequence: afterSequence ?? -1,
    }
  })

export const factoryCapstoneDriver: Effect.Effect<void, unknown, FiregridConfig> =
  Effect.scoped(Effect.gen(function*() {
    const anthropicKey = yield* anthropicKeyConfig
    if (Option.isNone(anthropicKey)) {
      yield* Effect.annotateCurrentSpan({
        "firegrid.factory_capstone.status": "blocked",
        "firegrid.factory_capstone.blocked_reason": "ANTHROPIC_API_KEY is absent",
        "firegrid.factory_capstone.anthropic_api_key_present": false,
      })
      return
    }

    const config = yield* FiregridConfig
    if (config.durableStreamsBaseUrl === undefined || config.namespace === undefined) {
      return yield* Effect.fail(
        new Error("factory-capstone requires durableStreamsBaseUrl and namespace"),
      )
    }

    const mcp = yield* makeFiregridMcpClient({
      durableStreamsBaseUrl: config.durableStreamsBaseUrl,
      namespace: config.namespace,
      streamId,
      clientId: 2,
      pollIntervalMs: 250,
    })

    yield* mcp.initialize

    // Wait for the host-seeded gateway context before provisioning off it.
    yield* mcp.observations.watchContexts(
      context => context.contextId === gatewayContextId,
    ).pipe(
      Stream.runHead,
      Effect.timeoutFail({
        duration: Duration.seconds(30),
        onTimeout: () => new Error("host gateway context did not appear over MCP"),
      }),
    )

    // Provision the capstone child over MCP — session_new inherits the gateway
    // claude-acp runtime (host-resolved runtime-context MCP).
    const session = yield* mcp.sessions.create({
      agentKind: "claude-acp",
      prompt: promptForFactoryLoop,
    })

    // Prompt the loop as a task; auto-approve its permission round-trips while
    // observing the child's agent output for the terminal / finding marker.
    const promptTask = yield* session.promptTask({
      prompt: promptForFactoryLoop,
      inputId: "tiny-firegrid-factory-capstone-turn-1",
      taskTtlMs: 180_000,
    })
    yield* Effect.forkScoped(autoApprovePermissions(session, promptTask.taskId))

    const result = yield* waitForMarker(session)

    yield* Effect.annotateCurrentSpan({
      "firegrid.factory_capstone.status": result.sawTerminal
        ? "terminal"
        : result.sawFinding
        ? "finding"
        : "incomplete",
      "firegrid.factory_capstone.anthropic_api_key_present": true,
      "firegrid.factory_capstone.context_id": session.contextId,
      "firegrid.factory_capstone.session_id": session.sessionId,
      "firegrid.factory_capstone.prompt_task_id": promptTask.taskId,
      "firegrid.factory_capstone.output_count": result.outputCount,
      "firegrid.factory_capstone.output_tags": result.outputTags,
      "firegrid.factory_capstone.permission_request_count": result.permissionRequests,
      "firegrid.factory_capstone.text_length": result.textLength,
      "firegrid.factory_capstone.timed_out": result.timedOut,
      "firegrid.factory_capstone.terminal_marker_observed": result.sawTerminal,
      "firegrid.factory_capstone.finding_marker_observed": result.sawFinding,
      "firegrid.factory_capstone.last_sequence": result.lastSequence,
      "firegrid.factory_capstone.transport": "mcp",
      "firegrid.factory_capstone.spawn_target":
        "npx -y @agentclientprotocol/claude-agent-acp@0.36.1",
    })
  })).pipe(
    Effect.withSpan("tiny_firegrid.factory_capstone.driver", {
      kind: "client",
    }),
  )
