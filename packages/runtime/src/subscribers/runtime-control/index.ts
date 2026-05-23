// Public subpath: `@firegrid/runtime/subscribers/runtime-control`.
//
// Wave (runtime-session move): the `RuntimeControlRequestSideEffects`
// Live implementation that previously lived at
// `packages/host-sdk/src/host/control-request-side-effects.ts` moved
// here. It is a runtime concern (it composes runtime-owned
// `RuntimeContextRead` + `RuntimeRunAppendAndGet` + the
// `RuntimeContextWorkflowSession` seam + the
// `PerContextRuntimeOutputWriter` runtime Tag), not a host-sdk concern.
// Host-sdk composes the Layer through the public subpath; it does not
// own the Effect body.

export { RuntimeControlRequestSideEffectsLive } from "./control-request-side-effects.ts"
