// Wave B canonical runtime root.
//
// `RuntimeHostLive` is the runtime-owned Layer graph that host-sdk installs
// to bring up the runtime. Per
// `docs/architecture/2026-05-22-runtime-physical-target-tree.md` (Composition
// Boundary) and `docs/architecture/2026-05-22-shape-c-cutover-roadmap.md`
// (§Wave B), this file does Layer/`Context.Tag` wiring ONLY.
//
// Hard rules
// ----------
// composition/ must not define schemas, transitions, handlers, workflow
// bodies, session behavior, or table operations; must not call producer
// append authorities, subscriber handlers, or transition functions inline;
// must not read or write durable tables; must not import any host-sdk
// module. The legacy body-driver symbols, the legacy input mailbox, the
// runtime kernel barrel, and the archive holding pen are all banned at
// lint time. See `packages/runtime/src/composition/README.md` and the
// `firegrid-composition-no-legacy-imports` Semgrep rule for the full
// symbol/path ban list.
//
// composition/ may import target folders only (`events/`, `tables/`,
// `producers/`, `transforms/`, `channels/`, `subscribers/`). Where a target
// folder still re-exports its Layer from a legacy implementation home, the
// re-export lives in that target folder's `index.ts`, NOT here. Composition
// reaches Shape D Layers through `subscribers/<name>/index.ts` shims; it
// does not import legacy substrate paths directly. The dep-cruiser
// folder-direction rules enforce the broader tier topology.
//
// What this root provides
// -----------------------
// Composed from target-shape runtime-owned Layers reached through target
// subpaths only:
//
//   - `tables/runtime-context-input-facts` → `RuntimeContextInputFactsLive`
//     (typed read source over `RuntimeControlPlaneTable.inputIntents`; the
//     greenfield replacement for the per-sequence `DurableDeferred` input
//     mailbox).
//   - `subscribers/runtime-context` → `RuntimeContextSubscriberLive`
//     (Shape C per-event handler; forks `runKeyedDispatch({source:
//     merge(inputs, outputs), handle: handleRuntimeContextEvent})` on host
//     scope at acquisition; the Wave D-A Shape (b) loop body landed in
//     PR #714 + proven by the tiny-firegrid
//     `wave-d-a-shape-b-input-identity-dedup` simulation).
//
// Wave D-A note (PR #714):
// Shape D workflow Layers (`RuntimeToolCallWorkflowLayer`,
// `WaitForWorkflowLayer`, `ScheduledPromptWorkflowLayer`) are wired
// **per-context** via `runtime-context-workflow-support.ts` /
// `toolCallWorkflowSupportLayer` (inside `runtime.run(...supportLayer)`)
// because they require per-context `WorkflowEngine` instances. Including
// them at the host scope here would surface their `WorkflowEngine`
// requirement at a level that has no per-context engine to satisfy it.
// The Wave B composition included them speculatively; D-A's production
// wire-in surfaces the scope mismatch, so the host-level composition root
// now carries only the Shape C subscriber + its typed input source.
//
// What this root requires (filled by host-sdk at composition time)
// ---------------------------------------------------------------
// The root Layer intentionally leaves the following as `R`-channel
// requirements rather than providing them itself:
//
//   - durable substrate tables owned by the protocol
//     (e.g. `RuntimeControlPlaneTable`) — host-sdk wires the
//     `effect-durable-operators` substrate;
//   - `RuntimeContextWorkflowSession` — host-sdk's codec/raw session adapter
//     (the runtime-owned inversion seam for the durable plane; the contract
//     lives at `subscribers/runtime-context-session/`);
//   - `RuntimeToolUseExecutor` — host-sdk wires per agent;
//   - `WorkflowEngine` (from `@effect/workflow`) — host-sdk provides via
//     `DurableStreamsWorkflowEngine` for the justified Shape D layers. The
//     workflow substrate appears here only as an unsatisfied requirement; the
//     Shape C subscriber-runtime composition does not depend on it.
//
// `AgentSession` is intentionally NOT ambient: it is a live codec-scoped
// capability built by `AcpSessionLive` / `StdioJsonlSessionLive` from
// `AgentByteStream`. The host-sdk codec adapter stores it inside
// `CodecRuntimeContextSession` and satisfies `RuntimeContextWorkflowSession`
// against the durable plane. Leaking `AgentSession` into runtime root
// composition would re-introduce the live-codec coupling Shape C explicitly
// removes.
//
// Wave gate
// ---------
// Wave B exit gate (per
// `docs/architecture/2026-05-22-shape-c-cutover-roadmap.md` §Wave B):
//
//   - The runtime root typechecks from semantic target folders.
//   - A focused construction test proves the Layer graph can be built without
//     the old RuntimeContext body path
//     (`packages/runtime/test/composition/host-live.test.ts`).
//
// Public turn proof (Wave C) is NOT a Wave B success criterion and is not
// performed by this file. Host-sdk cutover and a real public turn through the
// new root land in a separate PR.

import { Layer } from "effect"
import { RuntimeContextInputFactsLive } from "../tables/runtime-context-input-facts.ts"
import { RuntimeContextSubscriberLive } from "../subscribers/runtime-context/index.ts"

/**
 * Canonical runtime root Layer for the Shape C target tree.
 *
 * Provided services come from `tables/` and the Shape D workflow seams
 * (with justified workflow machinery). Requirements that remain in the `R`
 * channel (durable substrate, `RuntimeContextWorkflowSession`,
 * `RuntimeToolUseExecutor`, `WorkflowEngine`) are filled by host-sdk at
 * composition time.
 *
 * Use this Layer to install runtime services. Do not call this file's
 * exports directly; reach them through the Layer.
 */
// `provideMerge` so `RuntimeContextInputFactsLive`'s output
// (`RuntimeContextInputFacts`) feeds the subscriber's `RIn`; the merged
// Layer still exposes `RuntimeContextInputFacts` upstream so other
// runtime consumers can resolve it without duplicating the binding.
// The subscriber's remaining requirements (`RuntimeContextRead`,
// `RuntimeContexts`, `RuntimeRunAppendAndGet`,
// `RuntimeAgentOutputAfterEvents`, `RuntimeContextStateStore`,
// `RuntimeContextWorkflowSession`, `RuntimeToolUseExecutor`) stay in the
// merged Layer's `RIn` — host-sdk fulfils them via
// `RuntimeControlPlaneRecorderLive` + per-context state-store /
// session adapter / tool-executor bindings at composition time.
export const RuntimeHostLive = RuntimeContextSubscriberLive.pipe(
  Layer.provideMerge(RuntimeContextInputFactsLive),
)
