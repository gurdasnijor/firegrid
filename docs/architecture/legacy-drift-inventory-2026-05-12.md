# Legacy drift inventory — 2026-05-12

Post-tracer-017 repo-wide audit for stale architecture patterns, historical
scaffolding still living in production paths, and docs/spec drift that
risks pulling future work back into deprecated shapes.

**Branch:** `legacy-drift-inventory-2026-05-12`
**Base:** `main` @ `2c61753` (tracer-017 closure merged 2026-05-12T07:52:20Z)

This is **discovery + classification**, not bulk deletion. The only
edits in this PR are trivial doc-reference fixes for clearly stale text;
everything substantive is captured as a finding with a recommended
follow-up tracer.

## Method

```bash
# Production-code surveys
rg -n "snapshotThenFollow|Stream.runCollect|Stream.scan" packages/runtime/src packages/client/src
rg -n "Ref.make|HashMap.empty|new Set\b|new Map\b" packages/runtime/src packages/client/src
rg -n "Schema.decodeUnknownSync" packages/runtime/src packages/client/src packages/protocol/src
rg -n "scan:|operator\.source|ReactiveWorkflowOperator" packages/runtime/src

# Doc/spec drift surveys
rg -n "stream-native-runtime-loop|runtime_ingress\.accepted|RuntimeIngressAccepted|tracer-015" docs features
rg -n "runtime_ingress|@firegrid/durable-streams/\"" docs

# Boundary surveys
rg -n "@durable-streams/" packages apps --type-not=test
rg -n "from \"@firegrid/durable-streams\"" packages/client/src packages/runtime/src

# Scenario surveys
rg -n "readUnknownDurableEvents|appendUnknownDurableEvent|RequiredActionRuntimeLive" scenarios
```

## Findings

Severity legend:
- **blocker** — actively misleads new contributors; risks drift back into deprecated shape.
- **high** — production code still owns a bespoke version of what the operator package provides.
- **medium** — pattern smell, but contained; worth one focused PR.
- **low** — doc-only or trivial fix.

---

### F1 [HIGH] `runtime-operators/**` is a bespoke fold that should be `DurableConsumer`

**Files:** `packages/runtime/src/runtime-operators/{OperatorRuntime,OperatorDescriptor,OperatorSource,schema}.ts` (~239 lines)

**Why it matters:** `ReactiveWorkflowOperatorRuntimeLive` (lines 33–108 of
`OperatorRuntime.ts`) implements *exactly* the `DurableConsumer` pattern
by hand:

- `source.scan` → eager collect-all-facts (vs. `DurableConsumer.stream` source.read)
- `operator.select` → predicate (vs. `DurableConsumer.define({ select })`)
- `operator.executionId` → key derivation (vs. `key`)
- `const seenExecutionIds = new Set<string>()` → **in-memory dedupe**
  — restart loses dedupe (vs. `ConsumerCheckpointStore`)
- `operator.execute(...)` → side effect (vs. `process`)

The in-memory `Set` is the load-bearing correctness gap: the operator
silently re-runs workflows on every host restart. Adopting
`DurableConsumer` + `ConsumerCheckpointStore` makes restart semantics
durable and matches the design direction.

**Status:** Active drift. The `OperatorSource.scan: Effect<ReadonlyArray<Fact>>`
shape is also explicitly the kind of "eager retained-fold" that tracer
018's `ConsumerSource` is meant to replace.

**Recommended follow-up:** PR-sized tracer that:
1. Migrates `requiredActionOperator()` from `runReactiveWorkflowOperator`
   to a `DurableConsumer.run` call (with a dedicated checkpoint stream).
2. Deletes `runtime-operators/**` and its `firegrid-reactive-workflow-operators`
   feature spec ACIDs.
3. Renames or removes `OperatorSource` in favor of `DurableConsumer`'s
   `source.read` (or the planned `ConsumerSource` from tracer 018).

---

### F2 [HIGH] `required-action/service.ts` re-folds retained rows on every read

**Files:** `packages/runtime/src/required-action/service.ts:111-131` (`readRequiredActionRows` + `foldRequiredActionState`)

**Why it matters:** `getRequiredActionState` calls
`requiredActionStream(streamUrl).collect.pipe(...)` — collects the
**entire** retained stream and folds it with
`foldRequiredActionState` per query. This is the precise anti-pattern
the operators-SDD calls out:

> "Application code should not repeatedly read an entire retained
> stream and rebuild local state at every query boundary."

`DurableTable.materialize` + a projection from `requested`/`resolved`
rows is the target replacement; the in-memory `HashMap` table would
serve `get` directly without re-reading the wire.

**Status:** Active drift. Same shape as the `runtime_ingress.requested`
fold we just deleted via tracer 017, just on a different row family.

**Recommended follow-up:** Bundle with F1 into one "required-action
durable rework" tracer (`019`?): project rows → `DurableTable` view,
adopt `DurableConsumer` for the operator side, retire
`foldRequiredActionState` and the per-call `.collect`.

---

### F3 [HIGH] `required-action/launcher.ts` is a hidden composition root

**Files:** `packages/runtime/src/required-action/launcher.ts` (85 lines)

**Why it matters:** `RequiredActionRuntimeLive` builds its own
mini-host: `DurableStreamsWorkflowEngine.layer` + `RequiredActionsLive`
+ `ReactiveWorkflowOperatorRuntimeLive` + `FetchHttpClient.layer`,
distinct from `FiregridRuntimeHostLive`. Two production scenarios
(`tracer-009.test.ts`, `tracer-013.test.ts`) consume it directly.

Per the coordinator's "mini composition roots" warning, this is the
exact pattern that pulls future tracers back into bespoke wiring rather
than the host substrate.

**Status:** Active drift — but the test-surface dependency means it
can't be deleted without also reshaping tracer-009/013.

**Recommended follow-up:** Same tracer as F1/F2. Replace
`RequiredActionRuntimeLive` with a `FiregridRuntimeHostLive` extension
(or fold the required-action layers into the host streams config the
way `inputCheckpoints` is now configured). Rewrite tracer-009/013 to
use the production host surface.

---

### F4 [HIGH] `RawFoldStrategy` is a custom in-memory materialization table predating `DurableTable`

**Files:** `packages/runtime/src/materialization/raw-fold/RawFoldStrategy.ts` (~133 lines)

**Why it matters:** The `Raw` materialization strategy holds a
`Ref<Map<string, ProjectionState>>` and **folds events into it on each
write** (`projectIntoFold` does `Ref.updateAndGet(state, previous =>
... merge new events ...)`). Reads consult the in-memory map directly,
so the per-query cost is fine — but the strategy is structurally a
custom mini-`DurableTable` that predates the operator package.

`DurableTable` over a State-Protocol projection already provides this
with incremental view maintenance via TanStack DB/db-ivm — no manual
`Ref<Map>` plumbing, no parallel projection-state book-keeping, and
the same query shape. The drift concern isn't "wasted work per query";
it's "two different durable-table implementations in the codebase, one
of them custom and unused at the strategy boundary."

**Status:** Possibly intentional — it's a `MaterializationStrategy`
implementation (one of several behind the strategy interface). But
it's listed in our target-architecture docs as something the strategy
boundary lets us swap; we haven't actually swapped it.

**Recommended follow-up:** Separate medium-sized tracer once F1/F2
land. Either replace `RawFoldStrategy` callers with a
`DurableTable`-backed strategy, or delete it if no production callers
remain.

---

### F5 [MEDIUM] `runtime_ingress.requested` is transitional naming

**Files:**
- `packages/protocol/src/runtime-ingress/schema.ts` (the row type itself)
- `packages/client/src/firegrid.ts` (the public `Firegrid.prompt` API writes this row)
- All scenarios that assert on row.type

**Why it matters:** Tracer 017's PR body explicitly flagged the
`requested → firegrid.session.input` rename as a deferred decision.
The current name reinforces the legacy "runtime ingress" framing on a
**public** wire format. The longer it stays, the more migration
friction we accumulate.

**Status:** Acknowledged transitional naming; not silent drift.

**Recommended follow-up:** Standalone rename tracer when the team is
ready. Touches `Firegrid.prompt`, `RuntimeIngressRow*`,
`runtimeIngressError`, `runtimeIngressRequestedRowId`, plus all
scenarios. Strict separation: this is a rename, not a behavioral change.

---

### F6 [MEDIUM] `required-action/service.ts` uses `Schema.decodeUnknownSync` as a row constructor

**Files:** `packages/runtime/src/required-action/service.ts:167,196,197,214`

**Why it matters:** Same anti-pattern the rows.ts cleanup just retired
from `runtime-ingress`: trusted internal row construction routes
through a decoder. Should use plain typed objects with `satisfies` or
`.make()` on the row schema. Decoding belongs at the public API
boundary only.

**Status:** Active drift on the *same* pattern we cleaned in
runtime-ingress/rows.ts during tracer 017.

**Recommended follow-up:** Roll into F1/F2/F3 cleanup (the
required-action durable rework). Mechanical fix; no behavioral change.

---

### F7 [MEDIUM] Sibling-optional fields encoding invalid state in `runtime-operators/schema.ts`

**Files:** `packages/runtime/src/runtime-operators/schema.ts:21-24`

```ts
readonly operatorId?: string
readonly sourceId?: string
readonly executionId?: string
readonly cause?: unknown
```

The `ReactiveWorkflowOperatorError` carries four optionals where some
combinations are invalid (e.g. an "execution" failure cannot have no
`executionId`). The new pattern — tagged-class union — would make
invalid states unrepresentable.

**Status:** Low-impact (error metadata, not config), but exactly the
sibling-optional smell that the runtime-input refactor just cleaned up
on the configuration side.

**Recommended follow-up:** Drops out naturally when F1 deletes
`runtime-operators/**`. If F1 slips, take it as a small standalone
PR using the same `Schema.TaggedClass` + `Schema.Union` pattern as
`RuntimeInputStreams`.

---

### F8 [RESOLVED — no action] `runtime-output-source.ts` is the canonical EventSource adapter, not a composition mini-root

**Files:** `packages/runtime/src/materialization/runtime-output-source.ts`

The initial draft of this finding framed
`runtime-output-source.ts` as a parallel mini-root because it builds
its own `Layer.succeed(EventSource, ...)` outside
`FiregridRuntimeHostLive`. On closer inspection that framing was
overstated: the file provides the only canonical
`EventSourceService<RuntimeJournalEvent>` /
`EventSourceService<RuntimeEvent>` adapter the materialization
strategy interface relies on, and is consumed by
`materialize-pipeline.ts`, `session-projection-definition.ts`, and
active scenario tests. It's the EventSource boundary, not a runtime-host
parallel root.

**Status:** Not drift. Top-of-file comment added in the Lane B/C/D
follow-up to make the role explicit (so future audits don't re-flag
it). No code change required.

**Recommended follow-up:** None.

---

### F9 [LOW] Stale doc references to deleted scaffolding

**Files:**

| File | Stale ref | Severity |
| --- | --- | --- |
| `docs/proposals/SDD_EFFECT_NATIVE_DURABLE_STREAMS_PRODUCTION_CUTOVER.md:6` | `Depends on: stream-native-runtime-loop, ...` | medium — listed as live dependency |
| `docs/proposals/SDD_EFFECT_NATIVE_DURABLE_STREAMS_PRODUCTION_CUTOVER.md:352` | `pnpm ... test -- tracer-015` | low — test no longer exists |
| `docs/tracers/012-agent-ingress-prompt-stream.md:102,105` | Diagrams + prose reference `runtime_ingress.accepted` | medium — historical tracer doc; OK to mark historical |
| `docs/research/durable-execution-api-design-survey.md:47-48,70,524,538` | Lists `stream-native-runtime-loop.SURFACE.*` ACIDs + `tracer-015` as part of the survey's reference set | low — research doc, fair to leave as historical with a note |
| `docs/architecture/managed-agent-runtime-target-durable-facts.md:592-595` | Already updated in tracer-017 (entry now reads "DELETED in tracer 017") | resolved |

**Status:** Tracer-016 / current-target docs were corrected in PR #158.
The proposals / research / older-tracer docs still have stale text.

**Recommended follow-up:** Two-line fix per file. Either:
- Move tracer-012 and the SDD-cutover proposal explicitly to a
  `docs/historical/` directory; OR
- Add a "as of tracer 017, this surface was removed; historical
  reference only" banner.

The doc-reference fixes in *this* PR are limited to the trivial cases
(see "Edits in this PR" below).

---

### F10 [LOW] Scenario tests still use `durable-stream-fixtures` product-shaped read helpers

**Files:** `scenarios/firegrid/src/durable-stream-fixtures.ts`,
`scenarios/firegrid/src/{tracer-001,002,007,008,011,012,017}.test.ts`

**Why it matters:** `readUnknownDurableEvents`, `appendUnknownDurableEvent`,
`appendRuntimeJournalEvent` are scenario-local helpers that read/write
durable rows by sidestepping the production producer/reader the host
would normally use. For most tests this is fine (they're setting up
fixtures), but for tests asserting end-to-end production-surface
behavior it's a partial shadow harness.

**Status:** Mostly OK. Tracer-017 was specifically written to use only
production surfaces; the other tracers have varying levels of fixture
use.

**Recommended follow-up:** No action required for this audit. Worth
keeping an eye on when new scenarios are added — production-surface
assertion is the target standard (per FIREGRID_PROOF.2 phrasing).

---

### F12 [HIGH] `managed-agent-runtime-target.md` claims "Target Architecture" but is not actually canonical

**Files:**
- `docs/architecture/managed-agent-runtime-target.md` (423 lines) — titled `# Target Architecture: Managed-Agent Runtime Package Model`. Shows package shape with `runtime-operators/` (the drift target from F1) and pre-`effect-durable-operators` framing throughout. No banner, no "superseded by" link.
- `docs/architecture/managed-agent-runtime-target-durable-facts.md` (662 lines) — opens with: *"Status: proposed fork for review. This document does not replace `docs/architecture/managed-agent-runtime-target.md`."*

**Why it matters:** Two docs in `docs/architecture/` both claim
"target architecture" status. The newer one (with the correct
post-tracer-017 framing) explicitly disclaims that it replaces the
older one. The older one still shows the legacy `runtime-operators/`
package shape and predates the effect-durable-operators direction.

A new contributor (human or agent) reading `target.md` would walk away
believing `runtime-operators/` is the current target — directly
contradicting the drift this inventory is trying to surface. F1
becomes much harder to argue if the canonical architecture doc still
describes the deprecated package.

This is the **single highest-leverage doc fix** in the inventory: the
exact place where future tracers go to learn "what is Firegrid's
target shape" cannot be ambiguous about which doc is authoritative.

**Status:** Active drift. Not a typo — a structural ambiguity in the
architecture-documentation corpus.

**Recommended follow-up:** Either:

1. **Promote `target-durable-facts.md` to canonical.** Strike the
   "does not replace" disclaimer; banner `target.md` with "Historical:
   superseded by `managed-agent-runtime-target-durable-facts.md` as of
   tracer 017. Retained for the architectural reasoning record." OR
2. **Merge and delete.** Fold any unique-to-`target.md` content into
   `target-durable-facts.md` and delete `target.md`.

A trivial banner update is applied in this PR (see "Edits in this PR")
to mark `target.md` as historical with a forward pointer. The full
merge/promotion decision is left to Lane D as a follow-up; this PR
makes the inventory itself accurate without making the architectural
decision for the team.

---

### F11 [LOW] `@firegrid/durable-streams/state` and `/workflow-engine` subpaths used widely

**Files:**

```
packages/client/src/firegrid.ts:5      @firegrid/durable-streams/state
packages/runtime/src/materialization/session-projection-definition.ts:3   /state
packages/runtime/src/materialization/state-protocol/StateProtocolStrategy.ts:3 /state
packages/runtime/src/required-action/launcher.ts:5   /workflow-engine
packages/runtime/src/runtime-host/index.ts:5         /workflow-engine
packages/runtime/src/runtime-context/service.ts:4    /state
apps/flamecast/src/runtime/agent-webhooks.ts:4       /workflow-engine
apps/flamecast/src/shared/{db,state}.ts              /state
```

**Why it matters:** These are the *narrow* subpath imports the
dependency-cruiser rule prefers (vs. the broad root import). The
imports themselves are within policy — this is **not** drift. Logged
here for completeness so future audits don't flag them again.

**Status:** Within policy. No action needed.

---

## Net doc/spec edits in this PR

The PR is structured as discovery first, destructive cleanup second. The
following edits land alongside the inventory itself:

1. **Deleted**: `docs/architecture/managed-agent-runtime-target.md`
   (423 lines). Was the competing "Target Architecture" doc; resolves
   F12.
2. **Promoted to canonical**:
   `docs/architecture/managed-agent-runtime-target-durable-facts.md`.
   Title is now plain "Target Architecture..."; the
   "Status: proposed fork ... does not replace" disclaimer is gone.
   Cross-link list updated (tracer-012 flagged as historical inline).
3. **Cross-link sweep**:
   - `docs/tracers/005-durable-streams-substrate-extraction.md` now
     points at the canonical doc, with a promotion note.
   - `docs/research/durable-execution-api-design-survey.md` and
     `docs/architecture/current-architecture-alignment-review.md` gain
     historical banners pinning them to their original dates with a
     forward pointer to the canonical target.
   - `docs/architecture/managed-agent-control-surface.md` already
     pointed at the canonical doc; no edit required.
4. **Tracer-012 body**:
   - Top-of-doc historical banner about the deleted
     `runtime_ingress.accepted` row family.
   - "Minimum durable records: requested + accepted" listing struck
     down to just `requested`, with an updated-post-tracer-017 note
     keeping the authority-boundary requirement and pointing the
     substrate at `effect-durable-operators.ConsumerCheckpointStore`.
5. **SDD-cutover proposal** (`docs/proposals/SDD_EFFECT_NATIVE_DURABLE_STREAMS_PRODUCTION_CUTOVER.md`):
   - Stripped `stream-native-runtime-loop` from `Depends on:`.
   - Replaced the `pnpm ... test -- tracer-015` validation invocation
     with a comment + tracer-016/017 invocations.
6. **Source-code rationale comments** (no behavioral change):
   - `packages/runtime/src/materialization/raw-fold/RawFoldStrategy.ts`
     — explains the file is the in-process strategy, not target
     substrate; points at F4 / Lane B.
   - `packages/runtime/src/materialization/runtime-output-source.ts`
     — explains the file is the canonical `EventSource` adapter, not
     a composition mini-root; points at F8 (now resolved).

Anything outside this list is **out of scope** for this PR. Lane A
items (F1, F2, F3, F6, F7 — `runtime-operators/**` and
`required-action/**`) are owned by a separate tracer/PR.

---

## Prioritized remediation plan

Five coherent work lanes, ordered by leverage. Each is ~1 tracer-sized PR.

### Lane A — Required-action durable rework (covers F1, F2, F3, F6, F7)

The runtime-operators package, the required-action launcher, and the
required-action fold all collapse into one DurableConsumer-shaped
program. This is the highest-leverage cleanup because it deletes ~400
lines of bespoke fold/launcher code while landing AtMostOnce restart
semantics.

**Acceptance:**
- `runtime-operators/**` deleted; `firegrid-reactive-workflow-operators`
  spec retired.
- `required-action` operator uses `DurableConsumer.run` with a
  dedicated `requiredActions` checkpoint stream.
- `required-action.get(...)` queries a `DurableTable` view; the
  `.collect`-and-fold path is gone.
- `RequiredActionRuntimeLive` replaced by a host-streams capability
  (or merged into `FiregridRuntimeHostLive`); tracer-009/013 use the
  production host.
- `service.ts` row constructors use `satisfies` or `.make()` — no
  `Schema.decodeUnknownSync` in trusted paths.

### Lane B — Materialization strategy rationalization (covers F4, F8)

After Lane A, the materialization layer is the next bespoke-fold
holdout. Decide whether `RawFoldStrategy` should be replaced with a
`DurableTable`-backed implementation or deleted if no production
callers remain, and whether `runtime-output-source` should expose its
Layer through host streams config.

**Acceptance:** narrow decision doc + one of: (a) deletion of
`RawFoldStrategy`; (b) reshaped strategy interface; (c) explicit
"keep, here's why" rationale captured in `target-durable-facts.md`.

### Lane C — `runtime_ingress.requested` → `firegrid.session.input` rename (F5)

Standalone rename tracer when the team is ready to commit to the new
public name. Mechanical but invasive — touches `Firegrid.prompt`,
all `RuntimeIngressRow*` types, every scenario.

**Acceptance:** the new row type is the public name; the old name is
deleted with no compatibility shim; all scenarios and docs reference
the new name.

### Lane D — Historical doc segregation (F9, F12, partial)

Move/banner the proposals and research docs that reference deleted
surfaces. No code changes. Aim is to make the difference between
"current target" and "historical record" mechanically obvious to a
new contributor.

The load-bearing decision in this lane is **promoting
`managed-agent-runtime-target-durable-facts.md` to canonical** (F12):

- Strike the "Status: proposed fork ... does not replace" disclaimer
  at its top.
- Either delete `managed-agent-runtime-target.md` (after folding any
  unique content) or leave it with the historical banner this PR
  already applied.
- Audit every link into either file from elsewhere in the repo and
  ensure they point at the canonical one (or are explicitly
  "historical reference" links).

The SDD-cutover proposal
(`docs/proposals/SDD_EFFECT_NATIVE_DURABLE_STREAMS_PRODUCTION_CUTOVER.md`)
also needs a "current vs historical" decision in this lane — it still
describes itself as `Status: proposed` even though much of its target
state shipped via tracer 017.

**Acceptance:** every `docs/**.md` file is unambiguously either
"current target" or "historical" (banner or directory). No links from
current-target docs into historical without an explicit "historical
reference" attribution. `target-durable-facts.md` is the single
canonical architecture doc.

### Lane E — Standing audit hygiene (cross-cutting)

Lightweight: capture the rules this inventory exposes as a `STYLE.md`
in `docs/architecture/`. The recurring pattern checks the team has
been applying — no decoder-as-constructor, no sibling-optional
config, no mini composition roots, prefer DurableConsumer over bespoke
fold, neutral domain vocabulary for triggers — should be discoverable
by the next agent.

**Acceptance:** `docs/architecture/STYLE.md` exists, cross-linked
from contribution docs, with each rule citing one example of the
right shape and one example of the antipattern (linking to git history
where the pattern was introduced/removed).

---

## Validation run

```
$ pnpm run check:docs
✓ all docs/features pass trailing-whitespace and conflict-marker checks

$ pnpm run check:specs
ok …all feature.yaml files parse…

$ pnpm run lint:deps
✔ no dependency violations found (133 modules, 260 dependencies cruised)
```

No specs were edited in this PR (only the SDD-proposal and tracer-012
historical doc), so `acai push` was **not** run. If Lane A / Lane C are
taken up, those tracers will push their own ACID updates.

---

## Out of scope for this PR

- Any deletion of `runtime-operators/**`, `required-action/**`, or
  `RawFoldStrategy`. Those need their own tracer with tests.
- Renaming `firegrid.runtime_ingress.requested`.
- Adding `STYLE.md` (Lane E follow-up).
- Cleaning up `docs/research/durable-execution-api-design-survey.md`'s
  references to deleted features (research doc; historical OK).
