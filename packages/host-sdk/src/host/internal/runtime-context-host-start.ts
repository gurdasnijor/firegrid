// Wave C boundary split (#706 GREEN): private/internal host-side start
// primitive that actually drives the legacy workflow body. This file is
// the new home for the body-driver imports that USED to live in
// `host/commands.ts` and were reachable from BOTH the public turn entry
// AND the reconciler side-effect. That shared identity caused the
// infinite-recursion blocker reported on the failed cutover attempt: when
// the public start becomes channel-observed, the reconciler that
// consumes the request row called back into the same public function,
// which only wrote another request row, and no body ever ran.
//
// The non-recursive split (#706) routes:
//   - public start (declared in `host/commands.ts`) → host-plane channel
//     call + session ingress wait_for;
//   - reconciler side-effect (declared in
//     `host/control-request-side-effects.ts`) → THIS file's
//     `runtimeContextHostStart`, which is the inlined legacy body driver.
//
// This file is INTERNAL: it MUST NOT be re-exported from
// `host/index.ts` or any public package barrel; only
// `host/control-request-side-effects.ts` consumes it. The body-driver
// imports retained here are PARK-relocated quarantine debt — recorded in
// `host-sdk-runtime-import-baseline.json` with the PARK note
// "relocated from public start facade in W-C boundary split; deletion
// paired with body-driver retirement in W-D-A".
//
// Hard bans still apply at the public-facing boundary (NOT this file —
// this file is the private retirement holding pen until W-D-A).

import { WorkflowEngine } from "@effect/workflow"
import {
  requireLocalContext,
  type RuntimeContext,
} from "@firegrid/protocol/launch"
import { Effect } from "effect"
import { executeRuntimeContextWorkflow } from "@firegrid/runtime/kernel"
import {
  RuntimeContextWorkflowNative,
  RuntimeContextWorkflowPayload,
} from "@firegrid/runtime/kernel"
import {
  runtimeContextWorkflowExecutionId,
  runtimeExecutionClock,
} from "@firegrid/runtime/kernel"
import {
  RuntimeContextWorkflowRuntime,
} from "@firegrid/runtime/kernel"
import {
  AgentToolHost,
  type AgentToolHostService,
} from "../../agent-tools/execution/tool-host.ts"
import { runtimeContextWorkflowSupportLayer } from "../runtime-context-workflow-support.ts"
import type { StartRuntimeOptions } from "../types.ts"

// Note: the reconciler-side path doesn't need the
// `awaitContextMaterialized` barrier the public `startRuntime` keeps —
// `RuntimeControlRequestReconcilerLive` only dispatches `SideEffects.start`
// when a `RuntimeControlPlaneTable.startRequests` row materializes, which
// implies the context row was already written. The legacy duplicate of
// `awaitContextMaterialized` removed here was the only difference between
// this private primitive and its public facade ancestor.

const executeRuntimeContextWorkflowForContextId = (contextId: string) =>
  Effect.gen(function*() {
    const engine = yield* WorkflowEngine.WorkflowEngine
    yield* Effect.annotateCurrentSpan({
      "firegrid.context.id": contextId,
      "firegrid.workflow.name": RuntimeContextWorkflowNative.name,
      "firegrid.workflow.execution_id": runtimeContextWorkflowExecutionId(contextId),
    })
    const result = yield* executeRuntimeContextWorkflow(engine, RuntimeContextWorkflowNative, {
      executionId: runtimeContextWorkflowExecutionId(contextId),
      payload: RuntimeContextWorkflowPayload.make({
        contextId,
      }),
    })
    if (result.failure !== undefined) return yield* result.failure
    return result
  }).pipe(
    Effect.withSpan("firegrid.host.runtime_context.workflow.execute", {
      kind: "internal",
      attributes: {
        "firegrid.context.id": contextId,
      },
    }),
    Effect.annotateSpans("firegrid.side", "host"),
  )

const claimAndRunRuntimeContextWorkflow = (
  context: RuntimeContext,
  runtime: RuntimeContextWorkflowRuntime["Type"],
  agentToolHost: AgentToolHostService,
) =>
  Effect.gen(function*() {
    yield* Effect.annotateCurrentSpan({
      "firegrid.context.id": context.contextId,
      "firegrid.runtime.agent": context.runtime.config.agent ?? "",
      "firegrid.runtime.agent_protocol": context.runtime.config.agentProtocol ?? "",
      "firegrid.runtime_context_mcp.enabled":
        context.runtime.config.runtimeContextMcp?.enabled === true,
    })
    return yield* runtime.run({
      context,
      workflowName: RuntimeContextWorkflowNative.name,
      supportLayer: runtimeContextWorkflowSupportLayer(context.contextId, agentToolHost),
      effect: executeRuntimeContextWorkflowForContextId(context.contextId),
      deregisterOnExit: true,
    })
  }).pipe(
    Effect.withClock(runtimeExecutionClock),
    Effect.withSpan("firegrid.host.runtime_context.claim_and_run", {
      kind: "internal",
      attributes: {
        "firegrid.context.id": context.contextId,
      },
    }),
    Effect.annotateSpans("firegrid.side", "host"),
  )

/**
 * Private host-side start primitive. Invokes the workflow body directly.
 * Consumed ONLY by `RuntimeControlRequestSideEffectsLive.start`; never
 * exported via the public host-sdk barrel.
 */
export const runtimeContextHostStart = (
  options: StartRuntimeOptions,
) =>
  Effect.gen(function*() {
    const context = yield* requireLocalContext(options.contextId)
    const runtime = yield* RuntimeContextWorkflowRuntime
    const agentToolHost = yield* AgentToolHost
    return yield* claimAndRunRuntimeContextWorkflow(context, runtime, agentToolHost)
  }).pipe(
    Effect.withSpan("firegrid.host.runtime_context.internal_start", {
      kind: "internal",
      attributes: {
        "firegrid.context.id": options.contextId,
      },
    }),
    Effect.annotateSpans("firegrid.side", "host"),
  )
