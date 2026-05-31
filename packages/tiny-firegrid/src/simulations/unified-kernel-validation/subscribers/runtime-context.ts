/**
 * Re-export of the runtime-context signal subscriber from
 * `@firegrid/runtime/unified`. See `../signal.ts` for the Phase 2
 * migration context.
 *
 * Phase 3 (SDD_FIREGRID_UNIFIED_PRODUCTION_WIRING §A): the workflow body
 * consumes `RuntimeContextSessionAdapter` via Tag instead of a
 * closure-captured recorder. Simulations use `makeRecorderAdapter` to
 * provide the Tag with a Ref-backed stand-in implementation.
 */

export {
  makeRecorderAdapter,
  RuntimeContextSessionAdapter,
  type RecorderAdapter,
  type RecorderAdapterState,
  type RuntimeContextSessionAdapterService,
  type RuntimeContextSessionPayload,
  RuntimeContextSessionPayloadSchema,
  RuntimeContextSessionResultSchema,
  RuntimeContextSessionWorkflow,
  RuntimeContextSessionWorkflowLayer,
  type SessionInputPayload,
  SessionInputPayloadSchema,
} from "@firegrid/runtime/unified"
