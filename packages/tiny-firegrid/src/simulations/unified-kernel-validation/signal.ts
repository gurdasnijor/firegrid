/**
 * Re-export of the durable signal primitive from
 * `@firegrid/runtime/unified`. Phase 2 of
 * `SDD_FIREGRID_PROTOCOL_RESPONSE_UNIFICATION` lifted the primitive
 * into the runtime package; this module preserves the existing
 * sibling-import path so the simulation continues to be the
 * runnable harness verifying the unified architecture.
 *
 * Once Phase 2's deletion commit lands and downstream consumers
 * import directly from `@firegrid/runtime/unified`, this file can
 * be removed.
 */

export {
  awaitSignal,
  readSignalsFor,
  recordSignal,
  recoverPendingSignals,
  type ResumableWorkflow,
  sendSignal,
  type SignalRow,
  SignalRowSchema,
  type SignalRowRewriter,
  SignalTable,
  type SignalTableService,
  WorkflowEngine,
  type WorkflowCatalog,
  WorkflowEngineTable,
} from "@firegrid/runtime/unified"
