/**
 * FakeCodecAdapter — production-shape e2e scaffolding.
 *
 * Implements `RuntimeContextSessionAdapter` (per SDD §A) without a real
 * agent process. The fake adapter:
 *
 *   1. On `startOrAttach`: writes a `Ready` row to `RuntimeOutputTable`
 *      (simulating an agent's initial handshake).
 *   2. On `send(prompt)`: writes a `ToolUse` row (simulating the agent
 *      deciding it needs a tool call).
 *   3. On `send(tool-result)`: writes a `PermissionRequest` row
 *      (simulating the agent then needing permission).
 *   4. On `send(permission-response)`: writes a `TurnComplete` row.
 *   5. On `deregister`: records the deregistration; in real production
 *      this would release the process handle from the registry.
 *
 * These rows land in `RuntimeOutputTable.events`. `JournalObserverLive`
 * — which the production composition provides — picks up the
 * `PermissionRequest` and `ToolUse` rows and forks the sibling
 * workflows. The sibling workflows auto-relay their results back to
 * the session via `sendSignal` (§D, §E). The session body picks the
 * relays up as its next inputs.
 *
 * End result: a fully closed loop that exercises codec → journal →
 * observer → workflow → relay → session, with no driver in the middle
 * relaying anything. The driver just initiates the prompt and
 * responds to the permission request.
 */

import {
  RuntimeOutputTable,
  RuntimeContextSessionAdapter,
  type RuntimeContextSessionAdapterService,
} from "@firegrid/runtime/unified"
import {
  encodeRuntimeAgentOutputEnvelope,
} from "@firegrid/protocol/session-facade"
import { Prompt } from "@effect/ai"
import { Effect, Layer, Ref } from "effect"

type LogEntry =
  | { readonly op: "startOrAttach"; readonly contextId: string; readonly attempt: number }
  | { readonly op: "send"; readonly contextId: string; readonly attempt: number; readonly kind: string }
  | { readonly op: "deregister"; readonly contextId: string }

const sessionKey = (contextId: string, attempt: number): string =>
  `${contextId}:${attempt}`

const nextSequence = (
  sequences: Ref.Ref<Map<string, number>>,
  key: string,
) =>
  Ref.modify(sequences, (current) => {
    const next = (current.get(key) ?? 0) + 1
    const updated = new Map(current)
    updated.set(key, next)
    return [next - 1, updated]
  })

const writeOutput = (
  table: RuntimeOutputTable["Type"],
  contextId: string,
  attempt: number,
  sequence: number,
  encoded: string,
) =>
  table.events.insertOrGet({
    eventId: {
      contextId,
      activityAttempt: attempt,
      target: "events",
      sequence,
    },
    contextId,
    activityAttempt: attempt,
    sequence,
    source: "stdout",
    format: "jsonl",
    receivedAt: new Date().toISOString(),
    raw: encoded,
  }).pipe(Effect.orDie, Effect.asVoid)

const toolUseIdFor = (contextId: string, attempt: number): string =>
  `tu-fake-${contextId}-${attempt}`

const permissionRequestIdFor = (contextId: string, attempt: number): string =>
  `perm-fake-${contextId}-${attempt}`

export interface FakeCodecProbe {
  readonly snapshot: Effect.Effect<{ readonly log: ReadonlyArray<LogEntry> }>
}

/**
 * Build the fake codec Live + a snapshot probe. The Live satisfies
 * `RuntimeContextSessionAdapter`; the snapshot lets scenarios assert
 * what the codec was driven through.
 */
export const buildFakeCodecAdapter = (): Effect.Effect<{
  readonly layer: Layer.Layer<RuntimeContextSessionAdapter, never, RuntimeOutputTable>
  readonly probe: FakeCodecProbe
}> =>
  Effect.gen(function*() {
    const sequences = yield* Ref.make<Map<string, number>>(new Map())
    const log = yield* Ref.make<ReadonlyArray<LogEntry>>([])

    const layer = Layer.effect(
      RuntimeContextSessionAdapter,
      Effect.gen(function*() {
        const table = yield* RuntimeOutputTable
        const service: RuntimeContextSessionAdapterService = {
          startOrAttach: (contextId, attempt) =>
            Effect.gen(function*() {
              yield* Ref.update(log, (l) => [
                ...l,
                { op: "startOrAttach", contextId, attempt } satisfies LogEntry,
              ])
              const seq = yield* nextSequence(sequences, sessionKey(contextId, attempt))
              yield* writeOutput(
                table, contextId, attempt, seq,
                encodeRuntimeAgentOutputEnvelope({
                  _tag: "Ready",
                  capabilities: {
                    streamingText: true,
                    tools: true,
                    permissions: true,
                    images: false,
                    structuredInput: false,
                    cancellation: false,
                    multiTurn: true,
                    customStatus: [],
                  },
                }),
              )
            }),

          send: (contextId, attempt, input) =>
            Effect.gen(function*() {
              yield* Ref.update(log, (l) => [
                ...l,
                { op: "send", contextId, attempt, kind: input.kind } satisfies LogEntry,
              ])
              const seq = yield* nextSequence(sequences, sessionKey(contextId, attempt))
              switch (input.kind) {
                case "prompt":
                  // Simulate the agent wanting to call a tool.
                  yield* writeOutput(
                    table, contextId, attempt, seq,
                    encodeRuntimeAgentOutputEnvelope({
                      _tag: "ToolUse",
                      part: Prompt.makePart("tool-call", {
                        id: toolUseIdFor(contextId, attempt),
                        name: "echo",
                        params: { word: "hello" },
                        providerExecuted: false,
                      }),
                    }),
                  )
                  break
                case "tool-result":
                  // After tool result, simulate a permission request.
                  yield* writeOutput(
                    table, contextId, attempt, seq,
                    encodeRuntimeAgentOutputEnvelope({
                      _tag: "PermissionRequest",
                      permissionRequestId: permissionRequestIdFor(contextId, attempt),
                      toolUseId: toolUseIdFor(contextId, attempt),
                      options: [
                        { optionId: "allow_once", kind: "allow_once", name: "Allow" },
                      ],
                    }),
                  )
                  break
                case "permission-response":
                  // After permission, simulate turn complete.
                  yield* writeOutput(
                    table, contextId, attempt, seq,
                    encodeRuntimeAgentOutputEnvelope({
                      _tag: "TurnComplete",
                      finishReason: "stop",
                    }),
                  )
                  break
              }
            }),

          deregister: (contextId) =>
            Ref.update(log, (l) => [
              ...l,
              { op: "deregister", contextId } satisfies LogEntry,
            ]),
        }
        return service
      }),
    )

    const probe: FakeCodecProbe = {
      snapshot: Effect.map(Ref.get(log), (l) => ({ log: l })),
    }

    return { layer, probe }
  })
