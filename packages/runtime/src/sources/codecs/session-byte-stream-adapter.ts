
import type {
  RuntimeContext,
  RuntimeEventRow,
  RuntimeLogLineRow,
} from "@firegrid/protocol/launch"
import { type Effect } from "effect"
import type { AgentOutputEvent } from "../../events/index.ts"
import { type RuntimeContextError } from "../../runtime-errors.ts"

type WriteEffect<Row> = Effect.Effect<Row, unknown>

export interface RuntimeContextSessionOutputWriter {
  readonly appendAgentEvent: (
    context: RuntimeContext, activityAttempt: number, sequence: number, event: AgentOutputEvent,
  ) => WriteEffect<RuntimeEventRow>
  readonly appendEventRow: (context: RuntimeContext, row: RuntimeEventRow) => WriteEffect<RuntimeEventRow>
  readonly appendLogLine: (context: RuntimeContext, row: RuntimeLogLineRow) => WriteEffect<RuntimeLogLineRow>
}

export interface RuntimeRawByteSession {
  readonly context: RuntimeContext
  readonly activityAttempt: number
  readonly ownerSessionId: string
  readonly stdin: WritableStreamDefaultWriter<Uint8Array>
}

export interface RuntimeRawByteSessionStart {
  readonly session: RuntimeRawByteSession
  readonly run: Effect.Effect<void, RuntimeContextError>
}
