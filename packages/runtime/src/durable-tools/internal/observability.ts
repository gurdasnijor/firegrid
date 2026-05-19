import { Schema } from "effect"
import { WaitKeyEncoded, type WaitKey } from "./keys.ts"
import type { WaitRow } from "./table.ts"

export const encodeWaitKey = Schema.encodeSync(WaitKeyEncoded)

// Wait names are constructed as path strings like
//   `runtime-context/<contextId>/<family>/<rest>`
// where `<contextId>` is the per-context base64 (high cardinality) and
// `<family>` is the stable wait family (`output-after`, `agent-output`, …).
// Live traces showed that grouping by `firegrid.wait.name` doesn't cluster
// across contexts because the contextId is baked into the value. Extract a
// `firegrid.wait.family` attribute alongside the full name so backends can
// aggregate the family while still seeing the full identity.
//
// Names that don't follow the `runtime-context/…` path schema fall back to
// the full name as the family — defensible because non-path names tend to
// already be short/stable.
const RUNTIME_CONTEXT_WAIT_PREFIX = "runtime-context/"
const RUNTIME_CONTEXT_WORKFLOW_PREFIX = "runtime-context:"

const waitFamily = (name: string): string => {
  if (!name.startsWith(RUNTIME_CONTEXT_WAIT_PREFIX)) return name
  const segments = name.slice(RUNTIME_CONTEXT_WAIT_PREFIX.length).split("/")
  // segments[0] is the contextId (ctx_ext_<base64>); segments[1] is the family.
  return segments[1] ?? name
}

// Workflow executions are keyed `<workflowName>:<contextId>`. For
// `runtime-context` workflows the part after the colon is a context id, so
// wait spans emitted under the router fiber (which has no workflow scope and
// thus doesn't inherit the workflow's `Effect.annotateSpans` lift) can still
// surface `firegrid.context.id` for filtering. Returns undefined for any
// executionId that doesn't match — non-context workflows simply don't carry
// the attribute.
const contextIdFromExecutionId = (executionId: string): string | undefined =>
  executionId.startsWith(RUNTIME_CONTEXT_WORKFLOW_PREFIX)
    ? executionId.slice(RUNTIME_CONTEXT_WORKFLOW_PREFIX.length)
    : undefined

export const waitKeySpanAttributes = (waitKey: WaitKey): Record<string, unknown> => {
  const contextId = contextIdFromExecutionId(waitKey.executionId)
  return {
    "firegrid.workflow.execution_id": waitKey.executionId,
    "firegrid.wait.key": encodeWaitKey(waitKey),
    "firegrid.wait.name": waitKey.name,
    "firegrid.wait.family": waitFamily(waitKey.name),
    ...(contextId === undefined ? {} : { "firegrid.context.id": contextId }),
  }
}

export const waitSpanAttributes = (wait: WaitRow): Record<string, unknown> => ({
  ...waitKeySpanAttributes(wait.waitKey),
  "firegrid.wait.source": wait.source._tag,
})
