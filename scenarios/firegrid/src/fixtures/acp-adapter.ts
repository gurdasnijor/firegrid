/**
 * Tracer 023 — protocol-aware agent interface adapter.
 *
 * The adapter is *not* a SandboxProvider. It sits ABOVE the execution plane
 * and bridges:
 *
 *   durable RuntimeIngressTable prompt row  --(adapter)-->  ACP `session/prompt`
 *   ACP `session/update` / `requestPermission`  --(adapter)-->  caller-owned
 *                                                              AcpObservationTable
 *
 * Architectural constraints honored:
 *   - ACP/MCP semantics live entirely in this adapter (a scenario-package
 *     consumer), not in `@firegrid/*` (per
 *     `firegrid-scheduling-tool-bindings.AGENT_OBSERVATION_RECIPE.4` and
 *     `PACKAGE_PLACEMENT.4`).
 *   - Prompt intent is durable in `RuntimeIngressTable` BEFORE the ACP
 *     `session/prompt` request is issued (per
 *     `firegrid-platform-invariants.AUTHORITY.4` and
 *     `firegrid-agent-ingress.INGRESS.1`).
 *   - ACP transport details (raw JSON-RPC framing) never leak into Firegrid
 *     durable rows; only adapter-decoded message envelopes do.
 *   - Agent-visible tool descriptors stay the triple
 *     `{ name, description, inputSchema }`. The ACP wire surface today
 *     injects tool catalogs through MCP servers attached at `session/new`;
 *     this tracer keeps `mcpServers: []` and documents the MCP-mount as the
 *     follow-up (see tracer doc 023).
 */

import {
  ClientSideConnection,
  ndJsonStream,
  PROTOCOL_VERSION,
  type Client,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionNotification,
} from "@agentclientprotocol/sdk"
import {
  RuntimeIngressTable,
  type RuntimeIngressInputRow,
} from "@firegrid/protocol/runtime-ingress"
import { Clock, Effect, Ref, Runtime } from "effect"
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process"
import { Readable, Writable } from "node:stream"
import { AcpObservationTable, type AcpDirection, type AcpObservationKind } from "./acp-observation-table.ts"

/**
 * Neutral agent-tool descriptor triple. Adapter code must never expose
 * anything else to the agent (per
 * `firegrid-scheduling-tool-bindings.NEUTRAL_TOOL_BINDING_SHAPE.1`).
 */
export interface AgentToolDescriptor {
  readonly name: string
  readonly description: string
  readonly inputSchema: Readonly<Record<string, unknown>>
}

const stripToTriple = (descriptor: AgentToolDescriptor): AgentToolDescriptor => ({
  name: descriptor.name,
  description: descriptor.description,
  inputSchema: descriptor.inputSchema,
})

const nowIso = Clock.currentTimeMillis.pipe(Effect.map((ms) => new Date(ms).toISOString()))

type PermissionPolicy = (
  request: RequestPermissionRequest,
) => RequestPermissionResponse

export const allowEditsPolicy: PermissionPolicy = (request) => {
  const allow = request.options.find((option) => option.kind === "allow_once")
  if (allow === undefined) {
    return { outcome: { outcome: "cancelled" } }
  }
  return {
    outcome: {
      outcome: "selected",
      optionId: allow.optionId,
    },
  }
}

interface RunAcpTurnOptions {
  readonly contextId: string
  readonly agentArgv: ReadonlyArray<string>
  readonly cwd: string
  readonly toolCatalog: ReadonlyArray<AgentToolDescriptor>
  readonly permissionPolicy: PermissionPolicy
  readonly env?: Record<string, string>
}

interface RunAcpTurnResult {
  readonly sessionId: string
  readonly promptInputId: string
  readonly promptResponse: PromptResponse
  readonly frozenCatalog: ReadonlyArray<AgentToolDescriptor>
}

/**
 * Run one ACP turn end-to-end:
 *   - locate the durable prompt input row (must already be appended);
 *   - spawn the agent subprocess via Node's child_process;
 *   - wire stdin/stdout into the real ACP SDK ClientSideConnection;
 *   - record every ACP request/response/notification to the caller-owned
 *     AcpObservationTable;
 *   - return the agent's PromptResponse.
 *
 * The agent process is launched directly with `child_process.spawn`
 * (intentionally NOT through Firegrid's local-process SandboxProvider).
 * The SandboxProvider stream API line-splits stdout/stderr and journals to
 * `RuntimeOutputTable.events`; ACP requires byte-level duplex framing
 * (ndjson). Threading ACP through SandboxProvider would either re-encode
 * JSON-RPC into ingress rows or require a new byte-pipe API; both are
 * substantial substrate changes and are documented as follow-ups in tracer
 * doc 023.
 */
export const runAcpTurn = (
  options: RunAcpTurnOptions,
): Effect.Effect<RunAcpTurnResult, Error, RuntimeIngressTable | AcpObservationTable> =>
  Effect.gen(function* () {
    const ingressTable = yield* RuntimeIngressTable
    const observationTable = yield* AcpObservationTable
    const observations = observationTable.observations

    const inputs = yield* ingressTable.inputs.query((coll) =>
      coll.toArray.filter((row) => row.contextId === options.contextId && row.kind === "message"),
    )
    const promptRow = inputs.find((row) => row.status === "sequenced")
    if (promptRow === undefined) {
      return yield* Effect.fail(new Error(
        `tracer-023: no sequenced prompt input row for contextId=${options.contextId}`,
      ))
    }
    const promptText = promptTextFromRow(promptRow)

    const frozenCatalog = options.toolCatalog.map(stripToTriple)

    const sequenceRef = yield* Ref.make(0)
    const recordObservation = (
      direction: AcpDirection,
      kind: AcpObservationKind,
      method: string,
      payload: unknown,
      sessionId?: string,
    ) =>
      Effect.gen(function* () {
        const sequence = yield* Ref.updateAndGet(sequenceRef, (n) => n + 1)
        const observedAt = yield* nowIso
        const observationId = `obs_${options.contextId}_${sequence.toString().padStart(6, "0")}`
        yield* observations.insert({
          observationId,
          contextId: options.contextId,
          sequence,
          direction,
          kind,
          method,
          ...(sessionId === undefined ? {} : { sessionId }),
          payloadJson: JSON.stringify(payload),
          observedAt,
        })
      }).pipe(Effect.orDie)

    const runtime = yield* Effect.runtime<never>()
    const runPromise = Runtime.runPromise(runtime)

    return yield* Effect.tryPromise({
      try: () =>
        runAcpTurnPromise({
          ...options,
          promptRow,
          promptText,
          frozenCatalog,
          recordObservation: (direction, kind, method, payload, sessionId) =>
            runPromise(recordObservation(direction, kind, method, payload, sessionId)),
        }),
      catch: (cause) =>
        cause instanceof Error ? cause : new Error(`tracer-023: ${String(cause)}`),
    })
  })

const promptTextFromRow = (row: RuntimeIngressInputRow): string => {
  const payload = row.payload
  if (Array.isArray(payload)) {
    return payload
      .flatMap((part) => {
        if (typeof part === "object" && part !== null) {
          const record = part as Record<string, unknown>
          if (record["type"] === "text" && typeof record["text"] === "string") {
            return [record["text"] as string]
          }
        }
        return [] as Array<string>
      })
      .join("")
  }
  if (typeof payload === "string") return payload
  return JSON.stringify(payload)
}

const spawnAgent = (options: RunAcpTurnOptions): ChildProcessWithoutNullStreams => {
  const [executable, ...argv] = options.agentArgv
  if (executable === undefined) {
    throw new Error("tracer-023: agentArgv is empty")
  }
  return spawn(executable, argv, {
    cwd: options.cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...(options.env ?? {}),
      PATH: process.env["PATH"] ?? "",
    },
  })
}

type RecordObservation = (
  direction: AcpDirection,
  kind: AcpObservationKind,
  method: string,
  payload: unknown,
  sessionId?: string,
) => Promise<void>

interface RunAcpTurnPromiseOptions extends RunAcpTurnOptions {
  readonly promptRow: RuntimeIngressInputRow
  readonly promptText: string
  readonly frozenCatalog: ReadonlyArray<AgentToolDescriptor>
  readonly recordObservation: RecordObservation
}

const runAcpTurnPromise = async (
  options: RunAcpTurnPromiseOptions,
): Promise<RunAcpTurnResult> => {
  const child = spawnAgent(options)
  try {
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk) => {
      // eslint-disable-next-line no-console
      console.error("[tracer-023-agent-stderr]", chunk)
    })

    const childStdin = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>
    const childStdout = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>
    const stream = ndJsonStream(childStdin, childStdout)

    const client: Client = {
      async requestPermission(
        params: RequestPermissionRequest,
      ): Promise<RequestPermissionResponse> {
        await options.recordObservation(
          "agent_to_client",
          "request",
          "session/request_permission",
          params,
          params.sessionId,
        )
        const response = options.permissionPolicy(params)
        await options.recordObservation(
          "client_to_agent",
          "response",
          "session/request_permission",
          response,
          params.sessionId,
        )
        return response
      },
      async sessionUpdate(params: SessionNotification): Promise<void> {
        await options.recordObservation(
          "agent_to_client",
          "notification",
          "session/update",
          params,
          params.sessionId,
        )
      },
    }

    const connection = new ClientSideConnection(() => client, stream)

    await options.recordObservation(
      "client_to_agent",
      "request",
      "initialize",
      { protocolVersion: PROTOCOL_VERSION },
    )
    const initializeResponse = await connection.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
      },
    })
    await options.recordObservation(
      "agent_to_client",
      "response",
      "initialize",
      initializeResponse,
    )

    await options.recordObservation(
      "client_to_agent",
      "request",
      "session/new",
      {
        cwd: options.cwd,
        mcpServers: [],
        _meta: { frozenCatalog: options.frozenCatalog },
      },
    )
    const newSessionResponse = await connection.newSession({
      cwd: options.cwd,
      mcpServers: [],
    })
    await options.recordObservation(
      "agent_to_client",
      "response",
      "session/new",
      newSessionResponse,
      newSessionResponse.sessionId,
    )

    await options.recordObservation(
      "client_to_agent",
      "request",
      "session/prompt",
      { promptInputId: options.promptRow.inputId, text: options.promptText },
      newSessionResponse.sessionId,
    )
    const promptResponse = await connection.prompt({
      sessionId: newSessionResponse.sessionId,
      prompt: [{ type: "text", text: options.promptText }],
    })
    await options.recordObservation(
      "agent_to_client",
      "response",
      "session/prompt",
      promptResponse,
      newSessionResponse.sessionId,
    )

    return {
      sessionId: newSessionResponse.sessionId,
      promptInputId: options.promptRow.inputId,
      promptResponse,
      frozenCatalog: options.frozenCatalog,
    }
  } finally {
    if (!child.killed) child.kill()
  }
}

export { AcpObservationTable, acpObservationTableLayerOptions } from "./acp-observation-table.ts"
