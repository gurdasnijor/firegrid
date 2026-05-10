import { DurableDeferred } from "@effect/workflow"
import {
  RequiredActionResolutionSchema,
} from "./schema.ts"

export const requiredActionWorkflowName = "firegrid.required-action"

export const RequiredActionResolutionDeferred = DurableDeferred.make(
  "required-action-resolution",
  {
    success: RequiredActionResolutionSchema,
  },
)
