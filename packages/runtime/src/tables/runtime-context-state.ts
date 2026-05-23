// Wave 1 forward-target re-export for `RuntimeContextStateStore`.
//
// Public subpath: `@firegrid/runtime/tables/runtime-context-state`.
//
// Per `docs/architecture/2026-05-22-runtime-physical-target-tree.md`, the
// `RuntimeContextStateStore` capability tag, the per-context Layer factory,
// the `nextOutputObservation` point-read, and the
// `isStateRelevantOutputObservation` relevance predicate are scheduled to
// physically move under `tables/runtime-context-state.ts` in Wave 2. This file
// is the stable host-sdk-facing target for those symbols today; it re-exports
// from the current physical location in `workflow-engine/`.
//
// External consumers (including host-sdk) MUST migrate to this subpath rather
// than continuing to import from `@firegrid/runtime/kernel` or the
// substrate-internal `@firegrid/runtime/workflow-engine`. Both of those are
// barred for new code by the host-sdk import gate; the kernel-barrel
// violations that exist today are baselined as legacy debt.
//
// Wave 2 swaps the source of these symbols to a sibling implementation file in
// this folder. The subpath does not change.

export {
  isStateRelevantOutputObservation,
  makePerContextRuntimeContextStateStore,
  nextOutputObservation,
  type PerContextRuntimeContextStateConfig,
  RuntimeContextStateStore,
  type RuntimeContextStateStoreService,
} from "../workflow-engine/runtime-context-state.ts"
