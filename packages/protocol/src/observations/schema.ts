export const FiregridRuntimeObservationSourceNames = {
  runtimeRuns: "firegrid.runtime.runs",
  runtimeOutputEvents: "firegrid.runtime.output.events",
  runtimeOutputLogs: "firegrid.runtime.output.logs",
  runtimeIngressInputs: "firegrid.runtime.ingress.inputs",
  runtimeIngressDeliveries: "firegrid.runtime.ingress.deliveries",
  agentOutputEvents: "firegrid.runtime.agent-output-events",
} as const

export type FiregridRuntimeObservationSourceName =
  typeof FiregridRuntimeObservationSourceNames[keyof typeof FiregridRuntimeObservationSourceNames]
