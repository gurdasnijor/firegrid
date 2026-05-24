// Public events/agent-input subpath.
//
// Logical pipeline position: events/ (the first layer of the pipeline).
// Pure: no Effect, no Layer, no Context.Tag, no I/O. Owns the
// `AgentInputEvent` union + schema and the Prompt-backed sub-vocabulary that
// input rows decode into.
//
// Surfacing the Prompt vocabulary through events/ keeps `transforms/` import-
// allowed (events + protocol + pure-data effect helpers only) per the
// transforms README purity boundary; transforms must not reach @effect/ai
// directly.
//
// Source physically moved from `agent-event-pipeline/events/contract.ts`
// (`docs/architecture/2026-05-22-runtime-physical-target-tree.md` §events/).

export {
  AgentInputEventSchema,
  type AgentInputEvent,
  AgentPromptSchema,
  AgentToolResultPartSchema,
} from "./contract.ts"

// Prompt-content factories used to construct decoded AgentInput Prompt values.
// Re-exported through events/ so `transforms/` does not depend on @effect/ai
// directly. Pure constructors (no Effect environment).
export {
  textPart as agentPromptTextPart,
  userMessage as agentUserPromptMessage,
} from "@effect/ai/Prompt"
