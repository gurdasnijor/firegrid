// Public events/agent-output subpath.
//
// Logical pipeline position: events/ (the first layer of the pipeline).
// Pure: no Effect, no Layer, no Context.Tag, no I/O. Owns the
// `AgentOutputEvent` union + schema. `RuntimeAgentOutputObservation` is the
// per-context output projection (typed source observation row); it is
// consumed by transforms and Shape C subscribers alongside the raw output
// event union.
//
// Source physically moved from `agent-event-pipeline/events/{contract,output}.ts`
// (`docs/architecture/2026-05-22-runtime-physical-target-tree.md` §events/).

export {
  AgentOutputEventSchema,
} from "./contract.ts"
export {
  type RuntimeAgentOutputObservation,
} from "./output.ts"
