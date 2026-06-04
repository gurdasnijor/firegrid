# Spike: Validate Channels-As-Transport In firelab (Collapse Edition)

Date: 2026-05-20
Status: dispatchable, 2 cycles wall-clock
Owner: firelab coordinator
Source SDD: `docs/sdds/SDD_FIREGRID_ONE_SUBSTRATE_PRIMITIVE.md`
Validation substrate: `packages/firelab/`
Supersedes: earlier 5-phase 17-sim draft of this same doc
Last amended: 2026-05-20 (Gary's spike review: Source-read 1 promoted to
Cycle 0 pre-gate; Sim 2 grounded in actual current APIs not aspirational
names; Sim 3 explicit durable-row assertions; ergonomic-helpers-as-part-
of-finding rule added per "don't mask SDK gaps")

## The shift in goal

The earlier version of this spike asked: **"does the model hold across all
interaction patterns?"** That produced 17 sims across 5 phases.

The real question is sharper: **"can we delete the parallel-paths grab-bag
in `client-sdk/src/firegrid.ts` AND prove the general abstraction is
strong enough that public surfaces become light surface-specific glue?"**

Reframed that way, most of the original sims fall away:

- **Workflow engine validation drops out entirely** — the workflow engine
  is substrate-internal state machine infrastructure that sits FAR below
  the channel layer. Channels don't need to know how the engine
  implements itself; the channel layer is correct independent of the
  engine's internal table structure. (Removed from spike scope.)
- **Channel direction lowering** is a static property of `channel.ts`;
  verifiable by source-read in 10 minutes, not a sim.
- **External-effect adapter audit** is a grep pass; not a sim.
- **Per-direction equivalence sims** fold into one consolidated
  parallel-paths-collapse sim if it's scoped well.
- **Surface ergonomics / telemetry / error UX** are pre-beta polish, not
  load-bearing for the deletion decision.

What's left is the irreducible question: **can one channel registration
replace N parallel implementations across N surfaces while preserving
behavior?** Three sims answer that.

If the answer is yes, the spike outcome isn't a FINDING — it's a
**deletion PR** that collapses the grab-bag.

## Three sims, two source-reads — total 1-2 days wall-clock

All three sims are parallelizable; can run in three concurrent worker
lanes. **One pre-gate** (Source-read 1, ~30 min) runs before the sims to
confirm the validation assumptions.

## Cycle 0 — Pre-gate (~30 min)

### Source-read 1 — Channel direction lowering + current Tag+Layer shape

**Promote this to Cycle 0** because the sims below assume
`channel.ts` already exposes per-channel `Context.Tag + Layer` services
(the tf-kddg target shape). Current `channel.ts` on main still has
`ChannelInventory` plus channel values; the sims below need to know
whether the target shape has landed before they can assume it.

**Do (~30 min)**:

1. Read `packages/host-sdk/src/host/channel.ts` end-to-end
2. Read `packages/host-sdk/src/host/index.ts` for current channel exports
3. Determine which of these is true:
   - **(A) per-channel Tag+Layer landed**: each channel exposed as
     `Context.Tag` + corresponding Live Layer; `ChannelInventory` is
     either gone or scoped to a thin MCP-string-lookup adapter
   - **(B) tf-kddg partial**: some channels Tag+Layer, some still
     inventory-style — list which
   - **(C) tf-kddg not landed**: still `ChannelInventory`-centric
4. Also verify the four direction binding types map cleanly to
   DurableTable primitive signatures (the static lowering check)

**Gate**:

- If **(A)**: dispatch all three sims immediately
- If **(B)**: dispatch sims against the Tags that exist; flag the
  inventory-residue channels as "Sim N needs Tag+Layer for these channels
  first"
- If **(C)**: **do not dispatch sims**. Spike-prerequisite is tf-kddg
  completion. Document the prerequisite; coordinator dispatches tf-kddg
  finish-line work, then re-runs Cycle 0.

This is the 30-min gate. Don't burn worker-days assuming a Tag+Layer
shape that isn't there.

## Cycle 1 — Three sims, parallelized (~3 hours wall-clock)

### Sim 1 — Parallel-paths collapse (P0, the load-bearing one)

**Question**: can the four current parallel paths for reading agent output
be replaced by ONE channel with no behavior change?

Current parallel paths:
- `session.wait.forAgentOutput` (client-sdk public method)
- `hostProjectionObserver` (host-sdk leak per companion finding 2)
- Direct `RuntimeAgentOutputAfterEvents.forContext` (substrate escape hatch)
- (Implicit) raw `RuntimeOutputTable.events.rows()` queries in tests

**Setup**:
- Compose host + session
- Register `SessionAgentOutputChannel` (ingress)
- Drive a real agent that emits 3 known events
- Read the same stream via all four paths concurrently
- Compare: row counts, event order, span shapes, downstream consumer
  state

**Acceptance — the strong form**:
- All four observers see the same 3 events in the same order
- After confirmation, **rewrite one of the parallel paths to use the
  channel** (e.g., `session.wait.forAgentOutput = (opts) =>
  wait_for(SessionAgentOutputChannel, opts)`)
- Re-run all existing tests that depend on `session.wait.forAgentOutput`
- If all tests pass: **the parallel path is empirically replaceable**

**Verdict**:
- **GREEN**: replaceable. Deletion plan target: drop the duplicate
  implementations, keep one channel + per-surface sugar.
- **FOUND-GAP**: some test exposes a subtle difference. Document the
  exact behavior the legacy path provides; decide whether channel
  binding should match it or whether the test relied on
  implementation-specific behavior.
- **REFUTED**: channel can't reproduce one of the paths. SDD's
  "convergence" claim has a load-bearing hole; revise before proceeding.

**Time-box**: ~3 hours (sim setup + actual rewrite of one path + test
verification)

### Sim 2 — Multi-surface projection equivalence (P0)

**Question**: can the same callable channel be projected as BOTH a typed
client method AND an MCP tool, producing identical substrate operations?

**IMPORTANT — ground in ACTUAL current APIs**, not aspirational names.
Worker must:
1. Identify a real existing client method (e.g.,
   `firegrid.sessions.createOrLoad`, `firegrid.permissions.respond`)
2. Identify a real existing MCP tool projection of that same operation
   from `packages/host-sdk/src/agent-tools/bindings/` and
   `packages/runtime/src/agent-event-pipeline/...` (whichever exposes
   the tool)
3. Confirm both production code paths exist and target the same
   underlying durable substrate operation
4. THEN attempt to express both as projections over ONE channel

Pick a method/tool pair whose underlying substrate path is well-
understood. Recommended candidates (in order of likely cleanness):
- `firegrid.permissions.respond` ↔ MCP `session.permission_respond` tool
  (small surface, clear ack path)
- `firegrid.sessions.createOrLoad` ↔ MCP `session.create_or_load` tool
  (richer; control-plane reconciler-backed)

If neither pair has a current MCP projection, document that as a
finding-relevant gap (it suggests the MCP surface is already a subset
of the client surface, which informs the deletion plan).

**Setup**:
- Pick ONE callable channel (e.g.,
  `HostPermissionRespondChannel` or equivalent target)
- Two projections wired in the sim:
  - **Typed**: the actual current `firegrid.<method>(req)` client-sdk
    method as it exists today
  - **MCP tool**: the actual current MCP tool projection (use real tool
    name + real tool input schema)
- Driver invokes both with the same input in two consecutive runs
- Compare:
  - Resulting rows in the substrate tables actually written
  - Response semantics
  - OTel span graphs (modulo binding-specific wrapper spans)

**Acceptance — the strong form**:
- Both projections write semantically equivalent request rows
- Both observe the same completion rows
- Both return semantically equivalent responses
- Once confirmed, **delete one of the projection implementations** and
  re-wire it as a thin call to the same underlying channel verb
- Existing tests of both projections continue to pass

**Verdict**:
- **GREEN**: multi-surface projection works. Deletion plan target:
  client-sdk methods become thin sugar over `call(channel, req)`; MCP
  tool implementations become thin tool-shaped wrappers. ~80% of the
  duplicate implementation code goes away.
- **FOUND-GAP**: one projection adds behavior the other doesn't.
  Identify which behavior is load-bearing; decide whether it goes into
  the channel binding (so both inherit it) or stays as projection-
  specific glue.
- **REFUTED**: projections can't share a channel. SDD's "projection
  contract" is broken; major revision required.

**Time-box**: ~3 hours

### Sim 3 — Binding-swap isolation + durability preservation (P0)

**Question**: does `Layer.scoped(Channel, alternateBinding)` correctly
swap behavior for the scope while preserving durability invariants?

**Setup**:
- Two sessions: A and B
- `SessionPermissionChannel` callable channel
- Session A: install `autoApprove("allow")` policy via Layer.scoped —
  the binding wraps the default durable responder with a policy that
  pre-fills the decision before the durable write
- Session B: default Layer (no policy install)
- Drive permission requests from both sessions concurrently

**Acceptance — the strong form**:
- Session A's requests auto-approve AND the response row IS persisted
  to the durable substrate (per SDD's corrected autoApprove framing)
- Session B's requests follow default path; same durable persistence
- No cross-session leak (auto-approve in A does not affect B)
- Same channel Tag used in both compositions; only Layer differs

**EXPLICIT durable-row assertions** (don't skip these — they're the
load-bearing proof that the autoApprove framing is correct):

After the sim runs:
- Query the durable response table for session A's session-id-scoped
  rows
- Assert: response row(s) exist with `decision: "Allow"` and correct
  `requestId` matching the permission request(s) the agent issued
- Query the same table for session B's session-id-scoped rows
- Assert: response row(s) exist with whatever decision was made via the
  default path
- Assert: NO response row exists in session B with `decision: "Allow"`
  origin-tagged from session A's auto-approve policy

The point: if the autoApprove binding short-circuits without persisting
the response, replay/audit/cross-host consumers will see a gap. The
SDD's corrected framing says auto-approve is a SCOPED POLICY OVER the
durable write, not a bypass of it. This sim's job is to prove that
distinction is honored in code, not just in prose.

**Verdict**:
- **GREEN**: binding-swap works as the SDD claims. Policy installs and
  test stubs can both safely use the Layer.scoped pattern.
- **FOUND-GAP**: cross-session leak or durability gap. Identify whether
  the SDD's "scoped policy install" framing needs revision OR the
  Layer.scoped semantics need a wrapper.
- **REFUTED**: bindings can't be swapped without rebinding the Tag.
  autoApprove pattern as described in SDD doesn't work; rethink.

**Time-box**: ~2 hours

### Source-read 2 — External-effect adapter inventory (~60 min)

Static analysis pass. Grep for all external-effect call sites across the
monorepo:

- `await fetch(`, HTTP client constructions
- `Effect.tryPromise(` boundaries
- `child_process.spawn`, `Process.start`, sandbox process management
- File I/O outside test/fixture paths
- Direct stream/socket APIs

For each hit:
- Categorize: known adapter (sandbox / codec / webhook ingest / network)
- Confirm location: application-level adapters should be in `packages/runtime/`
  or a named binding-edge projection exception.
- Treat `effect-durable-streams` / `effect-durable-operators` as lower-tier
  substrate transport libraries, not application-level adapter leaks.
- Flag product-layer host/CLI hits outside runtime as boundary violations or
  required explicit exceptions.

Result: a finite catalog of external-effect adapters confirming the
SDD's "small fixed set" claim. Output: a table in the spike roll-up.

Landed result: `docs/research/tf-6w3s-external-effect-adapter-inventory.FINDING.md`.
Verdict: finite set confirmed, with explicit follow-up work for host-sdk
session byte-stream adapters, host-sdk MCP HTTP server placement, and CLI
embedded Durable Stream dev-server lifecycle.

## Two-cycle dispatch

### Cycle 0 (~30 min, single worker)

| Worker | Task | Time-box | Gate |
| --- | --- | --- | --- |
| Pre-gate | Source-read 1 — channel.ts Tag+Layer shape | ~30 min | (A) dispatch all 3 sims · (B) dispatch partial · (C) finish tf-kddg first |

### Cycle 1 (Day 1, ~3 hours wall-clock with 3 parallel workers)

Three workers dispatched in parallel after Cycle 0 gates GREEN:

| Worker | Task | Time-box |
| --- | --- | --- |
| A | Sim 1 — Parallel-paths collapse | ~3h |
| B | Sim 2 — Multi-surface projection equivalence | ~3h |
| C | Sim 3 — Binding-swap isolation + durability | ~2h |

In background (any idle slot):
- Source-read 2 — External-effect adapter inventory (~60 min)

End-of-cycle gate: all three sim verdicts captured. Coordinator
synthesizes implications.

### Cycle 2 (Day 2, ~4 hours)

Based on Cycle 1 verdicts, produce ONE of these three outcomes:

**Outcome A — All GREEN: The Deletion PR**

Coordinator/architect drafts the deletion PR:
- Inventory: which `client-sdk/src/firegrid.ts` methods become thin
  wrappers (~50 lines each → ~3-5 lines each)
- Inventory: which parallel-path duplicates get deleted
  (`hostProjectionObserver`, `FiregridRuntimeTables` exports,
  duplicate `FiregridClientOperations`)
- Inventory: which MCP tool implementations become thin wrappers
- Code-reduction estimate (target: ~50-70% reduction in
  `client-sdk/src/firegrid.ts`; full deletion of escape-hatch exports)
- Refactor sequencing: which deletions can be done independently vs
  must be done together
- Acceptance: existing tests continue to pass; no behavior change

This becomes the dispatch material for the actual lift-and-shift.

**Outcome B — One or more FOUND-GAP: The Carveout Plan**

For each gap, document:
- What exact behavior the legacy path provides that the channel doesn't
- Decide: extend the channel binding to absorb the behavior (preferred)
  OR document as the carveout that stays (acceptable)
- Updated deletion plan: deletion targets minus the carveout

**Outcome C — One or more REFUTED: SDD Revision**

The SDD has a load-bearing hole. Identify exactly which claim is wrong:
- Convergence claim (Sim 1 REFUTED): "channels can replace parallel
  paths" doesn't hold
- Projection contract (Sim 2 REFUTED): "one channel, many surfaces"
  doesn't hold
- Binding-swap pattern (Sim 3 REFUTED): "Layer.scoped binding swap"
  doesn't work

Pause production cutover plan; revise SDD; re-spike the revised claim.

## What success looks like (the deletion PR shape)

If Cycle 1 lands all-GREEN, here's what the resulting deletion PR
should accomplish:

**Files largely deleted or shrunk dramatically**:
- `packages/client-sdk/src/firegrid.ts` (~500 lines → ~150 lines of
  typed sugar)
- `packages/client-sdk/src/operations.ts` (duplicate
  `FiregridClientOperations`) — deleted, replaced by re-export from
  `@firegrid/protocol/session-facade`
- `packages/host-sdk/src/host/projection-observer.ts` and
  `hostProjectionObserver` export — deleted; sims migrate to client
  surface or direct channel use
- `packages/host-sdk/src/host/index.ts` barrel exports of
  `HostRuntimeObservationStreamsLive`, `RuntimeAgentToolExecutionLive`,
  `FiregridRuntimeTables`, etc. — removed (channels expose the
  semantics; substrate Live Layers stay substrate-internal)

**New shape**:
- `client-sdk/src/firegrid.ts`: typed Effect methods that look up
  channel Tag and dispatch via `binding.{stream, append, call}`
- Each method: 1-3 lines
- Net: client-sdk shrinks from grab-bag to projection layer

**Behavior unchanged** (the load-bearing acceptance):
- All existing tests pass
- All existing simulations pass
- Public method signatures unchanged (consumers don't migrate)
- OTel trace shape preserved (modulo channel-layer span additions)

**Deletion confidence is empirically grounded**: each line deleted has a
specific Sim 1/2/3 verdict justifying its removal.

## Why this is enough validation

The user-facing claim of the SDD that needs empirical proof is exactly:
**"channels are general enough to project all current surfaces."**

That claim is verified by:
- Sim 1: proves channels can replace N parallel paths (the convergence
  claim)
- Sim 2: proves channels can project to multiple surfaces simultaneously
  (the projection-contract claim)
- Sim 3: proves channels accept binding swaps (the policy-install /
  test-stub pattern)

Everything else in the original 17-sim plan was either:
- Validating substrate-internal properties (workflow engine, DurableTable
  primitives) that don't affect the channel layer's correctness
- Validating cosmetic/ergonomic properties (telemetry names, type
  ergonomics) that are pre-beta polish
- Re-validating things that fall out as side effects of Sim 1 succeeding

If Sim 1/2/3 land GREEN, **the abstraction is general enough to delete
the grab-bag.** That's the load-bearing outcome.

## What we explicitly DON'T validate (and why it's OK)

**Workflow engine internal structure** — substrate-internal; channels
sit above it; engine's internal table structure doesn't affect channel
correctness. The workflow engine could be reimplemented tomorrow with
different internal tables and the channel layer wouldn't change.

**Performance baselines under production load** — separate concern;
post-deletion perf can be measured against pre-deletion baseline once
the channel layer is in production.

**Multi-host coordination** — single-host sims are sufficient for
proving the abstraction is general; multi-host concerns get their own
validation wave if/when needed.

**Browser/edge transport** — future projection bindings (REST/gRPC) are
not exercised here; their existence is the *promise* of the projection
contract, not a current validation requirement.

**Span naming / type ergonomics / error UX** — surface polish; defer to
pre-beta hygiene wave (per companion assessment Gate D).

**External-effect adapter resilience** — sandbox/codec chaos testing is
a separate operational concern; the audit confirms the boundary is
finite, not that each adapter is bulletproof.

## Dispatch instructions for workers

Each sim follows the established firelab pattern:

```
packages/firelab/src/simulations/spike-channel-deletion/<name>/
  host.ts        — composes the test substrate
  driver.ts      — drives via public client surface or channel verbs
  index.ts       — wires host + driver into defineSimulation
```

Each worker delivers:
- One FINDING.md in `docs/research/` with verdict + cited trace lines +
  deletion implication
- Sim source committed alongside the FINDING
- For Sim 1: also commits the actual rewrite of one parallel path
  (proving the deletion works in code, not just in theory)

Reference patterns from prior validation arcs (INV-1, INV-2, INV-3,
Lane 6): each landed in <60 min of focused worker time. These sims are
~2-3h because each one validates a deletion claim, not just an
abstraction claim — the extra time is the actual rewrite + test
verification.

### Rule: ergonomic helpers are part of the finding, not hidden

If a sim needs new helper code to make the channel model usable (e.g.,
a wrapper that types channel-verb dispatch ergonomically, a `subscribe`
helper for client-side stream consumption, sugar for binding-swap
composition), **that helper IS part of the finding** — committed
alongside the sim, named explicitly in the FINDING, and treated as a
public-API gap to be addressed in the deletion plan.

Do NOT hide ergonomic helpers inside sim-internal utilities. The
purpose: the SDD claims channels are the right transport contract; if
that contract requires helpers to be usable, those helpers ARE part of
the proposed surface and must be visible to reviewers + the eventual
deletion-PR planner.

This preserves the "don't mask SDK gaps" rule established in prior
validation work. The sim's verdict (GREEN / FOUND-GAP / REFUTED) is
about whether the channel substrate works; if it works AND requires
new helpers for usability, that's FOUND-GAP with a clear next-step,
not GREEN-with-hidden-cost.

Concrete: if Sim 1's parallel-path replacement requires a 30-line
typed helper to make `wait_for(SessionAgentOutputChannel, ...)`
ergonomic compared to `session.wait.forAgentOutput(...)`, that helper
goes in the FINDING. The deletion-PR plan in Cycle 2 lists it as a
public-API addition required to make the deletion clean.

## Cycle 2 synthesis output

The coordinator's Cycle 2 deliverable is one of:
- `docs/handoffs/channel-deletion-pr-plan.md` (Outcome A)
- `docs/handoffs/channel-carveout-plan.md` (Outcome B)
- `docs/sdds/SDD_FIREGRID_ONE_SUBSTRATE_PRIMITIVE.md` revision (Outcome C)

In all three cases, the spike concludes in 2 cycles; further work
proceeds from the appropriate document.

## Cost summary

| Phase | Workers | Wall-clock | Output |
| --- | --- | --- | --- |
| Cycle 0 — Source-read 1 pre-gate | 1 | ~30 min | (A/B/C) decision on whether to dispatch sims |
| Cycle 1 — 3 sims parallel | 3 | ~3h (slowest sim) | 3 FINDINGs + 1 demonstration rewrite |
| Cycle 1 — Source-read 2 background | 1 (idle slot) | ~60 min | adapter inventory table |
| Cycle 2 — synthesis | 1 (coordinator/architect) | ~4h | deletion PR plan OR carveout plan OR SDD revision |
| **TOTAL wall-clock** | 3-4 | **~1.5 days** | go/no-go on the deletion lift-and-shift |

If Cycle 0 hits outcome (C) — tf-kddg's per-channel Tag+Layer shape
hasn't landed — the spike pauses; coordinator dispatches tf-kddg
finish-line work first, then re-runs Cycle 0. Adds however long tf-kddg
takes to wrap up; typically 1-3 days based on prior pattern.

vs. the previous 17-sim plan (~3-4 days wall-clock, validating
everything regardless of whether it affected the deletion decision).

The collapse is achieved by:
1. Dropping workflow engine validation (substrate-internal; out of scope)
2. Dropping per-direction sim coverage (folds into Sim 1)
3. Dropping cosmetic validation (defer to pre-beta polish)
4. Reframing each remaining sim as "validate a specific deletion claim"
   rather than "validate an abstraction property"
5. Two source-reads replace four sims (static verification suffices for
   inherent properties)

## Cross-references

- `docs/sdds/SDD_FIREGRID_ONE_SUBSTRATE_PRIMITIVE.md` (post-review
  amendments) — the model being validated
- `packages/host-sdk/src/host/channel.ts` — the four channel directions
- `packages/effect-durable-operators/src/DurableTable.ts` — substrate
  primitive
- `packages/client-sdk/src/firegrid.ts` — current grab-bag, primary
  deletion target
- `packages/firelab/README.md` — sim infrastructure conventions
- `docs/handoffs/sprint-to-private-beta/02-GARY_ARCHITECTURE_ASSESSMENT.md`
  — parallel-paths inventory (input to Sim 1)
- `docs/handoffs/sprint-to-private-beta/02b-COMPANION_ARCHITECTURE_ASSESSMENT.md`
  — surface-hygiene findings (input to source-read 2)
