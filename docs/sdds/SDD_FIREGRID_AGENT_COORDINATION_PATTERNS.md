# SDD: Agent Coordination Patterns on the Unified Substrate

Status: proposed (review before implementation)
Created: 2026-05-31
Owner: Firegrid Runtime / Architecture
Predecessors:
- `SDD_FIREGRID_UNIFIED_PRODUCTION_WIRING.md`
- `SDD_FIREGRID_UNIFIED_PRODUCTION_CODEC_ADAPTER.md`
- `docs/architecture/2026-05-31-unified-architecture-mental-model.md`
- Deleted prior art: `experiments/agent-coordination-patterns/` (removed in Phase 2 cutover)

## Purpose

Re-deliver the experimental evidence the deleted `agent-coordination-patterns/` experiment was producing — multi-agent coordination patterns (central, choreography, reviewer-revisor) compared against scenarios, with scored outcomes — on the new unified substrate.

Constraint: the deleted experiment was structurally suboptimal. The architecture changed underneath it; rather than restore the old shape and patch the wiring, re-express the experiment cleanly using the unified primitives.

## What was suboptimal about the old design

Reading the deleted code through current architectural lenses, the experiment carried several anti-patterns that the unified substrate makes avoidable:

| Old shape | Why it was suboptimal | What the unified substrate offers instead |
|---|---|---|
| **Host-local MCP for the coordination board** — agents read/write shared state via in-process `mcpChannels` registered on `FiregridLocalHostLive` | Conflates host wiring with experiment app code. Requires a separate MCP protocol round-trip for every state op. Board state isn't durable across host crashes. | Peer events (`UnifiedTable.peerEvents`) are the durable shared-state primitive. `emitPeerEvent` writes a row + optionally signals a parked observer. The board IS the table. |
| **`runtimeContextAcpPermissionPolicy: "allow"`** — global permission bypass for the experiment | A test-only override that doesn't model production; obscures which patterns rely on permission flow vs. ones that don't. | Per-context permission policy carried in `RuntimeContext.runtime.config` (`ProductionCodecAdapterLive` reads it). Each agent's permission posture is part of the scenario, not a global flag. |
| **Custom "coordination board" host service** with bespoke schemas, MCP routing, board-row tables | Each pattern reinvented routing for its own message shapes. Hard to compare patterns when each runs on different infrastructure. | A single peer-event channel (`name: pattern-message`, `eventId: <correlation>`, `payloadJson`) routes between agents. Patterns differ in *body logic*, not infrastructure. |
| **Coordination logic as imperative TypeScript** in scenario files | Couldn't crash-recover. Couldn't be replayed deterministically. No way to share durability semantics with the agents being coordinated. | Each coordination pattern is a `Workflow.make` body. Inherits engine memoization, idempotency, crash recovery, replay. The orchestrator is on the same substrate as the agents. |
| **20k LoC of generated reports/artifacts** committed to source tree (`reports/core-matrix-*/scenarios/.../score.json`) | Source bloat. Reports become stale immediately. No relationship between what's checked in and what re-running produces. | OTel trace.jsonl is the durable evidence. `pnpm trace:seams` is the regression gate. Scoring is computed at run time; one-line summary persists if needed. |
| **Scoring as ad-hoc per-scenario code** | Inconsistent metric semantics across scenarios. Hard to compare patterns. | Scoring is its own `Workflow.make` body keyed by scenario id; observes terminal session results from the journal, computes a typed `ScenarioScore` artifact. |
| **`mcpChannels` option on `FiregridLocalHostLive`** as a host-build-time argument | Couples the experiment's board to host composition. Different scenarios couldn't independently configure their board. | Coordination is per-scenario workflow bodies. Host composition stays generic; nothing about coordination leaks into `FiregridHost`. |

## The cleaner shape

Three architectural decisions drive the new design.

### Decision 1 — Coordination patterns are workflow bodies

A coordination pattern (central, choreography, reviewer-revisor) is a `Workflow.make` body that:

1. Takes a scenario payload (`{ scenarioId, agents, initialPrompt, ... }`).
2. Spawns N session workflows via `firegrid.launch` (one per agent role).
3. Routes inter-agent messages via peer events: when agent A's output should reach agent B, emit a peer event with `name: "${patternId}.message"` and `eventId: "${routeId}"`. Agent B's session body has a peer-event observer that translates inbound peer events into prompts.
4. Awaits the terminal condition (all agents settled, or a leader produces the final artifact).
5. Returns a typed result.

This puts the orchestrator on the same substrate as the agents — same durability, same replay, same idempotency. No separate "host" for the board.

### Decision 2 — Peer events ARE the shared-state primitive

The deleted experiment built a "coordination board" because the prior substrate didn't have a peer-event primitive. The unified architecture does (`UnifiedTable.peerEvents` + `emitPeerEvent` + `PeerEventObserverWorkflow`). Use it directly:

- Shared facts live as peer events keyed by `(name, eventId)`.
- Observers (the coordination workflow + any agent that needs to react) subscribe to a specific `(name, eventId)` and unblock when the event arrives.
- Multi-observer reads are native — every observer sees every event matching its filter.
- Durability and replay are the substrate's, not the experiment's.

No host-local MCP. No board service. The agents themselves don't even need to know they're coordinating — they receive prompts and produce outputs; the coordination workflow routes between them.

### Decision 3 — Scoring as a typed workflow output

Each scenario has a `Score` schema: `{patternId, scenarioId, completedAt, outcome, artifacts: ReadonlyArray<{kind, value}>, metrics: Record<string, number>}`. The coordination workflow returns this. The runner persists the score as a small artifact (one JSON per scenario × pattern, not 20k LoC of fragments).

Comparisons across patterns are computed from the per-scenario scores at report time — no comparison machinery lives in the substrate.

## Architectural decisions

### A. Coordination workflow surface

```ts
export interface CoordinationPayload<ScenarioInput> {
  readonly scenarioId: string
  readonly patternId: string  // "central" | "choreography" | "reviewer-revisor" | ...
  readonly input: ScenarioInput
}

export interface ScenarioScore {
  readonly scenarioId: string
  readonly patternId: string
  readonly completedAtMs: number
  readonly outcome: "success" | "partial" | "failure"
  readonly artifacts: ReadonlyArray<{ kind: string; value: string }>
  readonly metrics: Record<string, number>
}

export interface CoordinationWorkflow<I> {
  readonly workflow: Workflow.Workflow<CoordinationPayload<I>, ScenarioScore, never>
  readonly layer: Layer.Layer<never, never, ...>  // body deps
}
```

One workflow per pattern. The body uses `firegrid.launch + firegrid.prompt + emitPeerEvent + PeerEventObserverWorkflow.execute` — same surface a production application would use, on the same `FiregridHost`.

### B. Agent role declarations

```ts
export interface AgentRole {
  readonly roleId: string        // "coordinator" | "worker" | "reviewer" | "revisor"
  readonly initialPrompt: string
  readonly runtimeConfig: RuntimeConfig  // argv, agentProtocol, mcpServers, envBindings, ...
}
```

A scenario declares its agents up-front. The coordination workflow body iterates the roles, calls `firegrid.launch` per role, retains the contextIds, then orchestrates between them.

### C. Pattern catalog as workflow Layers

Each pattern is a Layer that registers its workflow body. Composition:

```ts
const coordinationPatterns = Layer.mergeAll(
  CentralCoordinatorWorkflowLayer,
  ChoreographyWorkflowLayer,
  ReviewerRevisorWorkflowLayer,
)
const host = FiregridHost({ codec: "acp", ... }).pipe(
  Layer.provide(coordinationPatterns),
)
```

The patterns are pure userland Effect code on top of `FiregridHost`. Nothing in `@firegrid/runtime` knows about coordination — coordination is an *application* of the substrate.

### D. Scenario runner

A small CLI (or sim scenario) takes:
- A list of scenarios (`scenarios.ts`)
- A list of patterns (`patterns.ts`)
- A `FiregridHost` composition
- A score output directory (or stdout)

Runs the matrix, collects scores, prints a comparison table. Optionally writes one JSON per (scenarioId, patternId) score to disk for downstream analysis.

### E. Evidence model

- **OTel trace** is the durable evidence (existing). Adds two new seams:
  - `coordination.pattern.execute` — the pattern's workflow body
  - `coordination.peer-route` — every peer-event-based routing decision
- **Seam coverage** extends to include these. `pnpm trace:seams` catches regressions in pattern execution wiring.
- **Per-scenario scores** are typed values produced by the workflow; the runner emits them. No 20k-LoC report tree.

## Implementation plan

### Phase A — Substrate preconditions (light touches on `@firegrid/runtime`)

Two small things `FiregridHost` needs that aren't there today:

- [ ] **Forward `acpPermissionPolicy` from `RuntimeContext.runtime.config` → `AcpSessionOptions`** in `codec-adapter.ts`. ~10 LoC.
- [ ] **Document the deprecation of host-local `mcpChannels`** — point users at `runtime.config.mcpServers` (URL-based per-context MCP) for any tool a pattern needs to expose to agents. The board pattern uses peer events, not MCP, so this is mostly a docs note.

### Phase B — Coordination workflow primitives (`@firegrid/coordination` package or sim-local)

Lives outside `@firegrid/runtime` — these are application-layer.

- [ ] `CoordinationPayloadSchema`, `ScenarioScoreSchema`, `AgentRoleSchema` in a small `coordination/` module.
- [ ] `routePeerMessage(from, to, content)` helper — wraps `emitPeerEvent` + sets up the `PeerEventObserverWorkflow.execute` on the recipient side. The single primitive every pattern uses.
- [ ] A `coordinator` Firegrid client wrapper that scopes `firegrid.launch + firegrid.prompt + routePeerMessage + awaitAgentTerminal` per scenario.

### Phase C — Pattern catalog (~3 patterns to start)

- [ ] `CentralCoordinatorWorkflow` — one coordinator agent receives all worker outputs, dispatches next-prompt to each worker, terminates on coordinator-says-done.
- [ ] `ChoreographyWorkflow` — agents address each other directly via peer events; coordination workflow only spawns + observes, doesn't route.
- [ ] `ReviewerRevisorWorkflow` — two-role pattern (reviewer, revisor) with a fixed n-round loop.

### Phase D — Scenarios

- [ ] One or two scenarios per pattern, defined as plain Effect values: `{scenarioId, agents, expectedOutcome, scorer}`. Start with the same `review-revision` scenario the deleted experiment had — gives directly-comparable evidence.

### Phase E — Runner + reports

- [ ] `coordination-matrix` sim (or CLI) — runs scenarios × patterns, collects scores, prints a comparison table. Same `unified-kernel-validation` runner pattern (driver + host + Effect-scoped).
- [ ] Add 2 OTel seams to `scripts/trace-seam-coverage.ts`: `coordination.pattern.execute`, `coordination.peer-route`.
- [ ] Score output: one JSON per (scenario, pattern) under `.simulate/runs/<runId>/scores/`. No source-tree pollution.

## Acceptance criteria

1. **Same scenarios produce comparable scores across patterns.** A single `review-revision` scenario can be run through `CentralCoordinatorWorkflow`, `ChoreographyWorkflow`, and `ReviewerRevisorWorkflow`, producing typed `ScenarioScore` values that can be compared.
2. **Patterns are pure userland.** Zero code in `@firegrid/runtime` knows about coordination. The substrate exposes peer events + session workflows; the patterns are built on top.
3. **OTel seam coverage extended.** `coordination.pattern.execute` and `coordination.peer-route` are mandatory seams when the coordination matrix sim runs.
4. **No 20k-LoC reports tree.** Scores live in run directories under `.simulate/runs/<runId>/scores/` and are inspectable as plain JSON. Comparison is computed at report time.
5. **Existing 8/8 + 17/17 + 21/21 (or 22/22) sim acceptance preserved.** The coordination matrix sim is additive; it doesn't perturb the unified-kernel-validation guarantees.
6. **Scores must include explanatory metadata.** `outcome`, `metrics`, `artifacts` — enough that "pattern A scored better than pattern B" is auditable from the score JSON alone.

## Out of scope

- **Real `claude-agent-acp` integration tests.** This SDD's evidence target is "patterns produce scored outcomes." It can use FixtureAgent variants (lifted from prior art) for deterministic results; a separate SDD wires in the live binary if production scoring against real Claude becomes a requirement.
- **Persistent score history / leaderboards.** Scores are per-run JSON. If a long-term trend tracker is needed, it's a separate concern (DB, web UI, etc.) — not architecture.
- **Generic coordination DSL.** Each pattern is a workflow body in TypeScript. No attempt to express patterns declaratively. If patterns explode in number, that's a future refactor question.
- **Resurrecting the deleted experiment's report formats.** The deleted experiment's `manifest.json`, `prompt.md`, `final-artifact.json`, `score.json` tree was over-engineered. New scores are flat JSON. If a downstream tool needs the old format it can be transformed at report time.

## Why this is better than restoring the old shape

The old experiment treated coordination as a host-level concern (mcpChannels, permission policies, board services) coupled to a since-deleted composition layer. Restoring it would resurrect the suboptimal coupling.

The new shape treats coordination as **userland workflow bodies on top of `FiregridHost`** — same substrate, same primitives (signals, peer events, channel router, codec adapter), no special host wiring. Coordination becomes "just another application of Firegrid," which is what the SDD's stated property — "deliver the entire product surface from three primitives" — actually means.

A side benefit: anyone wanting to build a new coordination pattern doesn't have to touch `@firegrid/runtime`. They write a `Workflow.make` body and a Layer. The substrate's job is done.

## Progress log

| Date | Phase | Note |
|---|---|---|
| 2026-05-31 | — | SDD drafted for review. Anti-pattern callouts from deleted experiment recorded; cleaner shape proposed in 3 architectural decisions. No code changes yet — awaiting review before Phase A. |
