/**
 * Tracer 023 — protocol-aware agent interface (real ACP SDK).
 *
 * Goal: validate Firegrid's substrate boundary against real ACP semantics —
 * initialize, session/new, session/prompt, session/update, requestPermission —
 * without adding ACP/MCP vocabulary to Firegrid packages and without inventing
 * a homegrown JSON-RPC facsimile.
 *
 * Architectural shape:
 *
 *   client (test)                                            durable plane
 *     |                                                            ^
 *     | 1. appendRuntimeIngress(prompt, kind="message")             |
 *     |    ----------------------------------------------------> RuntimeIngressTable
 *     | 2. runAcpTurn(adapter spawns ACP example agent)             |
 *     |    -- reads sequenced prompt row BEFORE sending ----------+ |
 *     |    -- ACP session/prompt -> agent subprocess (ndjson stdio)  |
 *     |    -- agent emits session/update + requestPermission         |
 *     |    -- adapter writes one row per ACP msg ---------------> AcpObservationTable
 *     |                                                              |
 *     | 3. test inspects RuntimeIngressTable + AcpObservationTable rows
 *
 * Asserted ACIDs:
 *  - firegrid-agent-ingress.INGRESS.1
 *  - firegrid-agent-ingress.INGRESS.2
 *  - firegrid-agent-ingress.INGRESS.4
 *  - firegrid-agent-ingress.INGRESS.6
 *  - firegrid-agent-ingress.HOST.3
 *  - firegrid-agent-ingress.BOUNDARY.1
 *  - firegrid-agent-ingress.BOUNDARY.4
 *  - client-event-plane-registration.ACP_AGENT_PROFILE.1
 *  - client-event-plane-registration.ACP_AGENT_PROFILE.3
 *  - firegrid-scheduling-tool-bindings.NEUTRAL_TOOL_BINDING_SHAPE.1
 *  - firegrid-scheduling-tool-bindings.NEUTRAL_TOOL_BINDING_SHAPE.4
 *  - firegrid-scheduling-tool-bindings.DURABLE_DESCRIPTOR_PUBLICATION.4
 *  - firegrid-scheduling-tool-bindings.AGENT_OBSERVATION_RECIPE.4
 *  - firegrid-scheduling-tool-bindings.NON_SCOPE.1
 *  - firegrid-scheduling-tool-bindings.NON_SCOPE.6
 *  - firegrid-workflow-driven-runtime.BOUNDARIES.1
 *  - firegrid-platform-invariants.AUTHORITY.4
 */

import { DurableStreamTestServer } from "@durable-streams/server"
import {
  appendRuntimeIngress,
  FiregridRuntimeHostLive,
} from "@firegrid/runtime"
import { RuntimeIngressTable } from "@firegrid/protocol/runtime-ingress"
import { Effect, Layer } from "effect"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  AcpObservationTable,
  acpObservationTableLayerOptions,
  allowEditsPolicy,
  runAcpTurn,
  type AgentToolDescriptor,
} from "./fixtures/acp-adapter.ts"

const here = dirname(fileURLToPath(import.meta.url))
const agentScript = join(here, "fixtures", "acp-example-agent.mjs")

let server: DurableStreamTestServer | undefined
let baseUrl: string | undefined

beforeEach(async () => {
  server = new DurableStreamTestServer({ port: 0, host: "127.0.0.1" })
  baseUrl = await server.start()
})

afterEach(async () => {
  await server?.stop()
  server = undefined
  baseUrl = undefined
})

// Frozen neutral tool catalog. The descriptor objects intentionally contain
// extra fields (transport, credentials, host id) so the test can prove the
// adapter strips them before exposing anything to the agent.
//
// NEUTRAL_TOOL_BINDING_SHAPE.4: credentials must not flow through agent-
// visible descriptors.
const untrustedCatalog: ReadonlyArray<AgentToolDescriptor & {
  readonly transport?: string
  readonly credentials?: { readonly token: string }
  readonly hostId?: string
}> = [
  {
    name: "firegrid_context",
    description: "Returns the current Firegrid runtime context identity.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    transport: "tcp://internal-streams.example:4007",
    credentials: { token: "MUST-NOT-LEAK" },
    hostId: "host-abc-secret",
  },
  {
    name: "firegrid_record_marker",
    description: "Append a non-secret marker to a caller-owned EventPlane row.",
    inputSchema: {
      type: "object",
      properties: { marker: { type: "string", maxLength: 64 } },
      required: ["marker"],
      additionalProperties: false,
    },
  },
]

const namespaceFor = (suffix: string) => `tracer-023-${suffix}-${crypto.randomUUID()}`

describe("tracer 023 protocol-aware agent interface", () => {
  it(
    "firegrid-agent-ingress.INGRESS.1 firegrid-agent-ingress.INGRESS.6 firegrid-agent-ingress.HOST.3 firegrid-agent-ingress.BOUNDARY.1 firegrid-agent-ingress.BOUNDARY.4 firegrid-scheduling-tool-bindings.NEUTRAL_TOOL_BINDING_SHAPE.1 firegrid-scheduling-tool-bindings.NEUTRAL_TOOL_BINDING_SHAPE.4 firegrid-scheduling-tool-bindings.DURABLE_DESCRIPTOR_PUBLICATION.4 firegrid-scheduling-tool-bindings.AGENT_OBSERVATION_RECIPE.4 firegrid-scheduling-tool-bindings.NON_SCOPE.1 firegrid-scheduling-tool-bindings.NON_SCOPE.6 client-event-plane-registration.ACP_AGENT_PROFILE.1 client-event-plane-registration.ACP_AGENT_PROFILE.3 firegrid-workflow-driven-runtime.BOUNDARIES.1 firegrid-platform-invariants.AUTHORITY.4 runs one ACP turn through durable Firegrid ingress and records every ACP message as caller-owned durable evidence",
    async () => {
      if (!baseUrl) throw new Error("durable streams test server not started")
      const namespace = namespaceFor("turn")
      const contextId = `tracer023-${crypto.randomUUID()}`
      const promptText = `tracer-023-prompt-${crypto.randomUUID()}`

      const hostLayer = FiregridRuntimeHostLive({
        durableStreamsBaseUrl: baseUrl,
        namespace,
        input: true,
      })
      const observationLayer = AcpObservationTable.layer(
        acpObservationTableLayerOptions({
          streamUrl: `${baseUrl}/v1/stream/${encodeURIComponent(namespace + ".tracer023.acpObservation")}`,
        }),
      )

      // INGRESS.1 + AUTHORITY.4: the prompt is a durable RuntimeIngress row
      // BEFORE any ACP/provider side effect.
      const appended = await Effect.runPromise(
        appendRuntimeIngress({
          contextId,
          kind: "message",
          authoredBy: "client",
          payload: [{ type: "text", text: promptText }],
          idempotencyKey: "tracer-023-prompt-idem",
        }).pipe(Effect.provide(hostLayer)),
      )
      expect(appended.contextId).toBe(contextId)
      expect(appended.status).toBe("sequenced")

      // Run the ACP turn. The adapter must read the durable prompt row
      // before calling connection.prompt(...).
      const result = await Effect.runPromise(
        runAcpTurn({
          contextId,
          agentArgv: [process.execPath, agentScript],
          cwd: here,
          toolCatalog: untrustedCatalog,
          permissionPolicy: allowEditsPolicy,
          env: { TRACER_AGENT_MARKER: `marker-${contextId}` },
        }).pipe(
          Effect.scoped,
          Effect.provide(Layer.merge(hostLayer, observationLayer)),
        ),
      )

      expect(result.promptInputId).toBe(appended.inputId)
      expect(result.promptResponse.stopReason).toBe("end_turn")

      // NEUTRAL_TOOL_BINDING_SHAPE.1 + .4 + DURABLE_DESCRIPTOR_PUBLICATION.4:
      // descriptors visible to the adapter are exactly the {name, description,
      // inputSchema} triple. Credentials, transport, and hostId fields from
      // the untrusted source MUST NOT survive into the frozen catalog.
      for (const descriptor of result.frozenCatalog) {
        expect(Object.keys(descriptor).sort()).toEqual(
          ["description", "inputSchema", "name"],
        )
      }

      // Read durable observation rows.
      const observations = await Effect.runPromise(
        Effect.gen(function*() {
          const table = yield* AcpObservationTable
          return yield* table.observations.query((coll) =>
            coll.toArray
              .filter((row) => row.contextId === contextId)
              .sort((left, right) => left.sequence - right.sequence),
          )
        }).pipe(Effect.scoped, Effect.provide(observationLayer)),
      )

      // ACP_AGENT_PROFILE.1 + AGENT_OBSERVATION_RECIPE.4: protocol updates
      // land as caller-owned EventPlane rows, not as Firegrid-native row
      // families. Verify methods/directions exist.
      const initRequest = observations.find((row) =>
        row.method === "initialize" && row.direction === "client_to_agent",
      )
      expect(initRequest).toBeDefined()
      const initResponse = observations.find((row) =>
        row.method === "initialize" && row.direction === "agent_to_client",
      )
      expect(initResponse).toBeDefined()
      expect(JSON.parse(initResponse!.payloadJson).protocolVersion).toBeDefined()

      const newSessionResponse = observations.find((row) =>
        row.method === "session/new" && row.direction === "agent_to_client",
      )
      expect(newSessionResponse).toBeDefined()
      const newSessionPayload = JSON.parse(newSessionResponse!.payloadJson) as {
        readonly sessionId?: string
      }
      expect(typeof newSessionPayload.sessionId).toBe("string")

      const promptRequest = observations.find((row) =>
        row.method === "session/prompt" && row.direction === "client_to_agent",
      )
      expect(promptRequest).toBeDefined()
      const promptRequestPayload = JSON.parse(promptRequest!.payloadJson) as {
        readonly promptInputId?: string
      }
      // INGRESS.1 + INGRESS.2: durable input id is correlated with the ACP
      // prompt dispatch.
      expect(promptRequestPayload.promptInputId).toBe(appended.inputId)

      const sessionUpdates = observations.filter((row) =>
        row.method === "session/update",
      )
      expect(sessionUpdates.length).toBeGreaterThanOrEqual(4)

      // The example agent emits at least: agent_message_chunk (start),
      // tool_call (read), tool_call_update (read complete), tool_call (edit),
      // tool_call_update (edit complete), agent_message_chunk (end).
      const sessionUpdateKinds = sessionUpdates.map((row) => {
        const payload = JSON.parse(row.payloadJson) as {
          readonly update?: { readonly sessionUpdate?: string }
        }
        return payload.update?.sessionUpdate
      })
      expect(sessionUpdateKinds).toContain("agent_message_chunk")
      expect(sessionUpdateKinds).toContain("tool_call")
      expect(sessionUpdateKinds).toContain("tool_call_update")

      const permissionRequest = observations.find((row) =>
        row.method === "session/request_permission" &&
        row.direction === "agent_to_client",
      )
      expect(permissionRequest).toBeDefined()
      const permissionResponse = observations.find((row) =>
        row.method === "session/request_permission" &&
        row.direction === "client_to_agent",
      )
      expect(permissionResponse).toBeDefined()

      const promptResponseObservation = observations.find((row) =>
        row.method === "session/prompt" && row.direction === "agent_to_client",
      )
      expect(promptResponseObservation).toBeDefined()
      const promptResponsePayload = JSON.parse(
        promptResponseObservation!.payloadJson,
      ) as { readonly stopReason?: string }
      expect(promptResponsePayload.stopReason).toBe("end_turn")

      // NEUTRAL_TOOL_BINDING_SHAPE.4 + AUTHORITY.4: secret-shaped values from
      // the untrusted source descriptor never end up in durable rows.
      for (const row of observations) {
        expect(row.payloadJson).not.toContain("MUST-NOT-LEAK")
        expect(row.payloadJson).not.toContain("host-abc-secret")
      }

      // INGRESS.6 + BOUNDARY.1: the canonical input surface is a DurableTable
      // row; no ACP/provider-specific endpoint is invented by Firegrid.
      const ingressRows = await Effect.runPromise(
        Effect.gen(function*() {
          const table = yield* RuntimeIngressTable
          return yield* table.inputs.query((coll) =>
            coll.toArray.filter((row) => row.contextId === contextId),
          )
        }).pipe(Effect.scoped, Effect.provide(hostLayer)),
      )
      expect(ingressRows).toHaveLength(1)
      expect(ingressRows[0]!.kind).toBe("message")
      expect(ingressRows[0]!.status).toBe("sequenced")
    },
    30_000,
  )
})
