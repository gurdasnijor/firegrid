/**
 * Protocol-owned, browser-safe READ VIEWS over runtime control-plane and output
 * rows — the read side of the §12 composition (see
 * docs/cannon/architecture/runtime-design-constraints.md). Pure row projections
 * (filter/derive by contextId), no live resources, so a read-only consumer can
 * follow runtime state without importing host/runtime internals.
 *
 * Callers provide the row source: a live table `.rows()` stream, a finite
 * snapshot stream, or any other projection-safe row stream.
 */
import { Stream } from "effect"
import type {
  RuntimeEventRow,
  RuntimeLogLineRow,
  RuntimeRunEventRow,
} from "./table.ts"
import type { RuntimeContext } from "./schema.ts"

const byContextId = (contextId: string) =>
  (row: { readonly contextId: string }) => row.contextId === contextId

export const runtimeContextsView = (
  contexts: Stream.Stream<RuntimeContext, unknown>,
): Stream.Stream<RuntimeContext, unknown> =>
  contexts

export const runtimeRunsForContextView = (
  runs: Stream.Stream<RuntimeRunEventRow, unknown>,
  contextId: string,
): Stream.Stream<RuntimeRunEventRow, unknown> =>
  runs.pipe(Stream.filter(byContextId(contextId)))

export const runtimeEventsForContextView = (
  events: Stream.Stream<RuntimeEventRow, unknown>,
  contextId: string,
): Stream.Stream<RuntimeEventRow, unknown> =>
  events.pipe(Stream.filter(byContextId(contextId)))

export const runtimeLogsForContextView = (
  logs: Stream.Stream<RuntimeLogLineRow, unknown>,
  contextId: string,
): Stream.Stream<RuntimeLogLineRow, unknown> =>
  logs.pipe(Stream.filter(byContextId(contextId)))
