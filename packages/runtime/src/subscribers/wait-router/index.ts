// subscribers/wait-router/ public surface.
//
// SHAPE: D — durable wait/timeout (see ./README.md).
//
// `WaitForWorkflow` + `WaitForWorkflowLayer` are owned here. The workflow
// body was physically relocated from `workflow-engine/workflows/wait-for.ts`
// into `./workflow.ts` per the runtime physical target tree (tf-hpr0). No
// compatibility shim remains under the legacy subpath; consumers reach the
// Shape D Layer through `@firegrid/runtime/subscribers/wait-router`.

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
} from "./workflow.ts"
