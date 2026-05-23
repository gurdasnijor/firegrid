# Shape C Cutover Roadmap

Doc-Class: dispatch-roadmap
Status: active
Date: 2026-05-22
Owner: Firegrid Architecture

Branch: `rearch/shape-c-cutover`

This roadmap is the durable dispatch guide for the cutover after the semantic
runtime scaffold landed in PR #689. It complements
`2026-05-22-shape-c-cutover-operating-plan.md`: the operating plan defines the
greenfield rules; this document defines the remaining execution waves.

Load-bearing context:

- `docs/cannon/architecture/runtime-design-constraints.md`
- `docs/cannon/architecture/runtime-pipeline-type-boundaries.md`
- `docs/architecture/2026-05-22-runtime-physical-target-tree.md`
- `docs/architecture/2026-05-22-shape-c-cutover-operating-plan.md`
- `docs/architecture/2026-05-22-shape-c-cutover-baseline.md`
- `docs/architecture/2026-05-22-shape-c-legacy-deletion-map.md`
- `docs/architecture/2026-05-22-shape-c-clean-room-test-triage.md`

The target architecture is not reached by more design work. It is reached by
making the current branch green, proving the host runs, and deleting anything
the new path no longer calls.

## Ground Rules

- The current branch is a greenfield replacement branch, not a compatibility
  migration.
- New runtime implementation lands in the semantic target tree:
  `events/`, `tables/`, `producers/`, `transforms/`, `channels/`,
  `subscribers/`, `composition/`, `_archive/`.
- Host-sdk imports runtime through tree-aligned public subpaths only.
- `composition/` means runtime-internal Layer assembly. It is not host-sdk
  composition and must not define business behavior.
- A lane that proves target behavior deletes the old code that behavior makes
  unreachable in the same PR whenever possible.
- A temporary shim is acceptable only when its PR names the exact blocker and
  the next deletion owner.
- Line/module delta is tracked against
  `docs/architecture/2026-05-22-shape-c-cutover-baseline.md`. Each cutover PR
  reports its delta against that baseline; the cumulative cutover delta is the
  falsification test.

Hard stops:

- Shape C imports `WorkflowEngine`, `Activity`, `DurableDeferred`, or
  `DurableClock`.
- Shape C makes `AgentSession` ambient.
- `subscribers/` imports `producers/`.
- `transforms/` imports `tables/`, `channels/`, `subscribers/`,
  `producers/`, `composition/`, or returns `Effect`.
- `tables/` imports `transforms/`, `subscribers/`, `producers/`, or
  `composition/`.
- Host-sdk imports `@firegrid/runtime/kernel`, `_archive/`, numeric runtime
  paths, or runtime physical paths.
- A PR keeps old and new active RuntimeContext implementations in parallel.

## Wave A: Artifact Placement

Status: in progress.

Goal: move the load-bearing artifacts into the semantic target tree without
building the final runtime root yet.

Artifacts:

- `RuntimeContextStateStore` -> `packages/runtime/src/tables/runtime-context-state.ts`
- `RuntimeContextInputFacts` read side -> `packages/runtime/src/tables/runtime-context-input-facts.ts`
- append authorities, if introduced -> `packages/runtime/src/producers/ingress-writers/`
- pure transitions and decoders -> `packages/runtime/src/transforms/`
- RuntimeContext handler -> `packages/runtime/src/subscribers/runtime-context/`
- RuntimeContext session command sink -> `packages/runtime/src/subscribers/runtime-context-session/`

Wave A exit gate:

- All moved artifacts expose tree-aligned public subpaths where external
  callers need them.
- Target folders contain no forbidden imports.
- Legacy source paths are deleted or reduced to named temporary re-export
  shims.
- `pnpm preflight` is green, or any failure is proven pre-existing and
  unrelated to the moved artifact.
- The line/module delta is recorded for each PR.

Do not build `composition/host-live.ts` in Wave A.

## Wave B: Runtime Root Assembly

Goal: assemble the canonical runtime root from target folders only.

Primary artifact:

- `packages/runtime/src/composition/host-live.ts`

Allowed work:

- Layer assembly from `tables/`, `producers/`, `channels/`, `subscribers/`,
  and justified Shape D subscriber Layers.
- A narrow public export such as
  `@firegrid/runtime/composition/host-live`, if host-sdk needs to install the
  runtime root.
- Minimal topology checks that are enabled by the assembly.

Forbidden work:

- Defining schemas, transitions, handlers, workflow bodies, session behavior,
  or table operations in `composition/`.
- Importing `RuntimeContextWorkflowNative`,
  `RuntimeContextWorkflowNativeLayer`, `RuntimeContextWorkflowRuntime`,
  `runtime-input-deferred`, `@firegrid/runtime/kernel`, or `_archive/`.
- Calling producer append functions, handlers, or transitions directly as
  business logic. `composition/` wires Layers and service tags.

Wave B exit gate:

- The runtime root typechecks from semantic target folders.
- Focused runtime-root tests prove the Layer graph can be constructed without
  the old RuntimeContext body path.
- Host-sdk is not cut over yet unless the same PR proves a real runtime turn
  through the new root without fallbacks.

If a Wave B PR also satisfies Wave C's turn proof gate, it merges as a
combined Wave B/C PR and the PR body says so explicitly. If it does not, Wave C
is a separate PR. The turn proof is not a Wave B success criterion.

## Wave C: Host-SDK Cutover And Public Turn Proof

Goal: route the public host-sdk entry through the runtime root and prove a real
runtime turn end-to-end.

Required proof:

```text
start context -> send input -> observe output -> terminate
```

The proof must use the real runtime root and durable substrate. It must not
special-case the lifecycle, mock away the substrate, or call the old
RuntimeContext workflow body.

"Real" means the proof runs the host-sdk public entry point against a real
DurableTable backend, or the production-equivalent in-memory backend used in
integration tests, with no test-only shortcut around the codec, channel router,
or state store.

Allowed work:

- Retarget host-sdk entrypoints to the runtime root public subpath.
- Rewrite target-valid tests from
  `2026-05-22-shape-c-clean-room-test-triage.md` so they assert the Shape C
  observable contract.
- Delete stale tests that only assert parked-body, deferred-mailbox, dense-scan,
  or workflow-local assumptions, naming the replacement test or proof.

Deletion required in the same wave when proven unreachable:

- old host-sdk RuntimeContext body launch path;
- ambient workflow support for RuntimeContext;
- public test helpers that inspect workflow-local body state.

Wave C exit gate:

- At least one public host-sdk runtime turn passes through the new root with no
  fallback.
- No host-sdk code path imports the old body-driver symbols for RuntimeContext.
- Any test rewrite/delete is classified as target regression, stale legacy
  assumption, or pre-existing unrelated failure.

## Wave D: Behavior Proofs With Paired Deletion

Goal: prove the remaining behaviors through the new shape and delete the old
machinery each proof makes unreachable.

Dispatch order:

1. Input delivery and restart/idempotency first. These are foundational and
   gate the other behavior proofs.
2. Tool, permission, and wait/child-output lanes run in parallel after input
   and restart are proven.

Dispatch lanes:

- Input delivery and ordering:
  - prove input facts feed the Shape C handler;
  - delete `runtime-input-deferred` and the per-sequence mailbox path.
- Tool call and result correlation:
  - prove tool result continuation uses durable result identity;
  - delete obsolete tool bridge/wrapper paths that re-enter the old body.
- Permission request/response:
  - prove permission response continuation through table/channel facts;
  - delete obsolete permission mailbox/response bridge code.
- Wait/child output/channel observation:
  - prove existing channel/router observation handles child output;
  - delete parallel `session_read` / `ChildOutput*` or equivalent artifacts.
- Restart/reload/idempotency:
  - prove no double processing after restart;
  - delete dense-output cursor/scaffolding that only supported parked-body
    replay progress.

Wave D exit gate:

- Each behavior has a target-shape test or integration proof.
- Every deletion is tied to the proof that made the old path unreachable.
- `_archive/` contents made unreachable by a proof are deleted by that proof's
  lane. Wave E's empty-archive gate is reached incrementally during Wave D,
  not by a late sweep.
- No `_archive/` import exists anywhere in target code.
- The cumulative runtime line/module delta against
  `2026-05-22-shape-c-cutover-baseline.md` is negative, or every positive
  delta still present names the target capability it adds.

## Wave E: Public Surface Shrink And Guard Ratchet

Goal: close the cutover by shrinking exported old symbols and making drift
hard to reintroduce.

Work:

- Remove old RuntimeContext body symbols from public barrels:
  - `RuntimeContextWorkflowNative`
  - `RuntimeContextWorkflowNativeLayer`
  - `RuntimeContextWorkflowPayload`
  - `executeRuntimeContextWorkflow`
  - `RuntimeContextWorkflowRuntime`
  - `appendRuntimeInputDeferred`
  - `runtimeInputDeferredFor`
  - `runtimeInputDeferredName`
- Keep subpaths only when their exported symbol sets are target-shaped.
- Remove `_archive/` runtime files, or close with an explicit blocker if any
  remain.
- Ratchet semgrep/effect-quality/public-surface baselines after deletions.
- Update SDDs and architecture docs so no bridge is described as target
  architecture.

Baseline ratchets happen as the violations they cover are deleted. For
example, a Wave C PR that removes host-sdk kernel-barrel imports shrinks the
corresponding semgrep baseline in the same PR. Wave E removes any remaining
baseline entries whose occurrence count has reached zero.

Wave E work that does not depend on a Wave D proof can run alongside Wave D.
Strict sequencing applies only where a deletion or ratchet depends on a proof.

Wave E exit gate:

- `pnpm run verify` passes.
- No old RuntimeContext workflow body path is reachable.
- No `_archive/` runtime files remain.
- Architecture guards are active and green.
- Final line/module delta is recorded.

## Feature Work Gate

Product feature work starts only after Wave E exits.

Before that point, work that appears to be feature work but touches runtime
turn lifecycle, host-sdk composition, channels, tool calls, waits, permission,
or RuntimeContext state is still cutover completion work.

Path-based reviewer test:

If a PR touches any file under one of these paths, it counts as cutover work
until Wave E exits, regardless of how the PR is framed:

- `packages/runtime/src/subscribers/`
- `packages/runtime/src/tables/`
- `packages/runtime/src/channels/`
- `packages/runtime/src/composition/`
- `packages/host-sdk/src/host/`
