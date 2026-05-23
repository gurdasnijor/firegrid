export {
  RuntimeContextError,
  asRuntimeContextError,
  mapRuntimeContextError,
} from "./runtime-errors.ts"
// Boundary (tf-bffo): the control-plane authority write-owner tags
// (RuntimeControlPlaneRecorderLive, RuntimeContextInsert(Live), RuntimeContexts,
// RuntimeContextRead, RuntimeLocalContextResolver, RuntimeRuns,
// RuntimeRunAppendAndGet) and the agent-output journal internals
// (RuntimeAgentOutputAfterEvents, RuntimeAgentOutputEvents(Layer), the
// RuntimeAuthorityAgentOutputObservation projection) are kernel internals — the
// write-ownership / commit points for durable collection families. They are NOT
// part of the above-box public surface: code above the substrate boundary reaches
// durable state through CHANNELS, not these service doors. Internal host
// composition still wires them via the `@firegrid/runtime/control-plane` and
// `@firegrid/runtime/runtime-output` subpaths; they are intentionally absent here.
export {
  RuntimeContextProvisionWorkflow,
  RuntimeContextProvisionWorkflowPayload,
  RuntimeControlRequestClaimedOutcomeSchema,
  RuntimeControlRequestDispatchOutcomeSchema,
  RuntimeControlRequestDoneOutcomeSchema,
  RuntimeContextWorkflowPayload,
  RuntimeLifecycleWorkflow,
  RuntimeLifecycleWorkflowPayload,
  RuntimeStartWorkflow,
  RuntimeStartWorkflowPayload,
  FieldEqualsPredicateSchema,
  FieldEqualsTriggerSchema,
  readRuntimeContext,
  runtimeContextWorkflowExecutionId,
  runtimeControlRequestWorkflowExecutionId,
  runtimeControlRequestWorkflowStreamUrl,
  type RuntimeControlRequestDispatchOutcome,
  type RuntimeExitEvidence,
  type StartRuntimeResult,
  type FieldEqualsPredicate,
  type FieldEqualsTrigger,
  evaluateFieldEquals,
} from "./workflow-engine/workflows/index.ts"
// tf-hpr0 HARD REDIRECT: WaitForWorkflow physically moved to
// `subscribers/wait-router/workflow.ts`. The runtime root barrel re-exports
// directly from the canonical subscriber subpath; no compatibility re-export
// remains in `workflow-engine/workflows/`.
export {
  WaitForWorkflow,
  WaitForWorkflowLayer,
  WaitForWorkflowMatchOutcomeSchema,
  WaitForWorkflowOutcomeSchema,
  WaitForWorkflowPayloadSchema,
  WaitForWorkflowTimeoutOutcomeSchema,
  waitForWorkflowExecutionId,
  type WaitForWorkflowOutcome,
  type WaitForWorkflowPayload,
} from "./subscribers/wait-router/index.ts"
// Post-#727 / tf-up1v cleanup wave: ToolCallWorkflow + payload schema
// physically moved to `subscribers/tool-dispatch/workflow.ts`. The runtime
// root barrel re-exports them directly from the tree-aligned subscribers
// subpath; the workflow-engine substrate path no longer defines them.
export {
  ToolCallWorkflow,
  ToolCallWorkflowPayloadSchema,
  type ToolCallWorkflowPayload,
} from "./subscribers/tool-dispatch/workflow.ts"
// Wave 2 (Shape C): the codec-session command sink contract is owned by the
// subscriber target folder. The runtime root barrel re-exports it directly
// from the public subscriber subpath; the workflow-engine substrate path no
// longer defines it.
export {
  RuntimeContextWorkflowSession,
  type RuntimeContextSessionCommand,
  type RuntimeContextSessionCommandAccepted,
  type RuntimeContextSessionStartedEvidence,
  type RuntimeContextWorkflowSessionService,
} from "./subscribers/runtime-context-session/index.ts"
export {
  AgentOutputAfterObservationSourceSchema,
  AgentOutputObservationSourceSchema,
  CallerFactObservationSourceSchema,
  CallerOwnedFactStreams,
  type CallerOwnedFactStreamsService,
  RuntimeObservationSourceSchema,
  type RuntimeObservationSource,
  RuntimeObservationStreams,
  RuntimeObservationStreamsLive,
  type RuntimeObservationStreamsService,
} from "./streams/index.ts"
// firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.5
// firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.6
export {
  mcpHeaderSecretBindingName,
  ResolveEnvBindingError,
  resolveMcpServerHeaders,
  resolveSpawnEnvVars,
  type EnvLookup,
} from "./producers/sandbox/secrets.ts"
// firegrid-effect-ai-inprocess-provider.SANDBOX_PROVIDER.1
export {
  effectAi,
  EffectAiSandboxProvider,
  type EffectAiSandboxConfig,
  type EffectAiSandboxProviderHelper,
} from "./producers/sandbox/effect-ai.ts"
export {
  AcpCapabilities,
  AcpSessionLive,
  type AcpMcpServerDeclaration,
  type AcpSessionOptions,
  StdioJsonlCapabilities,
  StdioJsonlSessionLive,
} from "./producers/codecs/index.ts"
export {
  RuntimeAgentOutputEnvelopeSchema,
  decodeRuntimeAgentOutputEnvelope,
  encodeRuntimeAgentOutputEnvelope,
  runtimeAgentOutputObservationFromRow,
  type RuntimeAgentOutputEnvelope,
  type RuntimeAgentOutputObservation,
} from "./events/output.ts"
export {
  AdapterCancelled,
  AgentAdapter,
  AgentAdapterRegistry,
  AdapterProtocolError,
  AdapterSessionNotPromptable,
  AdapterTerminated,
  AdapterUnsupportedFeature,
  CurrentAgentTurn,
  AgentAdapterSelectionError,
  LanguageModelAdapter,
  LanguageModelAdapterCapabilities,
  makeLanguageModelAdapter,
  PermissionRequiredButNotHandled,
  type AgentAdapterCapabilities,
  type AgentAdapterRegistryService,
  type AgentAdapterService,
  type AgentTurn,
} from "./producers/codecs/agent-adapters/index.ts"
export {
  ingestVerifiedWebhook,
  LinearWebhookFactSchema,
  type LinearWebhookFact,
  type VerifiedWebhookFact,
  VerifiedWebhookFactKeyEncoded,
  VerifiedWebhookFactKeySchema,
  type VerifiedWebhookFactKey,
  VerifiedWebhookFactSchema,
  VerifiedWebhookFactTable,
  type VerifiedWebhookFactTableOptions,
  type VerifiedWebhookFactTableService,
  type VerifiedWebhookHeaders,
  type VerifiedWebhookIngestConfig,
  VerifiedWebhookIngestError,
  type VerifiedWebhookIngestRequest,
  type VerifiedWebhookIngestResult,
  verifiedWebhookFactTableLayerOptions,
} from "./verified-webhook-ingest/index.ts"
