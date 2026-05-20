# Companion Architecture Assessment — to Gary's `02-`

Date: 2026-05-20
Assessed main: `7ecaa9102` (`tf-ygz3 Lane D slice 7`, PR #528)
Companion to: `02-GARY_ARCHITECTURE_ASSESSMENT.md`
Cross-referenced against:
- `docs/cannon/architecture/host-sdk-runtime-boundary.md`
- `docs/cannon/sdds/SDD_FIREGRID_AGENT_BODY_PLAN.md`
- `docs/cannon/sdds/SDD_FIREGRID_SCHEMA_PROJECTION_CONTRACT.md`

Update note: this companion has been folded into the consolidated planning
folder at `docs/handoffs/sprint-to-private-beta/architecture/`. Keep this file
as the original architect's independent validation pass and evidence log; route
new work from the consolidated folder.

## How To Read This

This document does NOT replace `02-GARY_ARCHITECTURE_ASSESSMENT.md`. Gary's
assessment is comprehensive and the carveout-list-as-scoreboard framing is
the right operational shape. This companion:

- Validates the load-bearing claims with independent code citations.
- Refines two framings where I'd phrase it differently.
- Adds 8 net findings that I think are missing or under-weighted.
- Names 4 acceptance gates I'd add for private-beta confidence.
- Surfaces 4 open architectural questions Gary leaves implicit.

If Gary's assessment + this companion agree on a recommendation, treat it as
load-bearing. If they disagree (rare in this pass), Gary's is the primary;
this companion explains the alternate read.

## Verdict

**Concur with Gary's 90-93% convergence number for substrate boundary +
guardrails.** I'd assess **closer to 80-85% if we also count public-surface
discipline** (barrel exports, simulation methodology, documentation drift),
which Gary captures as findings but doesn't roll into the convergence
percentage. Both numbers are healthy; the gap between them is the
"surface-API hygiene" debt that becomes the dominant private-beta risk now
that substrate boundary is mostly closed.

## What I Validate From Gary's Assessment

Independent code-citation pass on the load-bearing claims:

| Gary's claim | Verified |
| --- | --- |
| 8-file `currentHostSdkSubstrateDebt` carveout list exact | ✓ `.dependency-cruiser.cjs` matches |
| `runtime-tool-use-executor.ts` misplaced under `subscribers/` | ✓ `packages/runtime/src/agent-event-pipeline/subscribers/runtime-tool-use-executor.ts` exists; per `subscribers/README.md` should be host-scoped observation drivers, but the file defines a Context.Tag for tool dispatch — not a subscriber |
| `runtime` does not import `host-sdk` | ✓ `rg "@firegrid/host-sdk" packages/runtime/src` returns zero |
| `host-sdk` does not import `client-sdk` | ✓ `rg "@firegrid/client-sdk" packages/host-sdk/src` returns zero |
| `hostProjectionObserver` exported as host-sdk barrel API | ✓ `packages/host-sdk/src/host/index.ts:139-142` |
| Workflow definitions live under `packages/runtime/src/workflow-engine/workflows/` | ✓ contains `runtime-control-request.ts`, `runtime-context.ts`, `wait-for.ts`, `tool-call.ts`, etc. |
| Duplicate `FiregridClientOperations` in protocol + client-sdk | ✓ both `packages/protocol/src/session-facade/operations.ts` and `packages/client-sdk/src/operations.ts` exist |
| `RuntimeControlRequestWorkflowEngineLive` + `Reconciler*` exported via host-sdk barrel | ✓ `packages/host-sdk/src/host/index.ts:139, 142` |
| Path C reconciler is now event-driven (table `.rows()` subscription), not 5s polling | ✓ stale `pollIntervalMs` API but no longer drives the loop |
| `runtime-substrate.ts` knot composes observation + tool execution + workflow support + tool-executor tags | ✓ confirmed in source |
| `runtime/ARCHITECTURE.md` is stale (refs `@firegrid/client`, `@firegrid/runtime/runtime-host`) | ✓ file exists and refers to packages that don't match current names |

**Net**: every load-bearing factual claim in Gary's assessment that I
spot-checked verified. The carveout-as-scoreboard frame is operationally
correct.

## Where I'd Refine Two Framings

### Refinement 1: "Channels are not a universal replacement for control APIs" deserves stronger placement

Gary frames this as a "Finding" mid-document. I'd promote it to the
**Architectural Principles** tier alongside the firewall rule. It's the
distinction that prevents the next architecture wave from running aground:

- Channels are an **agent/application surface** abstraction over
  observation, send, and call patterns
- Control-plane operations (`launch`, `session.prompt`, `session.close`,
  permission responses) are **session/control projections** over the same
  substrate
- Both can lower through runtime workflows, durable streams, tables, or
  future engine primitives — but their AGENT-VISIBLE shape is different

Without this principle stated up-front, the natural next-instinct ("every
durable interaction becomes a channel") would push toward
`send(control.table, ...)` as a unifying agent-visible verb, which would
recreate the substrate-leak the body-plan SDD just closed.

Recommend: lift this finding into the canonical boundary doc's "Decision"
section as a sibling principle to "channels are the semantic firewall."

### Refinement 2: Convergence percentage should split substrate vs surface

Gary's 90-93% convergence figure is plausible for the substrate-boundary
firewall. **Public-surface discipline is materially lower** — probably
75-80% — because:

- `host-sdk` barrel still exports `HostRuntimeObservationStreamsLive`,
  `RuntimeAgentToolExecutionLive`, `RuntimeControlRequestWorkflowEngineLive`,
  `RuntimeControlRequestReconcilerDaemonLive`, `hostProjectionObserver`,
  `RuntimeAgentOutputObservation`, `CallerOwnedFactStreams`, and
  codec-adapter helpers
- Simulation methodology doc INSTRUCTS new examples to use
  `hostProjectionObserver` (line 60 of
  `packages/tiny-firegrid/docs/methodology.md`)
- Client-sdk re-exports `FiregridRuntimeTables`,
  `FiregridControlPlaneTableLive`, and `runtimeControlPlaneStreamUrl` as
  public surface
- Protocol README describes protocol as owning "DurableTable declarations"
  and shows direct table imports
- Stale `packages/runtime/ARCHITECTURE.md` describes a package shape that
  no longer exists

The substrate-boundary work is the foundation; surface-hygiene work is the
public face. Both need to be near-done before private beta because **the
public surface is what beta users will build against**. If a beta user
copies `hostProjectionObserver` into their own host composition because
that's what the methodology doc shows, the firewall is rebroken by their
own code with our blessing.

Recommend: report convergence as a **two-number score**:
`substrate-boundary 90-93% / surface-hygiene 75-80%`. The 8-file carveout
list is the scoreboard for the former; a barrel-export audit + methodology
sweep is needed for the latter.

## Net-Additional Findings

### Finding 1: SDD_FIREGRID_AGGRESSIVE_ONE_SUBSTRATE_SWAPOVER missing from cannon

`docs/cannon/architecture/host-sdk-runtime-boundary.md:24` lists the
aggressive-substrate-swapover SDD as a load-bearing input, but
`docs/cannon/sdds/` contains only four SDDs (body-plan, one-substrate,
engine-native-primitives, schema-projection). The aggressive-swapover SDD
is the operational sequencing layer between architecture and refactor
dispatch; its absence from cannon means coordinators routing dispatches
have to reach into the non-cannon `docs/sdds/` for the actual sequencing
guidance.

**Resolution in current cannon pass**: `docs/cannon/README.md` explicitly marks
`SDD_FIREGRID_AGGRESSIVE_ONE_SUBSTRATE_SWAPOVER.md` as historical and
superseded by the landed state plus current convergence assessment. That is
acceptable. If a future coordinator wants it retained as evidence, mirror it
under cannon research/history, not active SDDs.

### Finding 2: Simulation methodology doc is a firewall-violation prescription

`packages/tiny-firegrid/docs/methodology.md:60` reads:

> "should use `hostProjectionObserver` from `@firegrid/host-sdk` when the
> condition..."

This is more than a "harness leak" (Gary's framing). It's a
**documentation-level firewall violation**: the methodology doc actively
teaches the wrong pattern as the recommended approach. Four current sims
follow this guidance:

- `simulations/codex-acp-tool-calls/host.ts`
- `simulations/inv1-stream-zip-body/host.ts`
- `simulations/wait-pre-attach-roundtrip/host.ts`
- `simulations/phase0-wave-2b-stream-zip-restart-replay/host.ts`

Gary mentions two of these; the actual count is four. Each one's continued
use of the documented pattern blocks deleting the `hostProjectionObserver`
export. Each new sim added before the methodology doc is fixed inherits
the same leak.

**Recommend**: fix the methodology doc FIRST (it's blocking the
host-sdk export cleanup), then migrate the four existing sims, then
delete `hostProjectionObserver` from the barrel. Order matters: fixing
the doc first prevents new sims from being added with the leak before
the existing ones are migrated.

### Finding 3: Error types are scattered across the boundary with no contract

The current state of error types crossing the firewall:

- `packages/runtime/src/runtime-errors.ts` defines `RuntimeContextError`
- `packages/runtime/src/runtime-errors.ts` (or similar) defines
  `RuntimeIngressError`
- `packages/host-sdk/src/host/channel.ts` defines `UnknownChannelTarget`
- Various other `Schema.TaggedError` definitions scattered

The canonical boundary doc does not name an error ownership convention.
Per the projection-contract SDD, schemas are protocol-owned — but error
types are schemas too (`Schema.TaggedError`). Current state:

- Some error types live in runtime and are re-exported via host-sdk
  barrel (`RuntimeIngressError` re-exported per `host/index.ts:69`)
- Some live in host-sdk and could leak into runtime if errors flow
  upward via TaggedError handling

**Recommend**: add an explicit "Error types follow the projection
contract: domain error schemas live in protocol; runtime-internal failure
types live in runtime; binding-edge errors (e.g.
`UnknownChannelTarget`) live in the binding package owning that surface"
rule to the canonical boundary doc. Without it, the next refactor wave
will re-litigate error placement file-by-file.

### Finding 4: Telemetry / span names are a defacto public contract

OTel span names appear throughout the codebase as part of the host's
observable behavior. Examples Gary cited in his runner finding:

- `firegrid.agent_event_pipeline.acp.prompt`
- `firegrid.durable_table.rows`
- `firegrid.runtime_context.workflow.*`
- `firegrid.workflow_engine.*`
- `POST /v1/stream/...durableTools` (label-only, not code)

There is no centralized policy for span name ownership or stability.
Effectively:
- Span names that simulations assert against are public contract
  (simulation/runner code names them)
- Span names that operators alert on become public contract by usage
- Span names that change silently break observability without anyone
  noticing

For private beta, **observability is a product feature**. If beta
documentation references specific span names (e.g., "filter for
`firegrid.session.*` spans to debug your session"), those names become
external API. The current state is no policy.

**Recommend**: add a small "Telemetry Naming Contract" doc to cannon
that:
- Names span-name prefix conventions per package (e.g.,
  `firegrid.runtime.*`, `firegrid.host.*`, `firegrid.session.*`)
- Names which prefixes are stable (external contract) vs. internal
  (may change between minor versions)
- Lists span attribute keys that are stable vs. internal

Without this, the surface-hygiene number stays below 80% even after the
barrel exports are cleaned up.

### Finding 5: Schema versioning / migration is unaddressed for private beta

The projection-contract SDD names protocol as the schema source of truth
but does not address schema evolution. Private beta users will land on
whatever schema version ships. The next protocol minor version may add
optional fields, remove deprecated entries, or refactor an operation
catalog. The contract for projection packages handling that version skew
is not stated.

Concrete examples that will recur:
- A new optional field in `RuntimeContextRow`: do client-sdk consumers
  see it as `Schema.optional`? Do they pass it transparently?
- A renamed observation source: do agent-tool bindings still resolve the
  old name for backward compat? For how long?
- A new operation in `FiregridClientOperations`: do older client-sdk
  releases gracefully fall back, or hard-fail?

**Recommend**: add a "Schema Evolution" section to the schema-projection
SDD (or a sibling protocol-versioning doc) that names:
- The version-stability promise of `@firegrid/protocol` for beta
  (probably "additive minor versions only; breaking changes bump major")
- The compat-shim policy at the projection layer (probably "projection
  packages accept N-1 protocol minor versions")
- Migration tooling (codemod? auto-generated migration guide?)

This isn't a hard private-beta blocker, but the answer needs to be in
the user-facing docs before beta or every protocol change becomes a
user-facing coordination event.

### Finding 6: Layer composition ergonomics will regress before they improve

Gary's "Dark-Factory / Consumer Story" section says the top-level
composition shape is preserved. The canonical boundary doc shows:

```ts
const ChannelsLive = Layer.mergeAll(
  LinearWebhookLive(...),
  HumanApprovalChannelLive(...),
)

Layer.mergeAll(
  FiregridRuntimeHostLive(options).pipe(
    Layer.provideMerge(ChannelsLive),
  ),
  FiregridMcpServerLayer(mcpOptions).pipe(
    Layer.provideMerge(ChannelsLive),
  ),
)
```

This is **more complex** than today's typical "pass options to
`FiregridRuntimeHostLive`" pattern. The Layer-composition story is the
correct architectural shape, but it asks beta consumers to:
- Understand `Layer.mergeAll` vs `Layer.provideMerge` semantics
- Know which channel Layers go into which host Layer
- Construct per-channel Layers with the right substrate bindings

For private beta, this is an ergonomics hit at exactly the moment when
first-impression matters most.

**Recommend**: ship one of:
- A `FiregridChannelsLive([...channels])` convenience constructor that
  flattens the merge into options bag shape
- A "channel kit" pattern: `FiregridLinearKit({ webhookSecret })`
  returning a single Layer that contains both the verified-ingest
  substrate binding AND the channel surface
- An explicit cookbook in beta docs showing the canonical composition

The principled shape (per-channel Layers) is right; the unergonomic
shape (Layer.mergeAll + provideMerge dance) is what beta users will see
without intentional ergonomics work.

### Finding 7: Verified-webhook channel sequencing has a schema-placement gap

The canonical boundary doc says verified webhook ingestion splits across
three tiers:
- Signature verification + table writes → runtime
- Channel binding (`Channel<LinearWebhook>`) → host-sdk / app integration
- Stable webhook fact schema "if multiple bindings need it" → protocol

The third row is conditionally placed. For private beta, **the schema
needs to land in protocol BEFORE the first channel binding ships**.
Otherwise:
- The schema lands in host-sdk where the first channel is implemented
- Multiple bindings later (CLI inspector, client-sdk session log
  integration, etc.) each need access
- Cleanup migration becomes "move schema from host-sdk to protocol +
  update all binding consumers" — exactly the duplicate-catalog
  anti-pattern the schema-projection SDD just identified

**Recommend**: stage the Linear webhook trigger work as:
1. Land `LinearWebhookSchema` (or equivalent) in `@firegrid/protocol`
2. Add verified-ingest substrate in runtime that writes rows of that
   schema
3. THEN add the host-sdk `LinearWebhookChannel` binding

NOT:
1. Add LinearWebhookSchema in host-sdk alongside the channel binding
2. Migrate it to protocol later when the second binding lands

Sequencing matters. Gary correctly identifies the placement; this is the
sequencing refinement.

### Finding 8: agent-tools/ package-split risk should be decided, not deferred

The schema-projection SDD names `@firegrid/agent-tools` as a target
projection package (alongside future REST/gRPC/JSON-RPC). Today, those
bindings live in `host-sdk/src/agent-tools/`. The boundary framing
defers the package-split decision.

For private beta, **deferring this decision is fine** — but every
refactor touching `host-sdk/src/agent-tools/` between now and the
eventual decision either:
- Anticipates the split (extra abstraction work for hypothetical future
  shape), OR
- Ignores the split (rewrite later when split happens)

The current ambiguity invites both. Worth a concrete decision:

- **Option A**: agent-tools stays in host-sdk indefinitely (private
  beta + post-beta). Stop treating `@firegrid/agent-tools` as a planned
  package in cannon docs.
- **Option B**: agent-tools splits AFTER private beta lands. Cannon doc
  marks the split as P2 post-beta work. Refactors between now and then
  can ignore the split.
- **Option C**: agent-tools splits BEFORE private beta. Cannon doc
  prioritizes the split as Phase-2 work (between current carveout
  cleanup and beta loop).

**Recommend**: Option B. Reasoning: the schema-projection SDD's
`@firegrid/agent-tools` package is a target shape, not a blocker for
beta correctness. Beta can ship with bindings in host-sdk; post-beta can
extract them as the projection-package convergence concretes. Naming
the decision explicitly prevents over-engineering between now and beta.

## Acceptance Gates I'd Add For Private-Beta Confidence

Gary's Phase 1 acceptance list is solid. Four additions:

### Gate A: Surface-export audit passes

A barrel-export grep that finds:
- Nothing matching `*EngineLive`, `*ReconcilerDaemonLive`,
  `*SubstrateLive` in host-sdk barrels
- Nothing matching `*Observation` types re-exported from runtime
  through host-sdk barrels
- Nothing matching durable-table type/factory exports in client-sdk
  barrels

If the audit finds violations, they go on a tracked debt list with
deletion target dates.

### Gate B: Cannon completeness check

A check that:
- Every SDD referenced in cannon documents is also IN cannon (catches
  Finding 1's missing aggressive-swapover SDD)
- Every package's README points at cannon for canonical architecture
- No package README contradicts cannon framing (catches stale runtime
  ARCHITECTURE.md)

### Gate C: Methodology / examples doc sweep

A check that:
- `packages/tiny-firegrid/docs/methodology.md` does not teach
  substrate-import patterns as recommended
- Public examples (in docs/cookbook/, package READMEs) compose Layers
  via the documented public composition entrypoints, not via
  substrate-internal imports
- Each `@firegrid/*` package's README's "Quick Start" passes the
  firewall test (only imports protocol + own package + sanctioned
  cross-package public surfaces)

### Gate D: Span-name contract baseline

A simple JSON / TS file listing span names that are STABLE EXTERNAL
contract for private beta. Anything not on the list is internal and may
change. Beta docs reference only names on the list. Tests assert that
stable names continue to be emitted by their owning code.

This is the smallest viable telemetry contract; it can grow over time.

## Open Architectural Questions Still Owed

Gary's open-questions list focuses on coordinator hand-off items. Four
architectural decisions Gary's assessment touches but doesn't decide:

### Q1: What's the public-status of `effect-durable-operators`?

The canonical boundary doc treats durable-streams + durable-tables as
substrate. But `effect-durable-operators` is itself a package consumers
can depend on. Is it:
- A Firegrid-private substrate that consumers should never touch directly?
- A Firegrid-built primitive layer with its own public API and
  versioning story?
- A vendor/transitive dependency Firegrid happens to use?

The answer affects whether protocol can re-export `DurableTableHeaders`
(currently does, per `packages/protocol/src/index.ts`), whether client-sdk
should be able to construct `DurableTable` layers (currently can), and
whether docs can teach DurableTable operations as a way to extend
Firegrid.

### Q2: When does session_new_all migration trigger fire?

Gary defers `session_new_all` as P2-optional. The deferral is correct. But
no concrete trigger condition is named. Triggers worth picking:
- N children spawn-per-second in measured factory runs (numeric: 5/sec?)
- M users in beta feedback explicitly request batch primitive
- Per-spawn overhead becomes Z% of session creation latency

Without a trigger, "P2-optional" drifts to "never-built." Either pick a
trigger or explicitly mark as "deferred indefinitely; revisit if X."

### Q3: Is `FiregridRuntimeHostLive` the right surface name post-beta?

Gary's open question 4 in the canonical boundary doc notes the rename
question. The name is misleading once the substrate is fully encapsulated
in runtime — at that point, host-sdk's `FiregridRuntimeHostLive` composes
a runtime host, but the name suggests it IS the runtime host.

Better names worth considering:
- `FiregridLocalHost` (matches deployment topology)
- `FiregridHostComposition` (matches binding role)
- `FiregridHostLive` (drops "Runtime" implying ownership)

For private beta: keep `FiregridRuntimeHostLive` for compatibility. Post-
beta: rename and provide a deprecation alias for one minor version.
Decide now to prevent the next refactor wave from re-litigating.

### Q4: How does Effect-AI version skew interact with `host-sdk`?

`host-sdk` owns the Effect-AI `Tool` / `Toolkit` projection. Effect-AI
ships independently. When Effect-AI changes:
- `Tool.make` signature changes — host-sdk projection breaks
- New Effect-AI primitive lands — does host-sdk wrap it?
- Effect-AI removes a primitive — does host-sdk migrate beta consumers?

For private beta: pin Effect-AI to a known-good version in `host-sdk`'s
peerDependencies. Document the supported Effect-AI version range. Post-
beta: define a compatibility policy.

This is the same shape as Q1 but for an upstream dependency rather than
an internal substrate.

## Sequencing Refinements

Gary's three-phase sequencing (close-invariants → beta-loop → hardening)
is correct in shape. Two refinements:

### Refinement A: Insert a "Surface Hygiene Pass" between Phase 1 and Phase 2

Phase 1's carveout-list ratchet closes substrate-boundary debt. Phase 2's
beta loop introduces new public surface (webhook channel, side-effect
adapters). Between them, do a **surface-hygiene pass**:

- Barrel-export audit (Gate A)
- Cannon completeness check (Gate B)
- Methodology / examples sweep (Gate C)
- Span-name contract baseline (Gate D)
- Delete `hostProjectionObserver` after sim migration
- Collapse duplicate `FiregridClientOperations`
- Update stale `runtime/ARCHITECTURE.md`

Without this pass, Phase 2 adds new public surface on top of un-clean
existing public surface, compounding the hygiene debt.

Time-box: ~2 weeks of focused work. Coordinator dispatch: one lane per
hygiene item, can run parallel where files don't overlap.

### Refinement B: External-trigger work needs schema-first sequencing

Per Finding 7, the Linear verified-webhook trigger work should be
sequenced:

1. **Protocol**: land `LinearWebhookFactSchema` (or equivalent) in
   `@firegrid/protocol`
2. **Runtime**: extend verified-webhook-ingest to write rows of that
   schema (substrate work)
3. **Host-sdk**: add `LinearWebhookChannel` binding (presentation layer
   over the substrate)
4. **App integration**: wire the HTTP route + the channel into a sample
   composition (cookbook entry)

Each step is a separate small dispatch with clear acceptance. Sequencing
1 → 2 → 3 → 4 prevents the schema-in-host-sdk anti-pattern Finding 7
warns against.

## Cross-Validation Against Cannon Documents

### Against `docs/cannon/architecture/host-sdk-runtime-boundary.md`

Gary's assessment fully consistent with the canonical boundary doc. The
"Composition Boundary Rule" (section: "host-sdk is a composition
boundary, not a substrate owner") is the load-bearing principle that
Gary's findings operationalize. No conflicts.

One amendment worth folding into the canonical doc: explicitly state
"channels are not control APIs" as a sibling principle (Refinement 1
above).

### Against `docs/cannon/sdds/SDD_FIREGRID_AGENT_BODY_PLAN.md`

Gary's "Channels Are Not A Universal Replacement For Control APIs"
finding is consistent with the body-plan SDD's distinction between
agent verbs (`wait_for` / `send` / `call`) and session/control
projections (`session.prompt` / `session.start` / etc.).

One discrepancy worth resolving: the body-plan SDD's Channel Inventory
includes `session.self.lifecycle` and `session.log` as channels.
Gary's "appendRuntimeIngress" finding treats session control as
non-channel. These can coexist (session.self.lifecycle is an OBSERVATION
channel; session.prompt is a CONTROL projection) but the distinction
needs to be explicit in the body-plan SDD or readers will conflate them.

### Against `docs/cannon/sdds/SDD_FIREGRID_SCHEMA_PROJECTION_CONTRACT.md`

Gary's "Duplicate Session Operation Catalogs" finding and "Divergent
Projection-To-Substrate Pathways" finding fully align with the
schema-projection SDD's "Convergence acceptance" section. The
schema-projection SDD predicted these exact divergence points; Gary's
finding confirms they materialized.

One addition worth folding into the schema-projection SDD: the
**Schema Evolution** section per Finding 5 above. The SDD names the
target shape but doesn't address version skew handling.

## Summary For Coordinator Routing

If you're routing dispatches from this companion + Gary's, treat them as:

| Dispatch type | Gary's role | This companion's role |
| --- | --- | --- |
| Carveout-list ratchet | primary | confirm count and target |
| Public-surface hygiene | finding-level | adds Gates A/B/C/D as acceptance |
| Webhook trigger sequencing | identifies need | adds schema-first sequencing (Finding 7) |
| Methodology / examples sweep | finding-level | promotes to phase-aligned dispatch (Refinement A) |
| Architectural Q&A | identifies questions | adds Q1-Q4 (durable-ops public status, session_new_all trigger, Live name, Effect-AI version) |
| Cannon completeness | not addressed | identifies missing SDD (Finding 1) |
| Telemetry contract | runner-finding only | promotes to first-class gate (Finding 4 / Gate D) |
| Schema versioning | not addressed | identifies pre-beta need (Finding 5) |

## Net

Gary's assessment is the right operational ground-truth. This companion
adds the surface-hygiene dimension to the convergence number, names eight
findings that strengthen private-beta confidence, surfaces four
architectural decisions that should be made before they're forced, and
proposes a "Surface Hygiene Pass" between Phase 1 and Phase 2.

If both documents are read together by the next coordinator, **the
substrate boundary is close to closed; the public-surface discipline is
the next dominant risk**. Treat the carveout list as the primary
scoreboard, but add the surface-hygiene gates as second-order acceptance
before beta ships.

---

Cross-references:
- `docs/handoffs/sprint-to-private-beta/02-GARY_ARCHITECTURE_ASSESSMENT.md`
- `docs/cannon/architecture/host-sdk-runtime-boundary.md`
- `docs/cannon/sdds/SDD_FIREGRID_AGENT_BODY_PLAN.md`
- `docs/cannon/sdds/SDD_FIREGRID_SCHEMA_PROJECTION_CONTRACT.md`
- `.dependency-cruiser.cjs` — `currentHostSdkSubstrateDebt` (scoreboard)
- `packages/tiny-firegrid/docs/methodology.md:60` — leak-prescription evidence
