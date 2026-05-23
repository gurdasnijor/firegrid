// Kernel barrel — narrowed to its REMAINING SURVIVING SURFACE after the
// body+kernel deletion wave. The retired workflow body, mailbox, engine
// wrapper, dispatcher, checkpoint source/handle, and engine-execute
// helper are all gone (see PR body for the deletion sweep).
//
// IMMEDIATE RETIREMENT BEAD: tf-z8wq — Target-tree amendment: canonical
// homes for durable workflow engine substrate and remaining kernel leaf
// surfaces. Until tf-z8wq picks the canonical home for the surfaces
// below, this barrel and its two leaf files (runtime-host-config.ts,
// runtime-context-helpers.ts) survive as named residue, NOT as
// architectural ownership.
//
// Each export block below lists its exact current consumers (rg-verified).
// Zero-consumer surfaces have been deleted in this PR rather than
// documented (per OLA #726 reviewer directive). New callers should
// prefer the target subpaths named in each block instead of importing
// from `@firegrid/runtime/kernel`.

// -- RuntimeHostConfig Tag (kernel/runtime-host-config.ts) --
// Consumers (1 file, via this barrel):
//   - packages/host-sdk/src/host/config.ts
// Retire: tf-z8wq picks the canonical home for the RuntimeHostConfig Tag,
// then host-sdk/src/host/config.ts retargets and this re-export drops.
export {
  RuntimeHostConfig,
} from "./runtime-host-config.ts"

// -- Session-command Tag re-export (subscribers/runtime-context-session) --
// Consumers (3 files, via this barrel):
//   - packages/host-sdk/src/host/runtime-context-session/common.ts
//   - packages/host-sdk/src/host/runtime-context-session/codec-adapter.ts
//   - packages/host-sdk/src/host/runtime-context-session/raw-adapter.ts
// Retire: tf-z8wq directs callers to import directly from the canonical
// target subpath `@firegrid/runtime/subscribers/runtime-context-session`,
// then this re-export drops.
export {
  RuntimeContextWorkflowSession,
  type RuntimeContextSessionCommand,
  type RuntimeContextSessionCommandAccepted,
  type RuntimeContextSessionStartedEvidence,
  type RuntimeContextWorkflowSessionService,
} from "../subscribers/runtime-context-session/index.ts"

// -- State-store re-export (tables/runtime-context-state) --
// Consumers (2 files, via this barrel):
//   - packages/host-sdk/src/host/runtime-substrate.ts
//   - packages/host-sdk/src/host/per-context-runtime-output.ts
// Retire: tf-z8wq directs callers to import directly from the canonical
// target subpath `@firegrid/runtime/tables/runtime-context-state`, then
// this re-export drops.
export {
  makePerContextRuntimeContextStateStore,
  RuntimeContextStateStore,
} from "../tables/runtime-context-state.ts"

// -- Helpers (kernel/runtime-context-helpers.ts) --
// Consumers (1 file, via this barrel):
//   - packages/host-sdk/src/host/agent-tool-host-live.ts
// Retire: tf-z8wq picks the canonical home for the host-session
// context-resolution helper, then agent-tool-host-live.ts retargets and
// this re-export drops. (`readRuntimeContext` /
// `runtimeContextWorkflowExecutionId` / `runtimeExecutionClock` were
// re-exported here before this rev; all had zero kernel-barrel consumers
// and were deleted from the barrel — they remain available through
// `@firegrid/runtime/workflows` where applicable.)
export {
  requireLocalRuntimeContextWithHostSession,
} from "./runtime-context-helpers.ts"
