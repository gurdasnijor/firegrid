# Shape C Cutover — Output Observation / Child Output Slice

Doc-Class: internal-contract
Status: active
Date: 2026-05-22
Owner: Firegrid Architecture

Branch: `sidecar/shape-c-output-observation` (off `origin/rearch/shape-c-cutover`)
Integration target: `rearch/shape-c-cutover` (Wave 1)

**Verdict: 🟢 GREEN**

The slice integrates the existing `SessionAgentOutputChannel` / router shape
into the production target and removes RuntimeContext's per-event handler from
consuming dense output. Raw output remains observable through the existing
channel/router. No new protocol surface was needed.

## Wave 1 success criteria this slice contributes to

From `docs/architecture/2026-05-22-shape-c-cutover-operating-plan.md` §"Wave 1":

- ✅ "RuntimeContext state transitions no longer scan dense raw output for
  progress" — the per-context store's `nextOutput` now skips state-irrelevant
  observations during its forward point-walk; the handler is invoked only for
  the sparse subset (PermissionRequest / non-ACP ToolUse / Terminated).
- ✅ "Child/delegated output observation uses existing channel/router surfaces"
  — confirmed integration test against the production `sessionAgentOutputChannel`
  (which reads `RuntimeOutputTable.events.rows()`) through the existing
  `sessionAgentOutputObservationRoute` + `makeRuntimeChannelRouter`. No new
  primitive, schema, or protocol.

Out of scope for this slice (owned by CC2 / CC4):

- `RuntimeContextWorkflowNative` body deletion (CC2 — Shape C handler reshape).
- Per-sequence `DurableDeferred` input mailbox deletion (CC4).

## Load-bearing constraints observed

- **C2** ("Handlers Are State/Event Reducers, Not Long-Lived Bodies") — sparse
  predicate keeps the body's per-event Activity tied to state-relevant facts;
  CC2's handler reshape consumes this same shape.
- **C6** ("Observations Are Typed Source, Cursor, Match" + "Delegated Child
  Output") — child observation uses `source = SessionAgentOutputChannelTarget`
  + `cursor = afterSequence` + `match = isStateRelevantOutputObservation`
  (production handler) or no match (UI/telemetry/parent).
- **C7** ("Schemas are first-class") — terminal evidence on `Terminated` lives
  on the durable state row (`exitEvidence`), not edge-synthesized. `TurnComplete`
  is correctly inert and **not** a terminal authority.

## What changed (production)

`packages/runtime/src/workflow-engine/runtime-context-state.ts`:

- New pure predicate `isStateRelevantOutputObservation(context, observation)`,
  co-located with `nextOutputObservation` (single source of truth for the
  sparse contract). It is the dual of `transitionOutputEvent`: a non-relevant
  tag reduces to `action: None` regardless of state (proven in the test).
- `nextOutputObservation` accepts an optional `relevant` predicate; when
  provided, decodable-but-inert observations are skipped during the indexed
  forward walk (TextChunk / Ready / TurnComplete / Status / Error / ACP-side
  ToolUse). Default (no predicate) behavior is unchanged for non-handler
  callers.
- The production per-context store's `nextOutput` wires the predicate so the
  RuntimeContext body's handler is invoked only on sparse facts.

Diff: `1 file changed, 83 insertions(+), 8 deletions(-)`. Net **+75 lines** in
`runtime-context-state.ts` (group "RuntimeContext State/Input/Output Handling":
369 → 444). The other 7 files in that group are unchanged; the
"Output observation and transition handling" group is unchanged (541 lines,
unchanged), and the "Wait routing / observation matching" group is unchanged.

Positive movement justification per baseline doc: this adds the **sparse
state-relevant fact consumption** capability (Wave 1 success criterion #3).
CC2's body-shape replacement delivers the corresponding negative delta when it
removes the workflow body and its Activity-per-event wrap.

## What did NOT need to be added (hard constraints honored)

- ❌ No new `ChildOutput*` schema family — searched, zero in production source;
  C6 Semgrep guard `firegrid-c6-no-source-specific-cursor-event-taxonomy-in-agent-tools`
  (tf-zchu, already enforced) rejects re-introduction.
- ❌ No `session_read` request/response protocol — searched, zero in production;
  same guard.
- ❌ No `DurableOutputCursor` primitive — searched, zero. The `nextOutput`
  point-walk on `RuntimeContextStateStore` (tf-aseo, already in-tree) IS the
  durable cursor; this slice extends it with the relevance predicate, not a new
  primitive.

## Retired / made-unreachable surface

This slice does not delete any module. It makes a *behavior* unreachable on
the production path:

- **Made unreachable:** `transitionRuntimeContextEventActivity` invocation per
  *inert* output observation. Pre-cutover, every TextChunk / Ready /
  TurnComplete / Status / Error / ACP-side ToolUse generated a uniquely-named
  durable Activity memo row + span. Post-cutover, only the sparse subset does.
- **Deferred deletion (named follow-ups):**
  - The Activity wrapper itself (`transitionRuntimeContextEventActivity`) — CC2
    deletes it with the handler-shape replacement.
  - `RuntimeContextWorkflowNative` body — CC2 deletes the long-lived workflow
    body in the Shape C subscriber reshape.
  - `runtime-output-journal.ts` / `runtime-observation-streams.ts` — these are
    Shape B projection consumers (used by UI/wait-router); not deleted by this
    slice and not made unreachable.

## Guards landed with the behavior they protect (Wave 4)

- Existing `firegrid-no-replay-path-output-scan` (semgrep) already forbids
  full-table scans on the workflow replay path — covers the broader invariant.
- Existing `firegrid-c6-no-source-specific-cursor-event-taxonomy-in-agent-tools`
  (semgrep) rejects re-introduction of `ChildOutput*` / `session_read` / source
  cursor taxonomies — direct protection of the C6 contract this slice relies on.
- **New behavioral guard for this slice:**
  `packages/runtime/test/workflow-engine/runtime-context-state.sparse.test.ts`
  runs against the REAL production wiring (`makePerContextRuntimeContextStateStore`
  + `DurableStreamTestServer`). If a future change drops the predicate from
  `nextOutput`, all five sparse-consumption tests fail and a sixth (the
  dual-property test) flags the predicate-handler divergence.
- **New integration guard:**
  `packages/runtime/test/channels/session-agent-output-route.integration.test.ts`
  exercises the production `sessionAgentOutputChannel` + route + router end-to-end;
  failure indicates the channel/router child observation path regressed.

No new Semgrep rule is needed: behavior is guarded by tests against production
wiring, and the protocol-shape rules already exist.

## Evidence (path + how to run)

- Sparse fact consumption:
  `packages/runtime/test/workflow-engine/runtime-context-state.sparse.test.ts` —
  5 tests, all green. Asserts: (1) drains [Ready, TextChunk×2, PermissionRequest,
  TextChunk, ToolUse, TurnComplete, Terminated] returns only seq {3, 5, 7};
  (2) under ACP, ToolUse is correctly inert; (3) cursor advances across dense
  skips (replay-safe); (4) predicate ↔ transitionOutputEvent dual property
  across all 8 output tags; (5) terminal evidence is durable-row-owned.
- Channel/router child observation:
  `packages/runtime/test/channels/session-agent-output-route.integration.test.ts` —
  1 test. Asserts: parent observes the full dense child output through the
  production channel + route + router with no duplicates and strictly
  increasing sequences.
- Run:
  `cd packages/runtime && npx vitest run test/workflow-engine/runtime-context-state.sparse.test.ts test/workflow-engine/runtime-context-state.test.ts test/channels/session-agent-output-route.test.ts test/channels/session-agent-output-route.integration.test.ts`
  → **15/15 passing**. Body-level core test
  (`packages/host-sdk/test/host/runtime-context-workflow-core.test.ts`) →
  **8/8 passing** under sparse consumption (no regression).
- Typecheck: `pnpm turbo typecheck --filter @firegrid/runtime --filter @firegrid/host-sdk --filter @firegrid/protocol` clean.

## Falsification

This slice would have been **RED/YELLOW** if any of the following had been
required:

- A new `ChildOutput*` / `session_read` schema family. → Not needed.
- A new `DurableOutputCursor` primitive distinct from the existing
  `RuntimeContextStateStore.nextOutput`. → Not needed.
- A bridge that keeps the dense Activity invocation pattern alive while the
  sparse target is built. → Not built; the predicate IS the target shape.
- A source unable to provide the snapshot-first/subscribe-after-cursor boundary
  that route-backed observation depends on. → Not observed; the existing
  `sessionAgentOutputChannel` reads `RuntimeOutputTable.events.rows()` which is
  exactly that boundary.

## Production dependency

- This slice depends on tf-aseo (PR #633, on `origin/rearch/shape-c-cutover`)
  for the per-context durable state store the predicate plugs into.
- This slice depends on tf-1ymw (commit `83fad6e64`, on `origin/main` and on
  the integration branch) for `sessionAgentOutputObservationRoute`.
- CC2 (handler reshape, separate lane) depends on this slice's sparse contract.
- CC3 (tool/wait result rows, separate lane) coordinates with this slice
  through the shared `RuntimeContextStateStore` state row shape (unchanged).
