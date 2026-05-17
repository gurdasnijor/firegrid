import {
  type RuntimeIngressInputRow,
} from "@firegrid/protocol/runtime-ingress"
import { Stream } from "effect"

interface SequencedIngressOrderState {
  readonly nextSequence: number
  readonly pending: Map<number, RuntimeIngressInputRow>
}

const orderSequencedRuntimeIngressRows = <Error, Requirements>(
  rows: Stream.Stream<RuntimeIngressInputRow, Error, Requirements>,
): Stream.Stream<RuntimeIngressInputRow, Error, Requirements> =>
  rows.pipe(
    Stream.mapAccum<SequencedIngressOrderState, RuntimeIngressInputRow, ReadonlyArray<RuntimeIngressInputRow>>(
      {
        nextSequence: 0,
        pending: new Map<number, RuntimeIngressInputRow>(),
      },
      (state, row) => {
        const ordered: Array<RuntimeIngressInputRow> = []
        if (row.sequence === undefined) {
          return [state, ordered] as const
        }
        const pending = new Map(state.pending)
        pending.set(row.sequence, row)
        let nextSequence = state.nextSequence
        while (true) {
          const next = pending.get(nextSequence)
          if (next === undefined) break
          pending.delete(nextSequence)
          ordered.push(next)
          nextSequence += 1
        }
        return [{ nextSequence, pending }, ordered] as const
      },
    ),
    Stream.flatMap(rows => Stream.fromIterable(rows)),
  )

export const sequencedRuntimeIngressRowsForContext = <Error, Requirements>(
  source: Stream.Stream<RuntimeIngressInputRow, Error, Requirements>,
  contextId: string,
): Stream.Stream<RuntimeIngressInputRow, Error, Requirements> =>
  source.pipe(
    Stream.filter(row =>
      row.contextId === contextId &&
      row.status === "sequenced" &&
      row.sequence !== undefined,
    ),
    orderSequencedRuntimeIngressRows,
  )
