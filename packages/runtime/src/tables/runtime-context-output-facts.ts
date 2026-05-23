// Target-tree facade for the per-context output observation source.
//
// SHAPE: C. Lives under `tables/` per the runtime physical target tree
// decision rule (`docs/architecture/2026-05-22-runtime-physical-target-tree.md`,
// Wave 1 Application) — a durable read/tail source over per-context
// output rows belongs in `tables/`, alongside `runtime-context-input-facts.ts`
// (the input-side companion).
//
// This file is a thin re-export shim during the Wave A→2 physical move.
// The Live binding still lives in
// `producers/ingress-writers/per-context-output.ts` until the
// physical move lands; this façade lets `subscribers/runtime-context/`
// reach the per-context observation source through a tree-aligned path
// (per `runtime-subscribers-no-legacy-tree-import` boundary rule —
// subscribers may not import from `agent-event-pipeline/` directly).
//
// Public subpath: `@firegrid/runtime/tables/runtime-context-output-facts`
// can be reserved if an out-of-package consumer needs the per-context
// observation source by tree-aligned subpath. The Live binding stays at
// `host-sdk/src/host/per-context-runtime-output.ts:34`
// (`PerContextRuntimeAgentOutputAfterEventsLive`) — host-sdk composes it
// against `RuntimeHostConfig` + `CurrentHostSession`.

export {
  RuntimeAgentOutputAfterEvents,
} from "../tables/runtime-output.ts"
