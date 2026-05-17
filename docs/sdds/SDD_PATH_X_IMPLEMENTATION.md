# SDD: Path X Workflow-Native Runtime Substrate Implementation

Status: revised to the ratified live-owner shape. The original
three-PR plan (PR A / Q-2 / PR B / PR C) has been superseded by the
process-ownership retreat decision and the live-owner cutover now in
flight as #309.

Date: 2026-05-17

Authoritative inputs:

- `docs/sdds/DECISION_PATH_X_PROCESS_OWNERSHIP.md` (ratified decision)
- `docs/research/path-x-legacy-deletion-map.md`
- `docs/research/path-x-architecture-drift-sweep-2026-05-17.md`
- `docs/research/workflow-native-runtime-substrate-spike-2026-05-16.md`
- `docs/research/workflow-engine-audit.md`
- `docs/research/durability-assumption-audit-2026-05-16.md`

Related specs:

- `firegrid-host-sdk`
- `firegrid-schema-projection-contract`
- `firegrid-runtime-agent-event-pipeline`
- `firegrid-runtime-boundary-reconciliation`
- `firegrid-workflow-driven-runtime`
- `workflow-engine-durable-state`

## Decision

Path X is the implementation target, but its scope is bounded by
`DECISION_PATH_X_PROCESS_OWNERSHIP.md`: **the reactive workflow body is
the durable control plane only; it is not the live process actor.**

- The workflow owns durable run state (`RuntimeRun.started/failed/
  exited`), content-derived `DurableDeferred` decisions for input,
  permission, and tool round-trips, activity-backed tool execution via
  `RuntimeToolUseExecutor`, `Workflow.SuspendOnFailure` with durable
  cause, and cross-restart recovery.
- A **host-scoped live owner** (`RuntimeContextSession`) owns the
  raw/codec process and session loops, stdin / JSON-RPC emission,
  in-memory attachment, and the output pump. The workflow reaches it
  only through two short activities: `startOrAttach(context,
  activityAttempt)` and `send(context, activityAttempt, command)`.
- No second mini-runtime: no monolithic raw+codec supervisor, no
  generic workflow↔owner command queue as shared substrate, no host-sdk
  dependency on `RuntimeOutputJournalLayer` as an authority layer, no
  `runRuntimeContext` / `runCodecRuntimeEventPipeline` fallback.

This remains a greenfield cutover: no dual-write, no compatibility
writers, no divergence detection, no public-surface preservation matrix.
The public session method shape (`sessions.createOrLoad`,
`session.prompt`, `session.wait.*`, `session.permissions.respond`,
`session.snapshot`, `watchContexts`) is unchanged.

## Live-Owner Shape (Ratified)

The runtime-context workflow is `RuntimeContextWorkflowNative`
(`packages/host-sdk/src/host/runtime-context-workflow-core.ts`):

- reactive loop drives off `WaitFor.match<RuntimeAgentOutputObservation>`
  with a typed `{ _tag: "AgentOutputAfter" }` source;
- `handleAgentOutput` dispatches `ToolUse` through a
  `RuntimeToolUseExecutor` activity and returns the result via `send`;
- terminal output writes `RuntimeRun.exited`; recoverable failure
  suspends with durable cause.

The live owner is `RuntimeContextSession`
(`packages/host-sdk/src/host/runtime-context-session/`):

- `common.ts` — the shared seam: `RuntimeContextWorkflowSession`
  service, `makeRuntimeContextWorkflowSessionService`,
  `makeRuntimeContextSessionAdapterService`,
  `scopedRuntimeContextWorkflowSessionLayer`, an owner-kind
  (`"raw" | "codec"`) attach registry keyed by `{ contextId,
  activityAttempt }`, and a per-command durable claim
  (`claimRuntimeContextSessionCommand`) taken before any external
  byte / JSON-RPC emission. The registry exists for production
  correctness: a replayed cached `startOrAttach` result must reattach
  or rebuild an owner against an empty in-memory registry after engine
  restart.
- `raw-adapter.ts` — `RawRuntimeOwnerAdapter`: local-process spawn,
  stdin byte encoding, stdout/stderr capture, synthetic terminal
  emission. No ACP/JSON-RPC framing.
- `codec-adapter.ts` — `CodecRuntimeOwnerAdapter`: `AgentByteStream`,
  `AgentSession`, ACP / stdio-jsonl framing, typed `AgentInputEvent`
  sends. No raw prompt-to-line encoding.

Per-context output is written through the narrow host-sdk
`PerContextRuntimeOutputWriter`; the workflow observes it via the
`RuntimeAgentOutputAfterEvents` / `RuntimeAgentOutputEvents` read-side
(curated `@firegrid/runtime/runtime-output`), never the old journal
authority bundle.

## Scoped Runtime Subpaths

The `@firegrid/runtime/host-substrate` mega-barrel is retired. Host-sdk
composes the substrate through narrow role-scoped subpaths
(`packages/runtime/package.json` exports):

| Subpath | Source | Role |
| --- | --- | --- |
| `@firegrid/runtime/errors` | `src/runtime-errors.ts` | runtime-context / ingress error vocabulary |
| `@firegrid/runtime/tool-executor` | `…/subscribers/runtime-tool-use-executor.ts` | the `RuntimeToolUseExecutor` seam tag |
| `@firegrid/runtime/control-plane` | `src/authorities/index.ts` | durable context/run authorities |
| `@firegrid/runtime/runtime-output` | `…/authorities/runtime-output-public.ts` | curated KEPT observation surface only |
| `@firegrid/runtime/runtime-ingress` | `…/authorities/runtime-ingress-appender.ts` | **transient**: until the deferred-input rewrite |
| `@firegrid/runtime/workflow-engine` | `src/workflow-engine/index.ts` | `DurableStreamsWorkflowEngine` |

`runtime-output-public.ts` deliberately exports only the KEPT set
(`RuntimeAgentOutputAfterEvents`, `RuntimeAgentOutputEvents`,
`RuntimeAgentOutputEventsLayer`, `RuntimeAgentOutputObservation`) and
excludes the legacy shims so the dead path cannot be resurrected.
Legacy symbols (`runCodecRuntimeEventPipeline`,
`RuntimeIngressDeliveryTrackerLayer`, `RuntimeAgentOutputRowSink`,
`RuntimeLogLineAppendAndGet`) intentionally receive **no** scoped
subpath; they are deleted with the spine, not re-pathed.

## Actual Landed Sequence

1. **Engine confidence + durable ACP permission fix — landed**
   (#288/#289): durable workflow `cause`, content-derived
   `DurableDeferred` ACP permission continuations, engine replay
   coverage.
2. **Per-context output writer — landed** (#305 → #307 → #308):
   `PerContextRuntimeOutputWriter` + `AgentOutputAfter` plumbing;
   `RuntimeOutputJournalLayer` removed from `packages/host-sdk/src`;
   orphaned output-journal bundle and the raw `RuntimeEventAppendAndGet`
   edge deleted.
3. **Scoped runtime subpaths — landed on the cutover base** (#309):
   the six subpaths above; KEPT symbols re-pathed off `host-substrate`.
4. **Live-owner cutover — in flight as #309**: replaces the legacy
   spine with `RuntimeContextWorkflowNative` + `RuntimeContextSession`
   Raw/Codec adapters and deletes the old spine (see below).

## Old Spine Deleted in #309

#309 deletes, not deprecates:

- `packages/host-sdk/src/host/raw-process-runtime.ts`
  (`runRuntimeContext`);
- `packages/host-sdk/src/host/runtime-context-workflow.ts` (legacy
  `RuntimeContextWorkflowLayer` wrapper);
- `packages/runtime/src/agent-event-pipeline/session-runtime.ts`
  (`runCodecRuntimeEventPipeline`);
- `…/subscribers/ingress-delivery.ts` (`runIngressDelivery`),
  `…/subscribers/tool-router.ts` (`runToolRouter`),
  `…/subscribers/stderr-journal.ts` (`runStderrJournal`);
- `…/authorities/runtime-ingress-delivery-tracker.ts`;
- `packages/runtime/src/host-substrate.ts` (the barrel itself);
- the legacy-only tests (`tool-router.test.ts`, the deleted-mechanics
  rows of `runtime-ingress-authorities.test.ts` /
  `provider-uniqueness.test.ts`).

`transforms/ingress-to-agent-input.ts` is trimmed to the surviving
shaping used by the adapters. `layers.ts` flips composition to
`RuntimeContextWorkflowNativeLayer` + the `RuntimeContextSession`
scoped layer.

## Remaining Work: Deferred-Input Rewrite

`appendRuntimeIngress` / `appendRuntimeIngressToOwner` are **RESHAPE /
KEEP**, not yet converted. They remain `RuntimeIngressTable`-backed
behind the unchanged public `session.prompt`, and `agent-tool-host-live`
`schedule_me` still routes through `appendRuntimeIngressToOwner`. The
final slice:

- replaces the `RuntimeIngressTable` append with a content-derived
  `DurableDeferred` completion the reactive loop turns into a `send`;
- keeps `session.prompt` / cross-host routing semantics identical
  (a non-owner host completing the owner workflow's input deferred);
- keeps the `@firegrid/client-sdk` session API stable — client-sdk
  must not learn the deferred mechanics;
- then deletes the transient `@firegrid/runtime/runtime-ingress`
  subpath and `runtime-ingress-appender.ts`.

Until that lands, `runtime-ingress` is the only remaining transient
substrate edge; everything else in the spine is gone after #309.

## Schema-Based Transform Guidance

Runtime-boundary evidence and command shapes are Effect `Schema`
values, not hand-rolled interfaces. The live-owner seam already follows
this: `RuntimeContextSessionStartedEvidence` and
`RuntimeContextSessionCommandAccepted` are
`Schema.Schema.Type<typeof …Schema>` over `Schema.Struct`, and the
`startOrAttach` / `send` activities use those schemas as their
`success` type so replay decode is total.

Guidance for the deferred-input rewrite and any further transforms:

- Model every cross-boundary payload (deferred input commands,
  ingress→agent-input shaping in
  `transforms/ingress-to-agent-input.ts`) as a `Schema.Struct` /
  tagged union; derive the TS type with `Schema.Schema.Type`, never a
  parallel hand-written interface.
- Decode at the boundary with `Schema.decodeUnknown` (or
  `decodeUnknownSync` only where the value is already trusted and the
  failure is a defect) and return `ParseResult` failures through the
  typed error channel; do not `as`-cast workflow payloads.
- Use `Schema.transformOrFail` for ingress-row → `AgentInputEvent`
  shaping so encode/decode stay inverse and replay-stable; keep the
  transform pure and total.
- Prefer `Schema.TaggedError` / `Schema.TaggedClass` for
  runtime-context error and command variants so `Match`-based handling
  in the reactive loop stays exhaustive.

Style reference (read-only, do not edit): the vendored Effect Schema
tests under `repos/effect/packages/effect/test/Schema/` — in particular
the `Schema/` transformation cases, `ParseResult.test.ts`, and
`ParseResultFormatter.test.ts` — are the authoritative idiom for
`transformOrFail`, decode error handling, and tagged-union schemas.
Follow `repos/effect/AGENTS.md` and those examples over generated
guesses, per the repo's vendored-reference rule. No `repos/` edits.

## Invariants

- `@firegrid/runtime` does not import `@firegrid/host-sdk`,
  `@firegrid/client-sdk`, or `@firegrid/cli`.
- host-sdk and client-sdk remain sibling projections over protocol;
  browser/client code does not import runtime, host-sdk, Node, Effect
  AI, MCP, or platform-node.
- Tool execution stays on `RuntimeToolUseExecutor`; `schedule_me`
  continues through the executor / live host composition.
- Cross-host prompt routing remains true at the session level.
- After #309: dead-code and dependency checks see the old spine and
  `host-substrate` barrel as gone; only the `runtime-ingress` transient
  subpath remains pending the deferred-input rewrite.

## Summary

The plan is now: (1) engine + permission fix — landed; (2) per-context
output writer — landed; (3) scoped runtime subpaths — landed on the
cutover base; (4) live-owner cutover deleting the old spine and adding
`RuntimeContextWorkflowNative` + `RuntimeContextSession` Raw/Codec
adapters — in flight as #309; (5) deferred-input rewrite of
`appendRuntimeIngress` and retirement of the transient
`@firegrid/runtime/runtime-ingress` subpath — remaining. The public
session API is unchanged throughout.
</content>
