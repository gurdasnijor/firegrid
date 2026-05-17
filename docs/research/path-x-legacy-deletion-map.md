# Path X Legacy Deletion Map

Status: scout output / read-only analysis. Not an implementation PR.

Date: 2026-05-16

Base: `origin/main` @ `7ab037c24` (merge #298 "host-sdk dead-export cleanup").

Authoritative inputs read: `AGENTS.md`,
`docs/sdds/SDD_PATH_X_IMPLEMENTATION.md`,
`docs/sdds/SDD_FIREGRID_HOST_SDK.md`,
`features/firegrid/firegrid-host-sdk.feature.yaml`,
`packages/runtime/ARCHITECTURE.md`, and the host-sdk/runtime substrate code.

## Where We Actually Are

The SDK plane-split (SDD_FIREGRID_HOST_SDK PR A) **has landed**:
`packages/{client-sdk,host-sdk,cli,protocol,runtime}` exist and the
boundary holds.

Path X **PR A has landed** (#288/#289: durable workflow cause, ACP
permission `DurableDeferred`).

Path X **PR B "foundation" has landed** (`b0e8985d9`) but is **not the
PR B rewrite the SDD describes**. It added a *dead, unwired* reactive
body and left the entire legacy substrate live:

- `packages/host-sdk/src/host/runtime-context-workflow-core.ts` defines
  `RuntimeContextWorkflowNative` / `RuntimeContextWorkflowNativeLayer` —
  the reactive `WaitFor`-driven loop with `RuntimeToolUseExecutor`
  activities and a `RuntimeContextWorkflowSession` start/send seam.
- **No production module imports it.** `RuntimeContextWorkflowSession`
  has **no Live layer**.
- `FiregridRuntimeHostLive` (`packages/host-sdk/src/host/layers.ts:204`)
  still composes `RuntimeContextWorkflowLayer` (the legacy wrapper in
  `runtime-context-workflow.ts`), which runs `runRuntimeContext`
  (`raw-process-runtime.ts`) → legacy `runCodecRuntimeEventPipeline` /
  direct sandbox stream + `runIngressDelivery` + `runToolRouter` +
  `runStderrJournal` + the ingress-delivery / output-journal /
  ingress-appender authorities.

So **the full Path X PR B (reactive cutover) and PR C (cleanup) are
both still pending.** Everything below is the deletion map for that
remaining work. "PR B" = the reactive cutover that wires
`RuntimeContextWorkflowNativeLayer` and implements
`RuntimeContextWorkflowSession`; "PR C" = dead-surface/spec cleanup.

## Replacement Path X Surface (the keep side)

| Legacy responsibility | Path X replacement (already in tree) |
| --- | --- |
| `RuntimeContextWorkflowLayer` legacy wrapper | `RuntimeContextWorkflowNativeLayer` (`runtime-context-workflow-core.ts`) |
| `runRuntimeContext` activity body | `runWorkflowNativeRuntimeContext` reactive loop + `RuntimeContextWorkflowSession.start/send` activities |
| `runCodecRuntimeEventPipeline` forked subscribers | `runReactiveLoop` → `handleAgentOutput` → `runToolUseActivity` + `sendSessionActivity` |
| `runToolRouter` | `handleAgentOutput` ToolUse arm via `RuntimeToolUseExecutor` (seam preserved, already used by native body) |
| `runIngressDelivery` ingress-table claim/complete | content-derived `DurableDeferred` input completion via `RuntimeContextWorkflowSession.send` |
| `RuntimeOutputJournalLayer` as pipeline authority bundle | per-context side-channel output stream; `RuntimeAgentOutputEvents` observation **survives** as the `WaitFor` source |
| `appendRuntimeIngress` RuntimeIngressTable append | host-side `DurableDeferred` completion behind unchanged `session.prompt` |

Load-bearing keep: `runtime-wait-streams.ts` (`RuntimeWaitStreamsLive`)
consumes `RuntimeAgentOutputEvents` (output-journal) and optionally
`RuntimeIngressInputStream` (ingress-appender). The reactive loop's
`WaitFor.match({ source: { _tag: "AgentOutputAfter" }})` resolves
through this. **The output-table observation read path is not deletable
— it is the Path X observation substrate.**

## Per-Symbol Verdicts

### 1. `runRuntimeContext` — DELETE (PR B)

- Def: `packages/host-sdk/src/host/raw-process-runtime.ts:186`.
- Sole consumer: `runtime-context-workflow.ts:35` (legacy wrapper).
- Replacement: `runWorkflowNativeRuntimeContext` + the
  `RuntimeContextWorkflowSession` Live impl that PR B must write.
- Delete the whole `raw-process-runtime.ts` legacy path (`runRuntimeContext`,
  `runCodecRuntimeContext`, `outputRowFromProcessChunk`,
  `runtimeContextOutputTableLayer`, `sandboxSupervisorCommandTableLayer`)
  once the host composes `RuntimeContextWorkflowNativeLayer`.
- Blocking consumer to retarget first: `runtime-context-workflow.ts`.

### 2. `runCodecRuntimeEventPipeline` — DELETE (PR B)

- Def: `packages/runtime/src/agent-event-pipeline/session-runtime.ts:113`.
- Consumers: `raw-process-runtime.ts:172`; re-exported
  `runtime/host-substrate.ts:33` → root barrel.
- Replacement: codec-session activity boundary
  (`RuntimeContextWorkflowSession` impl) + reactive-loop tool dispatch.
- Delete the whole `session-runtime.ts` (it only exists to fork the
  legacy subscribers). Remove the `host-substrate.ts:32-34` re-export
  (PR C export removal; root barrel follows via `export *`).

### 3. `runIngressDelivery` — DELETE (PR B)

- Def: `packages/runtime/src/agent-event-pipeline/subscribers/ingress-delivery.ts:82`.
- Sole prod consumer: `session-runtime.ts:148` (deleted in #2).
- Replacement: `DurableDeferred` input completion.
- Delete the whole `subscribers/ingress-delivery.ts`. It also re-exports
  `runtimeIngressSubscriberId`; that helper moves with whatever (if
  anything) still needs subscriber ids — currently nothing after #2/#4.

### 4. `runToolRouter` — DELETE (PR B)

- Def: `packages/runtime/src/agent-event-pipeline/subscribers/tool-router.ts:50`.
- Sole prod consumer: `session-runtime.ts:154` (deleted in #2).
- Replacement: `handleAgentOutput` ToolUse arm in
  `runtime-context-workflow-core.ts` (already calls
  `RuntimeToolUseExecutor`). Seam (`RuntimeToolUseExecutor`) is KEPT.
- Delete the whole `subscribers/tool-router.ts`.
- Adjacent: `subscribers/stderr-journal.ts` (`runStderrJournal`) — same
  fate, sole consumer is `session-runtime.ts:141`. DELETE (PR B).
  `subscribers/index.ts` barrel loses three of four lines; keep
  `runtime-tool-use-executor.ts`.

### 5. `RuntimeIngressDeliveryTrackerLayer` + `RuntimeIngressDeliveryClaimAndComplete` (+ `RuntimeIngressDeliveries`) — DELETE (PR C, after PR B)

- Def: `packages/runtime/src/agent-event-pipeline/authorities/runtime-ingress-delivery-tracker.ts`.
- Prod consumers:
  - `raw-process-runtime.ts:28,182` (deleted #1)
  - `ingress-delivery.ts:8` subscriber (deleted #3)
  - `runtime-substrate.ts:12,47` — wired into
    `HostRuntimeObservationSubstrateLive`. **Blocking**: PR B must drop
    `RuntimeIngressDeliveryTrackerLayer` from that `Layer.mergeAll`.
  - `host-substrate.ts:60-65` re-export → root barrel.
- Replacement: `DurableDeferred` first-writer-wins (SDD: "at-most-once
  delivery enforced by workflow activities and activity claims").
- Delete the whole tracker authority file in PR C; remove the
  `host-substrate.ts` re-export block.

### 6. `RuntimeOutputJournalLayer` — INTERNALIZE / RESHAPE, net KEEP (PR B reshape, PR C trim) — HIGHEST UNCERTAINTY

- Def: `packages/runtime/src/agent-event-pipeline/authorities/runtime-output-journal.ts`.
- **Do not whole-delete.** `RuntimeAgentOutputEvents` is consumed by
  `runtime-wait-streams.ts:20` (`RuntimeWaitStreamsLive`) — the typed
  wait-source the Path X reactive loop's `WaitFor` AgentOutputAfter
  depends on. The output-table observation read path is Path X
  substrate.
- Legacy-only tags to delete: `RuntimeAgentOutputRowSink` (only
  `session-runtime.ts:8`, deleted #2), `RuntimeEventAppendAndGet` /
  `RuntimeLogLineAppendAndGet` (only `raw-process-runtime.ts:19-22`,
  deleted #1), `RuntimeLogLineSink`. Survivors: `RuntimeAgentOutputEvents`,
  `RuntimeOutputEvents`, `RuntimeOutputLogs`, plus a side-channel
  output **writer** the new `RuntimeContextWorkflowSession` impl uses.
- Net: reshape to "side-channel output write + typed observation
  streams", drop legacy append/sink tags. Trim `host-substrate.ts:66-76`
  re-export to survivors.
- Uncertainty: exact write shape depends on the PR B
  `RuntimeContextWorkflowSession` codec-session boundary design (the
  SDD Q-2 proof). Flag for PR B owner; do not delete the read side.

### 7. `appendRuntimeIngress` — INTERNALIZE / REWRITE, keep name (PR B)

- Def: `packages/host-sdk/src/host/commands.ts:114`; public export
  `host-sdk/src/host/index.ts:43`.
- Prod consumers: `commands.ts` itself; client-sdk drives the same
  routing behind `session.prompt`; cli `run.ts` comments reference it.
- SDD invariant kept: cross-host prompt routing at session level; a
  non-owner host submits input an owner workflow receives. The public
  name/signature stays; the body rewrites from `RuntimeIngressTable`
  append to a content-derived `DurableDeferred` completion.
- Verdict: keep the seam, rewrite internals in PR B. Do not delete.

### 8. `appendRuntimeIngressToOwner` — INTERNALIZE / REWRITE (PR B)

- Def: `packages/host-sdk/src/host/commands.ts:140`.
- Consumers: `commands.ts:137` (via #7);
  **`agent-tool-host-live.ts:202`** (`schedule_me` / child-session
  prompt append) — blocking consumer that must move to the deferred
  write in the same PR B.
- Same verdict as #7; `ownerIngressLayer` (`commands.ts:41`) and the
  `RuntimeIngressTable` layering die with the rewrite.

### 9. `hostOwnedStreamUrl` / `durableStreamUrl` / `runtimeControlPlaneStreamUrl` — KEEP ALL (no deletion)

- Def: `packages/protocol/src/launch/authority.ts:422/429/436`.
- Pure protocol-owned stream-name encoders, not "old path" authority.
- `durableStreamUrl`: app tables (`apps/factory/src/host.ts:156`),
  workflow, control plane, side-channel output — all still need it.
- `runtimeControlPlaneStreamUrl`: control-plane URL used by client-sdk
  (`firegrid.ts:290`), host layers — KEEP.
- `hostOwnedStreamUrl`: still needed for `workflow` and `durableTools`
  segments. The **legacy bit is not the helper** — it is the
  `segment: "runtimeIngress"` `RuntimeIngressTable` layering on top of
  it (`commands.ts:50` `ownerIngressLayer`, `layers.ts:127`
  `hostOwnedIngressLayer`, `client-sdk/firegrid.ts:327`
  `hostOwnedStreamOptions`). Those ingress-table layers die with #5/#7;
  the URL helpers do not.

### 10. host-substrate / root exports keeping the old path callable — DELETE export lines (PR C)

- `packages/runtime/src/host-substrate.ts`: delete the re-export blocks
  for the deleted symbols — `runCodecRuntimeEventPipeline` (32-34),
  ingress-delivery-tracker block (60-65), trim output-journal block
  (66-76) to survivors, trim ingress-appender block (53-59) to whatever
  the deferred rewrite keeps.
- `packages/runtime/src/index.ts` re-exports `host-substrate.ts` via
  `export *` — auto-follows; only its hand-written comment block needs
  updating.
- `packages/host-sdk/src/host/index.ts` / `runtime-substrate.ts` lose
  the deleted-symbol imports.
- Also adjacent (not in the scout list but "keeps old path callable"):
  `runtime-ingress-appender.ts` (`RuntimeIngressAppenderLayer`,
  `RuntimeIngressAppendAndGet`, `RuntimeIngressInputStream(Layer)`) —
  the `RuntimeIngressTable` *input* authority the deferred model
  replaces. Consumed by deleted #1/#3/#4 and by `commands.ts` (#7/#8),
  `local-process-stdin-delivery.ts:30` (PR B rewrites stdin to
  activity-backed per SDD), and optionally `runtime-wait-streams.ts:18`.
  Verdict: INTERNALIZE in PR B, DELETE/trim in PR C; `RuntimeIngressInputStream`
  may survive as the optional `runtimeIngressInput` wait source until a
  product flow needs it (already `Effect.serviceOption`). Uncertainty
  flagged — coupled to the PR B deferred-input design.

## Test Files: delete / rewrite candidates

| File | Verdict | PR | Reason |
| --- | --- | --- | --- |
| `packages/runtime/test/authorities/runtime-ingress-authorities.test.ts` | DELETE | C | asserts deleted `RuntimeIngressDeliveryClaimAndComplete`/`TrackerLayer` table mechanics |
| `packages/runtime/test/subscribers/tool-router.test.ts` | DELETE | C | tests deleted `runToolRouter` + `RuntimeOutputJournalLayer`; behavior re-covered by native loop test |
| `packages/runtime/test/authorities/provider-uniqueness.test.ts` | REWRITE | C | drop deleted-authority provider rows (`RuntimeIngressDeliveryTrackerLayer`), keep survivors |
| `packages/runtime/test/sources/sandbox/local-process-stdin-delivery.test.ts` | REWRITE | B | SDD mandates rewrite to assert the activity-backed at-most-once invariant |
| `packages/host-sdk/test/host/runtime-codec-event-plane.test.ts` | REWRITE | B | asserts legacy codec-event-plane + `appendRuntimeIngress` mechanics |
| `packages/host-sdk/test/host/prompt-routing.test.ts` | REWRITE | B | asserts old ingress-table routing; rebuild on deferred + session shape |
| `packages/host-sdk/test/host/sync-run-integration.test.ts` | REWRITE | B | exercises legacy `appendRuntimeIngress` + startRuntime substrate |
| `packages/host-sdk/test/host/runtime-context-workflow-core.test.ts` | KEEP, ADJUST | B | replacement test for `RuntimeContextWorkflowNative`; update when output-journal reshapes (it currently provides `RuntimeOutputJournalLayer`) |
| `packages/protocol/test/launch/authority.test.ts` | KEEP | — | URL encoders stay |
| `packages/client-sdk/test/firegrid.sessions.test.ts` | KEEP, maybe adjust | B | `runtimeControlPlaneStreamUrl` stays; revisit any ingress-shaped assertions |

## Recommended PR Split

**PR B (reactive cutover, by-revert-only):** wire
`RuntimeContextWorkflowNativeLayer` into `FiregridRuntimeHostLive`;
implement `RuntimeContextWorkflowSession` Live (codec-session activity
boundary, Q-2 proof shape); delete `raw-process-runtime.ts`,
`session-runtime.ts`, `subscribers/{ingress-delivery,tool-router,stderr-journal}.ts`,
legacy `runtime-context-workflow.ts`; rewrite
`appendRuntimeIngress`/`appendRuntimeIngressToOwner` +
`agent-tool-host-live` + `local-process-stdin-delivery` to the deferred
model; reshape the output-journal write side; rewrite the four B-marked
tests.

**PR C (cleanup + spec):** delete `runtime-ingress-delivery-tracker.ts`,
trim `runtime-output-journal.ts` / `runtime-ingress-appender.ts` to
survivors, remove dead re-export lines in `host-substrate.ts` +
`host-sdk` index/substrate, delete the two C-marked tests, rewrite
`provider-uniqueness.test.ts`, update `ARCHITECTURE.md`,
`agent-event-pipeline/README.md`, SDD/spec
(`RUNTIME_CAPABILITY_PROJECTIONS` + `SEQUENCING.12` superseded), run
dep/dead/docs/specs/semgrep.

## Native Supervisor Cutover — Prioritized Delete Blockers

Coordinator-priority view of the five core deletions. **Headline: none
of the five delete targets is product public API. Every consumer is old
internal substrate mechanics.** The only adjacent *kept* public/seam
surfaces are `appendRuntimeIngress` (host-sdk public, behind
`session.prompt`), `RuntimeToolUseExecutor` (host-substrate seam,
host-sdk provides Live, native loop already uses it), and the
**new** `RuntimeContextWorkflowSession` seam the cutover must implement
— that service *is* the native supervisor and the replacement owner for
all five.

Priority order = unblock sequence.

### P0 — `RuntimeContextWorkflowSession` Live impl (the supervisor itself)

Not a deletion; the gating prerequisite. Until it exists,
`RuntimeContextWorkflowNativeLayer` is dead and nothing below can be
deleted. Owner of the deleted behavior:

- `start(context, attempt)` — owns codec-session + sandbox process
  lifecycle (replaces `runRuntimeContext` + `runCodecRuntimeEventPipeline`
  process/codec setup + `runStderrJournal`), writes output rows the
  side-channel/`RuntimeAgentOutputEvents` observation reads.
- `send(context, attempt, event)` — owns input application into the
  codec (replaces `runIngressDelivery`'s "deliver claimed input to
  `session.send`"); invoked by the reactive loop's `sendSessionActivity`
  for both prompt input and tool results.

### P1 — `runToolRouter` / `tool-router.ts` — DELETE, no blocker

- Consumer classification: `session-runtime.ts:154` (old internal
  mechanics, deleted in P3); `test/subscribers/tool-router.test.ts`
  (internal test). **Zero public API consumers.**
- Replacement owner: `runtime-context-workflow-core.ts`
  `handleAgentOutput` ToolUse arm → `runToolUseActivity`
  (`RuntimeToolUseExecutor` seam, **already wired in the native body**)
  → `sendSessionActivity`. Replacement already exists; this is the
  lowest-risk delete once P0/P3 land.

### P2 — `runIngressDelivery` / `ingress-delivery.ts` — DELETE

- Consumer classification: `session-runtime.ts:148` (old internal
  mechanics, deleted P3); `test` only. **Zero public API consumers.**
- Replacement owner: `RuntimeContextWorkflowSession.send` (P0). Input
  no longer arrives via `RuntimeIngressTable` claim/complete; it arrives
  as a content-derived `DurableDeferred` completion that the reactive
  loop turns into a `sendSessionActivity`. The public entry that feeds
  it — `appendRuntimeIngress` — is **kept and rewritten** (#7), so the
  cross-host routing public contract is preserved while the internal
  delivery subscriber is deleted.

### P3 — `runCodecRuntimeEventPipeline` / `session-runtime.ts` — DELETE

- Consumer classification: `raw-process-runtime.ts:172` (internal,
  deleted P4); `runtime/host-substrate.ts:33` re-export → root barrel.
  The host-substrate re-export is **internal composition surface
  consumed only by host-sdk composition**, *not* product public API
  (browser/client cannot import it; PACKAGE_GRAPH.3). Safe to delete the
  export line. **Zero product public API consumers.**
- Replacement owner: `RuntimeContextWorkflowSession.start` (codec
  session lifecycle) + the reactive loop (output observation + tool
  dispatch). Blocker: P0.

### P4 — `runRuntimeContext` / `raw-process-runtime.ts` — DELETE

- Consumer classification: `runtime-context-workflow.ts:35` — the
  **legacy workflow wrapper**, pure old internal mechanics, itself
  deleted in the cutover (replaced by `RuntimeContextWorkflowNativeLayer`).
  **Zero public API consumers.**
- Replacement owner: `RuntimeContextWorkflowSession.start` absorbs the
  raw sandbox spawn / stdin / output-row construction; the workflow
  shell is `runWorkflowNativeRuntimeContext`. Blocker: P0; and
  `layers.ts:204` must swap `RuntimeContextWorkflowLayer` →
  `RuntimeContextWorkflowNativeLayer` in the same change (the real
  flip-the-switch step).

### Real public API vs old internal mechanics — net

| Surface | Class | Cutover action |
| --- | --- | --- |
| `runRuntimeContext`, `runCodecRuntimeEventPipeline`, `runIngressDelivery`, `runToolRouter`, `runStderrJournal` | old internal mechanics | DELETE |
| `runtime-context-workflow.ts` legacy `RuntimeContextWorkflowLayer` | old internal mechanics | DELETE (swap to Native) |
| `host-substrate.ts` re-exports of the above | internal composition surface (host-sdk-only, not product public) | DELETE export lines |
| `appendRuntimeIngress` / `appendRuntimeIngressToOwner` | **public seam** (host-sdk export, behind `session.prompt`; `agent-tool-host-live` `schedule_me`) | KEEP name, rewrite body to deferred |
| `RuntimeToolUseExecutor` | **kept seam** (host-sdk provides Live; native loop already consumes) | KEEP unchanged |
| `RuntimeContextWorkflowSession` | **new internal supervisor seam** | IMPLEMENT (replacement owner for all five) |

## Blockers / Uncertainty

1. **PR B has no `RuntimeContextWorkflowSession` Live impl.** The
   reactive body is dead until the codec-session activity boundary
   (SDD Q-2 proof) is built. That is the gating unknown for #1/#2/#6.
2. **Output-journal is partially load-bearing** (#6). Naive whole-file
   deletion breaks `RuntimeWaitStreamsLive` and the reactive loop's
   `WaitFor` source. Verdict is reshape, not delete; exact write shape
   pending the PR B codec boundary.
3. **Ingress-appender survival** (#10) is coupled to the deferred-input
   design; `RuntimeIngressInputStream` may persist as the optional
   wait-router source.
4. Cross-host prompt routing (SDD invariant) must stay green through
   the `appendRuntimeIngress` rewrite (#7/#8) — `agent-tool-host-live`
   `schedule_me` is the concrete blocking consumer.
5. `RuntimeIngressTable` protocol schema becomes unused after the
   deferred cutover; greenfield rules say no row migrations, so treat
   schema retirement as low-priority PR C protocol cleanup, not a
   blocker.
</content>
</invoke>
