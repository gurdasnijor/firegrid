# Lift Candidates — Patterns Sitting In Simulations

Audience: maintainers deciding what to promote into public-facing docs.

The `tiny-firegrid` simulations contain GREEN-verdict patterns that
codify production-load-bearing primitives but are not surfaced as
recipes, runbooks, or ARCHITECTURE.md sections. Each entry below
recommends a target lift — usually a recipe, sometimes an
ARCHITECTURE.md section. Acceptance criterion is the same as
`README.md#how-to-add-a-recipe`.

This list is not exhaustive. Add to it as new simulations land.

## Status (lifts landed in this PR)

| # | Lift | Target | Status |
|---|---|---|---|
| 1 | Wave C dispatch contract | [`docs/recipes/client-sdk-channel-targets.md`](client-sdk-channel-targets.md) | ✓ landed |
| 2 | RuntimeContext fact matrix | [`docs/architecture/runtime-context-fact-matrix.md`](../architecture/runtime-context-fact-matrix.md) + cross-link in `subscribers/runtime-context/README.md` | ✓ landed |
| 3 | Shape D dispatch criterion (MCP-entry tool path) | Section in `subscribers/tool-dispatch/README.md` + cross-link to #8 | ✓ landed |
| 4 | Agent-to-agent observation | [`docs/recipes/agent-to-agent-observation.md`](agent-to-agent-observation.md) | ✓ landed |
| 5 | Channel completion contracts | Section in `channels/README.md` | ✓ landed |
| 6 | Locked tool surface | Section in `subscribers/tool-dispatch/README.md` | ✓ landed |
| 7 | Channel-target indirection (host registry) | Section in `channels/README.md` | ✓ landed |
| 8 | Shape C vs Shape D — full decision table | [`docs/architecture/shape-c-vs-shape-d.md`](../architecture/shape-c-vs-shape-d.md) | ✓ landed |
| 9 | Terminal completion ordering (`SessionLifecycleChannel` vs `Terminated` event) | Section in `channels/README.md` | ✓ landed |
| 10 | Identity-keyed input dedup (Shape B/C handler discipline) | Section in `subscribers/keyed-dispatch/README.md` | ✓ landed |
| 11 | **Unified subscriber kernel — the concept-space collapse** | [`docs/architecture/unified-subscriber-kernel.md`](../architecture/unified-subscriber-kernel.md) + transitional-status note in `shape-c-vs-shape-d.md` | ✓ landed |
| — | **Drift fix:** `docs/recipes/runtime-permission-resume.md` rewritten — was pointing at retired `@firegrid/runtime/durable-tools` / `SourceCollections` / `RuntimeObservationSourceNames` / `agent-event-pipeline` paths. | (recipe rewrite) | ✓ landed |

The entries below remain as the audit derivation for each lift. As new
lift candidates appear, add them to this list with a recommended target
form.

## Deferred — runtime substrate / engine internals

These FINDING.md sims contain valuable patterns but are deeper into
engine substrate semantics than the typical contributor needs to read.
Lift them when a contributor is making changes in the affected layer:

| Sim | Pattern | Suggested target | When to lift |
|---|---|---|---|
| `input-suspend-crash-recovery` | Axis-2 durability gap; `Workflow.suspend` body is NOT re-armed by reconstruction (asymmetric vs `DurableClock.sleep` which IS). | Section in `engine/README.md` referenced from `shape-c-vs-shape-d.md`. | When the engine recovery semantics change. |
| `per-key-subscriber-push-restart` | Per-key subscriber-runtime style (fork-per-fact + per-key mutex) under `DurableTable` over Durable Streams. | Section in `subscribers/keyed-dispatch/README.md`. | When considering an alternative subscriber-runtime style. |
| `tiny-input-append-wakeup` | Atomic input append + wakeup via a single table method; `inputIds` as the idempotency index; dense point-addressed key allocation under concurrent producers. | Section in `tables/README.md` or a dedicated input-table doc when the input table is built. | When the input-table is implemented (#617). |
| `kernel-owned-write-arm` | Host-kernel/controller-owned write+arm pattern for resuming parked table-wait bodies on restart — without driver re-drive and without generic resume-all sweep. | Section in `engine/README.md` or a dedicated table-wait body doc. | When the table-wait body shape lands in production. |
| `shape-c-non-recursive-start` | Three-surface decomposition that prevents recursion in the public start path. | Section in `composition/host-public.ts` callers' README or a dedicated runbook. | When changes touch the start facade. |
| `runtime-context-session-workflow` | Shape D lane that closes two interlocking races on the Shape C session lifecycle. | Section in `subscribers/runtime-context-session/README.md` or a new `subscribers/runtime-context-session-workflow/README.md` once that subscriber lands. | When the Shape D lane lands in production. |
| `loop-state-table` (no FINDING.md) | Durable workflow-owned loop-state row (cursors + pending permission sets) lets skip-output-cursor avoid replay re-walk while permission request/response matching survives reloads. | Section in `subscribers/runtime-context/README.md`. | When the loop-state shape lands in production. |
| `target-architecture-reference` (no FINDING.md) | Phase 0B workflow-owned output append log + durable output cursor + result return; O(outputs) observation. | Reference in `engine/README.md` once the substrate is consolidated. | Substrate consolidation. |
| `delegation-proof-cap4`, `dark-factory`, `durable-channels-sync-async-spike`, `runtime-tool-use-executor-contract`, `tool-result-roundtrip` (no FINDING.md) | Various worked examples and substrate probes. | Review individually if a new contributor area needs an example. | As-needed. |

## High value (recommend lifting next)

### 1. Wave C dispatch contract — client SDK ↔ runtime channel targets

**Sim:** `tiny-firegrid/src/simulations/shape-c-channel-router-turn/FINDING.md`

**Verdict:** GREEN. The FINDING contains a complete mapping table of
every public `firegrid.ts` client method → production `ChannelTarget` +
direction + completion semantics. The author's note: "the mapping table
**is** the Wave C dispatch contract."

**Why lift:** anyone adding a new client method needs to know which
channel targets exist, which directions are available, and how
completion is signalled. Currently the answer requires walking the
client SDK source and grepping for channel constructors. The table makes
it discoverable in one read.

**Target form:** `docs/recipes/client-sdk-channel-targets.md`
(reference-style recipe; the table + a paragraph on how to add a new
target). The simulation is the test that keeps it honest.

### 2. RuntimeContext fact matrix — the per-key subscriber contract

**Sim:** `tiny-firegrid/src/simulations/runtime-context-fact-matrix/FINDING.md`

**Verdict:** GREEN. Tabulates every fact kind that drives RuntimeContext
state (input, output_transition, permission_response, tool_result,
terminal) with its routing key and whether it advances state. Calls out
the rawTextChunk exception explicitly: "UI/telemetry only."

**Why lift:** this is *the* canonical "what makes RuntimeContext tick"
reference. Currently buried in a clean-room proof finding. Any future
contributor who needs to add a new fact kind, or debug why a fact isn't
advancing state, would re-derive the matrix from source.

**Target form:** `docs/architecture/runtime-context-fact-matrix.md` (an
architecture reference, not a recipe — describes invariants, not
wiring).

### 3. Shape D dispatch — when to wrap a tool in a workflow

**Sim:** `tiny-firegrid/src/simulations/shape-d-tool-dispatch-mcp-entry/FINDING.md`

**Verdict:** GREEN (option A). Establishes the criterion that the
existing Shape D `ToolCallWorkflow` + `RuntimeToolUseExecutor` pair is
sufficient for at-most-once MCP-entry tool calls — no new durable
surface required. The finding's note is load-bearing: this is the
decision criterion for *every* future tool added through the MCP path.

**Why lift:** without this, every new tool author asks "do I need a
workflow?" Lifting the answer + the criterion saves the rederivation.

**Target form:** short section in
`packages/runtime/src/subscribers/tool-dispatch/README.md` summarizing
the criterion + linking to the finding for the proof.

### 4. Agent observation through the channel router

**Sims:**
- `tiny-firegrid/src/simulations/agent-coordination-readiness/FINDING.md`
- `tiny-firegrid/src/simulations/child-output-existing-channel-router/FINDING.md`

**Verdict:** GREEN. Documents the agent's path to observing another
agent's output through the existing `HostPlaneChannelRouter.dispatch`.
The patterns cover both `client.wait.forAgentOutput` (public method) and
direct `router.dispatch.waitFor` (router-mediated).

**Why lift:** this is the canonical multi-agent observation pattern. The
INV-5 finding (`inv5-cross-agent-event-choreography`) further documents
the peer-event variant. All three should be lifted together as the
"agent-to-agent comms" recipe.

**Target form:** `docs/recipes/agent-to-agent-observation.md`. Document
the `wait_for` channel + `event(name)` peer-pheromone patterns; link to
the three sims as evidence.

## Medium value (lift when touched)

### 5. Channel completion contracts

**Sim:** `tiny-firegrid/src/simulations/channel-completion-contracts/`
(no FINDING.md — sim itself is the contract test).

**Pattern:** every channel target declares completion semantics
(`terminal` vs `acknowledgement`). The sim asserts the contracts hold.

**Target form:** add a "Completion" section to
`packages/runtime/src/channels/README.md` if not already there.
Reference the simulation as the regression gate.

### 6. Locked tool surface — agentic patterns primitive profile

**Sim:** `tiny-firegrid/src/simulations/agentic-patterns-primitive-profile/`
(no FINDING.md; one-shot vitest at
`test/agentic-patterns-primitive-profile.test.ts` asserts the locked
tool list).

**Pattern:** the runtime-context MCP route exposes a fixed, asserted
set of agent tools. New tools require an explicit gate.

**Target form:** a short addendum in
`packages/runtime/src/sources/codecs/agent-adapters/README.md` (or
wherever the locked surface is enumerated) calling out the gate +
linking the test.

### 7. Inv-4 channel registry shape

**Sim:** `tiny-firegrid/src/simulations/inv4-channel-registry/` (no
FINDING.md).

**Pattern:** how channels register with the host's channel router. The
absence of a finding doc and the presence of a working sim suggest the
pattern is settled but undocumented.

**Target form:** section in `packages/runtime/src/channels/router/`
README (or `channels/README.md`) describing the registration shape +
when to choose `RuntimeContextChannelRouterLive` vs alternative
compositions.

## Process recommendations

- **Make `FINDING.md` standard.** Several high-value simulations (#5,
  #6, #7) have no FINDING.md. Without it the pattern is invisible to
  anyone not already in the sim.
- **Cross-link from runtime source READMEs.** Each runtime folder
  README should link to the simulation(s) that exercise its contract.
  Discoverability dies in silence.
- **Run lift candidates through code review like recipes.** A lift PR
  should: (1) add the recipe/doc, (2) add a cross-link from the
  authoritative source location, (3) reference the sim as the
  regression evidence.

Refs SDD #761 connectors revision (rejected) — the missed channel
primitive there is the canonical example of what happens when valuable
patterns sit only in simulations.
