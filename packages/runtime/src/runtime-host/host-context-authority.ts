// firegrid-host-context-authority.RUNTIME_CONTEXT_PRIMITIVES.1
// firegrid-host-context-authority.RUNTIME_CONTEXT_PRIMITIVES.2
// firegrid-host-context-authority.RUNTIME_CONTEXT_PRIMITIVES.3
// firegrid-host-context-authority.RUNTIME_CONTEXT_PRIMITIVES.4
// firegrid-host-context-authority.EFFECT_SCOPED_CONTEXT.1
// firegrid-host-context-authority.EFFECT_SCOPED_CONTEXT.2
// firegrid-host-context-authority.EFFECT_SCOPED_CONTEXT.3
//
// The host-context authority surface lives in @firegrid/protocol so
// the public client (@firegrid/client) can resolve host authority
// without depending on @firegrid/runtime. The runtime-host module
// re-exports the same names for code paths that already imported
// from "./host-context-authority.ts".

export {
  ContextNotFound,
  ContextNotLocal,
  CurrentHostSession,
  CurrentHostStopped,
  CurrentRuntimeContext,
  durableStreamUrl,
  findRuntimeContext,
  hostOwnedStreamUrl,
  insertLocalRuntimeContext,
  provideRuntimeContext,
  requireLocalContext,
  runtimeControlPlaneStreamUrl,
} from "@firegrid/protocol/launch"
