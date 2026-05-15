import { RuntimeObservationSourceNames } from "@firegrid/runtime/runtime-host"
import { Schema } from "effect"
import {
  DarkFactoryRunSchema,
  DarkFactoryTriggerSchema,
  darkFactoryFactsSourceName,
} from "./tables.ts"

export const PlannerPromptOptionsSchema = Schema.Struct({
  run: DarkFactoryRunSchema,
  trigger: DarkFactoryTriggerSchema,
  providerCapabilities: Schema.Array(Schema.String),
})
export type PlannerPromptOptions = Schema.Schema.Type<
  typeof PlannerPromptOptionsSchema
>

export const buildPlannerPrompt = (
  options: PlannerPromptOptions,
): string => {
  const decoded = Schema.decodeUnknownSync(PlannerPromptOptionsSchema)(options)
  const capabilities = decoded.providerCapabilities.length === 0
    ? "No execute-backed provider capabilities are advertised in this slice."
    : decoded.providerCapabilities.map(name => `- ${name}`).join("\n")
  const linear = decoded.trigger.linear
  const linearFields = linear === undefined
    ? "No Linear fields were supplied."
    : [
      `issueId: ${linear.issueId ?? "unknown"}`,
      `identifier: ${linear.identifier ?? "unknown"}`,
      `url: ${linear.url ?? "unknown"}`,
      `title: ${linear.title ?? "unknown"}`,
      `state: ${linear.state ?? "unknown"}`,
    ].join("\n")

  return [
    "You are the Firegrid dark-factory planner.",
    "",
    "Choreography rule: you own sequencing by reading durable facts and runtime observations, then calling Firegrid tools. Do not assume a hidden DAG or callback URL.",
    "",
    `Factory run key: ${decoded.run.factoryRunKey}`,
    `Planner context id: ${decoded.run.plannerContextId}`,
    `Subscriber id: ${decoded.run.subscriberId}`,
    `Fact source: ${darkFactoryFactsSourceName}`,
    `Runtime observation sources: ${Object.values(RuntimeObservationSourceNames).join(", ")}`,
    `External source: ${decoded.trigger.source}`,
    `External entity key: ${decoded.trigger.externalEntityKey}`,
    `External event key: ${decoded.trigger.externalEventKey}`,
    `Correlation id: ${decoded.trigger.correlationId ?? "none"}`,
    `Repository hint: ${decoded.trigger.repoHint ?? "none"}`,
    "",
    "Linear fields:",
    linearFields,
    "",
    "Advertised execute capabilities:",
    capabilities,
    "",
    "Available Firegrid tools: session_new, session_prompt, wait_for, schedule_me, sleep, and execute only for advertised capabilities. session_cancel/session_close may fail explicitly when the host does not support them.",
    "",
    "Start by producing a concise plan and requesting human approval. Prefer an ACP permission request when your runtime supports it. Otherwise wait_for a durable human approval fact in darkFactory.facts.",
    "When blocked, name the exact durable fact or PermissionResponse that will resume you. After approval, emit the next planner action before delegating work.",
  ].join("\n")
}
