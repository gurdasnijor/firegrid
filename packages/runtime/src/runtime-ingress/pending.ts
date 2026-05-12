import {
  type RuntimeIngressAcceptedRow,
  type RuntimeIngressRequestedRow,
  type RuntimeIngressRow,
} from "@firegrid/protocol/runtime-ingress"

interface RuntimeIngressSubscriber {
  readonly contextId: string
  readonly subscriberId: string
}

export interface PendingRuntimeIngressState {
  readonly accepted: Set<string>
  readonly pending: Map<string, RuntimeIngressRequestedRow>
}

export const runtimeIngressSubscriberKey = (
  row: {
    readonly contextId: string
    readonly ingressId: string
    readonly subscriberId: string
  },
): string =>
  `${row.contextId}:${row.ingressId}:${row.subscriberId}`

export const emptyPendingRuntimeIngressState = (): PendingRuntimeIngressState => ({
  accepted: new Set<string>(),
  pending: new Map<string, RuntimeIngressRequestedRow>(),
})

export const isRuntimeIngressAcceptedFor = (
  row: RuntimeIngressRow,
  subscriber: RuntimeIngressSubscriber,
): row is RuntimeIngressAcceptedRow =>
  row.type === "firegrid.runtime_ingress.accepted" &&
  row.contextId === subscriber.contextId &&
  row.subscriberId === subscriber.subscriberId

export const isRuntimeIngressRequestFor = (
  row: RuntimeIngressRow,
  contextId: string,
): row is RuntimeIngressRequestedRow =>
  row.type === "firegrid.runtime_ingress.requested" &&
  row.contextId === contextId

export const foldRuntimeIngressProgress = (
  state: PendingRuntimeIngressState,
  row: RuntimeIngressRow,
  subscriber: RuntimeIngressSubscriber,
): void => {
  if (isRuntimeIngressAcceptedFor(row, subscriber)) {
    const key = runtimeIngressSubscriberKey(row)
    state.accepted.add(key)
    state.pending.delete(key)
    return
  }
  if (!isRuntimeIngressRequestFor(row, subscriber.contextId)) return
  const key = runtimeIngressSubscriberKey({
    contextId: row.contextId,
    ingressId: row.ingressId,
    subscriberId: subscriber.subscriberId,
  })
  if (!state.accepted.has(key) && !state.pending.has(key)) {
    state.pending.set(key, row)
  }
}
