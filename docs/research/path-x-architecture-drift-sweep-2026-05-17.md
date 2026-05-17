# Path X Architecture Drift Sweep

Status: read-only audit. No product code changed.

Date: 2026-05-17

Base: `origin/main` @ `5966af5dc` (merge #304, the ratified DECISION).
Inspected: **PR #305 head `ed9b8300` (latest, re-fetched per coordinator
correction — an earlier `88ba8f2fc` ref was stale and its journal
findings are superseded below)**, draft PR #301 head, draft PR #303
head.

Source of truth: `docs/sdds/DECISION_PATH_X_PROCESS_OWNERSHIP.md`,
`docs/research/path-x-legacy-deletion-map.md`,
`docs/sdds/SDD_FIREGRID_HOST_SDK.md`,
`features/firegrid/firegrid-host-sdk.feature.yaml`.

## Headline

Hard package boundaries are **clean**: `@firegrid/runtime` does not
import host-sdk/client-sdk/cli (doc-comment mentions only);
`@firegrid/client-sdk/src` has zero forbidden imports.

On latest #305 (`ed9b8300`), **`RuntimeOutputJournalLayer` is fully
removed from `packages/host-sdk/src` (rg → zero)**. The legacy
`runRuntimeContext` path now writes through the narrow
`PerContextRuntimeOutputWriter` instead of providing the journal
authority. DECISION slice-1 "remove host-sdk's `RuntimeOutputJournalLayer`
dependency" is **satisfied**, even for the still-reachable legacy path.
No second mini-runtime is introduced (no supervisor/queue/monolith).

Remaining drift is sequencing/process, not authority leakage: the
legacy raw/codec + ingress-authority path is still *reachable* (expected,
sequenced to the adapter-split slice), #305 is **not rebased onto
main**, #303 carries the named monolith anti-pattern, and #301 is a
stale parallel cutover.

## P0 — Blockers

**None.** Boundaries hold; latest #305 is DECISION-compliant and removes
the journal-authority dependency.

## P1 — Cleanup required before the next cutover slice

### P1-1 — #305 is not rebased onto main; `git diff origin/main..pr-305` falsely shows the DECISION doc deleted

- Evidence: `git merge-base pr-305 origin/main` = `d62211403` (#302
  merge). `main@5966af5dc` (which added
  `docs/sdds/DECISION_PATH_X_PROCESS_OWNERSHIP.md` via #304) is **not an
  ancestor** of `pr-305`. `git cat-file -e
  pr-305:docs/sdds/DECISION_PATH_X_PROCESS_OWNERSHIP.md` → ABSENT.
  Hence `git diff origin/main..pr-305` reports
  `DECISION_PATH_X_PROCESS_OWNERSHIP.md | 178 ------` — a **stale-base
  artifact**: the doc is merely absent from #305's pre-#304 tree, not
  removed by any #305 commit. A GitHub 3-way merge retains main's doc
  (non-conflicting add on an untouched path).
- Violated clause: process/sequencing — `path-x-legacy-deletion-map.md`
  "Recommended PR Split" expects slices to land in order against
  current main.
- Recommended action: **rebase #305 onto `origin/main` before merge**,
  then re-run CI + boundary checks and confirm the DECISION doc is
  retained. The doc-deletion line is a diff artifact, **not** an
  intentional revert — do not block on it, but do not merge an
  un-rebased #305.
- Blocks #305 merge: **Yes, as a mandatory pre-merge step** (rebase
  only; no code change implied).

### P1-2 — Legacy `runRuntimeContext` / `runCodecRuntimeEventPipeline` / ingress-authority path still reachable

- Evidence (pr-305 `ed9b8300`):
  - `host-sdk/src/host/layers.ts:208` still composes
    `RuntimeContextWorkflowLayer` (legacy wrapper,
    `runtime-context-workflow.ts:46` → `:35 runRuntimeContext`).
  - `raw-process-runtime.ts:29` imports `runCodecRuntimeEventPipeline`
    from `@firegrid/runtime/host-substrate`; `:162` calls it; `:23/:170`
    `RuntimeIngressAppenderLayer`; `:27/:173`
    `RuntimeIngressDeliveryTrackerLayer`.
  - `RuntimeContextWorkflowNativeLayer` / `RuntimeContextWorkflowSession`
    still have **no production consumer**.
- Violated clause: `path-x-legacy-deletion-map.md` deletion gate;
  `DECISION` legacy classification (`runRuntimeContext`,
  `runCodecRuntimeEventPipeline`, `runIngressDelivery`, `runToolRouter`
  = DELETE/unreachable).
- Recommended action: **sequenced, not now.** This is the expected
  pre-cutover residual; the DECISION sequences named-symbol deletion to
  the raw/codec adapter-split slice. #305 still removes one whole legacy
  dependency edge (the entire `RuntimeOutputJournalLayer` authority,
  repo-wide in host-sdk), satisfying the DECISION non-draft bar. Track
  as the next slice's mandatory deletion: make
  `runtime-context-workflow.ts` + `raw-process-runtime.ts` unreachable,
  flip `layers.ts` to the native layer, drop the ingress-authority
  provides.
- Blocks #305 merge: **No** (expected sequenced residual; bar met).

### P1-3 — Draft #303 carries the named anti-pattern (monolithic supervisor)

- Evidence: `pr-303:packages/host-sdk/src/host/runtime-context-supervisor.ts`
  (`RuntimeContextSupervisorLive`, `…Command`, `…CommandAccepted`)
  wired at `pr-303:layers.ts:210`.
- Violated clause: `DECISION` "No second mini-runtime" — explicitly
  names `#303's runtime-context-supervisor.ts` as the blocked
  anti-pattern.
- Recommended action: **do not land.** Mark #303 superseded by the
  DECISION; harvest only its diagnostic. Replacement is the split
  `RawRuntimeOwnerAdapter`/`CodecRuntimeOwnerAdapter` slice.
- Blocks #305 merge: No (independent draft).

### P1-4 — Draft #301 is a stale, un-rebased parallel cutover overlapping #305

- Evidence: #301 (`codex/path-x-pr-c-native-cutover-main`) deletes
  `runtime-context-workflow.ts` (−56), rewrites
  `runtime-context-workflow-core.ts` (+160/−14), adds
  `internal/runtime-ingress-owner.ts` (+71), edits
  `session-runtime.ts` (+10/−7), `commands.ts`, `layers.ts`,
  `raw-process-runtime.ts` — all touched by #305 too. No monolithic
  supervisor (cleaner than #303) but it *edits* rather than deletes
  `session-runtime.ts` and predates the DECISION + the
  `PerContextRuntimeOutputWriter`.
- Violated clause: process/sequencing — two concurrent cutover branches
  vs the DECISION's single sequenced slice plan.
- Recommended action: **rebase-or-supersede.** Re-plan #301 on top of
  merged #305 + the split-adapter shape; keep its blocker doc as input.
- Blocks #305 merge: No; #305 should land first.

## P2 — Follow-up (non-blocking hygiene)

### P2-1 — Authority file imports a durable-tools internal type

- Evidence: pr-305
  `packages/runtime/src/agent-event-pipeline/authorities/runtime-output-journal.ts:13`
  `import type { RuntimeWaitSource } from "../../durable-tools/internal/types.ts"`
  (used at `:29` for `AgentOutputAfterSource`).
- Violated guidance: `packages/runtime/ARCHITECTURE.md` bounded-context
  separation (authorities ↔ durable-tools). Type-only, low severity.
- Action: when the journal authority is reshaped (deletion-map item 6),
  source `AgentOutputAfterSource` from a shared contract module instead
  of reaching into `durable-tools/internal`.

### P2-2 — host-sdk tests import the `@firegrid/runtime` root barrel

- Evidence: `packages/host-sdk/test/host/sync-run-integration.test.ts:35`,
  `test/agent-tools/tools.test.ts:36-37`,
  `test/agent-tools/tool-use-to-effect.test.ts:35-36`,
  `test/host/authority-context.test.ts:38`.
- Violated guidance: `SDD_FIREGRID_HOST_SDK.md` package-graph intent /
  barrel-import spirit. Pre-existing, tests only, not DECISION drift.
- Action: repoint to `@firegrid/runtime/host-substrate` / scoped
  subpaths when the legacy-deletion PR rewrites these tests.

## Superseded Findings (corrected after re-fetch)

The earlier audit on stale ref `88ba8f2fc` reported "legacy raw-process
still provides `RuntimeOutputJournalLayer`" and "`PerContextRuntimeOutputWriter`
added but unconsumed". **Both are invalid on latest `ed9b8300`:** the
journal layer is fully removed from `host-sdk/src`, and
`runRuntimeContext` consumes `PerContextRuntimeOutputWriter`
(`raw-process-runtime.ts:185`), adapting the legacy
`RuntimeEventAppendAndGet`/`RuntimeLogLineAppendAndGet`/`RuntimeAgentOutputRowSink`
tags onto the narrow writer.

## #305 Merge Verdict

**Mergeable after one mandatory pre-merge step**: rebase onto current
`origin/main` (P1-1) so it is evaluated against the ratified DECISION
and post-#302/#304 tree, and the spurious DECISION-doc deletion drops
out of the diff. Post-rebase, #305 is DECISION-compliant:

- removes the `RuntimeOutputJournalLayer` authority dependency from
  host-sdk entirely (slice-1 goal met, including the legacy path);
- adds the narrow `PerContextRuntimeOutputWriter` + `AgentOutputAfter`
  plumbing, consumed by the still-reachable legacy path;
- introduces no supervisor / command queue / monolith
  (no-second-mini-runtime satisfied);
- keeps the runtime read-side journal reshape/keep as intended.

One tracked follow-up (P1-2): the next sequenced slice must make the
legacy `runRuntimeContext` path unreachable and delete the
ingress-authority provides.

## Validation

- `pnpm run check:docs` — pass (this doc).
- Read-only sweep; no product code modified.
- #305 audited on re-fetched head `ed9b8300` (= coordinator-specified
  `ed9b8300cb389599d67afb8768b04eabd95fcda6`); boundary greps +
  `git show pr-305:…` + merge-base analysis.
</content>
