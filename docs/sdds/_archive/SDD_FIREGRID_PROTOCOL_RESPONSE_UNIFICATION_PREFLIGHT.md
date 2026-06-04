> **HISTORICAL (pre-#765).** References paths deleted in #765 (packages/substrate, packages/host-sdk/src/host, and legacy packages/runtime/src/{subscribers,durable-tools,workflow-engine,agent-event-pipeline,agent-tools,runtime-host,composition}); kept for provenance. Current architecture: docs/cannon/.

# SDD: Protocol Response Unification — Phase 2 Pre-Flight

Status: proposed (pre-flight for SDD_FIREGRID_PROTOCOL_RESPONSE_UNIFICATION Phase 2)
Created: 2026-05-31
Owner: Firegrid Protocol / Runtime / Client SDK
Predecessor: `SDD_FIREGRID_PROTOCOL_RESPONSE_UNIFICATION.md`
Validated by: `packages/firelab/src/simulations/unified-kernel-validation/` (6/6 scenarios + 16/16 invariants green; signal-based subscribers + `DurableEventChannel<P>` + Firegrid SDK driver all proven)

## Why this pre-flight exists at all

**Firegrid is a zero-user greenfield codebase.** There is no production traffic to migrate, no external consumers to deprecate against, no SLA to maintain compatibility under. The codebase exists to deliver firegrid's advertised properties with the smallest possible surface area. Backwards compatibility is **not a goal**; it is an active anti-goal that has repeatedly doomed unification attempts in this repo.

The persistent failure mode this pre-flight is designed to prevent:

> Land the new abstraction → mark the legacy paths "deprecated" → "we'll delete in a follow-up" → six months later the deprecated paths are load-bearing for new code that drifted in, the surface area grew rather than shrank, the unification is stuck in a permanent two-implementation state, and the next architectural review has TWO complete subsystems to reason about instead of one.

This has happened, by my count of the SDDs in `docs/sdds/`, at least four times in this repo (the patterns visible in `SDD_FIREGRID_AGGRESSIVE_ONE_SUBSTRATE_SWAPOVER.md`, the wait-router/wait-store collapse, the channel-router replacement of catalog-style registries, the prior runtime-context-session-workflow merges). Each one named the deletion targets; not all of them actually executed them.

**This pre-flight makes the deletion targets the load-bearing artifact.** The deliverable is measured in lines removed, not lines added.

## Deletion targets — with line counts

These are the surfaces Phase 2 deletes. Numbers are current `wc -l` of `.ts` source (excluding tests):

### 1. Shape C subscriber loops (`packages/runtime/src/subscribers/*`)

| Directory | Source lines | Disposition |
| --- | --- | --- |
| `runtime-context/` | 658 | **DELETE** — the Shape C input loop, replaced by signal-based session subscriber |
| `runtime-context-session/` | 127 | **DELETE** — Shape C session glue |
| `runtime-context-session-workflow/` | 379 | **DELETE** — workflow body that bridged DurableDeferred mailbox |
| `wait-router/` | 175 | **DELETE** — legacy wait substrate, retired by the workflow engine collapse |
| `tool-dispatch/` | 2630 | **MOSTLY DELETE** — keep ≤ ~200 lines for the signal-based tool dispatch workflow (mirroring sim shape); rest is Shape C bookkeeping |
| `keyed-dispatch/` | 175 | **DELETE** — per-key mutex / fork-per-fact dispatcher (Shape C subscriber-runtime artifact) |
| `runtime-control/` | 1130 | **AUDIT + TRIM** — likely 60–80% delete; the parts that drive `inputIntents` / `startRequests` / `permissionRequests` polling all go |
| `scheduled-prompt/` | 79 | **DELETE** — replaced by the signal-based ScheduledPromptWorkflow |
| **Subscribers total** | **5,353** | **Estimate: ~4,500 deleted** (~85%) |

### 2. Bespoke response schemas + bindings (`packages/protocol/`)

| File | Source lines | Disposition |
| --- | --- | --- |
| `src/runtime-ingress/schema.ts` | 204 | **TRIM TO ~50** — keep `PublicPromptRequestSchema`, drop `RuntimeIngressRequestSchema` / `RuntimeInputIntentRowSchema` / status enums / delivery-key codec |
| `src/launch/control-request.ts` | 368 | **TRIM TO ~80** — drop request-row factories (`makeRuntimeContextRequestRow`, `makeRuntimeStartRequestRow`, `makeRuntimeLifecycleRequestRow`, `makeRuntimeControlRequestClaimRow`, `makeRuntimeControlRequestCompletionRow`, `makeRuntimeStartRequestAck` + their schemas). Keep only what `contexts` derivation needs. |
| `src/launch/host-control-request.ts` | 237 | **DELETE entirely** — `appendInputIntent`, `makeHostPromptChannel`, `makeSessionPromptChannelForSession`, `makeHostPermissionRespondChannel`, `makeHostSessionsStartChannel`. Replaced by `@firegrid/runtime`'s signal-based bindings. |
| `src/launch/host-context-request-binding.ts` | 36 | **DELETE** — wraps the deleted context-request rows |
| `src/launch/table.ts` | (large) | **TRIM** — remove `inputIntents`, `contextRequests`, `startRequests`, `lifecycleRequests`, `controlRequestClaims`, `controlRequestCompletions` from `RuntimeControlPlaneTable`. Keep only `contexts`. |
| `src/agent-tools/schema.ts` | (large) | **TRIM** — drop `PermissionRespondOutputSchema` (collapses to `DurableEventChannel<PermissionRespondInput>`'s `EventOffset` return) |
| **Protocol total touched** | **~845 lines named here** | **Estimate: ~600 deleted, ~245 kept-and-collapsed** |

### 3. Client SDK consumers

| File | Disposition |
| --- | --- |
| `packages/client-sdk/src/channels/host-control-default.ts` | **DELETE** — standalone defaults that wrap `RuntimeControlPlaneTable.inputIntents`. Replaced by `@firegrid/runtime`'s signal-based Lives. |
| `packages/client-sdk/src/channels/host-sessions-create-or-load-default.ts` | **DELETE** unless contexts-derivation needs a similar shim |
| `packages/client-sdk/src/firegrid.ts` | **TRIM + RETYPE** — named methods (`firegrid.prompt`, `firegrid.sessions.prompt`, `firegrid.permissions.respond`) change return type from bespoke row to `EventOffset`. Drop the `withClientSpan` channels-specific helpers tied to deleted Tags. |
| `packages/client-sdk/src/operations.ts` | **TRIM** — `permissionRespond` operation drops its bespoke output schema reference |

### 4. Bridge / glue helpers (already named in P1 invariants)

| Symbol | Files | Disposition |
| --- | --- | --- |
| `appendInputIntent` | 2 | **DELETE** |
| `appendRuntimeInputDeferred` | (any remaining) | **DELETE** |
| `RuntimeContextWorkflowRuntime` | (any remaining) | **DELETE** |
| `makePerKeyMutex` / `per-key-mutex` | (any remaining) | **DELETE** |
| `eventAlreadyProcessed` / `lastProcessedInputSequence` | (any remaining) | **DELETE** |

These are all already enforced as forbidden by structural invariants I1–I12 in the simulation; Phase 2 makes the production source tree pass the same checks.

### 5. Tests

`packages/runtime` has ~10,056 lines of `.test.ts`. Conservative estimate:
- **~3,000–4,000 lines deleted** outright (tests for Shape C subscriber loops, wait-router, input-intent dispatching).
- **~1,500 lines rewritten** against the signal-based subscribers (the cases that still exist conceptually, just via different machinery).
- Net test reduction: ~30–40%.

### 6. Net surface-area estimate

| Component | Before | After | Delta |
| --- | --- | --- | --- |
| `runtime/src/subscribers/` | 5,353 | ~800 (signal subs lifted from sim) | **−4,553 (−85%)** |
| `protocol/src/runtime-ingress` + `launch/` (the four files above) | 845 | ~130 | **−715 (−85%)** |
| `client-sdk/src/channels/` defaults | ~150 (the two files) | 0 | **−150 (−100%)** |
| `runtime/src/channels/` | 2,193 | ~1,800 (host-control-routes shrinks) | **−400 (−18%)** |
| `runtime/src/tables/` | 1,718 | ~600 (most families dropped) | **−1,100 (−64%)** |
| Test files (runtime) | 10,056 | ~6,500 | **−3,500 (−35%)** |
| **Total estimated lines deleted** | | | **~10,400** |
| **Lines added (signal primitive + new bindings)** | | | **~1,500** |
| **NET DELTA** | | | **≈ −9,000 lines (−40% of `packages/runtime`)** |

If the PR lands with a delta significantly smaller than −5,000 lines net, **the unification has not happened** — it has been layered, and the same trap that doomed prior attempts is reasserting itself.

## Acceptance criterion (load-bearing)

**Phase 2's PR must show a net source-code line deletion of ≥5,000 lines across `packages/runtime`, `packages/protocol`, `packages/client-sdk` combined.**

This is a hard gate. PRs that introduce new abstractions without comparable deletion get rejected. Subsequent "we'll delete in follow-up" PRs are not credible historical precedent in this repo.

Additionally, the merged tree must pass these grep checks (`should return 0 matches`):

```
# Across packages/runtime, packages/protocol, packages/client-sdk:
grep -rn "RuntimeInputIntentRow"      → 0
grep -rn "PermissionRespondOutput"    → 0
grep -rn "RuntimeStartRequestAck"     → 0
grep -rn "appendInputIntent"          → 0
grep -rn "RuntimeContextWorkflowRuntime" → 0
grep -rn "makePerKeyMutex"            → 0
grep -rn "eventAlreadyProcessed"      → 0
grep -rn "lastProcessedInputSequence" → 0
grep -rn "inputIntents:"              → 0  (DurableTable row-family declaration)
grep -rn "startRequests:"             → 0
grep -rn "permissionRequests:"        → 0
grep -rn "contextRequests:"           → 0
grep -rn "wait-router"                → 0  (in directory paths)
grep -rn "durable-tools"              → 0  (in directory paths)
```

These mirror simulation invariants I1–I16 lifted to the production tree. The simulation has been passing them; Phase 2 makes production pass them too.

## Answers to the five open questions

### Q1 — `inserted: boolean` consumer audit

**Current readers:** 1 file (`packages/protocol/src/launch/control-request.ts`, the `makeRuntimeStartRequestAck` factory itself).

**Decision: DELETE the field entirely.** No real consumer reads it for branching. `RuntimeStartRequestAck` itself is deleted (per §2 above); its `inserted` field disappears with it. Idempotency is at the durable-streams Producer-Seq layer (which deduplicates at the wire — the producer gets a uniform success).

### Q2 — `inputId` / cross-row id correlation consumer audit

**Current readers:** 8 files in `packages/{protocol,runtime,client-sdk}/src/`. Inspection:

- `protocol/src/runtime-ingress/schema.ts` — defines the field (deleted with schema trim).
- `protocol/src/launch/host-control-request.ts` — writes the field (file deleted).
- `runtime/src/tables/runtime-context-input-facts.ts` — Shape C input fact table (deleted).
- `runtime/src/channels/session-permission.ts` — reads for permission correlation; rewires to signal-name correlation.
- `runtime/src/subscribers/runtime-context/index.ts` — Shape C input loop (deleted).
- `runtime/src/subscribers/runtime-context-session-workflow/workflow.ts` — Shape C workflow body (deleted).
- `runtime/src/composition/host-public.ts` — composition wiring (rewires to new bindings).
- `client-sdk/src/firegrid.ts` — client-side correlation (rewires to signal name; see Q4).

**Decision: REPLACE with signal-name correlation everywhere.** The signal name is the correlation key — responder uses `name = "permission-decision"` against `executionId = hash(contextId, permissionRequestId)`; the body awaits the same signal name. No cross-row id is needed.

### Q3 — `kind` discriminator placement (one channel + payload kind, vs N channels)

**Decision: ONE channel per surface, `kind` in payload.** Specifically:

- One `HostPromptChannel: DurableEventChannel<PublicPromptRequest>` — payload carries `{ payload, metadata }`; metadata MAY carry `kind` discriminator for cases that need it (`metadata.kind = "terminal"` for the terminal sentinel).
- One `HostPermissionRespondChannel: DurableEventChannel<PermissionRespondInput>` — payload carries `{ permissionRequestId, decision }`.

**Rationale:**
1. Fewer Tags = smaller channel registry = smaller dispatch surface area.
2. Signal-based subscribers do dispatch INSIDE the body via `awaitSignal({ name })` — the discriminator is already a body-level concern, not a channel-level concern.
3. Splitting into `HostPromptChannel` / `HostControlChannel` / `HostToolResultChannel` / `HostRequiredActionResultChannel` would add four Tags for a typing convenience that payload-level Schema discrimination already provides.

This rejects the alternative ("strong typing via separate channels") in favor of the smaller surface. The simulation has been validating this shape (sessions consume `SessionInputPayload { kind, payloadJson }`).

### Q4 — `RuntimeControlPlaneTable.contexts` / sessions storage

**Decision: `contexts` stays as a derivation index, scoped to the metadata it actually carries. Drop `sessions` entirely.**

- `contexts` family: keep `{ contextId, agent?, createdAt }` only. Drop `nextInputSequence` (no sequence allocator under signals). Reads continue via `firegrid.snapshot(contextId).context`.
- `sessions` family (if it exists separately): drop. `sessionId === contextId` for our purposes — `SessionHandleReference.sessionId` is derived from `externalKey` via `sessionContextIdForExternalKey()`. No separate sessions table needed.

The `HostContextsChannel` ingress stream stays — it's a read-side stream over the `contexts` family, useful for the client's `firegrid.watchContexts(...)`. This is a true derivation, not an event log.

### Q5 — OTel propagation under the unified shape

**Decision: OTel context lives in `headers.txid` (or `headers.otel`, name TBD per durable-streams docs) — at the wire, not in the application schema.**

- Drop `_otel: RowOtelContextSchema` from all row schemas.
- The signal primitive's `recordSignal` / `sendSignal` already runs inside an Effect span; OTel context propagates via the durable-streams headers naturally.
- Production rows that need to carry OTel context for cross-host span linkage use the durable-streams transport's header field.
- `stampRowOtel` helper deleted.

This eliminates a per-row schema field and aligns OTel propagation with the durable-streams transport convention rather than every application row schema duplicating context fields.

## Migration sequence

Phase 2 is ONE PR but the internal commit sequence keeps each commit reviewable:

1. **`protocol`: add `DurableEventChannel<P>` + `EventOffset` to `channels/core.ts`.** Additive. No breakage. Validates the new shape's type system.
2. **`runtime`: promote signal primitive + signal-based subscribers from sim to `src/signal/` + `src/subscribers-unified/`.** Additive. Both old and new subscribers exist; old still wired.
3. **`runtime`: add `HostPromptChannelLive` / `HostPermissionRespondChannelLive` / `HostSessionsStartChannelLive` / `SessionPromptChannelLive` Live Layers backed by signal subscribers.** Additive.
4. **`runtime`: swap `FiregridRuntimeHostLive` to provide the new Lives.** This is the cut — Shape C goes inactive. Production traffic (none, since zero users) routes through signals.
5. **`client-sdk`: retype named methods' return types (`EventOffset` instead of bespoke rows).** Coordinated with (4); the standalone defaults file is deleted.
6. **Deletion commit: remove Shape C subscriber dirs, removed table row families, removed schemas, removed factories, removed bridge helpers, removed tests.** This is the −5,000-line commit.
7. **Update consumers + their tests.** Mechanical sweep.
8. **`firelab` simulation: update imports to use promoted signal primitive from `@firegrid/runtime`. Rewrite `firegrid-client-scenarios.ts`'s driver to use NAMED methods (`firegrid.prompt`, `firegrid.permissions.respond`, etc.) — no more `channels.call` escape hatch. Add invariant I17 locking the named-method shape.**

The PR is not mergeable until commit (6) lands. Commits (1)–(5) without (6) is the historical failure mode — abstraction landed, legacy still load-bearing.

## Anti-pattern callout (re-stated)

The following are **explicitly rejected** as Phase 2 shapes:

- ❌ "Land the abstraction, deprecate Shape C, delete in a follow-up PR." There is no follow-up. The deletion is the deliverable.
- ❌ "Keep `inputIntents` for backward compatibility." There are zero callers to be backward-compatible with.
- ❌ "Add an `_inserted_legacy` field on `EventOffset` to ease migration." There are zero callers reading the prior `inserted` field for branching.
- ❌ "Mark `RuntimeInputIntentRow` `@deprecated`." Delete it.
- ❌ "We'll keep `RuntimeContextWorkflowRuntime` for now in case something else needs it." Nothing else needs it.

If any of these patterns appear in a Phase 2 PR, the PR is being mis-scoped and should be split — either the deletion happens, or the PR is rejected.

## Risk surface

| Risk | Likelihood | Mitigation |
| --- | --- | --- |
| A consumer reads a deleted field we didn't audit | LOW | Grep audit done in §2; TypeScript catches the rest at build time |
| A test depends on Shape C behavior in a way we didn't anticipate | MED | Test deletion is part of the deletion commit; remaining tests run against new shape |
| Production data in `inputIntents` becomes inaccessible | NONE | Zero users, no production data |
| `@effect/workflow` API changes break the signal primitive | LOW | Already validated through 6 simulation scenarios |
| The named-method retype breaks an external SDK consumer | NONE | Zero external consumers |
| Migration takes longer than estimated | MED | Commit (6) bounded by `wc -l` checks; if the deletion isn't that big, the trim wasn't aggressive enough |

The only meaningful risk is internal test-rewrite work in commit (7). Everything else is mechanical.

## Pre-flight execution

Before opening the Phase 2 PR:

1. **Run the grep audit fresh** on the day Phase 2 starts. Numbers above are 2026-05-31 snapshot; consumer landscape may shift.
2. **Verify the simulation still passes** through `pnpm simulate:run unified-kernel-validation` (all 6 scenarios, 16 invariants).
3. **Verify the grep checks listed in §"Acceptance criterion"** all return 0 against the simulation source tree (they already do — that's what I13–I16 lock).
4. **Confirm no parallel-track abstraction PRs are in flight** that would compete for the same files (Phase 2 will create big rebase conflicts).

## Cross-references

- `SDD_FIREGRID_PROTOCOL_RESPONSE_UNIFICATION.md` — the parent SDD
- `SDD_FIREGRID_AGGRESSIVE_ONE_SUBSTRATE_SWAPOVER.md` — prior aggressive swapover pattern (precedent for the "one PR, big deletion" shape)
- `packages/firelab/src/simulations/unified-kernel-validation/` — empirical proof; the shape Phase 2 lifts into production
- `https://github.com/durable-streams/durable-streams/blob/main/PROTOCOL.md` — the bedrock the unified shape ultimately rests on
