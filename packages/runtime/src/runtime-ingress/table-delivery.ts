import {
  RuntimeIngressTable,
  makeRuntimeIngressInputRow,
  type RuntimeIngressInputRow,
  type RuntimeIngressRequest,
} from "@firegrid/protocol/runtime-ingress"
import { Effect, Stream } from "effect"
import {
  localProcessStdinDelivery,
} from "../providers/sandboxes/index.ts"
import {
  runtimeIngressError,
  type RuntimeIngressError,
} from "../runtime-host/errors.ts"
import {
  asRuntimeContextError,
} from "../runtime-host/errors.ts"

const nowIso = (): string => new Date().toISOString()

const localProcessIngressSubscriberId = "runtime-context:local-process:stdin"

export const appendRuntimeIngressRequestToTable = (
  request: RuntimeIngressRequest,
): Effect.Effect<RuntimeIngressInputRow, RuntimeIngressError, RuntimeIngressTable> => {
  const program = Effect.gen(function* () {
    const row = makeRuntimeIngressInputRow(request)
    // firegrid-agent-ingress.INGRESS.1
    // firegrid-agent-ingress.INGRESS.3
    // firegrid-agent-ingress.INGRESS.6
    // firegrid-agent-ingress.INGRESS.9
    // firegrid-agent-ingress.HOST.1
    const table = yield* RuntimeIngressTable
    yield* table.inputs.insert(row).pipe(
      Effect.catchAll(() => Effect.void),
      Effect.mapError(cause =>
        runtimeIngressError(
          "append",
          "failed to append runtime ingress durable row",
          row.contextId,
          row.inputId,
          cause,
        )),
    )
    return row
  })
  return program as Effect.Effect<RuntimeIngressInputRow, RuntimeIngressError, RuntimeIngressTable>
}

export const sequenceRuntimeIngressInputs = (
  contextId: string,
) =>
  Stream.repeatEffect(
    Effect.gen(function* () {
      // firegrid-agent-ingress.INGRESS.10
      const table = yield* RuntimeIngressTable
      const rows = yield* table.inputs.query((coll) =>
        coll.toArray.filter(row => row.contextId === contextId),
      )
      const nextSequence = rows.reduce(
        (max, row) => row.sequence === undefined ? max : Math.max(max, row.sequence + 1),
        0,
      )
      const pending = rows
        .filter(row => row.status === "pending")
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
        .at(0)
      if (pending === undefined) {
        yield* Effect.sleep("25 millis")
        return
      }
      yield* table.inputs.upsert({
        ...pending,
        status: "sequenced",
        sequence: nextSequence,
        sequencedAt: nowIso(),
      })
    }),
  )

export const localProcessStdinForRuntimeIngress = (
  contextId: string,
) =>
  localProcessStdinDelivery({
    contextId,
    subscriberId: localProcessIngressSubscriberId,
  }).pipe(
    Stream.mapError(cause =>
      asRuntimeContextError(
        `runtime-ingress.${cause.op}`,
        cause.message,
        contextId,
        cause,
    )),
  )
