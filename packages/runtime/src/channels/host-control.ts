import {
  RuntimeOutputTable,
  type RuntimeControlPlaneTable,
  type RuntimeRunEventRow,
} from "@firegrid/protocol/launch"
import { runtimeAgentOutputObservationFromRow } from "@firegrid/protocol/session-facade"
import type { DurableTableHeaders } from "effect-durable-operators"
import { Effect, Option, Stream } from "effect"
import { runtimeContextOutputTableLayerForContext } from "../tables/output-table-layer.ts"

// tf-bffo: the durable host-control reads (context/run/output snapshot + the
// session-lifecycle run stream) are kernel-internal durable-state behavior and
// live in the runtime. host-sdk only COMPOSES these builders (plus the
// protocol-owned channel factories) into the HostControl channel layer.

export interface HostControlSnapshotConfig {
  readonly durableStreamsBaseUrl: string
  readonly headers?: DurableTableHeaders
}

const runStatusRank = (status: RuntimeRunEventRow["status"]): number =>
  status === "started" ? 0 : status === "failed" ? 1 : 2

const latestRunStatus = (
  runs: ReadonlyArray<RuntimeRunEventRow>,
) =>
  [...runs].sort((left, right) =>
    left.at.localeCompare(right.at) ||
    runStatusRank(left.status) - runStatusRank(right.status)).at(-1)?.status

export const makeHostControlSnapshot = (
  control: RuntimeControlPlaneTable["Type"],
  config: HostControlSnapshotConfig,
) =>
(contextId: string) =>
  Effect.gen(function*() {
    const context = yield* control.contexts.get(contextId)
    const runs = yield* control.runs.query(coll =>
      coll.toArray.filter(row => row.contextId === contextId))
    if (Option.isNone(context)) {
      return {
        contextId,
        runs,
        events: [],
        logs: [],
        agentOutputs: [],
        ...(latestRunStatus(runs) === undefined
          ? {}
          : { status: latestRunStatus(runs) }),
      }
    }
    const [events, logs] = yield* Effect.gen(function*() {
      const output = yield* RuntimeOutputTable
      return yield* Effect.all([
        output.events.query(coll =>
          coll.toArray.filter(row => row.contextId === contextId)),
        output.logs.query(coll =>
          coll.toArray.filter(row => row.contextId === contextId)),
      ])
    }).pipe(Effect.provide(runtimeContextOutputTableLayerForContext(config, context.value)))
    return {
      contextId,
      context: context.value,
      ...(latestRunStatus(runs) === undefined
        ? {}
        : { status: latestRunStatus(runs) }),
      runs,
      events,
      logs,
      agentOutputs: events.flatMap(row => {
        const output = runtimeAgentOutputObservationFromRow(row)
        return Option.isSome(output) ? [output.value] : []
      }),
    }
  })

export const hostSessionLifecycleStream = (
  control: RuntimeControlPlaneTable["Type"],
  sessionId: string,
) =>
  control.runs.rows().pipe(
    Stream.filter(row => row.contextId === sessionId),
  )

// `host-control-routes.ts` deleted per SDD_FIREGRID_PROTOCOL_RESPONSE_
// UNIFICATION phase 2. Channel bindings live in
// `@firegrid/runtime/unified/channel-bindings`.
