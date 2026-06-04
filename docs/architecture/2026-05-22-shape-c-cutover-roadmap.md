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
- Production lanes dispatched against an unvalidated upstream shape, signature,
  composition, or substrate question (see "Tiny-Firegrid-First Dispatch Gate"
  below).
- Speculative production artifacts that compile against an assumed but
  unlanded upstream signature are kept around for reshape. They are deleted.

## Tiny-Firegrid-First Dispatch Gate

`packages/firelab/` is the workbench. Production runtime code under
`packages/runtime/`, `packages/host-sdk/`, and `packages/protocol/` is where
*validated* shapes get built. The two roles do not blur:

- A firelab simulation answers a specific topology question (shape,
  signature, composition, or substrate) with one of `GREEN | YELLOW | RED`
  (see `docs/cannon/architecture/runtime-design-constraints.md` §"Greenfield
  Operating Mode").
- Production code lands the validated shape *fresh*. Tiny-firegrid modules
  do not graduate by copy/move. The simulation result is the contract;
  production is written against that contract using the production
  substrate, types, and Layer graph.

A production lane is dispatchable only when both are true:

1. **Upstream wave exited.** The wave the lane depends on (per the wave
   ordering below) has merged on `rearch/shape-c-cutover` and its exit
   gate is satisfied. Lanes do not dispatch against open sidecar branches,
   proof PRs, or "mostly merged" intermediate states.
2. **Uncertain shape validated GREEN in firelab.** If the lane
   contains any unresolved shape/signature/composition/substrate question
   that the wave it sits in has not already answered with a landed
   artifact, the answer must come from a GREEN firelab simulation
   before the production lane is dispatched. A YELLOW result dispatches
   the named substrate/helper layer first; a RED result stops the lane
   and revises the architecture.

What counts as an "uncertain shape" question (non-exhaustive):

- the public/internal signature of a runtime tag a downstream lane depends on;
- the composition Layer wiring a `composition/host-live.ts` root will
  expose (R-channel, Layer graph, what the host-sdk installs);
- the substrate identity and key shape of a new `DurableTable` family;
- the shape (B / C / D) classification of a new subscriber and the
  justification for any workflow machinery in its `R`;
- the integration contract between two target folders that have not yet
  exchanged a real call (for example, `subscribers/x` calling
  `channels/router.ts` for the first time).

What does **not** require a firelab loop:

- mechanical moves whose upstream signature already landed and is referenced
  by name (Wave A artifact relocations into the semantic tree are the
  canonical example);
- pure transform extraction whose call-sites are already typed;
- doc, baseline, and guard-rule patches.

### Speculative Production Artifacts Are Deleted

Production artifacts produced against an assumed but unlanded upstream
signature are *speculative*. Speculative artifacts are deleted, not parked
or reshaped. Concretely:

- A Wave N+1 production lane authored while Wave N is unsettled does not
  rebase forward when Wave N exits with a different signature. It is closed
  or its new files are deleted; the lane is rewritten fresh against the
  landed Wave N signature.
- "Parked" or "shelved" production PRs that predate the wave they depend on
  do not accumulate. They are closed once their target wave exits, with a
  comment naming what changed and what the fresh dispatch will look like.
- A speculative artifact is not preserved because it "compiles" or "passes
  tests against a mocked upstream." Compiling against a guess is the
  failure mode this rule prevents.

The reason is structural: the cost of reshape-when-the-real-signature-lands
is consistently higher than the cost of writing fresh against the validated
shape. Tiny-firegrid is cheap; production rewrites against half-known
upstream are not.

### Dispatch Gate Decision Form

For any Wave C/D production lane, the dispatch record must answer:

```text
Upstream wave:                 (Wave A / Wave B / Wave C / Wave D-input)
Upstream wave exit status:     (exited on rearch/shape-c-cutover / not yet)
Uncertain shape questions:     (list, or "none — mechanical")
Tiny-firegrid simulation:      (sim name + GREEN / YELLOW / RED, or
                                "n/a — no uncertain shape")
Production approach:           (written fresh against landed shape /
                                firelab graduation [forbidden])
```

A "firelab graduation" entry is itself a violation. The gate exists
precisely so production is written fresh.

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

Dispatch precondition: Wave A exited on `rearch/shape-c-cutover`. The
`composition/host-live.ts` Layer graph is the canonical example of a
composition question — if its `R` channel, the table set it requires, or
the host-sdk-facing public subpath is not already pinned by Wave A
artifacts, the open question is answered by a firelab composition
simulation GREEN before the production root is dispatched. See
"Tiny-Firegrid-First Dispatch Gate".

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

Dispatch precondition: Wave B exited on `rearch/shape-c-cutover` with the
runtime root assembly landed and its public subpath stable. Any open
shape/signature/composition question on the host-sdk side of the cut —
how host-sdk installs the root, what its public Layer surface looks
like, what the channel-router R-channel demands — is answered by a
firelab simulation GREEN before the production cutover lane is
dispatched. Speculative host-sdk lanes authored against an unlanded
runtime root signature are deleted, not rebased. See
"Tiny-Firegrid-First Dispatch Gate".

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

Dispatch precondition: Wave C exited on `rearch/shape-c-cutover` (one real
runtime turn through the new root). Each Wave D lane below names the
upstream Wave D dependency it sits behind (input-delivery + restart/
idempotency gate the rest). Any open shape question for a lane — durable
result identity key, completion-row schema, channel observation contract,
the at-most-once primitive the lane chooses — is answered by a
firelab simulation GREEN before the production lane is dispatched.
Production PRs that predate their upstream Wave D lane's exit are
speculative; their files are deleted and the lane is rewritten fresh
against the landed shape. See "Tiny-Firegrid-First Dispatch Gate".

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
