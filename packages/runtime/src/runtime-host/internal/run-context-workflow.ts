// firegrid-host-context-authority.RUNTIME_CONTEXT_PRIMITIVES.2
// firegrid-host-context-authority.RUNTIME_CONTEXT_HOST_AUTHORITY.4
//
// Single sanctioned RuntimeContextWorkflow execute call site. The
// public `startRuntime` in `packages/runtime/src/runtime-host/index.ts`
// gates with `requireLocalContext` before invoking this helper, so the
// authority check is observable at the public entry. This file lives
// under `runtime-host/internal/**` and is excluded from
// `firegrid-runtime-context-workflow-requires-local-authority`.

import type { Schema } from "effect"
import type { Effect } from "effect"
import type { Workflow, WorkflowEngine } from "@effect/workflow"

export const executeRuntimeContextWorkflow = <
  Name extends string,
  Payload extends Workflow.AnyStructSchema,
  Success extends Schema.Schema.Any,
  Error extends Schema.Schema.All,
>(
  engine: WorkflowEngine.WorkflowEngine["Type"],
  workflow: Workflow.Workflow<Name, Payload, Success, Error>,
  options: {
    readonly executionId: string
    readonly payload: Payload["Type"]
  },
): Effect.Effect<
  Success["Type"],
  Error["Type"],
  Payload["Context"] | Success["Context"] | Error["Context"]
> => engine.execute(workflow, options)
