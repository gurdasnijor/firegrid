> **HISTORICAL (pre-#765).** References paths deleted in #765 (packages/substrate, packages/host-sdk/src/host, and legacy packages/runtime/src/{subscribers,durable-tools,workflow-engine,agent-event-pipeline,agent-tools,runtime-host,composition}); kept for provenance. Current architecture: docs/cannon/.

# SDD: Wait Router Per-Context Output

## §0 — The load-bearing question, read this first

**Should the non-After `AgentOutput` wait-router arm resolve against per-context output streams, aligning with post-#315 writes, or against the host-prefixed runtime output stream; and what is the minimal sound change?**

This is the TFIND-012 / Beads `tf-8rp` framing question. Current status lives in the Beads DB (`bv --robot-triage` / `br`, join key `tfind:012`); no deleted Markdown ledger is authoritative.

Coordinator recommendation: choose **B: per-context output routing as the production contract, with the host-prefixed stream treated as dead compatibility residue until its structural dependency can be removed**. The minimal sound production behavior is: a non-After `AgentOutput` wait must identify a `contextId`, the wait router must observe that context's runtime output stream, and the host-prefixed `RuntimeOutputTable` must not be a production source of truth for agent output.

This does not need a code experiment to answer at framing time. The code evidence is direct: post-#315 writers append per-context rows, and the host-prefixed stream is documented in code as a no-writer A4 residue. Implementation signoff still needs to decide whether the next PR merely ratifies the already-landed per-context path with cleanup/tests, or removes the host-prefixed fallback/dependency outright.

## Status

Status: draft framing for coordinator/Gurdas signoff. No production code is in scope for this PR.

Finding: TFIND-012, Beads `tf-8rp`, label `tfind:012`, factory-supports.

Related specs:

- `firegrid-typed-wait-source-redesign.WAIT_ROUTER.1`
- `firegrid-host-context-authority.SCHEMA_STREAM_AUTHORITY.2`
- `firegrid-factory-aligned-agent-tools.WAIT_FOR.4`
- `firegrid-factory-aligned-agent-tools.WAIT_FOR.5`

## Current Evidence

The wait-router decision point is `packages/runtime/src/durable-tools/internal/wait-router.ts:92-104`. The non-After `AgentOutput` arm reads the `contextId` predicate from the wait trigger and calls `streams.agentOutputForContext(contextId)` when present. Its degenerate no-context fallback still calls `streams.agentOutput`, which is the host-prefixed runtime output stream.

`packages/runtime/src/durable-tools/internal/runtime-wait-streams.ts:58-78` documents the fallback problem explicitly: the `agentOutput` stream is `RuntimeAgentOutputEvents` over the ambient `RuntimeOutputTable`, i.e. the host-prefixed `...firegrid.host.{hostId}.runtimeOutput` stream. Post-#315 production writes do not target that stream; the `onNone` fallback exists to keep non-production/unit harness layers constructible when the per-context service is absent.

The production per-context observation provider is `packages/host-sdk/src/host/per-context-runtime-output.ts:105-178`. Its `forContext` method opens the runtime output table at `{prefix}.runtimeOutput.context.{contextId}` and streams decoded `RuntimeAgentOutputObservation` rows for that context.

The production write site is the same module: `packages/host-sdk/src/host/per-context-runtime-output.ts:41-58` constructs the per-context `RuntimeOutputTable.layer`, and `packages/host-sdk/src/host/per-context-runtime-output.ts:73-103` appends agent event rows through that per-context table.

The stream-name contract is in `packages/protocol/src/launch/authority.ts:254-270`, which requires runtime context output stream names to be `{prefix}.runtimeOutput.context.{contextId}`. `packages/protocol/test/launch/authority.test.ts:219-253` and `:310-315` prove encoding/decoding and URL construction for that per-context output side-channel.

The A4 residue is visible in `packages/host-sdk/src/host/layers.ts:148-164`: the host-owned output layer binds ambient `RuntimeOutputTable` to `...firegrid.host.{hostId}.runtimeOutput`, but the comment says nothing writes it post-#315 and it remains only because `RuntimeWaitStreamsLive` has a structural dependency on `RuntimeAgentOutputEventsLayer`.

The regression shape is captured in `packages/host-sdk/test/host/runtime-observation-sources.test.ts:107-117`: a `PermissionRequest` row written through the production per-context stream used to be missed when the wait observed the unwritten host-prefixed stream. The tiny model at `packages/tiny-firegrid/test/wait-for-output-pipeline.test.ts:5-28` frames the toy-level target as resolving `AgentOutput` sources against per-context output targets.

## Options

### A. Preserve host-prefixed `AgentOutput` routing

Under A, the non-After `AgentOutput` source continues to resolve through the ambient host-prefixed `RuntimeOutputTable` as a valid production path.

Benefits:

- Smallest apparent diff if the old model is treated as still authoritative.
- Keeps context selection entirely in row predicates rather than stream selection.
- Avoids touching the `RuntimeWaitStreamsLive` dependency on `RuntimeAgentOutputEvents`.

Costs:

- Contradicts post-#315 write topology: production output rows are written per-context, not to the host-prefixed stream.
- Recreates the observed failure mode: waits can hang until timeout while the matching row exists in the per-context stream.
- Keeps A4 host-vs-context residue in the hot path instead of quarantining it as cleanup debt.
- Makes the toy wait-for-output model misleading because it would model a per-context target that production does not actually observe.

Choose A only if production deliberately reintroduces a host-wide output journal writer. That is not the current architecture.

### B. Route non-After `AgentOutput` through the trigger `contextId`

Under B, `AgentOutput` remains the attempt-agnostic wait source, but production requires a `contextId` predicate and uses that predicate to select the per-context output stream. `evaluateFieldEquals` still performs final row matching. The host-prefixed `agentOutput` stream may remain only as a dead compatibility fallback while the structural dependency is unwound.

Benefits:

- Aligns read topology with post-#315 writes.
- Preserves the existing typed wait-source shape: `AgentOutput` means "all output for a context"; `AgentOutputAfter` remains explicit about context, activity attempt, and sequence.
- Keeps the minimal implementation local to wait-source resolution, guardrails, and tests.
- Matches the current production guard in `packages/host-sdk/src/agent-tools/execution/tool-use-to-effect.ts:216-240`, which rejects contextless `AgentOutput` waits for the `wait_for` tool.

Costs:

- The `contextId` precondition is implicit in the trigger rather than encoded in the `AgentOutput` source variant.
- Internal callers can still construct a contextless `AgentOutput` wait unless the boundary is tightened further.
- The host-prefixed fallback and ambient `RuntimeAgentOutputEventsLayer` dependency remain confusing until a cleanup slice removes or isolates them.

Choose B if the minimal sound change is to align production behavior now without expanding the typed-source schema.

### C. Encode context in the `AgentOutput` source and delete the fallback

Under C, `AgentOutput` itself grows `contextId` or splits into a new per-context source variant. The router no longer recovers context from the trigger, and `streams.agentOutput` / ambient host-prefixed output are removed from the production wait-source bundle.

Benefits:

- Makes illegal states unrepresentable: every `AgentOutput` wait source names the stream it observes.
- Removes the A4 fallback from the router instead of documenting it as dead.
- Simplifies future reviews because row predicates no longer double as stream authority.

Costs:

- Larger schema/API migration than TFIND-012 needs for the production drift.
- Requires updating persisted wait-source schemas, callers, tests, and possibly protocol-facing examples.
- Risks coupling this targeted drift fix to a broader typed-wait-source redesign.

Choose C as a follow-up cleanup if Gurdas wants the source schema to carry stream authority, not as the minimal TFIND-012 unblock.

## Recommendation

The coordinator recommendation is **B now, C later if desired**.

Production should treat `AgentOutput` waits as per-context observations. The minimal sound rule is:

1. `AgentOutputAfter` continues to use the explicit `contextId`, `activityAttempt`, and `afterSequence` fields already on the source.
2. Non-After `AgentOutput` must resolve to `agentOutputForContext(contextId)` using a required `contextId` predicate.
3. Contextless `AgentOutput` waits must be rejected at public/tool boundaries and must not silently observe the host-prefixed stream in production.
4. The host-prefixed `RuntimeOutputTable` dependency is A4 residue only; do not add writes or new behavior to it.

This answer keeps the toy framing honest: the toy should model the production target as per-context output, but the production finding is real because the old host-prefixed read path would miss rows that post-#315 production writes only to per-context streams.

## Secondary Questions After §0

1. Should the immediate implementation remove the `streams.agentOutput` field from `RuntimeWaitStreamsService`, or leave it as an explicitly dead fallback until a separate structural cleanup?
2. Should internal `WaitFor.match` calls reject contextless `AgentOutput`, or is public/tool boundary validation sufficient for the first slice?
3. Should `AgentOutput` grow `contextId` in the persisted wait-source schema, or should `contextId` remain a trigger predicate to preserve the typed-source redesign's source/predicate split?
4. Which regression test is the merge gate: a host-sdk production-substrate test like `runtime-observation-sources.test.ts`, the tiny pipeline, or both?
5. Should the stale comment references to the missing `docs/research/host-vs-context-boundary-audit.md §A4` become a short checked-in research note, or should they be repointed to this SDD after signoff?

## Acceptance Bar For The Follow-Up Implementation

The implementation PR that follows this framing should prove:

- a row written only to `{prefix}.runtimeOutput.context.{contextId}` wakes a non-After `AgentOutput` wait with matching `contextId`;
- a matching row in another context does not wake that wait;
- a contextless public/tool `AgentOutput` wait fails fast instead of sleeping until timeout;
- no production writer is added for `...firegrid.host.{hostId}.runtimeOutput`;
- any remaining host-prefixed read path is documented as compatibility-only and not exercised by production composition.
