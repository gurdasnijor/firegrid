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

export const darkFactoryChoreographyEvidencePrompt = (
  input: {
    readonly factoryRunKey: string
    readonly triggerFact: DarkFactoryFact
    readonly approvalSignalContextId: string
    readonly implementerAgentKind: string
  },
): string =>
  [
    "You are the tiny-firegrid dark-factory evidence probe.",
    "Use only the Firegrid runtime-context MCP tools available in this session.",
    "Do not invent success. Continue after tool errors and record each result.",
    "",
    `factoryRunKey: ${input.factoryRunKey}`,
    `accepted trigger fact JSON: ${JSON.stringify(input.triggerFact)}`,
    "",
    "Attempt these steps in order:",
    "1. Caller-owned approval fact wait: try to wait for a durable app fact with eventType=factory.permission.resolved and this factoryRunKey. If wait_for cannot name caller-owned DurableTable/fact sources, record exactly that.",
    `2. Delegation: call session_new with agentKind=${JSON.stringify(input.implementerAgentKind)} and a prompt asking the child to report IMPLEMENTER_READY. If it returns a session handle, call session_prompt on that session with a short follow-up. Record whether this is a supported delegation path.`,
    "3. Provider side effect: call execute for a PR-open-like provider side effect using sandbox.providerName=dark-factory-provider and sandbox.toolName=pull_request.opened. Record whether any public execute path exists.",
    `4. Durable long wait crux: call wait_for with source AgentOutput and whereFields { "contextId": ${JSON.stringify(input.approvalSignalContextId)}, "_tag": "TextChunk" }, timeoutMs 120000. This simulates a long approval wait whose result may arrive after the local-process agent is gone.`,
    "",
    "When you can no longer proceed, respond with one final line starting with DARK_FACTORY_EVIDENCE_DONE followed by compact JSON containing: callerFactWait, delegation, execute, durableResumeCrux.",
  ].join("\n")
