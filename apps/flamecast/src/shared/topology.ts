export interface FlamecastTopology {
  readonly streamUrl: string
  readonly runtimeId: string
  readonly startedAt: string
}

export const defaultTopologyPath = "/topology.json"
