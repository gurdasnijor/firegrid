import * as acp from "@agentclientprotocol/sdk"
import { Effect } from "effect"
import { inMemoryAcpEdgeHarness } from "./harness.ts"

interface AcpEdgeTransportResult {
  readonly initializedProtocolVersion: number
  readonly acpSessionId: string
  readonly firstStopReason: acp.StopReason
  readonly secondStopReason: acp.StopReason
  readonly sessionUpdateCount: number
  readonly firstText: string
  readonly secondText: string
}

const textFromUpdates = (
  updates: ReadonlyArray<acp.SessionNotification>,
): ReadonlyArray<string> =>
  updates.flatMap(notification => {
    const update = notification.update
    return update.sessionUpdate === "agent_message_chunk" &&
        update.content.type === "text"
      ? [update.content.text]
      : []
  })

const makeTestClient = (
  updates: Array<acp.SessionNotification>,
): acp.Client => ({
  sessionUpdate: async params => {
    updates.push(params)
  },
  requestPermission: async params => ({
    outcome: {
      outcome: "selected",
      optionId: params.options[0]?.optionId ?? "allow",
    },
  }),
})

const reject = <A>(message: string): Promise<A> =>
  Promise.reject(new Error(message))

export const acpEdgeTransportDriver: Effect.Effect<
  AcpEdgeTransportResult,
  unknown
> = Effect.tryPromise({
  try: async (): Promise<AcpEdgeTransportResult> => {
    const updates: Array<acp.SessionNotification> = []
    const stream = acp.ndJsonStream(
      inMemoryAcpEdgeHarness.clientOutput,
      inMemoryAcpEdgeHarness.clientInput,
    )
    const connection = new acp.ClientSideConnection(
      () => makeTestClient(updates),
      stream,
    )

    const initialized = await connection.initialize({
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: {},
    })
    const session = await connection.newSession({
      cwd: globalThis.process.cwd(),
      mcpServers: [],
    })
    const first = await connection.prompt({
      sessionId: session.sessionId,
      messageId: "acp-edge-turn-1",
      prompt: [
        {
          type: "text",
          text: "first Firegrid ACP edge turn",
        },
      ],
    })
    const second = await connection.prompt({
      sessionId: session.sessionId,
      messageId: "acp-edge-turn-2",
      prompt: [
        {
          type: "text",
          text: "second Firegrid ACP edge turn",
        },
      ],
    })

    const texts = textFromUpdates(updates)
    if (first.stopReason !== "end_turn") {
      return reject(`expected first ACP turn to end_turn, got ${first.stopReason}`)
    }
    if (second.stopReason !== "end_turn") {
      return reject(`expected second ACP turn to end_turn, got ${second.stopReason}`)
    }
    if (texts.length < 2) {
      return reject("expected ACP sessionUpdate text for both turns")
    }

    return {
      initializedProtocolVersion: initialized.protocolVersion,
      acpSessionId: session.sessionId,
      firstStopReason: first.stopReason,
      secondStopReason: second.stopReason,
      sessionUpdateCount: updates.length,
      firstText: texts[0] ?? "",
      secondText: texts[1] ?? "",
    }
  },
  catch: cause => cause,
}).pipe(
  Effect.tap(result =>
    Effect.annotateCurrentSpan({
      "firegrid.acp_edge_transport.protocol_version": result.initializedProtocolVersion,
      "firegrid.acp_edge_transport.acp_session_id": result.acpSessionId,
      "firegrid.acp_edge_transport.first_stop_reason": result.firstStopReason,
      "firegrid.acp_edge_transport.second_stop_reason": result.secondStopReason,
      "firegrid.acp_edge_transport.session_update_count": result.sessionUpdateCount,
      "firegrid.acp_edge_transport.first_text": result.firstText,
      "firegrid.acp_edge_transport.second_text": result.secondText,
    }),
  ),
  Effect.withSpan("firegrid.acp_edge_transport.driver", {
    kind: "client",
    attributes: {
      "firegrid.acid": "firegrid-zed-acp-stdio-external-agent.VALIDATION.4",
    },
  }),
)
