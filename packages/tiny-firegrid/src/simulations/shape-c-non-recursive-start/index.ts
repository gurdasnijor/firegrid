// Shape C Wave C — non-recursive public start facade (sim barrel).
//
// Validates the three-surface decomposition that makes the public start
// path non-recursive over existing primitives:
//
//   public start facade  →  HostSessionsStartChannel.call  (writes startRequest)
//                        →  SessionAgentOutputChannel wait_for (observes terminal)
//
//   reconciler           →  drains startRequests
//                        →  invokes INTERNAL host start side-effect (NOT public)
//
//   internal side-effect →  emits Terminated/Error onto session.agent_output
//                            (NOT a public-facade call)
//
// See `FINDING.md` for the GREEN verdict, production mapping, and the
// recursion-counter / structural recursion-guard tests.

export * from "./runtime.ts"
export * from "./public-facade.ts"
