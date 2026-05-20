import { sessionContextIdForExternalKey } from "@firegrid/protocol/session-facade"
import {
  appendRuntimeIngress,
  CallerOwnedFactStreams,
  durableStreamUrl,
  ensurePathInput,
  FiregridEnvBindingsFromEnv,
  FiregridLocalHostLive,
  FiregridLocalProcessFromEnv,
  FiregridMcpServerLayer,
  hostProjectionObserver,
  type RuntimeAgentOutputObservation,
} from "@firegrid/host-sdk"
import { Effect, Layer, Option, Schema, Stream } from "effect"
import {
  DurableTable,
  type DurableTableLayerOptions,
} from "effect-durable-operators"
import type { TinyFiregridHostEnv } from "../../types.ts"

const waitPreAttachExternalKey = {
  source: "tiny-firegrid",
  id: "wait-pre-attach-roundtrip",
} as const
const waitPreAttachContextId = sessionContextIdForExternalKey(waitPreAttachExternalKey)
const waitObservedMarker = "FIREGRID_WAIT_OBSERVED"

// Scenario constants the driver shares (NOT a substrate API — just the
// names the prompt needs to know).
export const factSource = "wait-pre-attach.facts"
export const factCorrelationId = "wait-pre-attach-roundtrip"
export const factEventType = "human.gate.approved"

const FactRowSchema = Schema.Struct({
  factId: Schema.String.pipe(DurableTable.primaryKey),
  source: Schema.String,
  eventType: Schema.String,
  correlationId: Schema.String,
  payload: Schema.Unknown,
  acceptedAt: Schema.String,
})

class WaitPreAttachFactTable extends DurableTable("waitPreAttach", {
  facts: FactRowSchema,
}) {}

const factTableLayerOptions = (
  baseUrl: string,
  namespace: string,
): DurableTableLayerOptions => ({
  streamOptions: {
    url: durableStreamUrl(baseUrl, `${namespace}.waitPreAttach`),
    contentType: "application/json",
  },
  txTimeoutMs: 2_000,
})

const preSeed = () => ({
  factId: `${factSource}:${factCorrelationId}:${factEventType}`,
  source: factSource,
  eventType: factEventType,
  correlationId: factCorrelationId,
  payload: {
    decision: "approved",
    note: "pre-attached before agent attaches its wait_for",
  },
  acceptedAt: new Date().toISOString(),
})

type TextChunkObservation = RuntimeAgentOutputObservation & {
  readonly event: Extract<
    RuntimeAgentOutputObservation["event"],
    { readonly _tag: "TextChunk" }
  >
}

type PermissionRequestObservation = RuntimeAgentOutputObservation & {
  readonly event: Extract<
    RuntimeAgentOutputObservation["event"],
    { readonly _tag: "PermissionRequest" }
  >
}

const isWaitPreAttachTextChunk = (
  observation: RuntimeAgentOutputObservation,
): observation is TextChunkObservation =>
  observation.contextId === waitPreAttachContextId &&
  observation.event._tag === "TextChunk"

const isWaitPreAttachPermissionRequest = (
  observation: RuntimeAgentOutputObservation,
): observation is PermissionRequestObservation =>
  observation.contextId === waitPreAttachContextId &&
  observation.event._tag === "PermissionRequest"

const waitPreAttachResultObserver = (
  env: TinyFiregridHostEnv,
) =>
  hostProjectionObserver({
    spanName: "firegrid.simulation.observer.wait_pre_attach_result",
    contextId: waitPreAttachContextId,
    initialState: "",
    attributes: {
      "firegrid.simulation.marker": waitObservedMarker,
    },
    project: (resultText, observation) => {
      if (!isWaitPreAttachTextChunk(observation)) return [resultText, Option.none()]
      const nextResultText = resultText + observation.event.part.delta
      return [
        nextResultText,
        nextResultText.includes(waitObservedMarker)
          ? Option.some(waitObservedMarker)
          : Option.none(),
      ]
    },
    onMatch: () => env.stopSignal.complete,
  })

const waitPreAttachPermissionResponder = () =>
  hostProjectionObserver({
    spanName: "firegrid.simulation.observer.wait_pre_attach_permission",
    contextId: waitPreAttachContextId,
    initialState: undefined,
    project: (state, observation) => [
      state,
      isWaitPreAttachPermissionRequest(observation)
        ? Option.some(observation.event.permissionRequestId)
        : Option.none(),
    ],
    onMatch: permissionRequestId =>
      appendRuntimeIngress({
        contextId: waitPreAttachContextId,
        kind: "required_action_result",
        authoredBy: "client",
        payload: {
          _tag: "PermissionResponse",
          permissionRequestId,
          decision: { _tag: "Allow" },
        },
        idempotencyKey: `wait-pre-attach-roundtrip:permission:${permissionRequestId}`,
      }).pipe(Effect.asVoid),
  })

// The pre-seed runs as part of the host layer's acquire. The fact is in
// the durable stream BEFORE the agent process is spawned, BEFORE the
// agent issues `wait_for`, BEFORE the runtime registers the wait. That's
// the "pre-attach" scenario the tf-pra bead asks about: does the wait
// router scan existing rows on attach, or does it only deliver
// future-arriving rows?
export const waitPreAttachHost = (
  env: TinyFiregridHostEnv,
) => {
  const baseUrl = env.durableStreamsBaseUrl
  const namespace = env.namespace
  const mcpHost = "127.0.0.1"
  const mcpPath = "/mcp"

  const factTable = WaitPreAttachFactTable.layer(
    factTableLayerOptions(baseUrl, namespace),
  )

  // Host pre-seeds the fact at layer acquire. Span-instrumented so the
  // exact pre-seed timestamp is visible in the trace alongside the
  // agent's later wait_for activity.
  const seed = Layer.scopedDiscard(
    Effect.gen(function*() {
      const table = yield* WaitPreAttachFactTable
      const row = preSeed()
      yield* table.facts.insertOrGet(row)
    }).pipe(
      Effect.withSpan("firegrid.wait_pre_attach.host.seed_fact", {
        kind: "internal",
        attributes: {
          "firegrid.wait_pre_attach.fact_source": factSource,
          "firegrid.wait_pre_attach.correlation_id": factCorrelationId,
          "firegrid.wait_pre_attach.event_type": factEventType,
        },
      }),
    ),
  ).pipe(Layer.provide(factTable))

  // Bind the durable table as the CallerOwnedFactStreams source for the
  // configured stream name. The runtime's wait_router reads from here
  // when the agent's wait_for source is `{ _tag: "CallerFact", stream }`.
  const callerFacts = Layer.effect(
    CallerOwnedFactStreams,
    Effect.map(WaitPreAttachFactTable, table => ({
      streamFor: (stream: string) =>
        stream === factSource ? table.facts.rows() : Stream.empty,
    })),
  ).pipe(Layer.provide(factTable))

  const appFacts = Layer.mergeAll(factTable, callerFacts, seed)

  const host = FiregridLocalHostLive({
    durableStreamsBaseUrl: baseUrl,
    namespace,
    input: true,
  }).pipe(
    Layer.provide(FiregridLocalProcessFromEnv(env.processEnv)),
    Layer.provide(FiregridEnvBindingsFromEnv({
      processEnv: env.processEnv,
      allow: [["ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"]],
    })),
  )

  const mcp = Layer.discard(
    FiregridMcpServerLayer({
      host: mcpHost,
      port: 0,
      path: ensurePathInput(mcpPath),
    }),
  )

  return Layer.mergeAll(
    mcp,
    waitPreAttachPermissionResponder(),
    waitPreAttachResultObserver(env),
  ).pipe(
    Layer.provideMerge(host),
    Layer.provideMerge(appFacts),
  )
}
