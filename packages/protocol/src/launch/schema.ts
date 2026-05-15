import { Schema } from "effect"
import {
  RuntimeContextHostBindingSchema,
  type RuntimeContextHostBinding,
} from "./authority.ts"

export const RuntimeOutputSourceSchema = Schema.Literal("stdout", "stderr")
export type RuntimeOutputSource = Schema.Schema.Type<typeof RuntimeOutputSourceSchema>

export const RuntimeJournalTargetSchema = Schema.Literal("events", "logs")
export type RuntimeJournalTarget = Schema.Schema.Type<typeof RuntimeJournalTargetSchema>

export const RuntimeJournalFormatSchema = Schema.Literal("jsonl", "text-lines")
export type RuntimeJournalFormat = Schema.Schema.Type<typeof RuntimeJournalFormatSchema>

export const RuntimeProviderSchema = Schema.Literal("local-process")
export type RuntimeProvider = Schema.Schema.Type<typeof RuntimeProviderSchema>

export const RuntimeAgentProtocolSchema = Schema.Literal("raw", "stdio-jsonl", "acp")
export type RuntimeAgentProtocol = Schema.Schema.Type<typeof RuntimeAgentProtocolSchema>

export const McpServerUrlDeclarationSchema = Schema.Struct({
  type: Schema.Literal("url"),
  url: Schema.String,
  headers: Schema.optional(Schema.Record({
    key: Schema.String,
    value: Schema.String,
  })),
}).annotations({
  parseOptions: {
    onExcessProperty: "error",
  },
})
export type McpServerUrlDeclaration = Schema.Schema.Type<typeof McpServerUrlDeclarationSchema>

export const McpServerDeclarationSchema = Schema.Struct({
  name: Schema.String.pipe(Schema.minLength(1)),
  server: McpServerUrlDeclarationSchema,
}).annotations({
  parseOptions: {
    onExcessProperty: "error",
  },
})
export type McpServerDeclaration = Schema.Schema.Type<typeof McpServerDeclarationSchema>

export const firegridRuntimeContextMcpName = "firegrid-runtime-context"

export const firegridRuntimeContextMcpDeclaration = (
  url: string,
): McpServerDeclaration => ({
  name: firegridRuntimeContextMcpName,
  server: {
    type: "url",
    url,
  },
})

// firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.5
//
// Only the binding (name + ref) is durably persisted. The ref names a host
// env var; the resolver reads the value at spawn time and merges it into
// SandboxCommand.envVars. The durable plane never sees the value.
export const RuntimeEnvBindingSchema = Schema.Struct({
  name: Schema.String,
  ref: Schema.String,
})
export type RuntimeEnvBinding = Schema.Schema.Type<typeof RuntimeEnvBindingSchema>

export const RuntimeConfigSchema = Schema.Struct({
  argv: Schema.Array(Schema.String),
  cwd: Schema.optional(Schema.String),
  agent: Schema.optional(Schema.String.pipe(Schema.minLength(1))),
  envBindings: Schema.optional(Schema.Array(RuntimeEnvBindingSchema)),
  agentProtocol: Schema.optional(RuntimeAgentProtocolSchema),
  mcpServers: Schema.optional(Schema.Array(McpServerDeclarationSchema)),
})
export type RuntimeConfig = Schema.Schema.Type<typeof RuntimeConfigSchema>

export const RuntimeJournalRuleSchema = Schema.Struct({
  source: RuntimeOutputSourceSchema,
  format: RuntimeJournalFormatSchema,
  target: RuntimeJournalTargetSchema,
})
export type RuntimeJournalRule = Schema.Schema.Type<typeof RuntimeJournalRuleSchema>

export const RuntimeContextIntentSchema = Schema.Struct({
  provider: RuntimeProviderSchema,
  config: RuntimeConfigSchema,
  journal: Schema.Array(RuntimeJournalRuleSchema),
})
export type RuntimeContextIntent = Schema.Schema.Type<typeof RuntimeContextIntentSchema>

export const PublicLaunchRuntimeIntentSchema = Schema.Struct({
  provider: RuntimeProviderSchema,
  config: RuntimeConfigSchema,
})
export type PublicLaunchRuntimeIntent = Schema.Schema.Type<typeof PublicLaunchRuntimeIntentSchema>

export const PublicLaunchRequestSchema = Schema.Struct({
  runtime: PublicLaunchRuntimeIntentSchema,
  requestedBy: Schema.optional(Schema.String),
}).annotations({
  parseOptions: {
    onExcessProperty: "error",
  },
})
export type PublicLaunchRequest = Schema.Schema.Type<typeof PublicLaunchRequestSchema>

const normalizeRuntimeConfig = (config: RuntimeConfig): RuntimeConfig => ({
  argv: [...config.argv],
  ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
  ...(config.agent === undefined ? {} : { agent: config.agent }),
  ...(config.envBindings === undefined ? {} : {
    envBindings: config.envBindings.map(binding => ({
      name: binding.name,
      ref: binding.ref,
    })),
  }),
  ...(config.agentProtocol === undefined ? {} : { agentProtocol: config.agentProtocol }),
  ...(config.mcpServers === undefined ? {} : {
    mcpServers: config.mcpServers.map(declaration => ({
      name: declaration.name,
      server: {
        type: declaration.server.type,
        url: declaration.server.url,
        ...(declaration.server.headers === undefined
          ? {}
          : { headers: { ...declaration.server.headers } }),
      },
    })),
  }),
})

export const localJsonlJournal = [
  { source: "stdout", format: "jsonl", target: "events" },
  { source: "stderr", format: "text-lines", target: "logs" },
] satisfies ReadonlyArray<RuntimeJournalRule>

export const normalizeRuntimeIntent = (
  runtime: PublicLaunchRuntimeIntent,
): RuntimeContextIntent => ({
  provider: runtime.provider,
  config: normalizeRuntimeConfig(runtime.config),
  // firegrid-durable-launch-runtime-operator.LAUNCH_ROWS.8
  journal: [...localJsonlJournal],
})

export const local = {
  jsonl: (config: RuntimeConfig): PublicLaunchRuntimeIntent => ({
    provider: "local-process",
    config: normalizeRuntimeConfig(config),
  }),
}

// firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.5
//
// Helper to construct an env binding with the env: ref shape. v1 supports
// only "env:VAR"; future ref shapes (vault, k8s secret, etc.) get their own
// constructors here.
export const envBinding = (
  name: string,
  envVarName: string = name,
): RuntimeEnvBinding => ({
  name,
  ref: `env:${envVarName}`,
})

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

const EnvVarName = Schema.String.pipe(
  Schema.filter((value) =>
    ENV_NAME_RE.test(value)
      ? undefined
      : `not a valid env-var identifier: ${value}`),
)

export const LaunchAuthorizedBindingSchema = Schema.Tuple(EnvVarName, EnvVarName)
export type LaunchAuthorizedBinding = Schema.Schema.Type<typeof LaunchAuthorizedBindingSchema>

export const LaunchConfigSchema = Schema.Struct({
  // firegrid-local-mcp-run.LAUNCH_CONFIG.4
  agentArgv: Schema.Array(Schema.String).pipe(
    Schema.filter((argv) =>
      argv.length > 0 ? undefined : "agentArgv must be non-empty"),
  ),
  cwd: Schema.optional(Schema.String.pipe(
    Schema.filter((value) =>
      value.length > 0 ? undefined : "cwd must be a non-empty path"),
  )),
  prompt: Schema.optional(Schema.String),
  envBindings: Schema.optional(Schema.Array(RuntimeEnvBindingSchema)),
  authorizedBindings: Schema.optional(Schema.Array(LaunchAuthorizedBindingSchema)),
  // firegrid-local-mcp-run.LAUNCH_CONFIG.6
  agent: Schema.optional(Schema.String.pipe(Schema.minLength(1))),
  agentProtocol: Schema.optional(RuntimeAgentProtocolSchema),
  // firegrid-local-mcp-run.LAUNCH_CONFIG.1
  mcpServers: Schema.optional(Schema.Array(McpServerDeclarationSchema)),
}).annotations({
  parseOptions: {
    onExcessProperty: "error",
  },
})
export type LaunchConfig = Schema.Schema.Type<typeof LaunchConfigSchema>

export const decodeLaunchConfig = Schema.decodeUnknown(LaunchConfigSchema)

export const injectLaunchMcpDeclaration = (
  config: LaunchConfig,
  declaration: McpServerDeclaration,
): LaunchConfig => ({
  ...config,
  // firegrid-local-mcp-run.MCP_ROUTE.3
  // firegrid-local-mcp-run.MCP_ROUTE.4
  // firegrid-local-mcp-run.LAUNCH_CONFIG.5
  mcpServers: [
    declaration,
    ...(config.mcpServers ?? []).filter(existing => existing.name !== declaration.name),
  ],
})

// firegrid-host-context-authority.RUNTIME_CONTEXT_HOST_AUTHORITY.1
// firegrid-host-context-authority.RUNTIME_CONTEXT_HOST_AUTHORITY.2
// firegrid-host-context-authority.RUNTIME_CONTEXT_HOST_AUTHORITY.4
//
// RuntimeContext gains a required `host` binding: hostId, the
// host-owned streamPrefix wire string, and the bind timestamp. The
// binding is filled in by the runtime host at context-create time
// (see `insertLocalRuntimeContext` in `@firegrid/runtime`); V1 does
// not create an intermediate unbound context row, and the context row
// itself is the durable context routing authority — no separate host
// directory or context placement table.
export const RuntimeContextSchema = Schema.Struct({
  contextId: Schema.String,
  createdAt: Schema.String,
  createdBy: Schema.optional(Schema.String),
  runtime: RuntimeContextIntentSchema,
  host: RuntimeContextHostBindingSchema,
})
export type RuntimeContext = Schema.Schema.Type<typeof RuntimeContextSchema>

/**
 * Construct a RuntimeContext row with its host binding filled in from
 * the current host session and the bind timestamp captured at create
 * time. Centralizing the binding here keeps host-authority schema
 * encoding next to the row schema rather than at call sites.
 */
export const makeRuntimeContext = (input: {
  readonly contextId: string
  readonly createdAtMs: number
  readonly createdBy?: string
  readonly runtime: RuntimeContextIntent
  readonly host: RuntimeContextHostBinding
}): RuntimeContext => ({
  contextId: input.contextId,
  createdAt: new Date(input.createdAtMs).toISOString(),
  ...(input.createdBy === undefined ? {} : { createdBy: input.createdBy }),
  runtime: input.runtime,
  host: input.host,
})

export const RuntimeRunEventKeySchema = Schema.Struct({
  contextId: Schema.String,
  activityAttempt: Schema.Number,
  status: Schema.Literal("started", "exited", "failed"),
})
export type RuntimeRunEventKey = Schema.Schema.Type<typeof RuntimeRunEventKeySchema>

export const runtimeRunEventFields = {
  runEventId: RuntimeRunEventKeySchema,
  contextId: Schema.String,
  activityAttempt: Schema.Number,
  status: Schema.Literal("started", "exited", "failed"),
  at: Schema.String,
  provider: RuntimeProviderSchema,
  exitCode: Schema.optional(Schema.Number),
  signal: Schema.optional(Schema.String),
  message: Schema.optional(Schema.String),
} as const
export const RuntimeRunEventSchema = Schema.Struct(runtimeRunEventFields)
export type RuntimeRunEvent = Schema.Schema.Type<typeof RuntimeRunEventSchema>

export const RuntimeOutputEventKeySchema = Schema.Struct({
  contextId: Schema.String,
  activityAttempt: Schema.Number,
  target: Schema.Literal("events"),
  sequence: Schema.Number,
})
export type RuntimeOutputEventKey = Schema.Schema.Type<typeof RuntimeOutputEventKeySchema>

export const runtimeEventFields = {
  eventId: RuntimeOutputEventKeySchema,
  contextId: Schema.String,
  activityAttempt: Schema.Number,
  sequence: Schema.Number,
  source: Schema.Literal("stdout"),
  format: Schema.Literal("jsonl"),
  receivedAt: Schema.String,
  raw: Schema.String,
} as const
export const RuntimeEventSchema = Schema.Struct(runtimeEventFields)
export type RuntimeEvent = Schema.Schema.Type<typeof RuntimeEventSchema>

export const RuntimeOutputLogLineKeySchema = Schema.Struct({
  contextId: Schema.String,
  activityAttempt: Schema.Number,
  target: Schema.Literal("logs"),
  sequence: Schema.Number,
})
export type RuntimeOutputLogLineKey = Schema.Schema.Type<typeof RuntimeOutputLogLineKeySchema>

export const runtimeLogLineFields = {
  logLineId: RuntimeOutputLogLineKeySchema,
  contextId: Schema.String,
  activityAttempt: Schema.Number,
  sequence: Schema.Number,
  source: Schema.Literal("stderr"),
  format: Schema.Literal("text-lines"),
  receivedAt: Schema.String,
  raw: Schema.String,
} as const
export const RuntimeLogLineSchema = Schema.Struct(runtimeLogLineFields)
export type RuntimeLogLine = Schema.Schema.Type<typeof RuntimeLogLineSchema>
