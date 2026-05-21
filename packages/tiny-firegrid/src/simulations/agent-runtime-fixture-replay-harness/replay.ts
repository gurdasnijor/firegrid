import { Prompt, Response } from "@effect/ai"
import {
  AgentInputEventSchema,
  type AgentInputEvent,
  AgentOutputEventSchema,
  type AgentOutputEvent,
} from "@firegrid/runtime/events"
import { Data, Effect, Schema } from "effect"
import acpTranscript from "./corpus/acp-transcript.json" with { type: "json" }
import codecDoubleAdvertisement from "./corpus/codec-double-advertisement.json" with { type: "json" }
import fakeMcpProviderPermission from "./corpus/fake-mcp-provider-permission.json" with { type: "json" }
import fuzzSeeds from "./corpus/fuzz-seeds.json" with { type: "json" }
import liveCanaryCodexAcp from "./corpus/live-canary-codex-acp.json" with { type: "json" }
import restartDisconnectTranscript from "./corpus/restart-disconnect-transcript.json" with { type: "json" }
import stdioJsonlTranscript from "./corpus/stdio-jsonl-transcript.json" with { type: "json" }

type ProviderAxis = "local-process" | "effect-ai"
type SessionModeAxis = "raw" | "codec"
type TransportAxis = "ACP" | "stdio-jsonl" | "fake-mcp-provider" | "raw-byte-stream"
type FaultClass =
  | "happy-path"
  | "crash-mid-action"
  | "dropped-wait"
  | "codec-double-advertisement"
  | "permission-gate-stall"
  | "live-agent-canary"
type Verdict = "pass" | "expected-fault" | "unsupported"
type Direction = "input" | "output"

interface ReplayFrame {
  readonly stream: "stdin" | "stdout" | "stderr"
  readonly chunk: string
}

type ReplayRecord = Record<string, unknown> & {
  readonly direction?: Direction
  readonly type?: string
}

interface ExpectedCounts {
  readonly outputEvents: number
  readonly inputEvents: number
  readonly permissionRequests: number
  readonly permissionResponses: number
  readonly toolUses: number
  readonly terminated: boolean
  readonly secretsAbsent: boolean
}

interface TranscriptFixture {
  readonly id: string
  readonly description: string
  readonly provider: ProviderAxis
  readonly sessionMode: SessionModeAxis
  readonly transport: TransportAxis
  readonly liveCanary: boolean
  readonly enableEnv?: string
  readonly agentCommand?: string
  readonly faultClass: FaultClass
  readonly verdict: Verdict
  readonly sourceBoundary: string
  readonly codecBoundary: string
  readonly durableEvidence: ReadonlyArray<string>
  readonly frames: ReadonlyArray<ReplayFrame>
  readonly records: ReadonlyArray<ReplayRecord>
  readonly expected: ExpectedCounts
}

interface FuzzSeed {
  readonly id: string
  readonly class: string
  readonly description: string
}

interface ReplaySummary {
  readonly fixtureId: string
  readonly provider: ProviderAxis
  readonly sessionMode: SessionModeAxis
  readonly transport: TransportAxis
  readonly faultClass: FaultClass
  readonly verdict: Verdict
  readonly outputEvents: number
  readonly inputEvents: number
  readonly permissionRequests: number
  readonly permissionResponses: number
  readonly toolUses: number
  readonly terminated: boolean
  readonly fuzzCases: number
  readonly skipped: boolean
}

type DecodedReplayEvent =
  | { readonly direction: "input"; readonly event: AgentInputEvent }
  | { readonly direction: "output"; readonly event: AgentOutputEvent }

interface ReplayHarnessResult {
  readonly matrixRows: ReadonlyArray<ReplaySummary>
  readonly fuzzCases: number
  readonly unsupportedRows: ReadonlyArray<string>
}

class ReplayContractMismatch extends Data.TaggedClass("ReplayContractMismatch")<{
  readonly fixtureId: string
  readonly message: string
}> {}

const fixtures: ReadonlyArray<TranscriptFixture> = [
  acpTranscript,
  stdioJsonlTranscript,
  fakeMcpProviderPermission,
  restartDisconnectTranscript,
  codecDoubleAdvertisement,
  liveCanaryCodexAcp,
] as ReadonlyArray<TranscriptFixture>

const seeds = fuzzSeeds as ReadonlyArray<FuzzSeed>

const capabilities = {
  streamingText: true,
  tools: true,
  permissions: true,
  images: false,
  structuredInput: true,
  cancellation: true,
  multiTurn: true,
  customStatus: [],
} as const

const stringField = (
  record: ReplayRecord,
  key: string,
  fallback: string,
): string => {
  const value = record[key]
  return typeof value === "string" ? value : fallback
}

const booleanField = (
  record: ReplayRecord,
  key: string,
  fallback: boolean,
): boolean => {
  const value = record[key]
  return typeof value === "boolean" ? value : fallback
}

const optionalNumberField = (
  record: ReplayRecord,
  key: string,
): number | undefined => {
  const value = record[key]
  return typeof value === "number" ? value : undefined
}

const outputEventFromRecord = (record: ReplayRecord): unknown => {
  switch (record.type) {
    case "ready":
      return { _tag: "Ready", capabilities }
    case "text":
      return {
        _tag: "TextChunk",
        part: Response.textDeltaPart({
          id: stringField(record, "id", "fixture-message"),
          delta: stringField(record, "delta", ""),
        }),
      }
    case "tool_use":
      return {
        _tag: "ToolUse",
        part: Prompt.toolCallPart({
          id: stringField(record, "toolUseId", "fixture-tool"),
          name: stringField(record, "name", "fixture_tool"),
          params: record["input"],
          providerExecuted: booleanField(record, "providerExecuted", false),
        }),
      }
    case "permission_request":
      return {
        _tag: "PermissionRequest",
        permissionRequestId: stringField(record, "permissionRequestId", "fixture-permission"),
        toolUseId: stringField(record, "toolUseId", "fixture-tool"),
        options: [
          {
            optionId: "allow-once",
            kind: "allow_once",
            name: "Allow once",
          },
          {
            optionId: "reject-once",
            kind: "reject_once",
            name: "Reject once",
          },
        ],
      }
    case "turn_complete":
      return {
        _tag: "TurnComplete",
        finishReason: stringField(record, "finishReason", "stop"),
        messageId: stringField(record, "messageId", "fixture-message"),
      }
    case "status":
      return {
        _tag: "Status",
        kind: stringField(record, "kind", "fixture.status"),
      }
    case "error":
      return {
        _tag: "Error",
        cause: stringField(record, "cause", "fixture error"),
        recoverable: booleanField(record, "recoverable", true),
      }
    case "terminated":
      return {
        _tag: "Terminated",
        exitCode: optionalNumberField(record, "exitCode"),
      }
    default:
      return {
        _tag: "Error",
        cause: `unsupported fixture output record: ${String(record.type)}`,
        recoverable: true,
      }
  }
}

const inputEventFromRecord = (record: ReplayRecord): unknown => {
  switch (record.type) {
    case "prompt":
      return {
        _tag: "Prompt",
        prompt: Prompt.userMessage({
          content: [Prompt.textPart({ text: stringField(record, "text", "") })],
        }),
        correlationId: stringField(record, "correlationId", "fixture-prompt"),
      }
    case "tool_result":
      return {
        _tag: "ToolResult",
        part: Prompt.toolResultPart({
          id: stringField(record, "toolUseId", "fixture-tool"),
          name: stringField(record, "name", "fixture_tool"),
          result: record["result"],
          isFailure: false,
          providerExecuted: false,
        }),
      }
    case "permission_response":
      return {
        _tag: "PermissionResponse",
        permissionRequestId: stringField(record, "permissionRequestId", "fixture-permission"),
        decision: { _tag: stringField(record, "decision", "Allow") },
      }
    case "cancel":
      return { _tag: "Cancel", reason: stringField(record, "reason", "fixture cancel") }
    case "terminate":
      return { _tag: "Terminate" }
    default:
      return { _tag: "Terminate" }
  }
}

const decodeOutput = (fixtureId: string, record: ReplayRecord) =>
  Schema.decodeUnknown(AgentOutputEventSchema)(outputEventFromRecord(record)).pipe(
    Effect.mapError(cause =>
      new ReplayContractMismatch({
        fixtureId,
        message: `output schema decode failed for ${String(record.type)}: ${String(cause)}`,
      })),
  )

const decodeInput = (fixtureId: string, record: ReplayRecord) =>
  Schema.decodeUnknown(AgentInputEventSchema)(inputEventFromRecord(record)).pipe(
    Effect.mapError(cause =>
      new ReplayContractMismatch({
        fixtureId,
        message: `input schema decode failed for ${String(record.type)}: ${String(cause)}`,
      })),
  )

const decodeRecord = (
  fixtureId: string,
  record: ReplayRecord,
): Effect.Effect<DecodedReplayEvent, ReplayContractMismatch> =>
  record.direction === "input"
    ? decodeInput(fixtureId, record).pipe(
      Effect.map(event => ({ direction: "input" as const, event })),
    )
    : decodeOutput(fixtureId, record).pipe(
      Effect.map(event => ({ direction: "output" as const, event })),
    )

const secretMarkers = ["OPENAI_API_KEY", "ANTHROPIC_API_KEY", "sk-", "xoxb-", "Bearer "]

const textContainsSecret = (value: string): boolean =>
  secretMarkers.some(marker => value.includes(marker))

const valueContainsSecret = (value: unknown): boolean => {
  if (typeof value === "string") return textContainsSecret(value)
  if (Array.isArray(value)) return value.some(valueContainsSecret)
  if (typeof value === "object" && value !== null) {
    return Object.values(value).some(valueContainsSecret)
  }
  return false
}

const assertEqual = (
  fixtureId: string,
  label: string,
  actual: unknown,
  expected: unknown,
) =>
  actual === expected
    ? Effect.void
    : Effect.fail(new ReplayContractMismatch({
      fixtureId,
      message: `${label}: expected ${String(expected)}, got ${String(actual)}`,
    }))

const fuzzFixture = (
  fixture: TranscriptFixture,
) =>
  Effect.forEach(seeds, seed =>
    Effect.gen(function*() {
      const chunkCount = fixture.frames.reduce(
        (count, frame) => count + Math.max(1, frame.chunk.length),
        0,
      )
      const hasInterleaving = new Set(fixture.frames.map(frame => frame.stream)).size > 1
      const duplicateToolIds = new Set(
        fixture.records
          .map(record => record["toolUseId"])
          .filter((value): value is string => typeof value === "string"),
      ).size < fixture.records.filter(record => typeof record["toolUseId"] === "string").length
      const missingPermissionResponse =
        fixture.expected.permissionRequests > fixture.expected.permissionResponses
      const sourceEnded = fixture.records.some(record =>
        record.direction === "output" && record.type === "terminated")
      const secretLeak = valueContainsSecret(fixture.records) || valueContainsSecret(fixture.frames)

      yield* Effect.annotateCurrentSpan({
        "firegrid.agent_runtime_fixture.fuzz.seed": seed.id,
        "firegrid.agent_runtime_fixture.fuzz.class": seed.class,
        "firegrid.agent_runtime_fixture.fuzz.chunk_count": chunkCount,
        "firegrid.agent_runtime_fixture.fuzz.has_interleaving": hasInterleaving,
        "firegrid.agent_runtime_fixture.fuzz.duplicate_tool_ids": duplicateToolIds,
        "firegrid.agent_runtime_fixture.fuzz.missing_permission_response": missingPermissionResponse,
        "firegrid.agent_runtime_fixture.fuzz.source_ended": sourceEnded,
        "firegrid.agent_runtime_fixture.fuzz.secret_leak": secretLeak,
      })

      if (seed.class === "provider-secret-leakage" && secretLeak) {
        return yield* Effect.fail(new ReplayContractMismatch({
          fixtureId: fixture.id,
          message: "provider secret marker found in replay fixture",
        }))
      }
      return seed.id
    }).pipe(
      Effect.withSpan("firegrid.agent_runtime_fixture.fuzz_case", {
        attributes: {
          "firegrid.agent_runtime_fixture.fixture_id": fixture.id,
          "firegrid-agent-runtime-fixture-replay.SOURCE_CONFORMANCE.4": true,
        },
      }),
    ), { discard: false })

const replayFixture = (
  fixture: TranscriptFixture,
) =>
  Effect.gen(function*() {
    if (fixture.liveCanary) {
      yield* Effect.annotateCurrentSpan({
        "firegrid.agent_runtime_fixture.live_canary": true,
        "firegrid.agent_runtime_fixture.enable_env": fixture.enableEnv ?? "",
        "firegrid.agent_runtime_fixture.agent_command": fixture.agentCommand ?? "",
      })
      return {
        fixtureId: fixture.id,
        provider: fixture.provider,
        sessionMode: fixture.sessionMode,
        transport: fixture.transport,
        faultClass: fixture.faultClass,
        verdict: fixture.verdict,
        outputEvents: 0,
        inputEvents: 0,
        permissionRequests: 0,
        permissionResponses: 0,
        toolUses: 0,
        terminated: false,
        fuzzCases: 0,
        skipped: true,
      } satisfies ReplaySummary
    }

    const decoded = yield* Effect.forEach(fixture.records, record =>
      decodeRecord(fixture.id, record),
    )
    const outputEvents = decoded.filter(item => item.direction === "output")
    const inputEvents = decoded.filter(item => item.direction === "input")
    const permissionRequests = outputEvents.filter(item => item.event._tag === "PermissionRequest").length
    const permissionResponses = inputEvents.filter(item => item.event._tag === "PermissionResponse").length
    const toolUses = outputEvents.filter(item => item.event._tag === "ToolUse").length
    const terminated = outputEvents.some(item => item.event._tag === "Terminated")
    const secretsAbsent = !valueContainsSecret(fixture.records) && !valueContainsSecret(fixture.frames)
    const fuzzed = yield* fuzzFixture(fixture)

    yield* assertEqual(fixture.id, "outputEvents", outputEvents.length, fixture.expected.outputEvents)
    yield* assertEqual(fixture.id, "inputEvents", inputEvents.length, fixture.expected.inputEvents)
    yield* assertEqual(fixture.id, "permissionRequests", permissionRequests, fixture.expected.permissionRequests)
    yield* assertEqual(fixture.id, "permissionResponses", permissionResponses, fixture.expected.permissionResponses)
    yield* assertEqual(fixture.id, "toolUses", toolUses, fixture.expected.toolUses)
    yield* assertEqual(fixture.id, "terminated", terminated, fixture.expected.terminated)
    yield* assertEqual(fixture.id, "secretsAbsent", secretsAbsent, fixture.expected.secretsAbsent)

    yield* Effect.annotateCurrentSpan({
      "firegrid.agent_runtime_fixture.fixture_id": fixture.id,
      "firegrid.agent_runtime_fixture.provider": fixture.provider,
      "firegrid.agent_runtime_fixture.session_mode": fixture.sessionMode,
      "firegrid.agent_runtime_fixture.transport": fixture.transport,
      "firegrid.agent_runtime_fixture.fault_class": fixture.faultClass,
      "firegrid.agent_runtime_fixture.verdict": fixture.verdict,
      "firegrid.agent_runtime_fixture.output_events": outputEvents.length,
      "firegrid.agent_runtime_fixture.input_events": inputEvents.length,
      "firegrid.agent_runtime_fixture.permission_requests": permissionRequests,
      "firegrid.agent_runtime_fixture.permission_responses": permissionResponses,
      "firegrid.agent_runtime_fixture.tool_uses": toolUses,
      "firegrid.agent_runtime_fixture.terminated": terminated,
      "firegrid.agent_runtime_fixture.fuzz_cases": fuzzed.length,
    })

    return {
      fixtureId: fixture.id,
      provider: fixture.provider,
      sessionMode: fixture.sessionMode,
      transport: fixture.transport,
      faultClass: fixture.faultClass,
      verdict: fixture.verdict,
      outputEvents: outputEvents.length,
      inputEvents: inputEvents.length,
      permissionRequests,
      permissionResponses,
      toolUses,
      terminated,
      fuzzCases: fuzzed.length,
      skipped: false,
    } satisfies ReplaySummary
  }).pipe(
    Effect.withSpan("firegrid.agent_runtime_fixture.replay_fixture", {
      attributes: {
        "firegrid.agent_runtime_fixture.fixture_id": fixture.id,
        "firegrid-runtime-agent-event-pipeline.SOURCE_CONFORMANCE.2": true,
        "firegrid-runtime-agent-event-pipeline.SOURCE_CONFORMANCE.3": true,
      },
    }),
  )

export const runReplayHarness: Effect.Effect<
  ReplayHarnessResult,
  unknown
> =
  Effect.gen(function*() {
    const matrixRows = yield* Effect.forEach(fixtures, replayFixture)
    const fuzzCases = matrixRows.reduce((sum, row) => sum + row.fuzzCases, 0)
    const unsupportedRows = matrixRows
      .filter(row => row.verdict === "unsupported")
      .map(row => row.fixtureId)
    yield* Effect.annotateCurrentSpan({
      "firegrid.agent_runtime_fixture.matrix_rows": matrixRows.length,
      "firegrid.agent_runtime_fixture.fuzz_cases": fuzzCases,
      "firegrid.agent_runtime_fixture.unsupported_rows": unsupportedRows.join(","),
      "firegrid-runtime-agent-event-pipeline.SOURCE_CONFORMANCE.1": true,
      "firegrid-runtime-agent-event-pipeline.SOURCE_CONFORMANCE.5": true,
      "firegrid-runtime-agent-event-pipeline.SOURCE_CONFORMANCE.7": true,
    })
    return { matrixRows, fuzzCases, unsupportedRows }
  }).pipe(
    Effect.withSpan("firegrid.agent_runtime_fixture.replay_harness"),
  )

export const replayHarnessFixtures = fixtures
export const replayHarnessFuzzSeeds = seeds
