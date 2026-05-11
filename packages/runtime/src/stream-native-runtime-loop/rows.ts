import {
  RuntimeJournalEventSchema,
  type RuntimeJournalEvent,
} from "@firegrid/protocol/launch"
import { Schema } from "effect"
import {
  runtimeIngressAcceptedRowId,
} from "../runtime-ingress/ids.ts"
import {
  RuntimeIngressAcceptedRowSchema,
  type RuntimeIngressAcceptedRow,
} from "../runtime-ingress/schema.ts"

export const makeRuntimeIngressAcceptedRow = (
  options: {
    readonly contextId: string
    readonly ingressId: string
    readonly subscriberId: string
    readonly provider: string
    readonly acceptedAt: string
  },
): RuntimeIngressAcceptedRow =>
  Schema.decodeUnknownSync(RuntimeIngressAcceptedRowSchema)({
    type: "firegrid.runtime_ingress.accepted",
    id: runtimeIngressAcceptedRowId(
      options.contextId,
      options.subscriberId,
      options.ingressId,
    ),
    at: options.acceptedAt,
    ingressId: options.ingressId,
    contextId: options.contextId,
    subscriberId: options.subscriberId,
    provider: options.provider,
    acceptedAt: options.acceptedAt,
  })

export const runtimeJournalEventFromOutput = (
  options: {
    readonly contextId: string
    readonly activityAttempt: number
    readonly sequence: number
    readonly channel: "stdout" | "stderr"
    readonly raw: string
    readonly receivedAt: string
  },
): RuntimeJournalEvent => {
  const common = {
    contextId: options.contextId,
    activityAttempt: options.activityAttempt,
    sequence: options.sequence,
    receivedAt: options.receivedAt,
    raw: options.raw,
  }

  if (options.channel === "stdout") {
    const event = {
      eventId: `stream-native-runtime-loop:${options.contextId}:stdout:${options.activityAttempt}:${options.sequence}`,
      ...common,
      source: "stdout" as const,
      format: "jsonl" as const,
    }
    return Schema.decodeUnknownSync(RuntimeJournalEventSchema)({
      type: "firegrid.runtime.output.stdout",
      id: event.eventId,
      at: options.receivedAt,
      event,
    })
  }

  const log = {
    logLineId: `stream-native-runtime-loop:${options.contextId}:stderr:${options.activityAttempt}:${options.sequence}`,
    ...common,
    source: "stderr" as const,
    format: "text-lines" as const,
  }
  return Schema.decodeUnknownSync(RuntimeJournalEventSchema)({
    type: "firegrid.runtime.output.stderr",
    id: log.logLineId,
    at: options.receivedAt,
    log,
  })
}
