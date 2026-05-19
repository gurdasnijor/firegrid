# LENSES

Code lenses make standing design decisions, non-obvious patterns, module
boundaries, and known hazards legible **at the point of contact**, so
future work doesn't relitigate decisions or naively "fix" intentional
patterns.

In code, an anchor is one line: `// LENS: <name> — <one-line summary>`.
The detail lives only here. Lenses are not doctrine — where a normative
rule matters it lives in an SDD/RFC and the lens points there. Lenses
coexist with `TFIND-*` anchors (TFINDs = findings; lenses = standing
decisions/implications). Each entry is ≤150 words. `what-would-invalidate`
is required: a lens with no invalidation condition is permanent overhead.

Shapes: **DECISION** (deliberate choice that looks wrong fresh) ·
**PATTERN** (structure to preserve) · **BOUNDARY** (non-obvious contract)
· **HAZARD** (known fragility/verification gap — named, not fixed here).

---

## durable-table:self-curry — PATTERN

**where** `packages/tiny-firegrid/src/effect-durable-operators/DurableTable.ts` — the table-collection factory (`makeMemoryDurableCollectionFacade` on `main`; the keystone PR evolves this to a `<Self>()`-curry form).
**what** The table factory preserves precise *per-table identity* through the provider seam. The keystone-PR direction makes this explicit by currying construction (`<Self>()(...)`), which reads as redundant double-application on purpose.
**why** Closes `Self = any` honestly without per-call `.tag` churn; precise per-table identity must survive the provider boundary (keystone PR / #348 provider seam).
**what-to-do-if-modifying** Preserve per-table identity through the factory. If the curry form has landed, keep the two-step application — collapsing it re-opens `Self = any` and loses identity at the provider boundary.
**what-would-invalidate** The provider seam stops requiring per-table precise identity (e.g. a single coarse table tag is adopted) — identity preservation here is then no longer load-bearing.

## host-sdk:rcws-rin-cycle — DECISION

**where** `packages/host-sdk/src/host/runtime-context-workflow-support.ts` — the "executor MUST stay `provideMerge`d" note.
**what** The workflow executor is `provideMerge`d into the runtime-context-workflow session layer even though the resulting published-and-required (RIN) shape reads like a layer cycle.
**why** The executor needs the captured context relayed across the deferred workflow boundary; separating it broke typing/composition in the keystone PR and #350 (RCWS env). The `provideMerge` is the deliberate resolution.
**what-to-do-if-modifying** Do not "break the cycle" by extracting the executor — that re-introduces the #350/keystone cascade. Changes here are architectural-class and cycle-sensitive.
**what-would-invalidate** The workflow boundary no longer needs relayed context (it is threaded explicitly), making the `provideMerge` removable without the cascade.

## host-sdk:captured-context-relay — PATTERN

**where** `packages/host-sdk/src/host/runtime-substrate.ts` — "captured at Layer-build time and re-provided" note (canonical of 5: also `commands.ts`, `mcp-host.ts`, `runtime-context-workflow-core.ts`, `agent-tools/execution/toolkit-layer.ts`).
**what** Several layers capture the whole ambient context (`Effect.context<T>()`) at build and re-provide it wholesale into a deferred effect. Looks like over-capture; it is a deliberate bulk relay.
**why** The deferred handler runs outside the original context; the relay carries it across that boundary. (S1: these closures are small, ≤28 LOC, pure pass-through — not selective captures.)
**what-to-do-if-modifying** Do not "trim unused tags" from the captured type — the relay passes the whole env through by design; narrowing starves the deferred handler.
**what-would-invalidate** The deferred boundary is removed, or context is threaded explicitly to the handler — the relay is then dead weight.

## client-sdk:intent-not-state — BOUNDARY

**where** `packages/client-sdk/src/firegrid.ts` — `appendRuntimeInputIntent` (runtime-input intent row construction). Contract: `docs/rfc/firegrid-client-runtime-input-intents.md`.
**what** The client SDK writes runtime-input *intents*, not runtime state. Consumers append a durable intent row; the host reconciles it into state. The client never mutates execution state directly.
**why** Decouples client from host execution; the durable intent row is the contract, reconciled host-side (the RFC).
**what-to-do-if-modifying** A client API that writes execution state directly crosses this boundary. Keep client writes intent-shaped; the doctrine is in the RFC.
**what-would-invalidate** The RFC contract changes so the client owns state transitions (the intent/reconcile split is removed).

## host-sdk:mcp-tool-transport-verification-gap — HAZARD

**where** `packages/host-sdk/src/host/mcp-host.ts` — the MCP server composition / tool-exposure transport boundary.
**what** A known verification gap on this transport path: a smoke test claimed to exercise tool calls while producing zero transport activity (the smoke-test-doesn't-test failure). Tests passing here does not guarantee the transport executed.
**why** The test stubbed above the transport; nothing asserted that bytes crossed. Documented as a standing fragility.
**what-to-do-if-modifying** Changes to this path are not covered by transport-level assertions; confirm by observing actual transport activity, not by test-green. (Fix is downstream, not specified here.)
**what-would-invalidate** Transport-level verification (byte/trace assertions) is added to this path's tests — the gap closes.

## runtime:claim-first-effects — PATTERN

**where** `packages/host-sdk/src/host/control-request-reconciler.ts` — reconcile/claim logic. Contract: neutral RFC §13.
**what** The reconciler appends a *claim* durable effect before executing work, and execution effects before terminal — claim-first ordering. The sequence is contractually required, not incidental.
**why** RFC §13 requires claim-before-execution so a crashed or duplicated reconcile is safe (idempotent claim window).
**what-to-do-if-modifying** Preserve the append order (claim → execution → terminal). Reordering for convenience breaks the §13 crash-safety contract.
**what-would-invalidate** §13 is revised, or the substrate adopts an idempotency mechanism that does not depend on append ordering.

## packages:public-vs-internal — BOUNDARY

**where** `packages/host-sdk/src/index.ts` — the public entry. Enforced by the dependency-cruiser package-graph discipline.
**what** A package's contract is its public entry (`@firegrid/<pkg>`), not its internal paths. `import … from "@firegrid/host-sdk/host/…"` reaches past the contract even though it resolves.
**why** Internal paths are refactorable without notice; only the entry is stable. (Calibration A6: 13/15 consumers use the entry.)
**what-to-do-if-modifying** Don't add cross-package imports of internal paths; if an external consumer needs a symbol, export it from the entry.
**what-would-invalidate** The package adopts an explicit multi-entry contract (e.g. a package `exports` map) that makes specific deep paths part of the public surface.
