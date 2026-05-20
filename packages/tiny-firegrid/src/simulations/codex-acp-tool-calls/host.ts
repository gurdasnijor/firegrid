import { sessionContextIdForExternalKey } from "@firegrid/protocol/session-facade"
import {
  ensurePathInput,
  FiregridEnvBindingsFromEnv,
  FiregridLocalHostLive,
  FiregridLocalProcessFromEnv,
  FiregridMcpServerLayer,
  hostProjectionObserver,
  type RuntimeAgentOutputObservation,
} from "@firegrid/host-sdk"
import { Layer, Option } from "effect"
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
  hostProjectionObserver({
    spanName: "firegrid.simulation.observer.codex_acp_tool_result",
    contextId: codexAcpContextId,
    initialState: "",
    attributes: {
      "firegrid.simulation.marker": toolResultMarker,
    },
    project: (resultText, observation) => {
      if (!isCodexAcpTextChunk(observation)) return [resultText, Option.none()]
      const nextResultText = resultText + observation.event.part.delta
      return [
        nextResultText,
        nextResultText.includes(toolResultMarker)
          ? Option.some(toolResultMarker)
          : Option.none(),
      ]
    },
    onMatch: () => env.stopSignal.complete,
  })

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
