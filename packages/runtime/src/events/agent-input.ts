// Wave 1 forward-target re-export for the AgentInputEvent vocabulary.
//
// Public subpath: `@firegrid/runtime/events/agent-input` (events/ is the first
// pipeline layer in
// `docs/architecture/2026-05-22-runtime-physical-target-tree.md`).
//
// Per the target tree, `events/agent-input.ts` owns the `AgentInputEvent`
// union + schema + the Prompt-backed sub-vocabulary that input rows decode
// into. Today the canonical schema union still lives under the legacy
// `agent-event-pipeline/events/` location and the Prompt sub-schemas come
// from `@effect/ai`; this file is the stable target import path for
// `transforms/` and future subscribers, the physical move follows later.
// Same scaffold pattern as #689 (`tables/runtime-context-state.ts`,
// `subscribers/runtime-context-session/index.ts`).
//
// Surfacing the Prompt vocabulary through events/ keeps `transforms/` import-
// allowed (events + protocol + pure-data effect helpers only) per the
// transforms README purity boundary; transforms must not reach @effect/ai
// directly.

export {
  AgentInputEventSchema,
  type AgentInputEvent,
  AgentPromptSchema,
  AgentToolResultPartSchema,
} from "../agent-event-pipeline/events/contract.ts"

// Prompt-content factories used to construct decoded AgentInput Prompt values.
// Re-exported through events/ so `transforms/` does not depend on @effect/ai
// directly. Pure constructors (no Effect environment).
export {
  textPart as agentPromptTextPart,
  userMessage as agentUserPromptMessage,
} from "@effect/ai/Prompt"
