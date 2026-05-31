/**
 * Re-export of the runtime-context signal subscriber from
 * `@firegrid/runtime/unified`. See `../signal.ts` for the Phase 2
 * migration context.
 */

export {
  buildRuntimeContextSessionLayer,
  makeRuntimeContextRecorder,
  type RuntimeContextRecorder,
  type RuntimeContextRecorderState,
  type RuntimeContextSessionPayload,
  RuntimeContextSessionPayloadSchema,
  RuntimeContextSessionResultSchema,
  RuntimeContextSessionWorkflow,
  type SessionInputPayload,
  SessionInputPayloadSchema,
} from "@firegrid/runtime/unified"
