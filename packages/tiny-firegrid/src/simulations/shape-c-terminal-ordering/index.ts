// Shape C Wave C — terminal-completion ordering sim.
//
// Validates that the ordering gap CC1 hit (public `startRuntime` observes
// `session.agent_output` Terminated before durable `runs.exited` settles)
// is closed by the existing per-session `SessionLifecycleChannel` ingress
// + `RuntimeRunEvent` durable row primitives. See FINDING.md for the
// verdict, cannon C7 anchor, and the exact production change required
// (route registration parity with #703).

export * from "./runtime.ts"
export * from "./public-facade.ts"
