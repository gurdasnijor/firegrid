import {
  runtimeAuthoritySourceName,
  type RuntimeAuthoritySourceName,
} from "../events/index.ts"

export const RuntimeAuthoritySourceNames = {
  runtimeContexts: runtimeAuthoritySourceName("firegrid.runtime.contexts"),
  runtimeRuns: runtimeAuthoritySourceName("firegrid.runtime.runs"),
  runtimeOutputEvents: runtimeAuthoritySourceName("firegrid.runtime.output.events"),
  runtimeOutputLogs: runtimeAuthoritySourceName("firegrid.runtime.output.logs"),
  runtimeIngressInputs: runtimeAuthoritySourceName("firegrid.runtime.ingress.inputs"),
  runtimeIngressDeliveries: runtimeAuthoritySourceName("firegrid.runtime.ingress.deliveries"),
  durableWaits: runtimeAuthoritySourceName("firegrid.runtime.durable-tools.waits"),
  durableWaitCompletions: runtimeAuthoritySourceName("firegrid.runtime.durable-tools.completions"),
  agentOutputEvents: runtimeAuthoritySourceName("firegrid.runtime.agent-output-events"),
} as const
export type { RuntimeAuthoritySourceName }
