# tiny-firegrid Findings

Running tracker for gaps surfaced while making tiny-firegrid configurations
compose against production APIs. These are findings from the model, not issues
the toy package should paper over.

## How To Use This Tracker

Each finding has a stable `TFIND-*` id so sidecar agents can annotate status
without rewriting the document. Use the status line only:

- `status: open`
- `status: in-progress (<branch-or-pr>)`
- `status: blocked (<reason>)`
- `status: resolved (<pr-or-commit>)`
- `status: superseded (<link-or-reason>)`

Keep resolution notes short. If a fix changes the architecture, link the SDD or
PR and leave the original evidence intact.

## Discipline

Tiny-firegrid is useful only when it is isomorphic to production boundaries.
When the toy needs a hand-written type, direct transition function, synthetic
host/client co-location, or lower-level assertion that production users would
not exercise, that is a finding first and a toy implementation detail second.

Configurations should be black-box system shapes. Tests drive those shapes
through public surfaces and assert externally observable behavior. Lower-level
tests that assert private table mechanics or internal transition steps are out
of scope for this package.

## Index

Triage column added 2026-05-18 (FINDINGS_TRIAGE_RUBRIC.md applied to every
finding incl. shipped ones). cat-1/2 = real production gap → sidecar SDD;
cat-3 = test-fixture awkwardness → toy fix + redirect, NO production change;
cat-4 = toy-internal / coverage-tooling artifact → toy / tooling, NO
production change; cat-5 = internal production cleanup → low-pri sidecar.
See "## Triage Audit (2026-05-18)" below the Index for the cross-cutting
conclusions (no shipped violations; the TFIND-036 process miss; the
TFIND-012/015 cat-4-wrapping-a-cat-1/2 inversions).

| ID | Status | Area | Finding | Triage |
| --- | --- | --- | --- | --- |
| TFIND-001 | resolved (#332 — consolidated client/host transaction) | client-sdk | `Firegrid.launch()` returns a context handle, not a session handle. | cat-1 (real client consumer hits launch/session split; folded into the #332 cluster) |
| TFIND-002 | resolved (#332 — client writes durable intent, no host identity) | client-sdk / host boundary | `sessions.createOrLoad()` still requires host identity. | cat-1 (rubric anchor — client-only frontend hits host-identity wall immediately) |
| TFIND-003 | resolved (#332 — durable start request + host reconciler) | client-sdk / host boundary | No remote start request surface. | cat-1 (real remote client needs a durable start trigger, not an in-process host capability) |
| TFIND-004 | unblocked by #332 (client/host now separable; toy realization = toy-maintainer follow-up) | tests / architecture | Tests must not compose client and host in one Effect environment. | cat-1-consequence (real e2e shape; unblocked by cat-1 #332; toy realization = toy follow-up) |
| TFIND-005 | #326 VERIFIED (Crux-B both arms pass; strict scope; gates green), NOT flip-ready — co-gated on TFIND-044 + TFIND-045; branch force-pushed `15af74c4e` (rebased onto main + SDD inv 7/6); coordinator holds merge | Effect layer typing | Workflow/table layer composition leaks type precision. | cat-2 (rubric anchor — `any` leaks Layer precision through public host factories; type-honesty boundary) |
| TFIND-006 | resolved (#325) | tiny host coverage | Durable configuration still models a tiny host capability. | cat-4/toy (toy fidelity — toy should compose production host; no production surface gap; its adoption surfaced cat-1 TFIND-028) |
| TFIND-007 | resolved (#323) | host-sdk | Host SDK lacks a named host surface type. | cat-2 (rubric anchor — consumers reached into impl to build an unnamed host type) |
| TFIND-008 | unblocked by #332 (separate-process client/host seam now exists; toy e2e = follow-up) | end-to-end shape | Client and host cannot yet be tested as separate processes end-to-end. | cat-1-consequence (real separate-process e2e; unblocked by #332; toy realization = toy follow-up) |
| TFIND-009 | superseded (false positive — codec is load-bearing) | workflow-engine | Durable workflow codec appears orphaned in the engine closure. | cat-4 (coverage-tool import-graph miss — codec is load-bearing; correctly closed, NO production code. Note: rubric calibration listed 5 assuming the orphan was real; the resolution proved it a coverage artifact = 4) |
| TFIND-010 | open — audit 2026-05-18: **BUILDABLE** (cap EXISTS: `RuntimeContextEngineRegistryLive` composed in `FiregridRuntimeHostLive` layers.ts:259) | runtime host | RuntimeContext engine registry is load-bearing. | cat-4/toy (toy modeling roadmap; capability verified present — realizable via the multi-context build) |
| TFIND-011 | open — audit 2026-05-18: **BUILDABLE** (cap EXISTS: `RuntimeContextEngineRegistry.reconcile()` reads per-context input-intents, sorts, applies before tailing — runtime-context-engine-registry.ts:195-213, called from startOrAttach:184) | runtime input | Startup reconciliation is not yet modeled against Durable Streams. | cat-4/toy (toy modeling roadmap; capability verified present) |
| TFIND-012 | open | durable-tools / wait | Wait-for output surface still needs production-backed modeling. | cat-4/toy WRAPPER over a cat-1/2 kernel ⚠ (the non-After `AgentOutput` wait-router arm reads the host-prefixed stream vs post-#315 per-context = REAL prod drift / A4 residue — split the prod kernel out as its own finding) |
| TFIND-013 | resolved (#338, `960ec59b3` — output-journal-pipeline.ts toy config landed) | output journal | Output journal / A4 path remains unmodeled in durable config. | cat-4/toy (toy A4/output-journal modeling = the #338 toy config; the A4 prod path itself is tracked separately as residue) |
| TFIND-014 | resolved (audit 2026-05-18 — REALIZED by #343 stdio-jsonl tool-execution config; `RuntimeToolUseExecutorLive` + `toolUseToEffect` + `Activity.make`-wrapped, exercised e2e) | tools | Tool execution and `AgentToolHost` are deferred. | cat-4/toy → realized; "deferred" status was stale post-#343 |
| TFIND-015 | **DECIDED B (Gurdas 2026-05-18)** — strict observation + workflow-side resumption; SDD #350 reviewed-sound; **B build dispatched to `163`** (correctness-critical: deferred-completion/authority — structural proof + deterministic failure-mode test, no forcing cast). Unblocks toy permission-flow-pipeline after impl lands. | permissions / codecs | Permission flow and codec authority remain unsettled. | cat-1/2 production architectural (resolved-direction: B). ACP codec currently does durable-deferred authority inside the codec (verified) vs README "codecs may not own durable permission state" — B aligns impl to the documented contract; TFIND-041 authority-family precedent |
| TFIND-016 | resolved (cat-3 CLOSE 2026-05-18, Gurdas-concurred) — a dedicated activity-boundary config necessarily exercises an INTERNAL abstraction (`Activity.make`), violating the CONFIGS "drive examples through public boundaries" rule. Activity-mediated durability (replay/retry) is observed through the public surface and already covered by the durable-streams replay config. No new config; no production change. | workflow activities | Activity boundaries are not yet represented. | cat-3 (test-fixture-shaped — modeling an internal-by-design abstraction directly is the wrong shape; redirect = observe activity-mediated behavior via the public surface, already covered) |
| TFIND-017 | open | toy DurableTable | `rows()` is a live tail; snapshot reads must use `query()`. | cat-4/toy (toy in-memory-adapter usage rule; no production surface) |
| TFIND-018 | resolved (#317/#320 cleanup) | toy discipline | Hand-maintained contracts are rejected. | cat-4/toy (toy discipline rule; toy cleanup PR, no production surface) |
| TFIND-019 | resolved (#317/#320 cleanup) | toy discipline | Internal transition functions are rejected. | cat-4/toy (toy discipline rule; toy cleanup, no production surface) |
| TFIND-020 | open | toy configuration shape | One configuration file should express one system shape. | cat-4/toy (toy discipline rule) |
| TFIND-021 | resolved (#317/#320 cleanup) | toy tests | Scenario tests should stay above component internals. | cat-4/toy (toy discipline rule; toy cleanup) |
| TFIND-022 | open | toy package surface | `src/index.ts` should not become an artificial public API. | cat-4/toy (toy discipline rule) |
| TFIND-023 | resolved (#317/#320 cleanup) | toy layout | Package layout should mirror production package layout. | cat-4/toy (toy discipline rule; toy cleanup) |
| TFIND-024 | open — cat-4 framing has a cat-1 PRODUCTION KERNEL: see TFIND-049 (toy realization blocked on it) | runtime adapters | Agent adapter path is still under-modeled. | cat-4/toy framing was WRONG that "`agent-adapters` exists in production" — it is NOT wired into the runtime host (effect-ai-native-agents Slice 4 unbuilt). The real gap = TFIND-049 (cat-1). TFIND-024 toy-realization blocked on TFIND-049 |
| TFIND-025 | open — RE-TRIAGED 2026-05-18 (audit) + **VERIFIED schedulable-build, NOT framing-gated** | durable-tools | Shape C / wait arbitration remains unmodeled. | cat-4/toy WRAPPER over a cat-1/2-FUTURE kernel (Shape C step 2). Step 1 LANDED; **steps 2-3 verified architecturally DEFINED** (convergence.md:74-81 — Step 2: collapse match/timeout arbitration onto `DurableDeferred.raceAll` since the race deferred already decides + completions reads redundant given idempotent deferredDone; Step 3: delete dead `completions` table + reduce `durable-wait-store.ts`) ⇒ deterministic implementation, NOT undefined/framing-gated. Precondition (per-context engine slice) MET (TFIND-010). = schedulable production cleanup ("recommended near-term"), NOT a bundle item. Toy modeling deferred until built — not toy laziness |
| TFIND-026 | resolved (#321) | durable backend | Durable-streams backend reached Group D. | cat-4/toy (toy milestone; toy PR #321, no production surface) |
| TFIND-027 | accepted | toy readability | Duplicate inline configuration code is acceptable when it documents wiring. | cat-4/toy (toy readability rule; accepted, no action) |
| TFIND-028 | resolved (#325) | host-sdk / runtime start | `RuntimeStartCapabilityLive` did not capture workflow support services. | cat-1 (REAL production runtime bug — an operator running a host via the public capability hits a missing `RuntimeOutputTable`; surfaced by the toy adopting prod composition) |
| TFIND-029 | in-progress (`sidecar/runtime-start-deps`) | host-sdk / runtime start | `RuntimeStartCapabilityLive` should enumerate workflow support dependencies. | cat-5 (internal production composition robustness — explicit deps vs ambient capture; not consumer-visible; correctly low-pri / auto-unblocks on #326) |
| TFIND-030 | resolved (#329) | client-sdk / projections | Snapshot agent output events are typed as records, not protocol unions. | cat-1 (real client-sdk consumer wants the typed `AgentOutputEvent` union from `snapshot()` without casts) |
| TFIND-035 | resolved (#333) | protocol / runtime SSOT | Two divergent agent-output envelope decoders; consolidate to one protocol-owned canonical union. | cat-2 (SSOT/boundary — two divergent envelope decoders; defensible as TFIND-030's tracked completion) |
| TFIND-031 | resolved (#331, e48d82904) | host/toolkit composition | Shared DurableTable tag-family provision missing; masked by TFIND-005 `any`; manifests at 4 prod + 8 test boundaries. | cat-2 (real host-composition correctness — missing shared DurableTable tag-family provision, was masked by the TFIND-005 `any`) |
| TFIND-032 | superseded (folded into TFIND-031) | host-sdk | `agent-tool-host-live.ts` manifestation of TFIND-031. | cat-2 (manifestation of cat-2 TFIND-031) |
| TFIND-033 | superseded (folded into TFIND-031) | host-sdk | `commands.ts` manifestation of TFIND-031. | cat-2 (manifestation of cat-2 TFIND-031) |
| TFIND-034 | superseded (folded into TFIND-031) | host-sdk | `toolkit-layer.ts` manifestation of TFIND-031. | cat-2 (manifestation of cat-2 TFIND-031) |
| TFIND-038 | resolved (#332 — RuntimeContextRequest carries full public runtime intent) | client-sdk / runtime config | Client session creation cannot express arbitrary public runtime intent (argv/env/ACP/MCP). | cat-1 (rubric anchor — real consumer launching a specific agent binary + MCP hits the client-intent gap) |
| TFIND-039 | resolved (#332 — durable start request + host reconciler) | client-sdk / host split | Client SDK has no client-visible runtime start trigger. | cat-1 (real client needs a durable start trigger; cluster end-state, folded into #332) |
| TFIND-040 | in-progress (`sidecar/session-observation` — SDD-first; OCA3; attach-point pending #332) | client-sdk / observations | Client SDK lacks a per-event session observation surface. | cat-1 (rubric anchor — real client consumer pattern: `session.subscribe()` per-event; correctly SDD-first) |
| TFIND-036 | RE-TRIAGED cat-3 → toy redirect (2026-05-18; was QUEUED-FOR-ARCHITECT/SDD #335) | MCP / tools | Firegrid MCP toolkit lacks a read-only runtime-state query tool. | cat-3 (rubric CANONICAL — "agent reads its own runtime exit code" has NO coherent non-Firegrid consumer; test-fixture awkwardness. NO production code shipped — caught at SDD stage. Toy fix: use `wait_for{RuntimeRun}` / accept the awkwardness; SDD #335's two-plane analysis is retained as the recorded *why* but NOT implemented) |
| TFIND-037 | superseded (duplicate — folded into TFIND-041) | ACP / tool execution | ACP MCP tool calls are provider-executed observations (= the ACP face of TFIND-041). | cat-1 (ACP face of the cat-1 architectural-shape TFIND-041) |
| TFIND-041 | resolved (#336 — decision B + by-decision doc-comment landed) | runtime / agent-event contract | `ToolUse` event lifecycle is under-discriminated (execution authority via session-mode, not event). | cat-1 (rubric anchor — real architectural shape question; resolution = right-sized by-decision doc-comment, zero behavior change) |
| TFIND-042 | resolved (#337) | scenarios / test infra | scenario-firegrid CLI `--help` flakes under high local turbo contention. | cat-4 (test-infra/tooling artifact — cold-start latency; test-infra-only fix, NO production code) |
| TFIND-043 | open (low priority — test-infra flake, TFIND-042-class) | runtime / test infra | `DurableStreamsWorkflowEngine` VALIDATION.5 flakes under 17-way local turbo contention. | cat-4 (test-infra/tooling artifact — load-contention flake; CI-arbiter, correctly NOT dispatched to a production sidecar) |
| TFIND-044 | resolved (#348 `798821692` — Option B named coarse provider seam, branded `AnyDurableTableTag`; SDD #345; signed off Gurdas 2026-05-18) | client-sdk / effect-durable-operators provider | `DurableTableProvider`'s single `ROut` generic cannot carry N heterogeneous precise `DurableTable` `<Self>` identities (`firegridRuntimeTableTags`; flamecast `client/main.tsx:360` TS2322) — a latent precision leak the TFIND-005 `any` was hiding. The provider API/usage WAS SDD'd (REACT_LIVE_QUERY); its generic *type shape* was not. | cat-2 (real boundary/wrong-shape — a real flamecast consumer hits it; the provider abstraction can't express the precise heterogeneous identity set; architect-gated; framing = §0 amendment to the existing provider SDD) |
| TFIND-045 | resolved (#347 `67de514a0` — enumerate reconciler env transitive deps; SDD #345; §5-Q1 oracle clean, §5-Q3 no external consumers; signed off Gurdas 2026-05-18) | host-sdk / control-request-reconciler | `RuntimeControlRequestReconcilerEnvironment` (`control-request-reconciler.ts:42-46`) omits `RuntimeOutputTable` + `HostRuntimeContextExecutionEnv` that `reconcileStartRequest:211` transitively requires via `startRuntime()`→`RuntimeContextEngineRegistry` — a genuine missing-dependency the TFIND-005 `any` was masking (Crux-B false-equivalence). | cat-2 (real production correctness — declared Effect env alias incomplete; fails when ambient doesn't supply it, TFIND-028 class; controlled experiment proved NOT branch scope-creep; relates TFIND-029 env-enumeration family, distinct mechanism from TFIND-044) |
| TFIND-046 | open (low priority — client-sdk ergonomic completeness; annotated in #341 MIGRATION_NOTES) | client-sdk / durable tables | client SDK exposes `FiregridRuntimeTables.ControlPlane` but not the `runtimeControlPlaneStreamUrl` builder needed to instantiate its layer, forcing consumer-shaped code to import the URL helper from `@firegrid/protocol/launch`. | cat-1 (real consumer gap — a client-side live control-plane query, the Flamecast `useDurableTable` pattern, must reach into protocol for the stream URL; low severity but consumer-facing; fix = client-sdk re-export/fold. NOT toy-test-cleanness: a real non-Firegrid consumer hits the identical import) |
| TFIND-047 | open (filed 2026-05-18 by Gurdas; framing-gated, distinct from TFIND-040) | client-sdk / snapshot observation typing | `RuntimeContextSnapshot["agentOutputs"]` carries weaker typing than runtime-side `RuntimeAgentOutputObservation`: the Codex test needs `asRecord` defensive casts to read `event.part.delta` / `event.part.name` from snapshot rows, while the same fields are properly typed when consumed from `RuntimeOutputTable.events.rows()` directly. | cat-2 (real client-SDK type-precision boundary — the snapshot path loses observation type precision the runtime side has, forcing consumer casts; distinct from TFIND-040 subscription ergonomics; relates TFIND-030/035 SSOT but a deeper `.part.*`/row-shape precision gap not closed by #329) |
| TFIND-048 | open — REFRAMED 2026-05-18 (Reading 2 / architectural; was mis-shaped as "client-sdk missing helper"); framing-gated, folds into the #332-impl MCP-lifecycle question; blocks Codex ACP | client/host boundary / MCP route + URL lifecycle | The #332 client/host model does not resolve **who builds the concrete `contextId`-scoped MCP URL and when**. Codex ACP bakes it client-side pre-`createOrLoad`; production (`host-sdk/mcp-host.ts`, CLI) has the **host** own the MCP server with a `/mcp/runtime-context/:contextId` route resolved at tool-call time. Client-baking a concrete URL into the intent is test-fixture-shaped. | cat-1/2 **architectural** (real production-model gap, not a missing API: re-exporting `sessionContextIdForExternalKey` would canonize the backwards lifecycle = WRONG fix. The determinism primitive itself is sound; the smell is URL-lifecycle ownership. Migration-as-validation working exactly as designed — proved #332 left an MCP-lifecycle hole. NOT cat-3 toy-fix: the production model needs the decision, not the toy) |
| TFIND-050 | open — corrective; **fix dispatched to `155` as Option (i) follow-up PR** (then #326 rebases onto it) | effect-durable-operators / provider seam | Merged #348 (signed-off TFIND-044 Option B) typed the erased provider prop `layer: Layer.Layer<unknown, E, never>` — `Layer` ROut is **contravariant**, so `unknown <: <Table>` fails on the explicit-props/by-name path (only the flamecast JSX-inference path ever worked). Latent type defect surfaced during the #326 rebase by `155`, which HALTED (no paper). Fix = `unknown → never` at the react.ts provider seam (DurableTableProviderProps + acquireServices); `155` empirically proved `never` typechecks BOTH paths 0-errors, assertions intact. | cat-2 corrective (real defect shipped in resolved TFIND-044/#348; design-conformant fix — Option B intent = erase ROut at the seam, `never` is the correct erasure operator for a contravariant position, `unknown` was a #348 oversight; NOT an A/B reopen). Process note: full-CI-green didn't catch it — no test referenced the props type by name on the failing path; latent until #326's by-name rebase. Cross-ref TFIND-044 |
| TFIND-049 | open — ARCHITECT/ROADMAP (build effect-ai-native-agents Slice 4? — Gurdas binary); blocks `agent-adapter-driven-pipeline` + capstone + TFIND-024 toy-realization | runtime host / agent-adapter integration | The runtime host has NO agent-adapter integration: `RuntimeProviderSchema = Literal("local-process")` only (`protocol/src/launch/schema.ts:60`); `FiregridRuntimeHostLive` hardcodes `LocalProcessSandboxProvider` (`host-sdk/src/host/layers.ts:31,143`); zero host-sdk consumers of `AgentAdapterRegistry`/`adapterFor`; `docs/proposals/effect-ai-native-agents.md:474` "Slice 4: wire `AgentAdapterRegistry.adapterFor(context)` into the runtime host" is explicitly **unbuilt**. | **cat-4/toy WRAPPER over a cat-1/2-FUTURE kernel** (Gurdas-classified 2026-05-18). Toy half (cat-4): the toy correctly refuses to model a capability that does not exist — not toy laziness. Kernel (cat-1/2): adapter-driven/AI-provider launch is **deferred FUTURE production work** (effect-ai-native-agents Slice 4), **NOT a current-architecture gap/bug/regression** — distinguish: nothing is broken today, the capability is planned-not-yet-built. Surfaced by `33`'s correct halt (migration-as-validation). Disposition = a roadmap binary Gurdas owns (build Slice 4 vs. keep dequeued), NOT a coordinator/sidecar fix |

## Triage Audit (2026-05-18)

`FINDINGS_TRIAGE_RUBRIC.md` applied to all 43 findings, including the
already-shipped ones, to check we did not ship rubric violations.

**Conclusion: NO rubric violation was shipped to production.** Every finding
that received production code is cat-1 or cat-2 (real consumer / boundary):
client/host cluster #332 (001/002/003/038/039 — cat-1), #323 (007 — cat-2),
#325 (028 — cat-1 real runtime bug), #329 (030 — cat-1), #331 (031±32/33/34
— cat-2), #333 (035 — cat-2), #336 (041 — cat-1 doc-only), #326 keystone
(005 — cat-2, pending). The toy/test-infra PRs (#317/#320/#321, #325's
toy-composition part, #337) touched no production surface.

**The TFIND-036 process miss (the reason for this rubric).** TFIND-036 is
the rubric's canonical cat-3 and reached a *fourth-revision SDD* (#335)
before triage asked whether "an agent reads its own runtime-run exit code"
was a real capability. It is not — it has no coherent non-Firegrid consumer
(the run hasn't exited; it's host-plane forensic data). The good news: it
was caught at the SDD stage — **no production code shipped**. The failure
was purely that triage was applied late, not that bad code landed. Going
forward the triage question is applied *before* engaging a finding's
framing. TFIND-036 re-triaged → cat-3, pushed back to the toy with a
redirect (see its detail entry). SDD #335's two-plane boundary analysis is
retained only as the recorded rationale for *why there is no agent read*; it
is not an implementation track.

**The inverse risk — cat-1/2 production kernels wrapped in cat-4 toy
framing.** Two open findings hide a real production sub-question inside a
toy-modeling ask and must be split, not closed as toy work:

- **TFIND-012** — the toy-modeling ask wraps a REAL production drift: the
  non-After `AgentOutput` wait-router arm reads the host-prefixed runtime
  output stream while post-#315 production writes per-context streams. That
  kernel is the tracked A4 / host-vs-context residue and is a cat-1/2
  production finding in its own right.
- **TFIND-015** — wraps the real production question of whether any codec
  completes workflow deferreds / performs authority-like work for
  permission-class events (TFIND-041 family), distinct from the toy
  permission-flow modeling.

Action: keep both open; the cat-4 toy-modeling halves route to the toy
maintainer; the cat-1/2 kernels are tracked production questions (TFIND-012
↔ A4 residue; TFIND-015 ↔ codec-authority / TFIND-041 family) — not to be
dispatched as generic toy coverage.

**Routing applied (rubric §"When to push back vs route"):** cat-1/2 →
sidecar SDD (done or in-flight); cat-5 (TFIND-029) → low-pri sidecar
(auto-unblocks on #326); cat-3 (TFIND-036) → toy + named redirect; cat-4
toy-coverage/discipline (006, 010–027, 042/043) → toy maintainer / coverage
tooling, NOT production sidecars. Most of the open backlog (010–025) is
cat-4 toy modeling roadmap, correctly not production work.

## Cat-4 Capability Audit (2026-05-18)

One-pass coordinator-verified capability-existence audit of the open
cat-4 toy-modeling cluster (after three "cat-4 wrapper over cat-1/2
kernel" discoveries: TFIND-012/015/024→049). Converts the CONFIGS
queue from consumer-hypothesis to verified plan. Per-finding verdict
(file:line evidence in each entry / index cell):

- **TFIND-010** — BUILDABLE. `RuntimeContextEngineRegistryLive` composed
  in `FiregridRuntimeHostLive` (layers.ts:259); consumed by
  control-reconciler + input-dispatcher.
- **TFIND-011** — BUILDABLE. Startup reconciliation EXISTS
  (`RuntimeContextEngineRegistry.reconcile()` per-context, before tailing
  — registry.ts:195-213 / startOrAttach:184).
- **TFIND-014** — RESOLVED/REALIZED by #343 (stdio-jsonl tool execution:
  `RuntimeToolUseExecutorLive` + `toolUseToEffect` + `Activity.make`,
  e2e-tested). "deferred" was stale.
- **TFIND-016** — **cat-3 CLOSED** (2026-05-18, Gurdas-concurred).
  `Activity.make` is workflow-internal-by-design; a dedicated
  activity-boundary config necessarily exercises an internal abstraction,
  violating the CONFIGS "drive examples through public boundaries" rule.
  Redirect: observe activity-mediated replay/retry via the public
  surface — already covered by the durable-streams replay config. No
  config, no production change.
- **TFIND-024** — PRODUCTION-DEFERRED → TFIND-049 (effect-ai-native
  Slice 4 unbuilt). Confirmed.
- **TFIND-025** — PRODUCTION-DEFERRED, **verified schedulable-build NOT
  framing-gated**. Steps 2-3 re-read (convergence.md:74-81): both
  architecturally DEFINED (Step 2 = collapse arbitration onto
  `DurableDeferred.raceAll`; Step 3 = delete dead `completions` table +
  reduce wait-store) — deterministic impl, not undefined. Precondition
  (per-context engine) MET → schedulable production cleanup
  ("recommended near-term"), NOT a bundle/framing item.
- **multi-context-production-consuming-pipeline** — BUILDABLE. Per-context
  observation demuxes cleanly through the public surface (contextId
  primary/composite key; registry per-context lookup;
  snapshot/waitForAgentOutputObservation/watchContexts filter per
  context). Dispatched to `33` 2026-05-18 (toy-side validation of
  TFIND-004/008 "unblocked by #332"; surface friction → cat-1 ergonomic
  finding, not a halt).

**No new architectural-framing kernel surfaced** — only TFIND-015
(permission/codec authority, pre-existing) joins the framing bundle.
TFIND-024/025 are production-deferred roadmap lines (build, not frame).
See [[feedback-configs-queue-precondition-verify-capability]].

## Findings

### TFIND-001: Client launch handle is not a session handle

status: resolved (#332 — folded into the consolidated client/host transaction; see TFIND-002 cluster note)

Sidecar (2026-05-18): dispatched to Codex Coding Agent 1. Shares the
exact root cause as TFIND-002/003 (`launch()` also requires
`CurrentHostSession` via `insertLocalRuntimeContext`); the
`SDD_FIREGRID_CLIENT_HOST_BOUNDARY.md` §3 shape generalizes to it.
Bounded question: is TFIND-001 independently resolvable now via an
additive protocol/client down-payment analogous to #327, or is it purely
a manifestation of the same deferred client/host coordinated transaction
(fold it, as 032/033/034 folded into 031)? SDD-first; framing-gated;
no production code before coordinator review + Gurdas framing signoff.

`Firegrid.launch()` creates a `RuntimeContextHandle` with `contextId` and
`snapshot`, but programmatic prompt/start/wait operations are exposed on
`FiregridSessionHandle` from `sessions.createOrLoad()` / `sessions.attach()`.
For scenarios that need prompt + start + wait, tiny-firegrid must drive the
session facade instead of the lower-level launch handle.

Next action: decide whether launch should stay a context-only primitive, or
whether a launch-created context should have an obvious path to a
session-shaped handle.

### TFIND-002: Critical: session creation still requires host identity

status: resolved (#332, 2d474c70d)

CLUSTER RESOLVED 2026-05-18 (#332 merged — consolidated client/host
boundary, Option 1). One transaction resolved the whole client/host
reach-past cluster:
- **TFIND-002**: `sessions.createOrLoad()` writes a
  `RuntimeContextRequestRow` (full public runtime intent) — no
  `CurrentHostSession` on the client path.
- **TFIND-001**: `launch()` is the same durable-request seam (folded
  in); no longer a host-bound context primitive.
- **TFIND-003 / TFIND-039**: `session.start()` writes a durable
  `RuntimeStartRequestRow` (request/ack); a host-side
  `control-request-reconciler` binds contexts + claims/runs starts.
- **TFIND-038**: `RuntimeContextRequestRow` carries argv/env/agent
  protocol/MCP — arbitrary public runtime intent expressible client-side.
- CLI/factory migrated to the host-owned synchronous `startRuntime()`
  same-transaction (no compat wait-helper). Abandon semantics =
  terminal/no-revival/10min, idempotent claim via `insertOrGet`,
  duplicate-start suppression — guarded by 5 named deterministic
  failure-mode tests (concurrent-one-winner, window-expiry-re-eligible,
  abandon-terminal, duplicate-start-suppressed, request-not-lost) + a
  6th determinism test; CI-confirmed green; no cast on the
  reconciler/claim/dedup/completion path (charter correctness bar met).
- **TFIND-004 / TFIND-008**: UNBLOCKED — the durable-intent/reconciler
  seam makes separate-process client/host e2e expressible; realizing it
  in the toy is a toy-maintainer follow-up, the production gap is closed.
- `startOnCreate?` reserved (Option 2 not foreclosed), not built.

CONSOLIDATED DECISION (Gurdas, 2026-05-18) — cluster anchor for
TFIND-001/002/003/038/039 (one root; SDD `#332
SDD_CONSOLIDATED_CLIENT_HOST_BOUNDARY.md`):
- **Option 1 chosen**: client writes durable intent
  (`RuntimeContextRequestRow` w/ full public runtime intent incl.
  argv/env/agent-protocol/MCP — TFIND-038) + `RuntimeStartRequestRow`
  (TFIND-039's client-visible trigger); a host-side reconciler binds
  contexts + claims/runs starts. Activates #327's inert rows; one client
  path + one host path (no second bridge).
- **start() = request/ack**; CLI/factory migrate to a **host-owned
  synchronous start surface in the SAME transaction** (no temporary
  compat wait-helper). The impl SDD must name that host-owned surface
  explicitly as the migration target.
- Option 2 not chosen but **not foreclosed**: a future
  `startOnCreate: true` flag on the request row can layer
  "creation⇒execution" later.
- **LOAD-BEARING for the impl SDD (Gurdas):** name the reconciler
  failure semantics explicitly — unclaimed `RuntimeContextRequestRow`
  within a window → claim-window / retry / timeout / abandon model +
  idempotency + duplicate-start suppression. Not to be handwaved.
Next: Codex Agent 1 produces the #332 implementation SDD (no production
code) → coordinator review → Gurdas signoff → then the coordinated
transaction.

Sidecar (2026-05-17): one coupled seam with TFIND-003. SDD
`SDD_FIREGRID_CLIENT_HOST_BOUNDARY.md`. **Option B down-payment MERGED**
as #327 (`f730c68bf`): additive `RuntimeContextRequest` /
`RuntimeStartRequest` schemas + deterministic-id constructors in
`@firegrid/protocol/launch` + 3 contract tests; strictly inert
(createOrLoad/start unchanged). Remaining for full closure: the
client/CLI/factory flip
+ a host-side reconciler are a later single coordinated transaction —
tracked cross-lane dependent (relates TFIND-008/006). insertLocalRuntime-
Context cutover concern resolved (#250 already merged; deprecation
supports this direction). Adjacent: TFIND-001 shares this root cause;
`SDD_FIREGRID_SESSION_FACT_CLIENT_SURFACES.md` needs a spec delta.

`Firegrid.sessions.createOrLoad()` requires `CurrentHostSession` because it
creates a host-bound `RuntimeContext` row through `insertLocalRuntimeContext`.
That makes a remote-client-shaped test impossible through the public session
creation API: the client must be composed with host identity, even though a
production client should not be in the same Effect environment as a host.

This is a high-priority schema projection / client-surface gap. The intended
split is client writes durable, namespace-scoped intents and reads projections;
the host owns host binding and live execution. Today the session creation API
still crosses that boundary.

Next action: sidecar should define the client-visible durable create/load
contract that does not require `CurrentHostSession`, or explicitly mark
session creation as host-mediated and expose the client entrypoint that
requests it.

### TFIND-003: Critical: no remote start request surface

status: resolved (#332 — durable start request + host reconciler; see TFIND-002 cluster note)

Sidecar (2026-05-17): coupled with TFIND-002 — same SDD/PR #327, same
Option B signoff (protocol-only `RuntimeStartRequest`; `start()`
unchanged this PR; client flip + host reconciler deferred to a later
coordinated transaction). See TFIND-002 note for full framing.

`FiregridSessionHandle.start()` requires `RuntimeStartCapability`, which is a
host-process capability. In a real deployment a client should not provide this
capability in-process. There is no public client API that records "start this
session" as a durable control-plane request for a host to claim and execute.

The durable-streams-backed toy can model host execution by calling the host
capability in a separate Effect invocation, but it cannot model a true remote
client requesting start through the same public client surface.

Next action: decide whether start is a host-only operation or a client-written
control intent. Then update client-sdk/protocol accordingly.

### TFIND-004: Critical: tests must not compose client and host in one Effect environment

status: unblocked by #332 (production seam exists; toy realization = toy-maintainer follow-up)

The durable-streams-backed test briefly composed `FiregridLive` and the tiny
host layer together to satisfy `CurrentHostSession` and
`RuntimeStartCapability`. That made the test pass, but it modeled a deployment
shape a production user should not use. The real boundary is the durable
substrate: the client writes/reads Durable Streams through client-sdk, while a
host process separately observes/executes through host-sdk.

Tiny-firegrid tests should prefer separate Effect invocations for client and
host sides. If a scenario cannot be expressed that way through public APIs, the
missing surface is the finding.

Next action: after `FiregridHost` lands, keep host and client layers separate
in tests and use only the durable backend as shared state.

### TFIND-005: Workflow layer composition leaks type precision

status: #326 VERIFIED (NOT flip-ready) — Crux-B both arms pass, strict scope, gates green; co-gated on TFIND-044 + TFIND-045; coordinator holds merge

**EXECUTION VERIFIED (Agent 2, 2026-05-18; coordinator-dispositioned).**
Agent 2 completed the STRICT idiom migration on `15af74c4e`
(`sidecar/workflow-layer-precision`, force-pushed: rebased onto main
`83ff0ada5` + certified-dead lint sweep `da1356e1d` + SDD inventory
correction). Findings:
- **Crux-B binding condition MET:** both probe arms pass against the
  curried shape — Arm A `IsAny<ROut>`=false + concrete class
  (RuntimeControlPlaneTable, RuntimeOutputTable); Arm B mutual
  non-assignability proven via negative control. Probe throwaway, deleted.
- **Strict scope confirmed:** lib curry per SDD §Exact signature; 7 prod
  (SDD undercounted 6 — `DarkFactoryTable` mandatory once `Self=any`
  default removed; inventory corrected) + 14 test idiom appends; all
  non-idiom hunks are direct mechanical consequences (dead-cast/dead-
  suppression removals, test type-args, WaitFor helper generalization
  RIn=never preserved); tiny-firegrid annotation removal empirically
  proven non-papering.
- **Gates:** lint chain green; tests green all curry-affected pkgs (incl.
  host-sdk 103 — tests pass despite typecheck-red ⇒ confirms SDD's
  zero-runtime-change claim). Recursive CI typecheck RED on EXACTLY two
  residuals, both halt-rule findings, neither #326 scope.
- **Flip is HARD-GATED (flamecast IS in the merge typecheck set):** two
  reds — (1) flamecast `main.tsx:360` = TFIND-044 (already excised); (2)
  the NEW host-sdk reconciler env leak = **TFIND-045** (filed; controlled
  experiment proved NOT branch scope-creep — `control-request-reconciler.ts`
  is unmodified by the branch). #326's OWN pkgs (edo/runtime/protocol/
  client-sdk) typecheck GREEN in isolation.

#326 is preserved + correct but its flip/merge is co-gated on **both**
TFIND-044 and TFIND-045 SDD dispositions (flamecast cannot be CI-red).
Coordinator holds the merge gate. Agent 2 standby; NO impl on
TFIND-044/045 (architect-gated SDD-first).

---
Prior status (preserved for evidence):

status (superseded): FRAMING SIGNED OFF (Gurdas 2026-05-18) — #326 = mechanical curried-idiom migration ONLY; verify-then-flip; "fork (2)" EXCISED → TFIND-044

**SIGNOFF + RE-SCOPE (Gurdas, 2026-05-18; SDD signoff `349bfd8af` on
`sidecar/workflow-layer-precision`).** Curried `(ns,schemas)<Self>()`
shape **accepted** (mirrors `Context.Tag`/`Effect.Service`;
options-object + `.tag<Self>()` rejected). Binding execution conditions:
1. **Verify Crux B in practice:** before flip, run BOTH probe arms
   against the curried shape and confirm pass — (a) `IsAny<ROut>` false,
   (b) two distinct tables' `ROut` mutually non-assignable.
2. **Stale-SHA void:** `#322` is in `origin/main` (`a38da9781`); the
   dispatch's contingency plan guarded a post-#322-impossible condition
   — void, not papered. Coordinator re-synced.
3. **Halt rule (load-bearing):** proceed per SDD §"Migration plan"
   (curry lib + 6 prod + 14 test sites, no other production change). ANY
   consumer typecheck failure for a reason OTHER than a missing
   `<Self>()` idiom → HALT + surface as a NEW architectural finding (a
   latent leak the `any` hid), NOT #326 fix scope, NO forcing/widening
   cast at the call site.
4. **Verify-then-flip-ready, not flip-then-verify.** Single PR; per-file
   commits grouped (lib / runtime / protocol / tests). Flip-ready only
   after probe + full gate green.

**"fork (2)" is dissolved.** The flamecast `client/main.tsx:360`
`DurableTableProvider` TS2322 (heterogeneous N-table provider whose
single `ROut` generic can't carry N precise `<Self>` identities) is a
non-idiom consumer failure per the halt rule → **excised from #326 and
filed as TFIND-044** (own SDD, architect-gated). It is no longer a
coordinator A/B improvisation. #326's flip/merge remains gated on
TFIND-044 only because flamecast can't be left red in CI — a
properly-scoped architectural finding now, not a snap decision. Agent 2
(`155`) dispatched to audit #326 to strict idiom scope + run the probe +
verify-then-flip; the mechanical dead-cast/inference tail is in-scope
only where it is the direct consequence of the idiom (no behavior/
requirement change).

---
Prior status (preserved for evidence):

status (superseded): blocked (keystone FULLY ASSEMBLED — #326 single unit, green except fork (2); (2) ARCHITECT decision = the ONLY thing between here and the cascade)

#326 ASSEMBLED 2026-05-18: rebased clean (`--onto` dropped 7 superseded
TFIND-031 WIP; canonical = merged #331) + 5 non-toy curry-precision
cleanups + #339 (toy maintainer's 3-file cleanup, cherry-pick -x,
authorship preserved) folded as ONE mutually-dependent unit. Full lint
chain 0, lint:dead/dup(42<50)/deps 0, turbo test 17/17. Residual is
EXACTLY: (2) flamecast `main.tsx:360` TS2322
(`DurableTableProvider`/`firegridRuntimeTableTags` heterogeneous N-tag
shape — architect-gated, Gurdas) + the TFIND-043 VALIDATION.5 CI-arbiter
flake (non-blocker). #326 merges the instant Gurdas decides fork (2) →
that single merge unblocks the TFIND-007-step2 + TFIND-029 (#328)
cascade. The entire keystone is one decision away.

Fork(1) progress (2026-05-18): full repo sweep = 21 `extends
DurableTable(` callsites; 20 already curried by #326, the only
un-migrated one was `apps/factory/src/tables.ts:145 DarkFactoryTable` —
fixed. #326 branch carried 7 SUPERSEDED TFIND-031 WIP commits beneath
the 3 TFIND-005 commits (canonical TFIND-031 = merged #331 e48d82904);
coordinator authorized the clean `git rebase --onto origin/main
a7b1111b2` reconstruction (replays only the 3 TFIND-005 commits; zero
work lost). Curry-precision lint-fallout (dead casts /
`eslint-disable no-unsafe-return` / type-only imports made dead by the
precision change) ruled IN-SCOPE of fork(1): 5 non-toy sites → OCA3
(in progress); 3 toy-file sites (tiny-firegrid configs) → routed to the
toy maintainer to land CONCURRENT with #326 (lint is repo-wide
max-warnings-0; toy-edit boundary preserved). VALIDATION.5 contention
flake → filed TFIND-043 (TFIND-042-class, CI-arbiter, NOT a #326
blocker). Post-cleanup #326 residual reduces to exactly ONE merge
blocker: **fork (2)** — the heterogeneous multi-table
`DurableTableProvider`/`firegridRuntimeTableTags` precise-N-tag API
shape (flamecast `main.tsx:360` TS2322), an architect decision queued to
Gurdas. #326 merges the instant (2) is decided + the concurrent toy
cleanup lands.

Keystone update (2026-05-18): **TFIND-031 #331 MERGED** (e48d82904) —
the DurableWait* leak-stack root + Option-Y execution-scoped
self-containment is resolved (deterministic record→blocked→wake test
passing; a typecheck-passing-but-broken sibling-merge attempt was caught
& rejected by that test, not forced). #326 (the TFIND-005 curry
self-identity keystone) does NOT go green atop #331 due to #326's OWN
incomplete scope — a two-part fork, NOT TFIND-031, NOT in the SDD
buckets:
1. **Incomplete curry sweep (mechanical, IN-SCOPE of TFIND-005's
   signed-off "all callsites").** `apps/factory/src/tables.ts:145`
   `DarkFactoryTable` (and likely more app/scenario callsites) never got
   `<Self>()` — factory was absent from #326's commit → runtime
   `Class extends value () => {}`. Dispatched to OCA3 to complete the
   full repo sweep on the #326 branch.
2. **DurableTableProvider heterogeneous multi-table precise identity
   (ARCHITECT decision — beyond the signed-off SDD).**
   `firegridRuntimeTableTags` (client-sdk `firegrid.ts:237`) is an
   N-table array consumed via single-generic
   `DurableTableProvider<ROut,E>` (effect-durable-operators
   `react.ts`). Precise per-table `<Self>` identities cannot be
   represented by one ROut generic → flamecast `#typecheck` TS2322. The
   SDD scoped 6 prod + 14 test occ; it did NOT address a heterogeneous
   multi-table provider's ROut shape. This is a DurableTableProvider
   API-shape decision for the keystone owner — QUEUED to architect-handoff;
   coordinator does not improvise it.

Cascade status: TFIND-007-step2 + TFIND-029 (#328) remain GATED on #326,
which is now blocked on (2). #326 will be "green except the (2) TS2322"
once OCA3 finishes (1); it merges only after Gurdas decides (2). The
in-scope Cat C/A #326 fixes are preserved on the branch (372c8b1a0).

Keystone update (2026-05-17): the fix on PR #326 is **correct** —
`.layer` now returns a precise `Layer<<Table>, …>` (protocol typecheck
clean, all 6 prod classes + 14 test occ migrated). As the SDD predicted,
making `.layer` precise **surfaced 4 genuine pre-existing production
requirement-provision bugs** the `any` was masking (now filed as
TFIND-031..034) plus test fallout. Per discipline these were NOT papered
over. Gurdas decision: **stack** — fix TFIND-031..034 as separate scoped
PRs first (fanned to workers), then #326 rebases green and merges last as
the keystone. TFIND-005 is the keystone that also unblocks TFIND-007
step 2 and TFIND-029. #326 stays draft/red until the stack lands.

Decision (Gurdas, 2026-05-17): approve the full breaking sweep — adopt the
canonical self-referential Tag idiom `class X extends DurableTable(ns,
schemas)<X>() {}` with a `defineDurableTable` signature change, all
production call sites migrated in one transaction. Scope is **6 production
call sites + 14 test occurrences** post-#322.

Framing signed off (Gurdas, 2026-05-17): SDD
`SDD_DURABLE_TABLE_SELF_IDENTITY.md` (PR #326) reviewed and approved; the
**curried `(ns,schemas)<Self>()`** public shape is accepted
(options-object / `.tag<Self>()` rejected). The SDD proved the minimal
fix inert and the naive precise fix type-unsound (cross-table Identifier
unification). Implementation in progress on PR #326; zero runtime/behavior
change; coordinator merges on green under the mechanical-once-framed rule.

Composing `Workflow.toLayer`, `DurableTable.layer`, and
`DurableStreamsWorkflowEngine.layer` can leak `any` through `Layer` pipe
inference even when every consumed service is named explicitly. Earlier durable
configuration iterations had to localize this with annotations.

After #323, `FiregridRuntimeHostLive` has a named public surface but still
infers `Layer<any, DurableTableError, never>`. The durable-streams-backed tiny
configuration consumes the production factory directly and must localize a
single `no-unsafe-return` suppression at that return boundary.

Tiny-firegrid should continue treating broad `as unknown as Effect<...>` casts
on configuration exports as a failed model. A narrow internal annotation is only
acceptable when it identifies the production type boundary that leaked.

Sidecar root-cause trace (2026-05-17): the leak is **not** in
`DurableStreamsWorkflowEngine.layer` (that infers precisely as
`Layer<WorkflowEngineTable | WorkflowEngine, DurableTableError, never>`). It is
in `effect-durable-operators` `DurableTable`: `DurableTableTagClass<Schemas,
Self = any>` (`DurableTable.ts:191`) declares `.layer` as
`Layer.Layer<Self, DurableTableError>`, but `defineDurableTable` returns the
tag class via `as unknown as DurableTableTagClass<Schemas>` (`:1016`),
discarding `Self`, so `Self` defaults to `any`. Every `DurableTable`-derived
`.layer()` (`WorkflowEngineTable`, `RuntimeControlPlaneTable`,
`RuntimeOutputTable`) therefore returns `Layer<any, …>`, which poisons every
host/engine composition that merges a table layer. This is load-bearing: it
gates TFIND-007 step 2 (the host-sdk test suite depends on this `any` `ROut`
to discharge internal requirements).

Sidecar deepened analysis (2026-05-17, surface:155): the minimal fix is
**provably inert and the obvious stronger fix is type-unsound** —
1. A `this`-polymorphic / `Self`-flowing `.layer` typechecks 17/17 green
   but a type-probe shows `WorkflowEngineTable.layer()` ROut is still
   `any`. Green only proves no consumer relied on the `any`; the fix
   changed nothing, because `as unknown as DurableTableTagClass<Schemas>`
   + `Self = any` erases identity at the factory return and an already-
   `any` Tag Identifier cannot be recovered downstream.
2. Returning the precise `typeof DurableTableTag` is **unsound**: Effect
   Tag identity is the `Self` type param, not the runtime key. Every
   table built by `defineDurableTable` shares the same lexical
   `DurableTableTag`, so all such tables would **unify** — one table's
   layer would type-satisfy another table's requirement. Strictly worse
   than the `any` leak.
3. The only sound fix is the canonical Effect self-referential idiom:
   `class WorkflowEngineTable extends DurableTable(ns, schemas)<WorkflowEngineTable>() {}`
   — a `defineDurableTable` signature change plus every `extends
   DurableTable(` call site. This exceeds a zero-API-change down-payment.

status note: blocked pending a framing decision (architectural change vs.
accept as a documented latent finding). If approved, an SDD precedes
implementation. Root cause re-verified directly from source.

### TFIND-006: Runtime start remains a toy host capability

status: resolved (#325)

The durable-streams-backed configuration uses real Durable Streams tables and
the real `DurableStreamsWorkflowEngine`, but the host side is still a tiny
`RuntimeStartCapability` implementation with a tiny in-memory active-engine
registry and a tiny `AgentSessionService`.

It does not compose `FiregridRuntimeHostLive`,
`RuntimeContextEngineRegistryLive`, `RuntimeInputIntentDispatcherLive`,
`RuntimeContextWorkflowSessionLive`, or `RuntimeHostAgentToolHostLive`.

PR #325 replaces the durable-streams-backed toy host with
`FiregridRuntimeHostLive`, which brings the production registry, dispatcher,
runtime workflow session, per-context output writer, tool-host support, and
durable-tools observation substrate into the configuration.

Next action: keep the durable configuration on production host composition;
future gaps should become narrower findings rather than rebuilding a tiny host.

### TFIND-007: Host SDK has layer factories, not a named host surface

status: resolved (#323)

The named-type deliverable landed on `main` (#323): `FiregridHost` is
exported from `@firegrid/host-sdk`; tiny-firegrid can now return
`Layer.Layer<FiregridHost, ...>` instead of a local alias. Step 2
(annotating factory return types) remains deferred and is tracked under
TFIND-005 — see the linked note below.

`packages/host-sdk` exports public layer factories such as
`FiregridRuntimeHostLive` and `FiregridLocalHostLive`, plus capability tags
owned by protocol/runtime, but it does not export a named host surface type
that a caller can compose against directly.

Sidecar resolution (PR #323, `sidecar/host-surface`, SDD
`docs/sdds/SDD_FIREGRID_HOST_SURFACE.md`): exports a `FiregridHost` union
type from `@firegrid/host-sdk` — a `@category models` union following
Effect's own `NodeContext`/`BunContext` precedent, not a `Host` service.
Step 2 (annotating the factory return types `Layer.Layer<FiregridHost,
...>`) is **deferred and blocked on TFIND-005**: the factories currently
infer `Layer<any, …>` (the TFIND-005 leak) and the host-sdk test suite
depends on that `any` to discharge internal requirements; pinning the
return before TFIND-005 turns the suite red.

Tiny-firegrid now consumes the exported type instead of inventing a local
host-layer alias.

Next action: complete factory return type annotation after TFIND-005.

### TFIND-008: Client surface and host surface cannot yet be tested as separate processes end-to-end

status: unblocked by #332 (separate-process client/host seam exists; toy e2e = toy-maintainer follow-up)

The desired test shape is: client Effect program writes context/input/start
requests through client-sdk; separate host Effect program observes durable
state and executes runtime; client Effect program reads output projections.
The current public APIs do not support that shape cleanly because session
creation and start still require host-side Effect services.

This is the most important value produced by the toy so far: it located the
boundary violation at the public API signatures rather than in lower-level
runtime mechanics.

Next action: unblock TFIND-002, TFIND-003, and TFIND-007, then rewrite the
durable-streams-backed test into separate client and host invocations.

### TFIND-009: Durable workflow codec is orphaned within the workflow-engine closure

status: superseded (false positive — codec is load-bearing)

The coverage analysis found
`packages/runtime/src/workflow-engine/internal/codec.ts` is not imported by
`workflow-engine/` production modules. That is a production cleanup finding,
not a tiny-firegrid coverage gap.

Resolution (sidecar, 2026-05-17): **FALSE POSITIVE — no action.**
`internal/engine-runtime.ts` imports all four codec exports
(`decodeWorkflowResult` / `encodeWorkflowResult` / `reviveEncodedResult` /
`reviveExit`) and uses them at 7 call sites; `makeWorkflowEngine` is
reached via the public `@firegrid/runtime/workflow-engine`
(`DurableStreamsWorkflowEngine`) and exercised by
`DurableStreamsWorkflowEngine.test.ts` + `deferred-done-idempotency.test.ts`.
The codec is connected and load-bearing, not vestigial. The coverage
tool's import graph missed `engine-runtime.ts → codec.ts` (toy-closure
walk). Nothing to delete or reconnect; no PR.

### TFIND-010: RuntimeContext engine registry is load-bearing

status: open

The first dispatcher-backed toy used a closed-over execution id rather than a
registry mapping `contextId` to active engine handles. That proved the single
context happy path, but it could not model the important host behavior:
demuxing intents to active per-context engines, leaving no-engine intents for
startup reconciliation, teardown/deregistration, or multi-context isolation.

Later in-memory configurations added the registry shape, but the
durable-streams-backed configuration still uses a tiny local registry instead
of production `RuntimeContextEngineRegistryLive`.

Next action: model production registry behavior in the host-sdk-backed durable
configuration.

### TFIND-011: Startup reconciliation is not yet modeled against Durable Streams

status: open

The per-context architecture requires a newly started owner engine to read the
namespace intent stream for its context and process unconsumed intents before
tailing new ones. The in-memory model documents this shape, but the
durable-streams-backed configuration does not yet prove reconciliation against
the production Durable Streams backend.

Next action: add a durable replay/reconciliation case after the host type and
registry path are wired through production host-sdk.

### TFIND-012: Wait-for output surface still needs production-backed modeling

status: open

The toy has an in-memory `wait-for-output` configuration, but the
durable-streams-backed configuration exercises client `wait.forAgentOutput`
through the output table only for the modeled text path. It does not yet model
the runtime durable-tools `wait_for` surface or the production wait router.

This matters because the host-vs-context audit found that the non-After
`AgentOutput` wait-router arm reads the host-prefixed runtime output stream,
while post-#315 production writes per-context runtime output streams. The toy
model identifies option (a), making the non-After arm context-aware, as the
architecturally aligned fix.

Next action: add a production-backed wait configuration after host/client
surface cleanup.

### TFIND-013: Output journal / A4 path remains unmodeled in the durable configuration

status: resolved (#338, `960ec59b3`)

RESOLVED 2026-05-18 (#338 merged — `output-journal-pipeline.ts` toy
config + test, full CI gate green, coordinator-reviewed). The config
exercises the per-context output-authority / `AgentOutputAfter` path
against production `FiregridRuntimeHostLive`. **Halt-class clearance
recorded:** an interim CI-red showed a 4th per-context output row
(`[0,1,2,3]` vs `[0,1,2]`) on the #318/#331 `AgentOutputAfter` path —
investigated as a possible duplicate-output regression in merged
#318/#331. Root cause was a **test-fixture double-emit** (the toy agent
fixture printed its own `Terminated` envelope *and* the stdio-jsonl
codec derives terminal evidence from process exit ⇒ two terminal rows),
fixed by the fixture no longer printing `Terminated` (just
`process.exit(0)`, codec owns terminal evidence). Verified non-papering:
`readPerContextOutputRows` asserts the **raw unfiltered** journal
(`events.query(toArray)`), assertion stays `[0,1,2]`. **NOT a #318/#331
production regression** — deterministic fixture bug. Reach-pasts
annotated to TFIND-039/040.

---
Prior status (preserved): open

The durable-streams-backed configuration writes runtime output through
`RuntimeOutputTable` directly. It does not exercise
`RuntimeAgentOutputAfterEvents` / the per-context output authority path that
surfaced the A4 drift.

Next action: extend the durable configuration or add a sibling configuration
that routes output through the production output authority path.

### TFIND-014: Tool execution and AgentToolHost are intentionally deferred

status: open

The current toy session advertises `tools: false` and uses
`toolUseMode: "observation_only"`. It does not model `RuntimeToolUseExecutor`,
`AgentToolHost`, `toolUseToEffect`, or activity-wrapped tool execution.

Next action: add a tool-execution configuration after the host/client surface
is stable enough to avoid hard-coding another toy-only tool seam.

### TFIND-015: Permission flow and codec authority remain unsettled

status: FRAMING DRAFTED + COORDINATOR-REVIEWED-SOUND (SDD #350 `SDD_PERMISSION_CODEC_AUTHORITY.md`); awaiting Gurdas batched signoff (bundle: TFIND-048 + TFIND-015 [+#334]). gates `permission-flow-pipeline`.

**Framing (SDD #350, by `163`, coordinator-reviewed 2026-05-18):** §0
= the Gurdas-accepted question verbatim. A = bless ACP codec-side
durable-deferred authority; **B (recommended) = strict observation +
workflow-side durable resumption** (codec keeps ONLY the live ACP
promise/correlation; workflow/runtime owns durable deferred
creation/completion). Evidence **coordinator-verified accurate**: the
ACP codec genuinely does durable-deferred permission authority *from
inside the codec* — `DurableDeferred.make` (acp/index.ts:154-158),
`engine.deferredResult(...)` poll + `DurableDeferred.done(...)`
(:283-328), requiring `WorkflowEngine`/`WorkflowInstance` — while the
codecs README explicitly states codecs "may not own … durable
permission state." Concrete documented-contract contradiction; B aligns
impl to the existing contract and is consistent with the TFIND-041
authority-family precedent (same family, not mechanically identical:
ACP reaches into WorkflowEngine/DurableDeferred whereas TFIND-041's
decided branch is workflow code reading a normalized event by session
mode). If Gurdas picks A, the codec boundary docs+tests must be
explicitly rewritten to bless codec-side permission authority. No code;
no experiment needed at framing level.

Original framing (preserved):

The toy does not yet model permission requests or permission responses. That
leaves open the Cycle 1 question: whether codec layers only translate protocol
events, or whether any codec currently completes workflow deferreds / performs
authority-like work for permission-class events.

Next action: add a permission-flow configuration that makes permission request
output observable through the per-context output channel and routes permission
responses back as client input intents, unless production chooses a different
authority boundary.

### TFIND-016: Activity boundaries are not yet represented

status: open

The toy workflow uses `DurableDeferred.await` and direct Effect composition,
but it does not model `Activity.make` / workflow activity execution. Production
uses activity boundaries to isolate side effects, retries, and replay behavior.

Next action: include an activity boundary in the future tool-execution
configuration.

### TFIND-017: DurableTable rows are live tails in the toy adapter

status: open

The in-memory DurableTable adapter's `rows()` stream was changed from a finite
snapshot to snapshot-plus-live-tail semantics to match subscriber use cases.
That is useful for dispatcher-style configurations, but `Stream.runCollect` on
`rows()` will now hang. Snapshot reads should use `query()`.

Next action: keep this documented near the adapter and use `query()` for
snapshot-only reads.

### TFIND-018: Hand-maintained contracts are rejected

status: resolved (#317/#320 cleanup)

Earlier toy iterations introduced hand-maintained contract/type files such as
`properties/type-contracts.ts` and wait-source types. That violated the core
purpose of the package: drift should appear as type errors against production
exports, not as another maintained mirror.

Rule: import production types when they are public and architecturally
meaningful; if the needed type is not exported, record a finding instead of
recreating it locally.

### TFIND-019: Internal transition functions are rejected

status: resolved (#317/#320 cleanup)

Earlier toy iterations included `simulation/transitions.ts` and direct
transition-style helpers. Those are not aligned with the purpose of
tiny-firegrid. The model should be driven through public Effect, Stream,
DurableTable, Workflow, client-sdk, protocol, runtime, and host-sdk surfaces.

Rule: if a scenario needs a direct transition function to be expressible,
production is hiding an architectural seam.

### TFIND-020: Configuration files should each express one system shape

status: open

The first durable-streams iteration exported separate runnable effects for
end-to-end and replay scenarios. That mixed scenarios into the configuration
and made the file read like test infrastructure rather than a named system
configuration.

Direction: one configuration file = one Firegrid system shape. Tests exercise
multiple properties of that shape.

### TFIND-021: Scenario tests should stay above component internals

status: resolved (#317/#320 cleanup)

Lower-level tests such as DurableTable seam tests were removed or rejected
because tiny-firegrid is not a replacement for unit tests. Its tests should
assert full-system properties of a configuration: intent to output, replay,
multi-context isolation, wait semantics, and future tool/permission flows.

### TFIND-022: `src/index.ts` should not become an artificial public API

status: open

The package is private and exists as executable architecture documentation.
Exports should stay minimal. Adding exports just because code exists makes the
toy look like a reusable library and obscures which files are configurations
versus implementation scaffolding.

Next action: review exports before opening the PR and keep only entries needed
by tests or future configurations.

### TFIND-023: Package layout should mirror production package layout

status: resolved (#317/#320 cleanup)

Folders such as `seams/` were rejected because they introduced toy vocabulary.
The directory structure should mirror current production conventions
(`runtime/agent-event-pipeline`, `runtime/agent-adapters`, `host-sdk/host`,
`effect-durable-operators`, `configurations`) so readers can map toy code back
to production code directly.

### TFIND-024: Agent adapter path is still under-modeled

status: open — BLOCKED on TFIND-049 (its cat-4 framing concealed a cat-1 production kernel)

The toy currently models an `AgentSessionService` and a tiny sandbox output
stream, but it does not yet show how `packages/runtime/src/agent-adapters` fits
between sandbox/process streams, codecs, workflow session send/receive, and
output persistence.

**Re-triage 2026-05-18:** TFIND-024 was triaged cat-4/toy on the
assumption "`agent-adapters` exists in production." `33`'s
`agent-adapter-driven-pipeline` build attempt (Gurdas-directed) proved
that assumption WRONG: the adapter path is **not wired into the runtime
host** (effect-ai-native-agents **Slice 4 unbuilt** — see TFIND-049 for
verified file:line evidence). So TFIND-024 is the canonical
"cat-1/2 kernel hiding in cat-4 toy framing" inverse-risk (cf.
TFIND-012/015): the toy "under-modeling" is a *symptom* of an unbuilt
production capability, not toy laziness. TFIND-024's toy realization is
**blocked on TFIND-049 / Slice 4**, not on "host/client process
separation."

Next action: gated on TFIND-049 (Slice 4 roadmap decision — Gurdas).
When the runtime host integrates `AgentAdapterRegistry`, the
`agent-adapter-driven-pipeline` config realizes this finding.

### TFIND-025: Durable-tools Shape C / wait arbitration remains unmodeled

status: open

The toy does not model the durable-tools wait router, timeout arbitration, or
future Shape C step 2 (`DurableDeferred.raceAll`-style arbitration). Because
wait behavior crosses workflow, output, and tool surfaces, it should be modeled
as a full configuration rather than a lower-level helper test.

Next action: add a durable-tools configuration after TFIND-012.

### TFIND-026: Durable-streams backend reached Group D

status: resolved (#321)

The durable-streams-backed configuration boots `@durable-streams/server`, uses
production `RuntimeControlPlaneTable`, `RuntimeOutputTable`, and
`DurableStreamsWorkflowEngine`, and asserts replay after engine reconstruction
without duplicate client sends.

### TFIND-027: Duplicate inline configuration code is acceptable

status: accepted

Duplication inside tiny-firegrid configurations is acceptable when it keeps the
architectural wiring visible. The package is documentation plus verification;
factoring every repeated line into helpers can make the system shape harder to
read. Duplication should still not obscure public boundaries or create hidden
toy APIs.

### TFIND-028: RuntimeStartCapabilityLive did not capture workflow support services

status: resolved (#325)

Switching the durable-streams-backed configuration to the production
`FiregridRuntimeHostLive` surfaced that `RuntimeStartCapabilityLive` captured
`RuntimeContextEngineRegistry` and `AgentToolHost`, but not the host-scoped
services needed later by `runtimeContextWorkflowSupportLayer`. Calling
`RuntimeStartCapability.start()` as a public host capability failed at runtime
with a missing `RuntimeOutputTable`.

The fix captures the full host context when constructing the capability and
provides it when running the claimed context workflow. This keeps
client/host-separated tests on the public capability instead of reaching for a
private start path.

The ambient capture does not currently introduce a type/lint leak: focused
host-sdk and tiny-firegrid typecheck plus eslint pass. It is still an indirect
dependency expression; TFIND-029 tracks the clearer explicit-dependency shape.

Next action: keep `FiregridRuntimeHostLive` in tiny-firegrid so future support
layer regressions surface in this configuration.

### TFIND-029: RuntimeStartCapabilityLive should enumerate workflow support dependencies

status: in-progress (`sidecar/runtime-start-deps`)

Sidecar (2026-05-17): assigned as an independent parallel task; verify
what #325 did (ambient capture) then either implement explicit
enumeration (mechanical) or justify ambient via a short SDD (framing-
gated). Draft PR for visibility.

TFIND-028 fixed the runtime bug by capturing the full host context when
constructing `RuntimeStartCapabilityLive` and re-providing it when `start()`
runs. That is behaviorally correct, but it captures every ambient service
rather than naming the services `claimAndRunRuntimeContextWorkflow` needs
through `runtimeContextWorkflowSupportLayer`.

A more explicit production shape would make those requirements visible in the
layer contract instead of relying on ambient context capture. That would make
future support-layer changes fail at composition/type boundaries rather than
at runtime.

Next action: refactor `RuntimeStartCapabilityLive` to enumerate the workflow
support dependencies it must retain, or document why Effect context capture is
the intended host-capability pattern.

### TFIND-030: Snapshot agent output events are typed as records, not protocol unions

status: resolved (#329, a7c76c268)

RESOLVED 2026-05-18 (#329 merged): protocol-owned `AgentOutputEvent`
union (byte-mirroring runtime via the same `@effect/ai` Prompt/Response
primitives; `@effect/ai` added to `@firegrid/protocol` — Gurdas-blessed,
lint:deps clean). Protocol envelope/observation decode parses `event`
against the union; `session.snapshot().agentOutputs[].event` is the typed
union, re-exported from client-sdk. Q2 STRICT: non-conforming event →
`Option.none()` (intentional observable change to snapshot()/wait.* for
malformed events; verified by decode-PATH + reject-path tests).
Out-of-scope SSOT consolidation deferred = TFIND-035. The intentional
protocol↔runtime mirror is recorded via a scoped `.jscpd.json` ignore
(repo's sanctioned by-design-dup mechanism, not a global threshold bump).

Framing signed off (Gurdas, 2026-05-18): Q1 = **Option C** (smallest
sound down-payment — protocol-owned `AgentOutputEvent` union; switch only
the protocol envelope/observation decode + client-sdk snapshot type;
runtime `events/output.ts` untouched); Q2 = **strict reject**
(non-conforming `event` → decode error/`Option.none()`, an intentional
observable change to `snapshot()`/`wait.*`, documented in #329). Full
SSOT consolidation deliberately deferred → tracked as TFIND-035 (a
tracked dependent, not a bridge). Implementation in progress on #329.

Sidecar (2026-05-18): verified real (not discoverability). The typed
`AgentOutputEventSchema` union is `@firegrid/runtime`-owned; client-sdk
and protocol are runtime-source-free, so exposing it needs a
**protocol-owned union = cross-package schema-ownership change**, and the
protocol decode currently parses `event` only as a `Record` + `_tag`
string (a sound fix changes the protocol DECODE CONTRACT — a behavior
change). Decisive: `SDD_FIREGRID_SCHEMA_PROJECTION_CONTRACT.md` already
prescribes `event: AgentOutputEventSchema` — current `Record` is a
divergence from the approved target; plus two divergent envelope decoders
(runtime typed vs protocol Record) = latent SSOT finding. SDD on PR #329;
framing-gated on Q1 (ownership mechanism) + Q2 (decode reject vs
permissive — observable behavior). No code until Gurdas signoff.

The durable-streams-backed test needs a local `textDeltas` projection that
checks `agentOutputs[].event` as `Record<string, unknown>` instead of using the
typed `AgentOutputEvent` union. The runtime output rows are decoded correctly
at runtime, but the client snapshot projection type loses the discriminated
event shape.

This weakens client-side code that wants to branch on `_tag` or inspect event
payloads from `session.snapshot()` without local record checks or casts.

Next action: tighten the client-sdk snapshot/projection type so decoded
`agentOutputs[].event` is exposed as the public `AgentOutputEvent` union.

### TFIND-031: host/toolkit composition omits a shared DurableTable tag-family provision

status: resolved (#331, e48d82904)

RESOLVED 2026-05-18 (#331 merged): Option-Y execution-scoped
self-containment landed exactly as the SDD diagnosed — the support
layer required what it provided (`RuntimeToolUseExecutorLive`'s own
`Effect.context<DurableWait*>` capture was provideMerged as a sibling,
never discharged). Fix (NO cast): provide the SAME
`HostRuntimeObservationSubstrateLive` reference INTO the executor while
keeping it provideMerged into the workflow chain → Effect memoization =
ONE shared store (workflow body + wait-router + tool executor);
`toolCallWorkflowSupportLayer` got analogous self-containment. A first
sibling-`Layer.merge` attempt typechecked but broke
`TOOL_EXECUTOR_SEAM.2` schedule_me — **caught and rejected by the
deterministic record→blocked→wake test, not forced green**; corrected
re-thread passes it. Full gate green (turbo typecheck 17/17, test 17/17,
host-sdk 96/96 incl. the wake path), CI-confirmed. Cat A/B fixes
included. Closes the TFIND-005 leak-stack root; the remaining TFIND-005
keystone work is the separate #326 curry-self-identity fork (see
TFIND-005).

Honest keystone status (2026-05-18): NOT green yet, by design. The
shared-store gate passed (structural proof, prior). Final Option-Y
type-threading hit a precisely-diagnosed knot, **recorded not forced**:
`runtimeContextWorkflowSupportLayer` carries `DurableWait*` in BOTH RIn
and ROut (requires-what-it-provides), so `Effect.provide` re-surfaces
unsatisfied `DurableWait*` on every consumer regardless of capture seam —
why narrowed and widened variants leaked identically. Bounded fix (NOT a
new fork; Option Y unchanged + proven): make the support layer
self-contained for `DurableWait*` (internal `Layer.provide` of the single
proven shared store so the tags leave RIn while staying in ROut; correct
the `provideMerge`/`unwrapEffect` ordering in
`RuntimeContextWorkflowNativeLayer.pipe(...)`). Correctness-critical wait
routing — must be validated by a deterministic record→blocked→wake test,
no forcing cast. The same agent that diagnosed it (it wrote the precise
handoff into this branch's SDD) is executing the focused completion run;
remaining: support-layer re-thread, det. test, ~42 Cat A/B/C fallout,
full gate, flip #331, rebase #326 → then keystone cascade unblocks
TFIND-007-step2 + TFIND-029.

Shared-store gate DISCHARGED (2026-05-18, structural proof on #331, not
convention): `DurableWaitStoreLive` materializes NO store of its own (all
5 services are pure `Effect.map(DurableToolsTable, …)` adapters);
`DurableToolsWaitForLive` calls `DurableToolsTable.layer()` exactly once
and feeds the same ref to both `WaitRouterLive` (waker) and the recorder
tags over one `durableToolsTableLive` — Effect Layer memoization ⇒
waker+recorder are one materialized store; a divergent store is
structurally impossible at source. Emit-then-wait hazard closed at the
source. Agent 2 proceeding with Y autonomously (gate was the sole
escalation trigger; it passed). Remaining: re-thread support-layer
DurableWait* discharge to the 3 leak seams, deterministic
record→blocked→wake confirmation test, ~42 Cat-A/B/C fallout, verify,
flip #331, rebase #326.

Update (2026-05-18): the contained ambient-tag fixes are done (client-sdk
launch provideService; `HostRuntimeContextExecutionEnv` capture of
RuntimeControlPlaneTable|RuntimeOutputTable|CurrentHostSession|RuntimeHostConfig).
The remaining 3 seams (toolkit-layer:215, agent-tool-host-live:90,
commands:163) leak the 4 `DurableWait*` tags — an architectural fork
(SDD `SDD_TFIND031_DURABLE_WAIT_SUBSTRATE_OWNERSHIP.md`, PR #331). Gurdas
signed off **Option Y** (execution-scoped: merge `DurableWaitStoreLive`
into `runtimeContextWorkflowSupportLayer`; no public host-contract change,
no test ambient edits) with a NON-NEGOTIABLE emit-then-wait correctness
gate: a deterministic blocked-pending test must PROVE
`DurableWaitStoreLive` and `HostOwnedDurableToolsWaitForLive` resolve to
ONE shared materialized store (router wakes on the store waits are
recorded in); divergence → restructure to one store or re-escalate, never
assume. On green, #326 rebases → keystone merge (unblocks
TFIND-007-step2 + TFIND-029).

Surfaced by TFIND-005. Initially filed as 4 separate leaks
(TFIND-031..034); Agent 2's finding-grade diagnosis (2026-05-17) shows
they are **one root cause, not four**: all four production boundaries
plus the test fallout leak the *same tag family* —
`RuntimeControlPlaneTable`, `RuntimeOutputTable`, and the four
`DurableWait*` row tags. The `any` collapsed every consumer's
requirements channel, so a single missing provision site in the
host/toolkit composition manifested at 4 production type-boundaries +
test boundaries. Triaged as ONE root finding with multiple
manifestations — fixed as a single scoped PR, not a 4-PR scatter
(narrower, smaller, correct shape).

Manifestations (folded in): `client-sdk/src/firegrid.ts` (TFIND-032
... see superseded rows), `host-sdk/src/host/agent-tool-host-live.ts`,
`host-sdk/src/host/commands.ts` (CLI inherits),
`host-sdk/src/agent-tools/execution/toolkit-layer.ts`
(HandlersFrom/DurableWaitRowLookup shape).

Test fallout categorized by Agent 2: Cat A — `as Layer<never>` cast
masks (2 files, remove cast); Cat B — genuine requirement surfacing (5
files, fixed by the root provision); Cat C — inference loss (1 file,
`react-types.test.ts`: provider correct, test needs explicit type args).
Protocol src+test fully clean — confirms the TFIND-005 core fix is sound.

Next action: Agent 2 traces the single provision site, lands the root
provision + test-fallout fix as ONE scoped PR (separate from #326); then
#326 rebases green and merges last as the keystone (unblocks
TFIND-007-step2 + TFIND-029).

### TFIND-032: (folded into TFIND-031)

status: superseded (manifestation of TFIND-031 — `agent-tool-host-live.ts`)

Not an independent bug. Same root as TFIND-031 (shared tag-family
provision missing). See TFIND-031.

### TFIND-033: (folded into TFIND-031)

status: superseded (manifestation of TFIND-031 — `commands.ts`)

Not an independent bug. Same root as TFIND-031. CLI inherits this
boundary. See TFIND-031.

### TFIND-034: (folded into TFIND-031)

status: superseded (manifestation of TFIND-031 — `toolkit-layer.ts`)

Not an independent bug. The `HandlersFrom`/`DurableWaitRowLookup` shape
is the same root tag-family provision gap viewed through the toolkit
handler chain. See TFIND-031.

### TFIND-035: Two divergent agent-output envelope decoders (SSOT consolidation)

status: resolved (#333, 28aac646f)

RESOLVED 2026-05-18 (#333 merged) per signed-off framing: canonical
`AgentOutputEvent` union + part sub-schemas relocated to a dedicated
`@firegrid/protocol/agent-output` subpath (Q3); `@firegrid/runtime`
`contract.ts` re-exports the moved subset, dup defs deleted (Q1=A
relocate+re-export); one envelope decoder with the two observation shapes
retained (Q2); no further @effect/ai (Q4). #329's
`session-facade/agent-output-event.ts` mirror deleted; client-sdk
`AgentOutputEvent` unchanged. **Completion signal achieved**: the scoped
`.jscpd.json` ignore was DELETED — duplication genuinely eliminated, not
hidden (lint:dup 42<50 with the ignore removed; was 91 when duplicated).
Closes the TFIND-030 SSOT dependent.

Surfaced during TFIND-030. There are two envelope decoders for
agent-output rows: runtime's (`agent-event-pipeline/events/output.ts`,
already parses `event: AgentOutputEventSchema` — typed) and protocol's
(`session-facade/schema.ts` — previously a `Record`; TFIND-030 makes it
parse the new protocol-owned union). TFIND-030 Option C deliberately
leaves the runtime decoder and the runtime-owned `AgentOutputEventSchema`
in place to keep blast radius minimal. This is the deferred SSOT work:
relocate/consolidate to a single protocol-owned canonical union with
runtime re-export, collapsing the two decoders. Deliberate tracked
dependent, NOT a bridge — must be closed, not left as a permanent fork.

Now active as the tracked dependent (TFIND-030 landed #329). The
accepted intentional duplication is currently recorded via a scoped
`.jscpd.json` ignore on
`packages/protocol/src/session-facade/agent-output-event.ts` — that
ignore is the standing marker of this debt and MUST be removed when the
canonical relocation lands (its removal is the completion signal).

Next action: scope the canonical relocation (option A/B of SDD #329 —
move `AgentOutputEventSchema` + part sub-schemas to `@firegrid/protocol`,
runtime re-exports, collapse to one decoder, delete the jscpd ignore) as
its own coordinated PR. Architectural; SDD + framing-gate. On-deck owner:
OCA3 (deepest context from #329), sequenced after the consolidated
client/host SDD priorities.

### TFIND-038: Client session creation cannot express arbitrary runtime intents

status: resolved (#332 — RuntimeContextRequest carries full public runtime intent; see TFIND-002 cluster note) — TOY-REALIZATION pending (Gurdas decision: option 3, see below)

**TOY-REALIZATION DECISION (Gurdas, 2026-05-18) — applies to the Codex
ACP + stdio-jsonl tool-execution tests (TFIND-038/039 reach-pasts;
relates TFIND-004/008).** The *production* findings 002/038/039 are
resolved by #332. The remaining work is the toy-side realization: the
Codex ACP and stdio-jsonl tests still demonstrate the exact
anti-patterns the durable-streams migration (#341/#342) eliminated —
host-context capability extraction, host-bound row construction, direct
`RuntimeStartCapability.start`, snapshot polling — annotated to
TFIND-038/039/040 but green under the annotations, so the findings gate
nothing operationally and the tests silently model the patterns the
production-fidelity rubric now discourages.

**Decision: option (3).** Migrate BOTH tests to the production-fidelity
public client/session surface (the #341/#342 pattern) **now**, in ONE
PR, by ONE agent (toy maintainer, `surface:33`), where **migration ==
validation**: prerequisites (#332) have landed, so they should go green
through the public surface. If any cannot, that is the validation
signal — **file the surface gap as a NEW finding; do NOT reintroduce an
escape hatch, do NOT `it.skip`**. Migration and any finding-resolution
in the SAME PR by the SAME agent so there is no window where someone
"fixes the red test" by re-adding host reach-pasts. `RuntimeContextSnapshot`
typing gap filed regardless as **TFIND-047** — the migration must
consume/validate it (eliminate the `asRecord` casts, or TFIND-047
tracks why it cannot yet). Dispatched to `surface:33` 2026-05-18.

Original triage/evidence below.

status: resolved (#332 — RuntimeContextRequest carries full public runtime intent; see TFIND-002 cluster note)

The Codex ACP tool-call test manually constructs a `RuntimeContext` with
`makeLocalRuntimeContextForHostSession` and writes it through
`RuntimeControlPlaneTable.contexts.upsert(...)`. It does this because the
client session facade cannot currently create/load a session with arbitrary
runtime configuration: binary argv, env bindings, ACP protocol selection, and
MCP server declarations.

That is not just test awkwardness. A real consumer that wants to launch a
specific agent binary with a specific MCP setup has the same gap: the
client-visible session creation surface does not yet express the full public
runtime intent needed for this scenario.

Sidecar triage (2026-05-18, surface:153): part of the client/host boundary
cluster — a sharper manifestation of TFIND-002. The #327
`RuntimeContextRequest` schema is the seam; the likely down-payment is an
additive enrichment of that request to carry full public runtime intent
(argv/envBindings/agentProtocol/MCP), analogous to Option B. Not fanned
out separately — to be folded into the consolidated client/host
transaction (see TFIND-039 / TFIND-001 SDD).

### TFIND-039: Client SDK has no client-visible runtime start trigger

status: resolved (#332 — durable start trigger + host reconciler landed; see TFIND-002 cluster note) — TOY-REALIZATION pending (Gurdas option-3 decision recorded under TFIND-038)

The Codex ACP tool-call test manually extracts `RuntimeStartCapability` from
the host context and calls `start({ contextId })`. That is a host capability,
not a real client operation. The test reaches into it because the client SDK
does not expose a durable start request or any other client-visible way to ask
a host to start a runtime context.

This is the bigger operational split gap: Firegrid can model a client appending
input intent rows and reading projections, but starting the runtime still
requires an in-process host service. Either hosts should auto-start eligible
contexts when they become active, or the client plane needs a durable
start-trigger row that a host-side reconciler observes and claims.

Sidecar triage (2026-05-18, surface:153): this **is** the deferred
host-reconciler transaction already identified as the cross-lane
end-state of TFIND-002/003 (`SDD_FIREGRID_CLIENT_HOST_BOUNDARY.md` §3/§5).
The #327 `RuntimeStartRequest` schema is its client-side half (merged,
inert). NOT a new independent workstream — it is the named form of the
cluster end-state; to be scoped as ONE consolidated client/host
reconciler SDD/transaction after the TFIND-001 investigation lands.

### TFIND-040: Client SDK lacks a per-event session observation surface

status: in-progress (SDD #334 ready — framing review; Q1 deferred to #332; impl queued)

SDD #334 (`SDD_FIREGRID_SESSION_OBSERVATION_SURFACE.md`,
`sidecar/session-observation`): the substrate primitive already exists
internally (`waitForAgentOutputObservation` = `RuntimeOutputTable.events
.rows()` tail → filterMap → filter); `subscribe()` is that pipeline minus
`Stream.runHead`, yielding TFIND-030 typed `RuntimeAgentOutputObservation`.
No substrate/protocol change; `wait.forAgentOutput` refactors to
`subscribe |> filter |> runHead` (one code path, no drift). Stable across
TFIND-035 (consumer only). Framing: Q1 attach-point (A session / B
context / C both) **explicitly deferred to #332** per Gurdas (impl is
contextId-keyed/attach-point-agnostic, so deferral is non-blocking);
coordinator concurs with OCA3 recs on the rest — **Q2** live-tail until
scope close, **Q3** ship `subscribe()` only first (wait.* enrichments =
tracked follow-up), **Q4** generic stream only (typed conveniences =
follow-up sugar). Non-blocking: impl queued behind keystone /
TFIND-035-impl / #332-impl-SDD; awaiting Gurdas rubber-stamp on Q2/Q3/Q4.

The Codex ACP tool-call test subscribes directly to `RuntimeControlPlaneTable`
and `RuntimeOutputTable` for durable assertions, but still polls
`session.snapshot()` to assemble final text because the client SDK lacks a
session-scoped event stream. Today the choices are either low-level durable
table subscriptions or broad snapshot polling.

This matters for client-shaped tests and real consumers that want to react to
agent output incrementally. A `session.subscribe()` stream or a richer
`session.wait.*` family would let tests and applications observe events without
polling snapshots or manually opening substrate tables.

Sidecar triage (2026-05-18, surface:153): distinct client-surface
ergonomics finding (a `session.subscribe()` / richer `session.wait.*`).
Relates to TFIND-008 (separate-process e2e) and consumes TFIND-030's
typed `AgentOutputEvent` decode. Architectural; track open, scope after
TFIND-030 lands and the client/host transaction shape is settled.

### TFIND-036: Firegrid MCP toolkit lacks a read-only runtime-state query tool

status: RE-TRIAGED cat-3 → toy redirect (2026-05-18; was QUEUED-FOR-ARCHITECT/SDD #335)

**RE-TRIAGE (2026-05-18, coordinator, per FINDINGS_TRIAGE_RUBRIC.md +
Gurdas direction).** Triage category: **3 (test-fixture awkwardness)** —
the canonical cat-3. The triage question: *would a real consumer outside
Firegrid need an agent to read its own runtime-run exit code for a real
purpose?* No: the agent is inside the current run (it has not exited), and
runtime-run exit/signal is host-plane forensic data with no coherent
in-run agent use. The `sleep durationMs:0` "workaround" was the toy
reaching for a plausible-sounding capability to exercise the MCP bridge —
test-fixture awkwardness wearing capability clothes. **No production
change. No further SDD work.**

Redirect to the toy maintainer (what to do instead): exercise the MCP
bridge with an *existing* tool, or use `wait_for{RuntimeRun}` (already a
host-plane agent primitive) where the config genuinely needs run presence
/ terminal state; accept that there is no non-blocking "read my own exit
code" because that capability is not well-formed in the agent plane. The
finding is closed as reframed, not as built.

SDD #335's two-plane boundary analysis (session-plane name vs host-plane
truth; why `session.status` is deliberately dormant; why option (A) would
ship a leak) is **retained as the recorded rationale for why there is no
agent runtime-state read** — it is documentation of the boundary decision,
NOT an implementation track. SDD #335 stays draft/closed, no dispatch.

Note: TFIND-036 reaching a 4th-revision SDD before this triage is the
process gap that motivated the rubric (see "## Triage Audit (2026-05-18)").
It was caught at the SDD stage — no production code shipped.

---
Original framing (preserved for evidence):

status (superseded): QUEUED-FOR-ARCHITECT (architectural binary; SDD #335; not dispatched)

Sidecar review (2026-05-18, OCA3 SDD #335,
`sidecar/mcp-readonly-query`): two nuances reframe this from "add a
tool" to a binding-SCOPE + read-CONTRACT decision a coordinator may NOT
make:
1. `wait_for` ALREADY accepts `RuntimeRun` as a source
   (`RuntimeWaitSource = AgentOutput | RuntimeRun`) but is a *blocking
   suspension* primitive — it cannot express a non-blocking "most recent
   run + exit code / none-yet" read. The `sleep durationMs:0` workaround
   exists because there is NO read at all.
2. A `session.status` operation ALREADY EXISTS in the protocol catalog
   but is DORMANT: `clientName`+`cliName` projection, **no `toolName`**,
   and no live impl on any surface. The absent `toolName` is itself an
   already-expressed product stance: runtime-state reads are
   client/CLI-facing, NOT agent-facing.
Options: **A** realize + tool-bind `session.status` (reuse schema,
session-level not raw run exit code; forces realizing a dormant op);
**B** new dedicated read-only runtime-runs query op over
`RuntimeControlPlaneTable.runs` → latest `RuntimeRunEventRow`
(exitCode/signal), read-only by construction (OCA3 non-committal lean);
**C** affirm no agent read (the stance `session.status` already
encodes). Narrow Qs: Q1 read contract, **Q2 agent-surface-at-all (core
product call)**, Q3 read-only lowering/authority guarantee, Q4 wait_for
overlap, Q5 dormant `session.status` realization across client/CLI. No
substrate change.

**Coordinator action:** Q2 is a core product binary Gurdas has not
decided — per the autonomous charter this is QUEUED for architect-handoff,
NOT dispatched. No production code. Carried in the architect-handoff
status. SDD #335 stays draft.

The requested scenario wanted a simple read-only tool such as "find the most
recent runtime run for this context and report its exit code." The current
canonical toolkit in `packages/host-sdk/src/agent-tools/bindings/tools.ts`
exposes `sleep`, `wait_for`, session mutation tools, scheduling, and sandbox
execution, but no direct read/list runtime-state tool.

The first Codex ACP configuration therefore asks the agent to call `sleep`
with `durationMs: 0`. That exercises the MCP bridge and Firegrid tool surface,
but it is a weaker operator/user experience than a read-only inspection tool
and less directly tied to durable runtime state.

Sidecar triage (2026-05-18, surface:153): ingested from Codex coordinator
(authored on PR #330 branch). Distinct, real toolkit-surface finding;
independent of the client/host cluster. Open; not yet dispatched (lower
priority than the keystone + client/host headline). Decide: expose a
read-only runtime-state query tool vs reads-via-`wait_for`/projections.

### TFIND-037: ACP MCP tool calls are provider-executed observations

status: superseded (duplicate — folded into TFIND-041)

Authored by the Codex coordinator on the PR #330 branch in parallel with
the canonical TFIND-041 assignment; they are the **same finding** from
two angles. TFIND-037's evidence (preserved): in
`packages/host-sdk/src/host/runtime-context-workflow-core.ts` the workflow
body skips `RuntimeToolUseExecutor` for `ToolUse` when
`context.runtime.config.agentProtocol === "acp"`; ACP receives MCP servers
via `AcpSessionLive(..., { mcpServers })`, the ACP process executes MCP
calls itself and reports provider-executed `ToolUse` observations — a
different semantics than stdio-jsonl `ToolUse` which Firegrid executes via
`RuntimeToolUseExecutor`. This is the ACP-specific face of the general
TFIND-041 statement (execution authority not carried by the event). All
tracking, the binary decision, and the probe result live under TFIND-041.

### TFIND-041: ToolUse event lifecycle is under-discriminated

status: resolved (#336, e361d4147 — decision B + by-decision doc-comment)

RESOLVED 2026-05-18: Gurdas decided **(B)** — session/codec mode owns
the ToolUse execution lifecycle by decision, not by default. The
canonical decision is now recorded in-code (#336, doc-comment at the
`agentProtocol === "acp"` branch in `runtime-context-workflow-core.ts`):
ACP = observation-only, stdio-jsonl = client-result roundtrip, the
`AgentOutput` `ToolUse` event is deliberately NOT discriminated by
execution authority, and the (A) event-level discriminant is a tracked,
deliberately-deferred future option. Doc-only, zero behaviour change.

Reconciliation note: TFIND-037 (Codex, PR #330 branch) is the ACP-face
duplicate of this finding and is superseded into it. This entry is the
single canonical record.

**Pause-and-track exchange:** the Codex coordinator paused its PR #330
test, requested an id + canonical tracking before proceeding; coordinator
assigned TFIND-041 and tracked it; Codex then ran the stdio-jsonl probe
(below) rather than coding a fix. No production change is being made
pending the binary decision — this finding is explicitly *track now,
decide later*.

**The binary choice (explicit) — a Gurdas framing decision:**
- **(A) Event-level discriminant.** Promote execution authority onto the
  event itself: split `ToolUse` into `ToolUseRequest` (Firegrid executes
  via `RuntimeToolUseExecutor`, expects `ToolResult` roundtrip) vs
  `ToolUseObservation` (provider-executed; observe-only, no roundtrip) —
  or an explicit `providerExecuted` discriminant. Workflow body becomes
  codec-agnostic; the `agentProtocol === "acp"` branch is deleted.
  Cost: protocol/event-contract change rippling through every codec +
  workflow + consumers.
- **(B) Session-mode authority, made explicit.** Keep session/codec mode
  as the authority axis; **document by decision** that workflow ToolUse
  interpretation is codec/session-aware by design (ACP =
  observation-only; stdio-jsonl = client-result roundtrip). Cost: ~nil
  (a documented, intentional decision); the event stays
  under-discriminated by choice, not by accident.

Current production is (B) **by default, not by decision** — empirically
confirmed by the probe.

**DECIDED (Gurdas, 2026-05-18): (B).** Session mode owns the ToolUse
lifecycle **by decision, not by default**. Do NOT promote an event-level
discriminant now; (A) is tracked as a future-cycle improvement gated on
real demand (codec-agnostic workflow need / a third codec).

Next action (small, sidecar-shaped — queued for next free worker, micro-PR):
land a doc-comment at the workflow boundary in
`packages/host-sdk/src/host/runtime-context-workflow-core.ts` (the
`agentProtocol === "acp"` branch that skips `RuntimeToolUseExecutor`)
stating that session/codec mode is the **intentional, by-decision**
authority for ToolUse execution lifecycle (ACP = observation-only;
stdio-jsonl = client-result roundtrip), with a back-reference to
TFIND-041 and the deferred (A) discriminant option. Doc-only; no behavior
change; not framing-gated (decision made).

`ToolUse` is normalized as a shared `AgentOutputEvent`, but execution
authority is not carried by the event. ACP and stdio-jsonl both emit
`ToolUse`, while the workflow core interprets it by consulting
codec/session mode. Evidence:
`packages/runtime/src/agent-event-pipeline/events/contract.ts` defines
`ToolUse` as a single event shape;
`packages/runtime/src/agent-event-pipeline/codecs/stdio-jsonl/index.ts`
marks emitted tool calls `providerExecuted: false`, session
`toolUseMode: "client_result_roundtrip"`;
`packages/runtime/src/agent-event-pipeline/codecs/acp/index.ts` declares
`toolUseMode: "observation_only"` and rejects `ToolResult` input;
`packages/host-sdk/src/host/runtime-context-workflow-core.ts:230`
compensates with codec-aware branching (`if agentProtocol === "acp"
return undefined`) before deciding whether to execute through
`RuntimeToolUseExecutor`.

Load-bearing decision to track: either (A) promote execution authority
to an event-level discriminant (`ToolUseRequest` vs `ToolUseObservation`,
or an explicit provider-executed/requested split), or (B) keep
session-mode as the authority axis and document that workflow
interpretation is codec/session-aware by design. Current production
shape is (B) by default rather than by explicit decision.

Sidecar triage (2026-05-18, surface:153): genuine production
architectural finding; distinct from TFIND-015 (broader codec authority)
and TFIND-014 (toy-scope tool execution). NOT fanned out — track now;
the Codex coordinator probes via the stdio-jsonl config whether one
workflow body can express both lifecycles without codec knowledge. The
A-vs-B decision is a future Gurdas framing call, informed by that probe;
no sidecar code until then.

Probe result (2026-05-18, Codex coordinator, PR #330
`stdio-jsonl-tool-execution-pipeline`): a local stdio-jsonl agent emits
`tool_use` for `sleep`, awaits `tool_result`, emits final text only after
`{ slept: true }`. Test passes against `FiregridRuntimeHostLive`; durable
evidence: control-plane input intent, run started/exited, RuntimeOutput
Ready, `ToolUse` named `sleep` `providerExecuted=false`, final TextChunk
`FIREGRID_TOOL_RESULT sleep slept=true`. **Confirms (B)-by-default
empirically**: one workflow body does NOT interpret the ToolUse lifecycle
purely from the event — production still relies on codec/session
semantics (`agentProtocol === "acp"` branch) to decide execution.
Nuance: `ToolResult` is an `AgentInputEvent` (sent back to the codec),
so it is NOT exposed as a RuntimeOutputTable row — durable proof of
ToolResult is necessarily indirect (via subsequent agent output). This
ToolResult-not-durably-observable point also touches TFIND-040
(client per-event observation surface) — cross-linked, not a new id.

### TFIND-042: scenario-firegrid CLI `--help` flakes under high local turbo contention

status: resolved (#337, 1f69c5583)

RESOLVED 2026-05-18 (#337): diagnosed as cold-process startup latency —
the test spawns a cold `pnpm firegrid --help` (pnpm bin + Node + CLI
ESM graph); `--help` is fully deterministic (static-string asserts, no
ports/network/races) so the only variable is process-start time. Under
17-way local turbo contention the first cold invocation exceeded the 10s
execFile cap and was killed mid-startup. NOT a determinism/correctness
defect (correctly not surfaced as halt). Fix: raised execFile timeout
10s→60s and per-test vitest timeout 15s→90s — a deterministic ceiling
that resolves the instant the process exits (not a sleep/skip/quarantine
/assertion-paper); all assertions + coverage intact; test stays in both
the contended local turbo lane and CI. Validated: `pnpm turbo run test`
17/17 (the exact triggering contention now passes), full gate clean,
CI-confirmed. Test-infra only; no production code.

Observed during TFIND-035 (#333) verification: under 17-way local
`turbo` contention, the scenario-firegrid CLI `--help` test flaked once;
it passed deterministically in isolation, on rerun, and on CI's dedicated
Tests job. #333 was a schema-only change (no CLI surface touched) so this
is pre-existing test-infra timing sensitivity under load, NOT a
regression. Filed so it is tracked rather than lost.

Next action: low priority — when convenient, harden the scenario-firegrid
CLI `--help` test against load-induced startup latency (or quarantine it
from the contended local turbo lane). Not gating any workstream.

### TFIND-043: DurableStreamsWorkflowEngine VALIDATION.5 flakes under 17-way local turbo

status: open (low priority — test-infra flake, TFIND-042-class, not a regression)

Surfaced during #326 fork(1) verification (OCA3). Runtime
`DurableStreamsWorkflowEngine` VALIDATION.5 ('expected [] length 1, got
0') PASSES isolated (~509ms) but flakes under 17-way local `turbo`
contention. Distinct test from TFIND-042 (that was scenario-firegrid CLI
`--help`) but the same class: load-induced contention, not a determinism
or correctness defect, NOT introduced by #326. CI's dedicated Tests job
is the arbiter (passes there). Explicitly NOT a #326 blocker.

Next action: low priority — when convenient, harden VALIDATION.5 against
load-induced contention (same approach family as TFIND-042's
deterministic ceiling) or isolate it from the contended local turbo
lane. Not gating any workstream.

### TFIND-044: DurableTableProvider cannot carry N heterogeneous precise DurableTable identities

status: QUEUED-FOR-ARCHITECT (framing = AMENDMENT to existing `SDD_DURABLE_TABLE_REACT_LIVE_QUERY.md`, NOT a new SDD; was TFIND-005 "fork (2)"; excised 2026-05-18 per the TFIND-005 halt rule)

Triage: **cat-2** (real production boundary / wrong shape). A real
flamecast consumer hits it: the `DurableTableProvider<ROut,E>` React
seam (`effect-durable-operators` `react.ts`) consumes
`firegridRuntimeTableTags` (client-sdk `firegrid.ts:237`), an N-table
array. Once the TFIND-005 curried idiom makes each table's `<Self>`
identity precise, a single `ROut` generic can no longer represent the
heterogeneous set of N distinct precise identities → flamecast
`client/main.tsx:360` TS2322. This is a latent precision leak the
TFIND-005 `any` was hiding — surfaced, not introduced, by the idiom.

Provenance: this was tracked as TFIND-005 "fork (2)". Gurdas's
2026-05-18 TFIND-005 framing signoff established the halt rule: a
consumer typecheck failure for a reason other than a missing `<Self>()`
idiom is a NEW architectural finding with its own SDD, not #326 fix
scope, and the coordinator does NOT improvise the provider API shape.
So it is filed here, separately.

The shape question (do NOT decide without an SDD + Gurdas framing): a
heterogeneous variadic / tuple-typed provider that carries N precise
identities (purist; ripple across client-sdk / effect-durable-operators
/ flamecast) vs. a coarse aggregate type localized to that one provider
seam while every table stays precise everywhere else (smaller blast
radius). Architect-gated; SDD-first; no production code, no call-site
forcing cast.

Gating relationship: #326 (TFIND-005 mechanical idiom migration) is
verified flip-READY independently, but its flip/merge is gated on
TFIND-044's disposition only because flamecast cannot be left red in CI.
The keystone cascade (TFIND-007-step2 + TFIND-029 / #328) is therefore
now gated on TFIND-044's SDD + decision, not on a coordinator A/B.

Note (2026-05-18): the `DurableTableProvider` API/usage WAS already
SDD'd — `docs/proposals/SDD_DURABLE_TABLE_REACT_LIVE_QUERY.md` (props
`layer`+`tables=[...]`, lifecycle, `useDurableTable`, boundaries; even
shows the heterogeneous `tables=[ControlPlane, Output]` case). What that
SDD never specified is the provider's **generic type shape** (`<ROut,E>`)
— it predates the curry, when identities were `any`. TFIND-044 is that
unspecified type-level decision, surfaced by the TFIND-005 curry. So it
is **NOT a new standalone SDD** (would fragment the provider design):
it is an **amendment to `SDD_DURABLE_TABLE_REACT_LIVE_QUERY.md`** adding
a §0 generic-identity type-shape decision.

Next action: `155` amends `docs/proposals/SDD_DURABLE_TABLE_REACT_LIVE_QUERY.md`
with the §0 A/B generic-identity decision (A heterogeneous variadic vs B
coarse-aggregate localized to the one provider seam), citing flamecast
`client/main.tsx:360` TS2322, effect-durable-operators `react.ts`,
client-sdk `firegrid.ts:237`; coordinator reviews framing → Gurdas
signoff → implement → unblocks #326 flip → keystone cascade.

### TFIND-045: RuntimeControlRequestReconciler environment alias omits transitively-required tags

status: QUEUED-FOR-ARCHITECT (own SDD + framing gate; halt-rule finding surfaced by #326 verify; co-gates #326 flip with TFIND-044)

Triage: **cat-2** (real production correctness / wrong shape). Surfaced
by the TFIND-005 halt rule during Agent 2's #326 verify (2026-05-18).

`RuntimeControlRequestReconcilerEnvironment`
(`packages/host-sdk/src/host/control-request-reconciler.ts:42-46` =
`CurrentHostSession | RuntimeControlPlaneTable |
RuntimeContextEngineRegistry | AgentToolHost`) **omits**
`RuntimeOutputTable` and `HostRuntimeContextExecutionEnv`, yet
`reconcileStartRequest` (`:211`) transitively requires them via
`startRuntime()` → `RuntimeContextEngineRegistry`. Pre-curry, the
TFIND-005 `any` made `RuntimeOutputTable` spuriously assignable to
`RuntimeControlPlaneTable` (the Crux-B false equivalence), so the
declared env "covered" the gap. The precise `<Self>` idiom exposes the
genuine missing-dependency — textbook "a latent requirement leak the
`any` was hiding" (TFIND-028 class: declared env doesn't enumerate true
transitive deps; would fail when ambient context doesn't supply them).

Distinct from **TFIND-044** (different mechanism: an Effect
requirements-channel env alias, not the flamecast N-table React
provider). Relates to **TFIND-029** (same env-enumeration family —
`RuntimeStartCapabilityLive` explicit deps) but a distinct file/surface;
cross-link, do not fold.

Provenance / discipline: per the TFIND-005 halt rule this is NOT #326
fix scope and is NOT papered with a forcing/widening cast. Agent 2's
controlled experiment proves it is NOT #326 branch scope-creep — the
error persists identically with the branch's host-sdk/runtime fallout
hunks reverted to origin/main, and `control-request-reconciler.ts` is
unmodified by the branch. It also bleeds into tiny-firegrid's typecheck
via TS path resolution to host-sdk src.

Gating: #326's flip/merge is co-gated on TFIND-045 **and** TFIND-044
(both must be dispositioned; flamecast cannot be CI-red). The keystone
cascade (TFIND-007-step2 + TFIND-029 / #328) is gated on these two SDDs.

Next action: scope a dedicated SDD for the reconciler environment
enumeration (correctly declare/provide `RuntimeOutputTable` +
`HostRuntimeContextExecutionEnv`, or restructure how
`reconcileStartRequest` acquires them — relate
`control-request-reconciler.ts:42-46/211`, `startRuntime()`,
`RuntimeContextEngineRegistry`; cross-ref TFIND-028/029). Coordinator
reviews framing → Gurdas signoff → implement. SDD-first; no production
code, no call-site forcing cast.

### TFIND-046: client SDK exposes the control-plane table tag but not its stream-URL builder

status: open (low priority — client-sdk ergonomic completeness)

Triage: **cat-1** (real consumer gap, low severity). Surfaced + honestly
annotated by the toy in #341's `MIGRATION_NOTES.md` while migrating
`durable-streams-backed-pipeline.test.ts` to drive purely through the
public client surface.

The client SDK exposes `FiregridRuntimeTables.ControlPlane` (the durable
table tag), but to instantiate its layer a consumer must supply the
stream URL via `runtimeControlPlaneStreamUrl`, which is only exported
from `@firegrid/protocol/launch`. So consumer-shaped code that builds a
client-side live query over the control-plane table (the Flamecast
`useDurableTable(FiregridRuntimeTables.ControlPlane)` + live-query
pattern) must reach past the client SDK into a protocol URL helper.

Triage question: would a real consumer outside Firegrid hit this? Yes —
any client building a live control-plane subscription needs the same URL
builder; the client SDK surface is incomplete for its own exposed table
tag. This is NOT "the test would be cleaner if" (the import is genuinely
forced by a public-surface gap, not test ergonomics). Low severity (the
protocol helper is public and not host-bound) → low priority, but a real
client-surface completeness finding, not toy scope.

Next action (low priority, sidecar-shaped, micro): re-export
`runtimeControlPlaneStreamUrl` (or a `FiregridRuntimeTables.ControlPlane`
layer convenience that folds it) from `@firegrid/client-sdk` so
consumer-shaped code does not import protocol URL helpers directly. Not
gating any workstream; fold into the next natural client-sdk-touching
PR. #341 merges with the reach-past annotated to this id.

### TFIND-047: snapshot agentOutputs typing is weaker than the runtime observation type

status: open (filed 2026-05-18 by Gurdas; framing-gated; distinct from TFIND-040)

Triage: **cat-2** (real client-SDK type-precision boundary / wrong
shape).

`RuntimeContextSnapshot["agentOutputs"]` carries weaker typing than the
runtime-side `RuntimeAgentOutputObservation`. The Codex ACP test uses
`asRecord` defensive casts to extract `event.part.delta` and
`event.part.name` from snapshot rows, whereas the same fields are
properly typed when consumed from `RuntimeOutputTable.events.rows()`
directly. A real client-SDK consumer reading `session.snapshot()
.agentOutputs` therefore gets a weaker type than the runtime
observation and must cast.

Distinct from **TFIND-040** (that is subscription/observation-surface
*ergonomics* — `session.subscribe()`); this is observation *type
precision through the snapshot path*. Relates to **TFIND-030** (made
`session.snapshot().agentOutputs[].event` the typed `AgentOutputEvent`
union via #329) and **TFIND-035** (SSOT) but is **not closed by #329** —
it is a deeper `.part.*` / snapshot-row-shape precision gap vs.
`RuntimeAgentOutputObservation`.

Filed per Gurdas regardless of the TFIND-038/039 toy-realization option;
the option-3 migration (recorded under TFIND-038) must consume/validate
it — i.e. eliminate the `asRecord` casts, or TFIND-047 tracks precisely
why they cannot be removed yet (the validation signal).

Next action: scope a client-sdk snapshot-observation typing fix
(`RuntimeContextSnapshot["agentOutputs"]` row type → expose the same
precision as `RuntimeAgentOutputObservation`, including `event.part.*`);
relate the runtime `RuntimeOutputTable.events` row type and the
TFIND-030 `AgentOutputEvent` union. Architectural (public observable
type change like TFIND-030) — SDD/framing-gated; coordinator scopes →
Gurdas signoff. Not on the keystone critical path.

### TFIND-048: MCP route + URL lifecycle ownership unresolved in the #332 client/host model

status: open — REFRAMED 2026-05-18 (architectural; coordinator RECOMMENDS Reading 2). Was mis-filed as "client-SDK lacks a pre-create helper" (Reading 1, cat-2 small re-export). Gurdas challenged the shape before it set; an architecture investigation (Explore, evidence below) strongly supports Reading 2. The Reading-1-vs-Reading-2 binary is the **§0 load-bearing decision for Gurdas's framing signoff** — coordinator does not own it; recommendation only. Framing-gated; folds into the #332-impl MCP-lifecycle question; blocks Codex ACP.

Triage: **cat-1/2 architectural** (real production-model gap — NOT a
missing API, NOT a toy-fix). The migration-as-validation worked exactly
as designed: the toy maintainer (`surface:33`), migrating Codex ACP per
option-3 (TFIND-038), hit the gap, **did not paper it**, paused Codex
ACP, proceeded stdio-jsonl, reported to `surface:153`.

**The two readings (Gurdas, 2026-05-18) — the §0 load-bearing decision (Gurdas owns it; coordinator recommends):**
- *Reading 1 (helper-missing, cat-2):* re-export `sessionContextIdForExternalKey`
  from client-SDK; small fix. **Coordinator recommends AGAINST — evidence below contradicts it.**
- *Reading 2 (design-smell, architectural):* baking a concrete
  `contextId`-scoped MCP URL into the intent *before* `createOrLoad` is
  the consumer predicting createOrLoad's output; a real host provisions
  the route-scoped MCP route *after* materializing the context. The
  "missing helper" is the wrong abstraction. **Coordinator RECOMMENDS Reading 2; Gurdas decides at the framing signoff (evidence below).**

**Evidence (Explore, file:line):**
- `sessionContextIdForExternalKey` (`protocol/src/session-facade/schema.ts:482`)
  is a sound deterministic primitive (canonical-JSON → id; pure;
  re-exported by client-sdk `firegrid.ts:49` but undocumented). Its
  determinism is **for client/host independent reconciliation**, not for
  clients to pre-bake route URLs. The primitive is NOT the smell.
- Production host **owns** the MCP server: `host-sdk/src/host/mcp-host.ts:1-26`
  mounts `/mcp/runtime-context/:contextId`; the route param is the
  request authority, resolved **at tool-call time** (`:118-124`), no
  pre-provisioning. CLI (`cli/src/bin/run.ts`) starts the host MCP
  server FIRST, then derives contextId, then builds the URL.
- Codex ACP test/config (`tiny-firegrid/src/configurations/codex-acp-tool-call-pipeline.ts:24-36,57-81`,
  `test/...:374-392`) builds the concrete URL **pre-`createOrLoad`** and
  embeds it in the intent — the **test fixture** starts the server
  before the context exists; uniquely test-fixture-shaped.
- `SDD_CONSOLIDATED_CLIENT_HOST_BOUNDARY.md:49-95` ("client writes
  intent, host materializes") is **silent on who builds the concrete
  `contextId`-scoped MCP URL and when**.
- No other config (durable-streams, stdio-jsonl, output-journal) uses
  MCP or pre-derives a contextId-scoped URL. Codex ACP is unique.

**The real question (load-bearing, for §0 of the framing):** in the
#332 model, how does the client express "this runtime needs MCP"
*without* a concrete URL or final contextId, and how/when does the
**host** derive the concrete `contextId`-scoped MCP URL post-
materialization and deliver it to the agent? Re-exporting the helper
would canonize the backwards lifecycle and is explicitly rejected.

**Sequencing / ownership:** resolution is an **architectural framing
decision on MCP route/URL lifecycle in the #332 model** (likely a
section of / extension to the #332 implementation SDD), NOT a toy
reshape and NOT a client-SDK helper re-export. The Codex ACP config
shape is downstream of that decision. **Codex ACP stays
paused/unmigrated** (no escape hatch, no `it.skip`, no protocol
reach-past) until the framing is decided and implemented; the resumed
Codex ACP migration is then the validation. stdio-jsonl migration
proceeds independently (no MCP) — see #343.

Next action: coordinator scopes the MCP-route/URL-lifecycle framing
(§0 = the load-bearing question above; options: host-provisioned URL
delivered post-materialization vs. client URL-pattern + host
resolution vs. other) → batched framing-signoff pass with Gurdas
alongside TFIND-044/045 (+#334). Off the keystone critical path but the
live blocker of the dispatched option-3 Codex ACP work.

### TFIND-049: runtime host has no agent-adapter integration (effect-ai-native-agents Slice 4 unbuilt)

status: open — ARCHITECT/ROADMAP binary (Gurdas owns: prioritize Slice 4 vs. keep adapter configs dequeued). Blocks `agent-adapter-driven-pipeline` + `agent-adapter-tool-execution-pipeline` capstone + TFIND-024 toy-realization.

Triage: **cat-4/toy WRAPPER over a cat-1/2-FUTURE kernel**
(Gurdas-classified 2026-05-18). The toy half is cat-4: it correctly
refuses to model a capability that does not exist (not toy laziness).
The kernel is cat-1/2 but specifically **deferred FUTURE production
work** (effect-ai-native-agents Slice 4), **NOT a current-architecture
gap, bug, or regression** — the distinction matters for anyone reading
FINDINGS: nothing is broken today; the capability is planned and
not-yet-built. Surfaced 2026-05-18 by `33`'s Gurdas-directed
`agent-adapter-driven-pipeline` build: it halted correctly per protocol
rather than reach past / replace host internals.
Migration-as-validation working exactly as designed.

**Verified evidence (coordinator, file:line):**
- `RuntimeProviderSchema = Schema.Literal("local-process")` — only
  value (`packages/protocol/src/launch/schema.ts:60`).
- `FiregridRuntimeHostLive` imports + hardcodes
  `LocalProcessSandboxProvider` (`packages/host-sdk/src/host/layers.ts:31,143`).
- Zero host-sdk consumers of `AgentAdapterRegistry` / `adapterFor`
  (grep `packages/host-sdk/src` = empty). `RuntimeContextWorkflowSessionLive`
  only selects raw vs codec sessions.
- `docs/proposals/effect-ai-native-agents.md:474` — **"### Slice 4:
  Runtime Host Integration — Wire `AgentAdapterRegistry.adapterFor(context)`
  into the runtime host"**; `:482` "Only after Slice 4 proves production
  behavior". Slice 4 is explicitly future/unbuilt.

So adapter-driven / AI-provider launch is **not a missing surface — it
is an unbuilt production capability**. The `agent-adapter-driven-pipeline`
config (and the `agent-adapter-tool-execution-pipeline` capstone) cannot
be production-consuming until Slice 4 lands. Distinct from TFIND-048
(MCP URL lifecycle, an existing-capability shape question) — TFIND-049
is capability-absent.

**Process note (CONFIGS queue):** the CONFIGS.md queue marked
`agent-adapter-driven-pipeline` "pre-conditions clean (TFIND-024 open,
no upstream blocks)". That was WRONG — there is a hard upstream block
(Slice 4). Queue pre-condition assessments must verify the *production
capability exists*, not merely that the modeling TFIND is open. See
[[feedback-configs-queue-precondition-verify-capability]].

Next action: **architect-handoff to Gurdas** — roadmap binary:
(a) prioritize building effect-ai-native-agents Slice 4 now (unblocks
the adapter config + capstone + TFIND-024) vs. (b) keep the adapter
configs dequeued/blocked until Slice 4 is independently scheduled.
Coordinator does NOT decide this (new production-capability roadmap
binary). `33` redirected to genuinely-clean work meanwhile;
`agent-adapter-driven-pipeline` + capstone CONFIGS rows → BLOCKED on
TFIND-049/Slice 4 (toy updates CONFIGS in its scope).
