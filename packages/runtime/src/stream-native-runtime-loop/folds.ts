import { HashSet, Option, Stream, type Effect } from "effect"
import type {
  RuntimeIngressRequestedRow,
  RuntimeIngressRow,
} from "../runtime-ingress/schema.ts"

type RuntimeIngressAcceptedRow = Extract<
  RuntimeIngressRow,
  { readonly type: "firegrid.runtime_ingress.accepted" }
>

const deliveredKey = (
  row: {
    readonly contextId: string
    readonly ingressId: string
    readonly subscriberId: string
  },
): string =>
  `${row.contextId}\u0000${row.ingressId}\u0000${row.subscriberId}`

interface PendingIngressOptions {
  readonly contextId: string
  readonly subscriberId: string
}

interface RetainedIngressFacts {
  readonly rowsRead: number
  readonly deliveredKeys: HashSet.HashSet<string>
}

interface PendingIngressSelection {
  readonly first: Option.Option<RuntimeIngressRequestedRow>
  readonly count: number
}

const isDeliveredFor = (
  options: PendingIngressOptions,
) =>
(
  row: RuntimeIngressRow,
): row is RuntimeIngressAcceptedRow =>
  row.type === "firegrid.runtime_ingress.accepted" &&
  row.contextId === options.contextId &&
  row.subscriberId === options.subscriberId

const isRequestedFor = (
  options: Pick<PendingIngressOptions, "contextId">,
) =>
(
  row: RuntimeIngressRow,
): row is RuntimeIngressRequestedRow =>
  row.type === "firegrid.runtime_ingress.requested" &&
  row.contextId === options.contextId

export const retainedIngressFacts = <E, R>(
  rows: Stream.Stream<RuntimeIngressRow, E, R>,
  options: {
    readonly contextId: string
    readonly subscriberId: string
  },
): Effect.Effect<RetainedIngressFacts, E, R> =>
  rows.pipe(
    Stream.runFold(
      {
        rowsRead: 0,
        deliveredKeys: HashSet.empty<string>(),
      } satisfies RetainedIngressFacts,
      (state, row) => ({
        rowsRead: state.rowsRead + 1,
        deliveredKeys: isDeliveredFor(options)(row)
          ? HashSet.add(state.deliveredKeys, deliveredKey(row))
          : state.deliveredKeys,
      }),
    ),
  )

const pendingIngressRows = <E, R>(
  rows: Stream.Stream<RuntimeIngressRow, E, R>,
  options: PendingIngressOptions,
  deliveredKeys: HashSet.HashSet<string>,
): Stream.Stream<RuntimeIngressRequestedRow, E, R> =>
  rows.pipe(
    Stream.filterMap(row =>
      isRequestedFor(options)(row) ? Option.some(row) : Option.none()),
    Stream.filter(row =>
      !HashSet.has(deliveredKeys, deliveredKey({
        contextId: row.contextId,
        ingressId: row.ingressId,
        subscriberId: options.subscriberId,
      }))),
  )

export const selectPendingIngress = <E, R>(
  rows: Stream.Stream<RuntimeIngressRow, E, R>,
  options: PendingIngressOptions,
  deliveredKeys: HashSet.HashSet<string>,
): Effect.Effect<PendingIngressSelection, E, R> =>
  pendingIngressRows(rows, options, deliveredKeys).pipe(
    Stream.runFold(
      {
        first: Option.none<RuntimeIngressRequestedRow>(),
        count: 0,
      } satisfies PendingIngressSelection,
      (state, row) => ({
        first: Option.isSome(state.first) ? state.first : Option.some(row),
        count: state.count + 1,
      }),
    ),
  )
