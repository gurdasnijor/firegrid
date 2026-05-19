import type { ServeError } from "@effect/platform/HttpServerError"
import {
  ensurePathInput,
  FiregridMcpServerLayer,
  FiregridRuntimeHostLive,
  type FiregridHost,
  RuntimeEnvResolverPolicy,
  type RuntimeHostTopologyOptions,
} from "@firegrid/host-sdk"
import { durableStreamUrl } from "@firegrid/protocol/launch"
import { Layer, Schema } from "effect"
import {
  DurableTable,
  type DurableTableError,
  type DurableTableHeaders,
  type DurableTableLayerOptions,
  type DurableTableService,
} from "effect-durable-operators"

export const DarkFactoryFactSchema = Schema.Struct({
  factKey: Schema.String.pipe(DurableTable.primaryKey),
  source: Schema.String,
  externalEventKey: Schema.String,
  externalEntityKey: Schema.String,
  eventType: Schema.String,
  factoryRunKey: Schema.String,
  createdAt: Schema.String,
  payload: Schema.Unknown,
})
export type DarkFactoryFact = Schema.Schema.Type<typeof DarkFactoryFactSchema>

const darkFactoryEvidenceSchemas = {
  facts: DarkFactoryFactSchema,
} as const

export class DarkFactoryEvidenceTable extends DurableTable(
  "tiny.darkFactory",
  darkFactoryEvidenceSchemas,
) {}

export type DarkFactoryEvidenceTableService = DurableTableService<
  typeof darkFactoryEvidenceSchemas
>

export interface DarkFactoryEvidenceTableOptions {
  readonly baseUrl: string
  readonly namespace: string
  readonly headers?: DurableTableHeaders
  readonly txTimeoutMs?: number
}

export const darkFactoryEvidenceStreamUrl = (
  options: {
    readonly baseUrl: string
    readonly namespace: string
  },
): string =>
  durableStreamUrl(
    options.baseUrl,
    `${options.namespace}.tiny.darkFactory.evidence`,
  )

export const darkFactoryEvidenceTableLayerOptions = (
  options: DarkFactoryEvidenceTableOptions,
): DurableTableLayerOptions => ({
  streamOptions: {
    url: darkFactoryEvidenceStreamUrl(options),
    contentType: "application/json",
    ...(options.headers === undefined ? {} : { headers: options.headers }),
  },
  txTimeoutMs: options.txTimeoutMs ?? 2_000,
})

interface DarkFactoryPipelineOptions {
  readonly baseUrl: string
  readonly namespace?: string
  readonly hostId?: string
  readonly mcpHost?: string
  readonly mcpPort?: number
  readonly mcpPath?: string
  readonly headers?: DurableTableHeaders
  readonly localProcessEnv?: RuntimeHostTopologyOptions["localProcessEnv"]
  readonly envPolicy?: Layer.Layer<RuntimeEnvResolverPolicy>
}

export const darkFactoryRealAgentEnvPolicy = (
  env: NodeJS.ProcessEnv,
): Layer.Layer<RuntimeEnvResolverPolicy> => {
  const authorizedBindings: Array<[string, string]> = []
  if (env.OPENAI_API_KEY !== undefined) {
    authorizedBindings.push(["OPENAI_API_KEY", "OPENAI_API_KEY"])
  }
  if (env.ANTHROPIC_API_KEY !== undefined) {
    authorizedBindings.push(["ANTHROPIC_API_KEY", "ANTHROPIC_API_KEY"])
  }
  return RuntimeEnvResolverPolicy.withPolicy({
    authorizedBindings,
    lookupEnv: name => env[name],
  })
}

export const tinyDarkFactoryPipeline = (
  options: DarkFactoryPipelineOptions,
): Layer.Layer<
  FiregridHost | DarkFactoryEvidenceTable,
  DurableTableError | ServeError,
  never
> => {
  const namespace = options.namespace ?? `tiny-dark-factory-${crypto.randomUUID()}`
  const hostId = options.hostId ?? "host-a"
  const host = FiregridRuntimeHostLive(
    {
      durableStreamsBaseUrl: options.baseUrl,
      namespace,
      hostId,
      hostSessionId: `${hostId}-session`,
      input: true,
      ...(options.headers === undefined ? {} : { headers: options.headers }),
      ...(options.localProcessEnv === undefined
        ? {}
        : { localProcessEnv: options.localProcessEnv }),
    },
    options.envPolicy ?? RuntimeEnvResolverPolicy.denyAll,
  )
  const table = DarkFactoryEvidenceTable.layer(
    darkFactoryEvidenceTableLayerOptions({
      baseUrl: options.baseUrl,
      namespace,
      ...(options.headers === undefined ? {} : { headers: options.headers }),
    }),
  )
  return Layer.mergeAll(
    table,
    Layer.discard(
      FiregridMcpServerLayer({
        host: options.mcpHost ?? "127.0.0.1",
        port: options.mcpPort ?? 0,
        path: ensurePathInput(options.mcpPath ?? "/mcp"),
      }),
    ).pipe(Layer.provideMerge(host)),
  )
}

export const makeDarkFactoryTriggerAcceptedFact = (
  input: {
    readonly factoryRunKey: string
    readonly externalEventKey: string
    readonly externalEntityKey: string
    readonly payload: unknown
    readonly createdAt: string
  },
): DarkFactoryFact => ({
  factKey: `factory.trigger.accepted:${input.factoryRunKey}`,
  source: "tiny-firegrid",
  externalEventKey: input.externalEventKey,
  externalEntityKey: input.externalEntityKey,
  eventType: "factory.trigger.accepted",
  factoryRunKey: input.factoryRunKey,
  createdAt: input.createdAt,
  payload: input.payload,
})

export const makeDarkFactoryPermissionResolvedFact = (
  input: {
    readonly factoryRunKey: string
    readonly decision: "approved" | "rejected"
    readonly createdAt: string
  },
): DarkFactoryFact => ({
  factKey: `factory.permission.resolved:${input.factoryRunKey}`,
  source: "tiny-firegrid",
  externalEventKey: `permission:${input.factoryRunKey}`,
  externalEntityKey: input.factoryRunKey,
  eventType: "factory.permission.resolved",
  factoryRunKey: input.factoryRunKey,
  createdAt: input.createdAt,
  payload: { decision: input.decision },
})

export const makeDarkFactoryPullRequestOpenedFact = (
  input: {
    readonly factoryRunKey: string
    readonly url: string
    readonly createdAt: string
    readonly placeholder: boolean
  },
): DarkFactoryFact => ({
  factKey: `factory.pull_request.opened:${input.factoryRunKey}`,
  source: "tiny-firegrid",
  externalEventKey: `pull-request:${input.factoryRunKey}`,
  externalEntityKey: input.url,
  eventType: "factory.pull_request.opened",
  factoryRunKey: input.factoryRunKey,
  createdAt: input.createdAt,
  payload: {
    url: input.url,
    placeholder: input.placeholder,
  },
})

export const makeDarkFactoryTerminalFact = (
  input: {
    readonly factoryRunKey: string
    readonly createdAt: string
    readonly payload: unknown
  },
): DarkFactoryFact => ({
  factKey: `factory.terminal:${input.factoryRunKey}`,
  source: "tiny-firegrid",
  externalEventKey: `terminal:${input.factoryRunKey}`,
  externalEntityKey: input.factoryRunKey,
  eventType: "factory.terminal",
  factoryRunKey: input.factoryRunKey,
  createdAt: input.createdAt,
  payload: input.payload,
})

export const darkFactoryChoreographyHappyPathPrompt = (
  input: {
    readonly factoryRunKey: string
    readonly triggerFact: DarkFactoryFact
    readonly approvalSignalContextId: string
    readonly implementerAgentKind: string
  },
): string =>
  [
    "You are the tiny-firegrid dark-factory planner.",
    "Use the Firegrid runtime-context MCP server available in this ACP session.",
    "You drive the happy path. The test only supplies the human approval signal after you wait for it.",
    "Do not answer before making the required Firegrid tool calls.",
    "",
    `factoryRunKey: ${input.factoryRunKey}`,
    `accepted trigger fact JSON: ${JSON.stringify(input.triggerFact)}`,
    "",
    "Required sequence:",
    "1. Read the accepted trigger fact above and emit a short text line containing factory.trigger.accepted and the factoryRunKey.",
    "2. Request approval. If your ACP runtime offers a permission request flow, use it. Then call the Firegrid wait_for tool with exactly this approval query:",
    JSON.stringify({
      waitQuery: {
        source: { _tag: "AgentOutput" },
        whereFields: {
          contextId: input.approvalSignalContextId,
          _tag: "TextChunk",
        },
      },
      timeoutMs: 120_000,
    }),
    "3. After wait_for returns matched=true, delegate the implementer by calling session_new with:",
    JSON.stringify({
      agentKind: input.implementerAgentKind,
      prompt: `IMPLEMENTER_READY for ${input.factoryRunKey}`,
    }),
    "4. If session_new returns a session handle, call session_prompt on that session with:",
    JSON.stringify({
      prompt: `Continue implementer handoff for ${input.factoryRunKey}`,
    }),
    "5. PR-open provider execution is not wired in the live host yet (tf-mn2 sub-gap 3). Do not call execute for this smoke; instead emit the terminal marker below as the explicitly marked non-durable happy-path placeholder for factory.pull_request.opened.",
    "",
    "Final response format, after the required tool calls:",
    `DARK_FACTORY_TERMINAL {"factoryRunKey":${JSON.stringify(input.factoryRunKey)},"approval":"approved","implementer":"delegated","pullRequest":"placeholder-opened"}`,
  ].join("\n")
