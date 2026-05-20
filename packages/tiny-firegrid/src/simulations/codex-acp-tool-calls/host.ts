import { sessionContextIdForExternalKey } from "@firegrid/protocol/session-facade"
import {
  ensurePathInput,
  FiregridEnvBindingsFromEnv,
  FiregridLocalHostLive,
  FiregridLocalProcessFromEnv,
  FiregridMcpServerLayer,
} from "@firegrid/host-sdk"
import {
  RuntimeAgentOutputEvents,
  RuntimeAgentOutputEventsLayer,
  type RuntimeAgentOutputObservation,
} from "@firegrid/runtime/runtime-output"
import { Effect, Layer, Stream } from "effect"
import type { TinyFiregridHostEnv } from "../../types.ts"

const codexAcpExternalKey = {
  source: "tiny-firegrid",
  id: "codex-acp-tool-calls",
} as const

const codexAcpContextId = sessionContextIdForExternalKey(codexAcpExternalKey)
const toolResultMarker = "FIREGRID_TOOL_RESULT sleep slept=true"
type TextChunkObservation = RuntimeAgentOutputObservation & {
  readonly event: Extract<
    RuntimeAgentOutputObservation["event"],
    { readonly _tag: "TextChunk" }
  >
}

const isCodexAcpTextChunk = (
  observation: RuntimeAgentOutputObservation,
): observation is TextChunkObservation =>
  observation.contextId === codexAcpContextId &&
  observation.event._tag === "TextChunk"

const codexAcpToolResultObserver = (
  env: TinyFiregridHostEnv,
) =>
  Layer.scopedDiscard(
    Effect.gen(function*() {
      const output = yield* RuntimeAgentOutputEvents
      yield* output.pipe(
        Stream.filter(isCodexAcpTextChunk),
        Stream.mapAccum("", (resultText, observation) => {
          const nextResultText = resultText + observation.event.part.delta
          return [nextResultText, nextResultText.includes(toolResultMarker)]
        }),
        Stream.filter(Boolean),
        Stream.take(1),
        Stream.runDrain,
        Effect.zipRight(env.stopSignal.complete),
        Effect.withSpan("firegrid.simulation.observer.codex_acp_tool_result", {
          kind: "internal",
          attributes: {
            "firegrid.context.id": codexAcpContextId,
            "firegrid.simulation.marker": toolResultMarker,
          },
        }),
        Effect.forkScoped,
      )
    }),
  ).pipe(
    Layer.provide(RuntimeAgentOutputEventsLayer),
  )

export const codexAcpHost = (
  env: TinyFiregridHostEnv,
) => {
  const namespace = env.namespace
  const mcpHost = "127.0.0.1"
  const mcpPath = "/mcp"
  const host = FiregridLocalHostLive({
    durableStreamsBaseUrl: env.durableStreamsBaseUrl,
    namespace,
    input: true,
  }).pipe(
    Layer.provide(FiregridLocalProcessFromEnv(env.processEnv)),
    Layer.provide(FiregridEnvBindingsFromEnv({
      processEnv: env.processEnv,
      allow: [["OPENAI_API_KEY", "OPENAI_API_KEY"]],
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
    codexAcpToolResultObserver(env),
  ).pipe(
    Layer.provideMerge(host),
  )
}
