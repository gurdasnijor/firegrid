import { Stream } from "effect"
import type {
  RuntimeControlPlaneTableService,
  RuntimeEventRow,
  RuntimeLogLineRow,
  RuntimeOutputTableService,
  RuntimeRunEventRow,
} from "./table.ts"
import type { RuntimeContext } from "./schema.ts"

const byContextId = (contextId: string) =>
  (row: { readonly contextId: string }) => row.contextId === contextId

export const runtimeContextsView = (
  control: RuntimeControlPlaneTableService,
): Stream.Stream<RuntimeContext, unknown> =>
  control.contexts.rows()

export const runtimeRunsForContextView = (
  control: RuntimeControlPlaneTableService,
  contextId: string,
): Stream.Stream<RuntimeRunEventRow, unknown> =>
  control.runs.rows().pipe(Stream.filter(byContextId(contextId)))

export const runtimeEventsForContextView = (
  output: RuntimeOutputTableService,
  contextId: string,
): Stream.Stream<RuntimeEventRow, unknown> =>
  output.events.rows().pipe(Stream.filter(byContextId(contextId)))

export const runtimeLogsForContextView = (
  output: RuntimeOutputTableService,
  contextId: string,
): Stream.Stream<RuntimeLogLineRow, unknown> =>
  output.logs.rows().pipe(Stream.filter(byContextId(contextId)))

export const filterRuntimeRowsForContext = (contextId: string) =>
  byContextId(contextId)
