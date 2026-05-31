/**
 * Re-export of the permission/tool signal subscribers from
 * `@firegrid/runtime/unified`. See `../signal.ts` for the Phase 2
 * migration context.
 */

export {
  buildPermissionRoundtripLayer,
  buildToolDispatchLayer,
  makeToolExecutor,
  PERMISSION_DECISION_SIGNAL,
  type PermissionDecision,
  type PermissionDecisionPayload,
  PermissionDecisionPayloadSchema,
  PermissionDecisionSchema,
  type PermissionRoundtripPayload,
  PermissionRoundtripPayloadSchema,
  PermissionRoundtripResultSchema,
  PermissionRoundtripWorkflow,
  type ToolDispatchPayload,
  ToolDispatchPayloadSchema,
  ToolDispatchResultSchema,
  ToolDispatchWorkflow,
  type ToolExecutor,
  type ToolExecutorState,
} from "@firegrid/runtime/unified"
