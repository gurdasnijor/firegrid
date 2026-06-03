/**
 * tf-ll90.5.1 — shape-c terminal-ordering proof driver.
 *
 * Public-surface only (`@firegrid/client-sdk`). Spawns the REAL `claude-acp`
 * agent, prompts it, and observes a full turn of raw agent_output
 * (`TextChunk` … `TurnComplete`). A `TurnComplete` is a raw agent_output that by
 * the per-event design does NOT terminate the session — the live process stays
 * registered. The driver then issues an explicit `session.close()`, the DURABLE
 * terminal: the host close binding emits `firegrid.unified.session.terminal_signal`
 * and executes the terminal per-event RuntimeContext handler, which runs
 * `adapter.deregister` (Scope.close → process reaped).
 *
 * The invariant the trace must show: terminal completion is bound to the durable
 * lifecycle (the terminal input/signal), NOT to a raw agent_output. Concretely,
 * `firegrid.unified.session.terminal_signal` precedes
 * `firegrid.unified.adapter.deregister` for the same `firegrid.context.id`, and
 * no `TurnComplete` agent_output triggers a deregister. The trace is the
 * deliverable; the prose finding interprets the ordering. This sim NEVER returns
 * a verdict object.
 *
 * Process-leak watch (tf-r06u.36 terminal-completion-relay leak): the finding
 * reports whether the deregister actually fired after close, or whether the
 * process leaked (terminal_signal with no following deregister).
 */

import {
  Firegrid,
  local,
  type FiregridService,
} from "@firegrid/client-sdk/firegrid"
import { Config, Effect, Option } from "effect"

const claudeAcpArgv = [
  "npx",
  "-y",
  "@agentclientprotocol/claude-agent-acp@0.36.1",
] as const

const anthropicKeyConfig = Config.redacted("ANTHROPIC_API_KEY").pipe(
  Config.option,
)

const marker = "SHAPE_C_TERMINAL_ORDERING_ACK"
const promptText = [
  "This is a Firegrid tiny simulation prompt-delivery probe.",
  `Reply with exactly this marker on its own line: ${marker}`,
  "Do not call tools. Do not inspect files.",
].join("\n")

interface ExternalKey {
  readonly source: string
  readonly id: string
}

const externalKey: ExternalKey = {
  source: "tiny-firegrid",
  id: "shape-c-terminal-ordering",
}

const sessionContextIdForExternalKey = (key: ExternalKey): string =>
  `session:${key.source}:${key.id}`

const sessionAgentOutputTarget = "session.agent_output"

interface AgentOutputObservation {
  readonly _tag: string
  readonly sequence: number
  readonly event?: {
    readonly _tag?: string
    readonly part?: {
      readonly delta?: string
    }
  }
}

const asObservation = (event: unknown): AgentOutputObservation | undefined => {
  if (typeof event !== "object" || event === null) return undefined
  const record = event as Record<string, unknown>
  if (typeof record._tag !== "string" || typeof record.sequence !== "number") {
    return undefined
  }
  return event as AgentOutputObservation
}

/**
 * Drive one full turn of raw agent_output until the agent completes its turn
 * (`TurnComplete`) or surfaces the marker text — proving the real agent is alive
 * and producing agent_output BEFORE any terminal is issued.
 */
const waitForTurn = (
  firegrid: FiregridService,
) =>
  Effect.gen(function*() {
    let text = ""
    let markerObserved = false
    const outputTags: Array<string> = []

    const textChunk = yield* firegrid.channels.waitFor(sessionAgentOutputTarget, {
      match: { _tag: "TextChunk" },
      timeoutMs: 30_000,
    })
    if (textChunk.matched) {
      const observation = asObservation(textChunk.event)
      if (observation !== undefined) {
        outputTags.push(observation._tag)
        text += observation.event?.part?.delta ?? ""
        markerObserved = text.includes(marker)
      }
    }
    const turnComplete = yield* firegrid.channels.waitFor(sessionAgentOutputTarget, {
      match: { _tag: "TurnComplete" },
      timeoutMs: 60_000,
    })
    const turnObservation = turnComplete.matched
      ? asObservation(turnComplete.event)
      : undefined
    if (turnObservation !== undefined) outputTags.push(turnObservation._tag)

    return {
      outputCount: outputTags.length,
      outputTags: outputTags.join(","),
      textLength: text.length,
      timedOut: !turnComplete.matched,
      markerObserved,
      turnCompleteObserved: turnComplete.matched,
      lastSequence: turnObservation?.sequence ?? -1,
    }
  })

export const shapeCTerminalOrderingDriver: Effect.Effect<void, unknown, Firegrid> =
  Effect.scoped(Effect.gen(function*() {
    const anthropicKey = yield* anthropicKeyConfig
    if (Option.isNone(anthropicKey)) {
      // No BLOCKING prompt — record a `blocked` finding and halt cleanly.
      yield* Effect.annotateCurrentSpan({
        "firegrid.shape_c_terminal.status": "blocked",
        "firegrid.shape_c_terminal.blocked_reason": "ANTHROPIC_API_KEY is absent",
        "firegrid.shape_c_terminal.anthropic_api_key_present": false,
      })
      return
    }

    const firegrid = yield* Firegrid
    const contextId = sessionContextIdForExternalKey(externalKey)

    const session = yield* firegrid.sessions.createOrLoad({
      externalKey,
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

    const promptOffset = yield* session.prompt({
      payload: { text: promptText },
      idempotencyKey: "tiny-firegrid-shape-c-terminal-turn-1",
    })
    const startOffset = yield* session.start()

    // 1) Observe a full turn of raw agent_output. A `TurnComplete` here does NOT
    //    terminate the session — the durable lifecycle is untouched.
    const turn = yield* waitForTurn(firegrid)

    // 2) Issue the explicit DURABLE terminal. This is the only thing that binds
    //    the lifecycle end: close binding → terminal_signal → terminal per-event
    //    handler → adapter.deregister.
    const closeResult = yield* session.close({
      reason: "tf-ll90.5.1 shape-c terminal-ordering probe",
    }).pipe(
      Effect.withSpan("tiny_firegrid.shape_c_terminal.driver.session_close", {
        kind: "client",
        attributes: {
          "firegrid.channel.target": "session.close",
          "firegrid.context.id": contextId,
        },
      }),
    )

    const postCloseTerminated = yield* firegrid.channels.waitFor(
      sessionAgentOutputTarget,
      {
        match: { _tag: "Terminated" },
        timeoutMs: 30_000,
      },
    )

    yield* Effect.annotateCurrentSpan({
      "firegrid.shape_c_terminal.status": turn.turnCompleteObserved
        ? "turn_completed_then_closed"
        : "incomplete_turn_then_closed",
      "firegrid.shape_c_terminal.anthropic_api_key_present": true,
      "firegrid.shape_c_terminal.context_id": contextId,
      "firegrid.shape_c_terminal.session_id": session.sessionId,
      "firegrid.shape_c_terminal.start_offset": startOffset.offset,
      "firegrid.shape_c_terminal.prompt_offset": promptOffset.offset,
      "firegrid.shape_c_terminal.close_acknowledged": closeResult.closed,
      "firegrid.shape_c_terminal.turn_output_count": turn.outputCount,
      "firegrid.shape_c_terminal.turn_output_tags": turn.outputTags,
      "firegrid.shape_c_terminal.turn_complete_observed": turn.turnCompleteObserved,
      "firegrid.shape_c_terminal.terminated_observed_post_close": postCloseTerminated.matched,
      "firegrid.shape_c_terminal.marker_observed": turn.markerObserved,
      "firegrid.shape_c_terminal.spawn_target": claudeAcpArgv.join(" "),
      "firegrid.shape_c_terminal.codec": "acp",
    })
  })).pipe(
    Effect.withSpan("tiny_firegrid.shape_c_terminal.driver", {
      kind: "client",
    }),
  )
