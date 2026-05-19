import { Schema } from "effect"
import { WaitKeyEncoded, type WaitKey } from "./keys.ts"
import type { WaitRow } from "./table.ts"

export const encodeWaitKey = Schema.encodeSync(WaitKeyEncoded)

export const waitKeySpanAttributes = (waitKey: WaitKey): Record<string, unknown> => ({
  "firegrid.workflow.execution_id": waitKey.executionId,
  "firegrid.wait.key": encodeWaitKey(waitKey),
  "firegrid.wait.name": waitKey.name,
})

export const waitSpanAttributes = (wait: WaitRow): Record<string, unknown> => ({
  ...waitKeySpanAttributes(wait.waitKey),
  "firegrid.wait.source": wait.source._tag,
})
