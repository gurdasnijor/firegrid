/**
 * `@firegrid/runtime/host-substrate`
 *
 * The narrow, explicit runtime composition surface that `@firegrid/host-sdk`
 * composes. This subpath exists so host-sdk (and host/CLI composition
 * roots) import the substrate services through one runtime-owned
 * entrypoint instead of reaching the `@firegrid/runtime` root barrel
 * (`@effect/no-import-from-barrel-package`).
 *
 * Boundary invariants:
 *  - `@firegrid/runtime` must not import `@firegrid/host-sdk`,
 *    `@firegrid/client-sdk`, or `@firegrid/cli`
 *    (`firegrid-host-sdk.PACKAGE_GRAPH.2`).
 *  - host-sdk may import this subpath; browser/client code must not
 *    (`firegrid-host-sdk.PACKAGE_GRAPH.3`).
 *  - This is a curated composition surface, not a second barrel: it
 *    re-exports only the substrate services host composition needs.
 */

export {
  asRuntimeContextError,
  mapRuntimeContextError,
  RuntimeContextError,
  RuntimeIngressError,
  runtimeIngressError,
} from "./runtime-errors.ts"
// firegrid-host-sdk.TOOL_EXECUTOR_SEAM.1 / .3 — runtime owns the narrow
// `RuntimeToolUseExecutor` capability tag; host-sdk provides the live layer.
export {
  RuntimeToolUseExecutor,
} from "./agent-event-pipeline/subscribers/runtime-tool-use-executor.ts"
export {
  runCodecRuntimeEventPipeline,
} from "./agent-event-pipeline/session-runtime.ts"
export {
  localProcessSpawnEnvFromHostEnv,
  RuntimeEnvResolverPolicy,
  type LocalProcessSandboxProviderOptions,
  type RuntimeEnvResolverPolicyValue,
} from "./agent-event-pipeline/sources/sandbox/index.ts"
export {
  RuntimeControlPlaneRecorderLive,
  RuntimeContexts,
  RuntimeContextInsert,
  RuntimeContextInsertLive,
  RuntimeContextRead,
  RuntimeRuns,
  RuntimeRunAppendAndGet,
  type RuntimeContextInsertService,
  type RuntimeContextReadService,
  type RuntimeRunAppendAndGetService,
} from "./authorities/index.ts"
export {
  RuntimeIngressAppenderLayer,
  RuntimeIngressAppendAndGet,
  RuntimeIngressAppendContextMismatch,
  RuntimeIngressInputStream,
  RuntimeIngressInputStreamLayer,
} from "./agent-event-pipeline/authorities/runtime-ingress-appender.ts"
export {
  RuntimeIngressDeliveryClaimAndComplete,
  RuntimeIngressDeliveries,
  RuntimeIngressDeliveryTrackerLayer,
  runtimeIngressSubscriberId,
} from "./agent-event-pipeline/authorities/runtime-ingress-delivery-tracker.ts"
export {
  RuntimeAgentOutputAfterEvents,
  RuntimeAgentOutputEvents,
  RuntimeAgentOutputEventsLayer,
  RuntimeAgentOutputRowSink,
  RuntimeEventAppendAndGet,
  RuntimeLogLineAppendAndGet,
  RuntimeLogLineSink,
  RuntimeOutputEvents,
  RuntimeOutputJournalLayer,
  RuntimeOutputLogs,
  type RuntimeAgentOutputObservation,
} from "./agent-event-pipeline/authorities/runtime-output-journal.ts"
export {
  DurableStreamsWorkflowEngine,
  type WorkflowEngineDurableStateOptions,
  WorkflowEngineTable,
  type WorkflowEngineTableService,
} from "./workflow-engine/index.ts"
