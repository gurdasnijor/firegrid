export type ToyRuntimeStatus = "created" | "started" | "exited" | "failed"

export interface ToySessionView {
  readonly contextId: string
  readonly prompt: string
  readonly status: ToyRuntimeStatus
  readonly eventCount: number
}
