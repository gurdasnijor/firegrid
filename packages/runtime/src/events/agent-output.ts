// Wave 1 forward-target re-export for the AgentOutputEvent vocabulary +
// RuntimeContext output observation projection.
//
// Public subpath: `@firegrid/runtime/events/agent-output` (events/ is the
// first pipeline layer in
// `docs/architecture/2026-05-22-runtime-physical-target-tree.md`).
//
// Per the target tree, `events/agent-output.ts` owns the `AgentOutputEvent`
// union + schema. `RuntimeAgentOutputObservation` is the per-context output
// projection (typed source observation row); it is consumed by transforms
// and Shape C subscribers alongside the raw output event union.
//
// Today the canonical definitions live in `@firegrid/protocol/agent-output`
// and `@firegrid/protocol/session-facade`, re-exported through the legacy
// `agent-event-pipeline/events/` chain. This file is the stable target
// import path for `transforms/` and future subscribers; the physical move
// follows later. Same scaffold pattern as #689
// (`tables/runtime-context-state.ts`, `subscribers/runtime-context-session/index.ts`).

export {
  AgentOutputEventSchema,
} from "../agent-event-pipeline/events/contract.ts"
export {
  type RuntimeAgentOutputObservation,
} from "../agent-event-pipeline/events/output.ts"
