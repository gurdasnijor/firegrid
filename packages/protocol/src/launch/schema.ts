import { Either, Schema, SchemaAST } from "effect"
import {
  RuntimeContextHostBindingSchema,
  type RuntimeContextHostBinding,
} from "./authority.ts"

export interface LaunchCliHelpEntry {
  readonly description: string
  readonly examples: ReadonlyArray<string>
  readonly defaultValue?: string
}

const readStringAnnotation = (
  schema: { readonly ast: SchemaAST.AST },
  annotationId: symbol,
): string | undefined => {
  const value = schema.ast.annotations[annotationId]
  return typeof value === "string" ? value : undefined
}

const readExampleAnnotations = (
  schema: { readonly ast: SchemaAST.AST },
): ReadonlyArray<string> => {
  const shellArg = (value: string): string =>
    /^[A-Za-z0-9_./:@=-]+$/.test(value) ? value : JSON.stringify(value)
  const examples = schema.ast.annotations[SchemaAST.ExamplesAnnotationId]
  if (!Array.isArray(examples)) return []
  return examples.map((example) => {
    if (typeof example === "string") return example
    if (Array.isArray(example) && example.every((part): part is string => typeof part === "string")) {
      return example.map(shellArg).join(" ")
    }
    return JSON.stringify(example)
  })
}

const cliHelpFromSchema = (
  schema: { readonly ast: SchemaAST.AST },
  fallback: LaunchCliHelpEntry,
): LaunchCliHelpEntry => {
  const description = readStringAnnotation(schema, SchemaAST.DescriptionAnnotationId) ?? fallback.description
  const examples = readExampleAnnotations(schema)
  const defaultValue = readStringAnnotation(schema, SchemaAST.DefaultAnnotationId) ?? fallback.defaultValue
  return {
    description,
    examples: examples.length === 0 ? fallback.examples : examples,
    ...(defaultValue === undefined ? {} : { defaultValue }),
  }
}

export const RuntimeOutputSourceSchema = Schema.Literal("stdout", "stderr")
export type RuntimeOutputSource = Schema.Schema.Type<typeof RuntimeOutputSourceSchema>

export const RuntimeJournalTargetSchema = Schema.Literal("events", "logs")
export type RuntimeJournalTarget = Schema.Schema.Type<typeof RuntimeJournalTargetSchema>

export const RuntimeJournalFormatSchema = Schema.Literal("jsonl", "text-lines")
export type RuntimeJournalFormat = Schema.Schema.Type<typeof RuntimeJournalFormatSchema>

export const RuntimeProviderSchema = Schema.Literal("local-process")
export type RuntimeProvider = Schema.Schema.Type<typeof RuntimeProviderSchema>

export const runtimeAgentProtocolValues = ["raw", "stdio-jsonl", "acp"] as const

export const RuntimeAgentProtocolSchema = Schema.Literal(...runtimeAgentProtocolValues).annotations({
  description: "Runtime codec used for the launched agent process.",
  examples: ["raw", "stdio-jsonl", "acp"],
  default: "raw",
})
export type RuntimeAgentProtocol = Schema.Schema.Type<typeof RuntimeAgentProtocolSchema>

export const RuntimeArgvSchema = Schema.Array(Schema.String).annotations({
  description: "Agent command and arguments after `--`.",
  examples: [
    ["node", "-e", "console.log('hello from firegrid')"],
    ["npx", "-y", "@zed-industries/codex-acp@0.14.0"],
  ],
})

const LaunchAgentArgvSchema = RuntimeArgvSchema.pipe(
  Schema.filter((argv) =>
    argv.length > 0 ? undefined : "agentArgv must be non-empty"),
).annotations({
  description: "Agent command and arguments after `--`; run requires at least one argument.",
  examples: [
    ["node", "-e", "console.log('hello from firegrid')"],
    ["npx", "-y", "@zed-industries/codex-acp@0.14.0"],
  ],
})

export const RuntimeCwdSchema = Schema.String.pipe(
  Schema.filter((value) =>
    value.length > 0 ? undefined : "cwd must be a non-empty path"),
).annotations({
  description: "Working directory for the launched agent process.",
  examples: ["/Users/alice/project"],
  default: "current working directory",
})

export const RuntimePromptSchema = Schema.String.annotations({
  description: "Initial prompt appended to the RuntimeContext ingress before launch.",
  examples: ["Summarize this repository and list next steps."],
})

export const RuntimeAgentSelectorSchema = Schema.String.pipe(Schema.minLength(1)).annotations({
  description: "Opaque agent selector recorded in launch config for adapters and host policy.",
  examples: ["local-shell", "codex-acp"],
})

export const LaunchSecretEnvCliValueSchema = Schema.String.annotations({
  description: "Authorize one host env var for the launched process as NAME or NAME=HOST_ENV_NAME; literal secret values are never accepted.",
  examples: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY=PARENT_OPENAI_API_KEY"],
})

export const McpServerHeaderRefSchema = Schema.Struct({
  ref: Schema.String.pipe(Schema.minLength(1)),
}).annotations({
  parseOptions: {
    onExcessProperty: "error",
  },
})
export type McpServerHeaderRef = Schema.Schema.Type<typeof McpServerHeaderRefSchema>

export const McpServerHeaderValueSchema = Schema.Union(
  Schema.String,
  McpServerHeaderRefSchema,
)
export type McpServerHeaderValue = Schema.Schema.Type<typeof McpServerHeaderValueSchema>

const SECRET_HEADER_NAME_RE =
  /(^|[-_])(authorization|api[-_]?key|token|secret|credential|session|cookie)([-_]|$)/i
const SECRET_HEADER_VALUE_RE =
  /^(Bearer|Basic|Token)\s+\S+|^(sk|pk|ghp|gho|github_pat|pat|xox[baprs]|ya29)[-_A-Za-z0-9]{8,}/i

export const isMcpServerHeaderRef = (
  value: McpServerHeaderValue,
): value is McpServerHeaderRef =>
  typeof value === "object" && value !== null && "ref" in value

export const isMcpServerHeaderLiteralSecret = (
  name: string,
  value: string,
): boolean =>
  SECRET_HEADER_NAME_RE.test(name) || SECRET_HEADER_VALUE_RE.test(value)

const validateMcpServerLiteralHeaders = (
  headers: Readonly<Record<string, McpServerHeaderValue>> | undefined,
): string | undefined => {
  if (headers === undefined) return undefined
  const entries = Object.entries(headers)
  let index = 0
  while (index < entries.length) {
    const [name, value] = entries[index]!
    if (typeof value === "string" && isMcpServerHeaderLiteralSecret(name, value)) {
      return `mcpServers header "${name}" carries a literal secret-shaped value; use { ref: "env:VAR" } instead`
    }
    index += 1
  }
  return undefined
}

const McpServerUrlDeclarationBaseSchema = Schema.Struct({
  type: Schema.Literal("url"),
  url: Schema.String,
  headers: Schema.optional(Schema.Record({
    key: Schema.String,
    value: McpServerHeaderValueSchema,
  })),
}).annotations({
  parseOptions: {
    onExcessProperty: "error",
  },
})

export const McpServerUrlDeclarationSchema = McpServerUrlDeclarationBaseSchema.pipe(
  // firegrid-local-mcp-run.LAUNCH_CONFIG.9
  Schema.filter(declaration => validateMcpServerLiteralHeaders(declaration.headers)),
)
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

// TFIND-048 (SDD_MCP_ROUTE_URL_LIFECYCLE Amendment 1 §A1.2): the
// URL-less client marker. A client expresses *that* the runtime needs
// the host-owned Firegrid runtime-context MCP server attached; it
// structurally cannot express *where* — this schema has no url/host/
// port slot. The concrete `contextId`-scoped URL is host-owned and is
// resolved + injected post-materialization at start time from the
// host's own bound MCP listener address (see host-sdk
// `FiregridRuntimeContextMcpBaseUrl`). A sentinel on an `mcpServers`
// entry was rejected: `mcpServers` is client-owned end-to-end (every
// entry carries a required client-authored `url`), while this server's
// URL authority is host-owned — the distinction is made visible at the
// schema level by a dedicated member.
export const RuntimeContextMcpMarkerSchema = Schema.Struct({
  enabled: Schema.Literal(true),
}).annotations({
  identifier: "firegrid.launch.runtimeContextMcpMarker",
  title: "Runtime-context MCP attachment marker",
  description:
    "URL-less client intent to attach the host-owned Firegrid runtime-context MCP server. The host resolves and injects the concrete contextId-scoped URL at start.",
  parseOptions: {
    onExcessProperty: "error",
  },
})
export type RuntimeContextMcpMarker = Schema.Schema.Type<
  typeof RuntimeContextMcpMarkerSchema
>

// Host-side concrete-injection helper. NOT part of the client path:
// only the host start path constructs this, from the host's own bound
// MCP base + the materialized `contextId`.
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
  argv: RuntimeArgvSchema,
  cwd: Schema.optional(RuntimeCwdSchema),
  agent: Schema.optional(RuntimeAgentSelectorSchema),
  envBindings: Schema.optional(Schema.Array(RuntimeEnvBindingSchema)),
  agentProtocol: Schema.optional(RuntimeAgentProtocolSchema),
  mcpServers: Schema.optional(Schema.Array(McpServerDeclarationSchema)),
  // TFIND-048: URL-less, host-owned runtime-context MCP attachment.
  // Distinct from `mcpServers` (client-owned, carries client URLs).
  runtimeContextMcp: Schema.optional(RuntimeContextMcpMarkerSchema),
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
  ...(config.runtimeContextMcp === undefined ? {} : {
    runtimeContextMcp: { enabled: config.runtimeContextMcp.enabled },
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

export interface LaunchSecretEnvCliBinding {
  readonly envBinding: RuntimeEnvBinding
  readonly authorizedBinding: LaunchAuthorizedBinding
}

const decodeEnvVarName = Schema.decodeUnknownEither(EnvVarName)

// firegrid-local-mcp-run.CLI_HELP.4
//
// Parse the public CLI spelling for secret env authorization. The durable
// launch config stores only env refs; literal secret values never cross the
// command line or durable schema boundary.
export const decodeLaunchSecretEnvCliValue = (
  raw: string,
): Either.Either<LaunchSecretEnvCliBinding, string> => {
  const equalsIndex = raw.indexOf("=")
  const name = equalsIndex === -1 ? raw : raw.slice(0, equalsIndex)
  const envName = equalsIndex === -1 ? raw : raw.slice(equalsIndex + 1)
  if (Either.isLeft(decodeEnvVarName(name))) {
    return Either.left(
      `--secret-env expects an env-var identifier, got "${name}". ` +
        "Use --secret-env NAME or --secret-env NAME=ENV_NAME; values are never accepted on the command line.",
    )
  }
  if (Either.isLeft(decodeEnvVarName(envName))) {
    return Either.left(
      `--secret-env right-hand side "${envName}" is not a valid env-var identifier. ` +
        "--secret-env names host env vars; it does not accept secret values.",
    )
  }
  return Either.right({
    envBinding: envBinding(name, envName),
    authorizedBinding: [name, envName],
  })
}

export const LaunchConfigSchema = Schema.Struct({
  // firegrid-local-mcp-run.LAUNCH_CONFIG.4
  agentArgv: LaunchAgentArgvSchema,
  cwd: Schema.optional(RuntimeCwdSchema),
  prompt: Schema.optional(RuntimePromptSchema),
  envBindings: Schema.optional(Schema.Array(RuntimeEnvBindingSchema)),
  authorizedBindings: Schema.optional(Schema.Array(LaunchAuthorizedBindingSchema)),
  // firegrid-local-mcp-run.LAUNCH_CONFIG.6
  agent: Schema.optional(RuntimeAgentSelectorSchema),
  agentProtocol: Schema.optional(RuntimeAgentProtocolSchema),
  // firegrid-local-mcp-run.LAUNCH_CONFIG.1
  mcpServers: Schema.optional(Schema.Array(McpServerDeclarationSchema)),
  // TFIND-048: URL-less host-owned runtime-context MCP attachment.
  runtimeContextMcp: Schema.optional(RuntimeContextMcpMarkerSchema),
}).annotations({
  parseOptions: {
    onExcessProperty: "error",
  },
})
export type LaunchConfig = Schema.Schema.Type<typeof LaunchConfigSchema>

// firegrid-local-mcp-run.CLI_HELP.4
export const LaunchCliHelp = {
  agentArgv: cliHelpFromSchema(LaunchAgentArgvSchema, {
    description: "Agent command and arguments after `--`.",
    examples: ["node -e 'console.log(\"hello\")'"],
  }),
  agent: cliHelpFromSchema(RuntimeAgentSelectorSchema, {
    description: "Opaque agent selector recorded in launch config.",
    examples: ["codex-acp"],
  }),
  agentProtocol: cliHelpFromSchema(RuntimeAgentProtocolSchema, {
    description: "Runtime codec used for the launched agent process.",
    examples: ["raw", "stdio-jsonl", "acp"],
    defaultValue: "raw",
  }),
  cwd: cliHelpFromSchema(RuntimeCwdSchema, {
    description: "Working directory for the launched agent process.",
    examples: ["."],
    defaultValue: "current working directory",
  }),
  prompt: cliHelpFromSchema(RuntimePromptSchema, {
    description: "Initial prompt appended to RuntimeContext ingress before launch.",
    examples: ["Summarize this repository."],
  }),
  secretEnv: cliHelpFromSchema(LaunchSecretEnvCliValueSchema, {
    description: "Authorize one host env var for the launched process.",
    examples: ["ANTHROPIC_API_KEY", "OPENAI_API_KEY=PARENT_OPENAI_API_KEY"],
  }),
} as const

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
