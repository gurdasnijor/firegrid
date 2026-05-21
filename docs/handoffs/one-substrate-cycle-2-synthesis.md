# One Substrate Primitive — Cycle 2 Synthesis

Date: 2026-05-20
Status: load-bearing decision document
Bead: `tf-ycxw`
Owner: Firegrid coordinator (architect tier)
Cycle 1 inputs (all on `origin/main`):
- Sim 1 — `docs/research/tf-jbtu-sim1-agent-output-collapse.FINDING.md` (PR #537, merge `61da445bc`)
- Sim 2 — `docs/research/tf-35f4-sim2-multi-surface-projection.FINDING.md` (PR #539, merge `e07ab2944`)
- Sim 3 — `docs/research/tf-2ld2-sim3-binding-swap-isolation.FINDING.md` (PR #535, merged earlier wave)
- Adapter inventory — `docs/research/tf-6w3s-external-effect-adapter-inventory.FINDING.md` (PR #540, merge `474bacf20`)
- SDD wave-3 amendment — `docs/sdds/SDD_FIREGRID_ONE_SUBSTRATE_PRIMITIVE.md` (commit `a6b4e6636`)
- Workstream F — `docs/handoffs/sprint-to-private-beta/architecture/04-runtime-boundary-workstreams.md` (commit `a6b4e6636`)
Spike doc: `docs/research/one-substrate-primitive-validation-spike.md`

## §0 Verdict: HYBRID A+B

The spike doc framed Cycle 2 as a choose-one-of-three decision (Outcome A — full deletion plan; Outcome B — bounded carveout plan; Outcome C — SDD revision). The Cycle 1 evidence requires a hybrid verdict rather than a single Outcome, organized along **two independent axes**:

| Axis | Inputs | Verdict | Rationale |
| --- | --- | --- | --- |
| **Channel axis** | Sims 1 / 2 / 3 — all GREEN | **Outcome A — Deletion PR plan** | The SDD's "one channel registration, N projections" claim holds at the row, response, and idempotency level for both ingress (Sim 1) and callable (Sims 2 + 3) channels. Parallel-paths collapse is empirically verified. |
| **Adapter axis** | tf-6w3s — FOUND ADDITIONAL ADAPTERS + BOUNDARY VIOLATIONS | **Outcome B — Carveout plan** | The adapter set is finite as claimed, but the "external effects in `packages/runtime/` only" boundary is false. Substrate-transport libraries are legitimate exceptions; host-sdk/CLI shims are real violations. |

**Outcome C is explicitly NOT taken.** The SDD has already been amended (wave-3 commit `a6b4e6636`) and Workstream F has already been added to the architecture handoff folder; both supply the architectural correction that the adapter axis required. The synthesis instrument is not "revise the SDD" — the SDD is already revised — it is "operationalize the revised SDD into a deletion plan + a carveout plan."

The hybrid verdict has a load-bearing **independence property**: channel-axis deletion work proceeds independently of adapter-axis carveout work **EXCEPT** at three named intersections (§3 below). Most channel-axis cleanup can ship immediately on merge of this synthesis doc; only the deletions that touch session-adapter or MCP/CLI server surfaces wait on the adapter-axis carveouts.

## §1 Channel axis — Outcome A: Deletion PR plan

### §1.1 What the Cycle 1 sims proved

**Sim 1 (tf-jbtu, PR #537) — `SessionAgentOutputChannel` parallel-paths collapse**

The four parallel paths for reading agent output (`session.wait.forAgentOutput`, `hostProjectionObserver`, `RuntimeAgentOutputAfterEvents.forContext`, raw `RuntimeOutputTable.events.rows()`) all observed the **same three events in the same order** through the channel-routed implementation. The product path (`session.wait.forAgentOutput`) was rewritten to dispatch through `SessionAgentOutputChannel` (cited at `packages/client-sdk/src/firegrid.ts:358,377,650,670`); `hostProjectionObserver` was rerouted as a regression-harness path (cited at `packages/host-sdk/src/host/projection-observer.ts:17,22`).

Trace evidence: `firegrid.simulation.rewritten_path=session.wait.forAgentOutput` and matching event signatures across all four observers (FINDING §"Sim Evidence" cites `trace.jsonl:247,251,253,261`).

Ergonomic helper required: `waitForIngressChannelProjection` (client-internal at `firegrid.ts:377`). Cycle 2 must decide whether this becomes a public protocol-tier verb once a second cross-package consumer materializes (cited as §"Ergonomic Helper / Cycle 2 API Gap" in the Sim 1 FINDING).

**Sim 2 (tf-35f4, PR #539) — multi-surface projection equivalence on `HostSessionsCreateOrLoadChannel`**

A single protocol-owned callable-channel contract was projected as TWO surfaces (typed client method `firegrid.sessions.createOrLoad` + sim-local MCP-tool-style projection) over the SAME Live Layer. Both projections wrote `RuntimeContextRequestRow`s that matched by field-set, by row schema, by `_otel` stamp presence, by `createdBy`, by `runtime`, and by the `(sessionId === contextId)` derivation invariant.

Insert-or-get fence holds **across** projection boundaries: a client-method invocation followed by an MCP-tool-style invocation with the same `externalKey` resolves to the same `requestId` (one row, two projections).

Load-bearing for future bindings: the MCP-tool projection runs in `runMcpToolProjection` **without a Firegrid client in scope** — proving the channel contract is independently consumable by REST/gRPC/MCP projections that don't import client-sdk.

Five test assertions all pass in `packages/tiny-firegrid/test/spike-channel-deletion/sim2-multi-surface-projection.test.ts`. All 18 pre-existing client-sdk tests continue to pass.

**Sim 3 (tf-2ld2, PR #535) — binding-swap isolation + durable persistence on `SessionPermissionChannel`**

`Layer.scoped(SessionPermissionChannel, autoApprovePolicy(default))` correctly swaps the responder for one session scope while the response value **still persists** through the default durable binding.

Durable-row evidence (cited from the Sim 3 FINDING):

```json
Session A row: { decision: "Allow",  origin: "sim3:autoApprove:session-a" }
Session B row: { decision: "Deny",   origin: "sim3:default:session-b"     }
Cross-session leak query (Allow rows in Session B with autoApprove origin): 0
sameChannelTag: true; sameChannelTarget: "session.permissions.respond"
```

This validates the SDD's corrected framing (commit `28ae907d4`): auto-approve is a **non-durable scoped policy OVER the durable write**, not a bypass of durability.

### §1.2 Independent deletion candidates

These proceed immediately on merge of this synthesis doc. None of them touch the adapter-axis intersection points named in §3.

| # | Target | Source-verified deletion handle | Driver bead |
| --- | --- | --- | --- |
| 1 | `hostProjectionObserver` removal | `packages/host-sdk/src/host/projection-observer.ts` + export from `host/index.ts` after lane 2 (tf-9sx9) migrates the 4 simulation consumers off the symbol | follow-up after tf-9sx9 lands |
| 2 | Duplicated `FiregridClientOperations` collapse | `packages/client-sdk/src/operations.ts` (delete or re-export from `@firegrid/protocol/session-facade`); protocol copy stays canonical | new follow-up bead (`tf-XXXX: collapse duplicate FiregridClientOperations`) |
| 3 | client-sdk method bodies → thin channel dispatch | `packages/client-sdk/src/firegrid.ts` per-method substrate dispatch (`appendRuntimeContextRequest`, `appendRuntimeInputIntent`, `appendRuntimeStartRequest`, etc.) becomes per-method channel-Tag dispatch; method body shrinks from 10–30 lines to 3–5 lines each | `tf-aago` (already blocked on this synthesis) |
| 4 | `ChannelInventory` narrowing | `packages/host-sdk/src/host/channel.ts` collapses to ~30 lines of inventory-only utilities once contract types are deleted in favor of `@firegrid/protocol/channels` re-export | `tf-zd8s` (already blocked on this synthesis) |
| 5 | Client-sdk standalone-default `HostSessionsCreateOrLoad` Layer | `packages/client-sdk/src/channels/host-sessions-create-or-load-default.ts` (introduced as a transitional mirror in Sim 2 PR; slated for deletion once production composition routes through host-sdk's Live Layer) | folds into tf-aago or `tf-cyet` |

**Sequencing rule for the Independent set:** order is **not** strictly serial. #1 depends on tf-9sx9; #2/#3/#4 are independent of each other and can be parallelized across lanes. #3 (tf-aago) is the longest-pole task and should dispatch first or in parallel with #2 and #4.

### §1.3 Reduction estimate

- `packages/client-sdk/src/firegrid.ts`: ~500 → ~150 LOC target (per Sim 2 FINDING §"Deletion plan")
- `packages/client-sdk/src/operations.ts`: deleted or reduced to a thin re-export from `@firegrid/protocol/session-facade`
- `packages/host-sdk/src/host/channel.ts`: ~current size → ~30 LOC inventory-only (per Sim 2 FINDING)
- host-sdk public barrels: substrate-leak names removed (driven by `tf-8oaq` + `tf-u1zn`, both in flight)

The Cycle 1 wave has already shipped the **scaffolding** for the channel-axis deletions: `@firegrid/protocol/channels/` module now exists with the channel contract types, factories, and three per-channel Tags (`SessionAgentOutputChannel`, `HostSessionsCreateOrLoadChannel`, `SessionPermissionChannel`). The remaining Cycle 2 deletion work is consumer migration, not new architectural construction.

## §2 Adapter axis — Outcome B: Carveout plan (references)

### §2.1 What tf-6w3s proved

Production Firegrid adapters cluster around **four finite categories**, each correctly inside `packages/runtime/`:
- **Sandbox process management** — `packages/runtime/src/agent-event-pipeline/sources/sandbox/local-process.ts` (10 cited call sites)
- **Codec adapters** (stdio-jsonl, ACP) — `packages/runtime/src/agent-event-pipeline/codecs/` (8 cited call sites)
- **Verified webhook ingest** — `packages/runtime/src/verified-webhook-ingest/adapter.ts` (2 cited call sites)
- **Network/agent adapters** (ACP connection prompts/sessions/cancels) — `packages/runtime/src/agent-adapters/acp/adapter.ts` (5 cited call sites)

The SDD's "small fixed set" claim is **directionally confirmed**. The package-boundary claim is **not** — there are external effects outside `packages/runtime/`.

### §2.2 Substrate-transport exceptions

`effect-durable-streams` and `effect-durable-operators` own HTTP/storage effects that are part of the substrate transport itself, below Firegrid's runtime line. tf-6w3s cited 25+ call sites across:
- `packages/effect-durable-streams/src/protocol/Http.ts` (HTTP client GET/POST/PUT/DELETE methods)
- `packages/effect-durable-streams/src/internal/sse.ts` (SSE parser + decoder)
- `packages/effect-durable-streams/src/protocol/Producer.ts` (send loop, batch send, drain effect)
- `packages/effect-durable-operators/src/DurableTable.ts` (TanStack DB persistence, `FetchHttpClient` layer, stream creation, preload, awaitTxId)

The SDD wave-3 amendment (commit `a6b4e6636`) already encodes these as legitimate lower-tier exceptions:

> "Durable substrate libraries (`effect-durable-streams`, `effect-durable-operators`) are explicit lower-tier exceptions; they provide the transport used by DurableTable and DurableStream and are not app-level adapter leaks."

No carveout work required here — the exception is documented; this section exists only to acknowledge the axis and reference the canonical placement rule.

### §2.3 Product-layer boundary violations (the actual carveout)

Four real boundary violations identified by tf-6w3s, each operationalized as an already-beaded follow-up:

| # | Violation | Already-beaded follow-up | Decision shape |
| --- | --- | --- | --- |
| 1 | `packages/host-sdk/src/host/runtime-context-session/codec-adapter.ts:71,73` + `raw-adapter.ts:47,175,177,303` — byte-stream conversion + stdin writer | **`tf-pisb` (P1)** | Relocate adapter bodies below runtime (per Workstream C amendment in `a6b4e6636`); host-sdk retains adapter selection / composition only |
| 2 | `packages/host-sdk/src/host/mcp-host.ts:45,168,270` — `node:http` createServer + `NodeHttpServer.layer(...)` | **`tf-r8ib` (P1)** | Binary decision: (a) keep as named binding-edge exception with no durable substrate authority, OR (b) relocate the server body to runtime/agent-tools |
| 3 | `packages/cli/src/bin/run.ts:316,338` — embedded Durable Stream test server start/stop | **`tf-yxdd` (P2)** | Classify as named CLI exception OR move dev-server lifecycle below the binding line |
| 4 | (covered by #1, #2, #3 above) | — | — |

All three carveout beads are already filed and blocked on this synthesis. Cycle 2 doesn't author new beads for this axis; it **dispatches the three that exist** when their named blockers clear.

## §3 Cross-axis intersection matrix

Channel-axis deletions intersect with adapter-axis carveouts at exactly **three points**. Outside these three, all channel-axis deletion work is independent of the adapter axis.

| Channel-axis deletion candidate | Adapter-axis intersection? | Status |
| --- | --- | --- |
| `hostProjectionObserver` removal (§1.2 #1) | None — host-sdk-internal observation seam, no byte/server effects | **Independent** |
| Duplicated `FiregridClientOperations` collapse (§1.2 #2) | None — pure schema/typed-ref alignment | **Independent** |
| client-sdk method bodies → channel dispatch (§1.2 #3) | None — Layer-tier composition, no byte/server effects | **Independent** |
| `ChannelInventory` narrowing (§1.2 #4) | None — host-sdk-internal | **Independent** |
| Standalone-default Layer deletion (§1.2 #5) | None — client-sdk-internal | **Independent** |
| Session ingress/egress channel collapse IF it touches `codec-adapter.ts` or `raw-adapter.ts` byte streams | **YES** — Workstream C / `tf-pisb` territory | **Gated on tf-pisb** |
| MCP tool projection collapse IF it touches `mcp-host.ts` server installation | **YES** — `tf-r8ib` decision | **Gated on tf-r8ib** |
| CLI projection collapse IF it touches the embedded dev-server | **YES** — `tf-yxdd` classification | **Gated on tf-yxdd** |

**Key property:** the Independent set (the top five rows) does not require any adapter-axis carveout to land first. It can dispatch the moment this synthesis doc merges.

## §4 Implementation sequencing

### Phase 1 — Independent set (dispatch on synthesis-doc merge)

1. **`tf-aago` (P1, currently blocked on this synthesis)** — client-sdk + CLI projection surfaces over protocol-owned channel/launch contracts. Largest deletion scope; longest pole. **Dispatch first.**
2. **`tf-zd8s` (P1, currently blocked on this synthesis)** — `ChannelInventory` narrowing/retirement. Independent of tf-aago; can run in parallel.
3. **`hostProjectionObserver` removal** — follow-up after lane 2 (`tf-9sx9`) merges its consumer migrations; small atomic deletion PR.
4. **Duplicated `FiregridClientOperations` collapse** — new follow-up bead (1–2h scope); independent.

### Phase 2 — Gated set (dispatch as adapter-axis carveouts land)

1. **`tf-pisb`** runs first among the adapter carveouts (largest scope; touches codec-adapter + raw-adapter relocation). On merge: any channel deletions in §3 that touched those files become dispatchable.
2. **`tf-r8ib`** runs second (single decision + relocation OR exception-naming). On merge: MCP tool projection collapses can dispatch.
3. **`tf-yxdd`** runs third (smallest scope; CLI dev-server classification). On merge: CLI projection cleanup can dispatch.

### Phase 3 — Post-cutover

1. **`tf-cyet` (P0, blocked on `tf-aago`)** — once tf-aago lands, decide between Outcome 1 (client-sdk eliminates direct `RuntimeControlPlaneTable.{contextRequests,inputIntents,startRequests}.insertOrGet` writes; uses channel dispatch end-to-end; dispatcher shrinks accordingly) OR Outcome 2 (formalize the dispatcher as the durable-RPC substrate behind callable channels).

   Per Sim 2's evidence: client-method projections now dispatch through `HostSessionsCreateOrLoadChannel.binding.call`, which internally still does `RuntimeControlPlaneTable.contextRequests.insertOrGet`. The dispatcher is structurally Pattern 1 from the SDD. **Cycle 2's strong recommendation:** Outcome 1 once tf-aago lands. The dispatcher's runtime existence becomes load-bearing as the callable-channel Pattern 1 implementation; it stops being a separately-named architectural concept and becomes "the runtime-internal binding behind `call(channel, req)`."

2. **Downstream chain unblocked by `tf-ycxw` close:** `tf-24jn` → `tf-h0ku` → `tf-t2a5` (external trigger loop) and `tf-k138` (end-user docs align to channel projection model) and `tf-05jj` (session/output observation uses paved channel surface) and `tf-30nu` (first egress/callable adapter over channels).

## §5 Non-goals (explicit)

- **No SDD revision required.** Wave-3 amendment + Workstream F already supply the architectural correction the adapter axis demanded. Outcome C is rejected.
- **No "all external effects in runtime" claim restored.** Substrate-transport-tier exceptions are valid; they are named in the SDD wave-3 amendment.
- **No collapsing channels into universal agent-facing verbs.** The body-plan SDD's distinction between agent verbs (`wait_for`/`send`/`call`) and session/control operations (typed methods) holds. Channels are typed semantic transport; surface names are projection-specific.
- **No deletion-only plan.** The hybrid A+B verdict is the operational truth. Adapter-axis carveouts are first-class.
- **No new spike sims.** Sims 1/2/3 + tf-6w3s are sufficient evidence for the deletion-and-carveout plan. Further sims would be answering questions the deletion-work itself answers in production.
- **Production MCP tool wiring for `session.create_or_load` is OUT of this synthesis scope.** Sim 2 demonstrated the projection-contract claim with a sim-local MCP tool; the production tool follows mechanically and is a Cycle-2 implementation detail of tf-aago or a tf-aago sibling.

## §6 Acceptance for Cycle 2 as a whole

This synthesis doc is itself the Cycle 2 acceptance artifact. Cycle 2 closes when:

- [x] All four Cycle 1 inputs landed on `main` (Sims 1/2/3 + tf-6w3s)
- [x] SDD wave-3 amendment landed (`a6b4e6636`)
- [x] Workstream F landed in handoff architecture folder (`a6b4e6636`)
- [x] Adapter-axis carveout beads filed (`tf-pisb`, `tf-r8ib`, `tf-yxdd`)
- [ ] This synthesis doc merged (the present PR)
- [ ] `tf-ycxw` bead closed on merge

Cycle 2 explicitly does **not** wait on:
- Adapter-axis carveout merges (those are Phase 2 of the implementation plan, not blockers on the synthesis verdict)
- Channel-axis deletion merges (Phase 1)
- Any Phase 3 work

## §7 Coordinator decision

**Cycle 2 verdict: PROCEED with hybrid A+B plan above.**

- **Channel axis: Outcome A.** Dispatch tf-aago, tf-zd8s, hostProjectionObserver removal follow-up, and FiregridClientOperations collapse immediately on merge of this synthesis doc.
- **Adapter axis: Outcome B.** Dispatch tf-pisb, tf-r8ib, tf-yxdd in that order; channel-axis Gated-set work follows each as it lands.
- **Outcome C rejected:** SDD revision already shipped via wave-3 amendment + Workstream F.

The deletion plan is empirically grounded — every line slated for removal has a specific Sim 1/2/3 verdict justifying it. The carveout plan is empirically grounded — every named exception/violation has a tf-6w3s inventory line citing file:line. No assumptions in the absence of data; every claim source-verified.

## §8 Cross-references

### Source FINDINGs (all on `origin/main`)
- `docs/research/tf-jbtu-sim1-agent-output-collapse.FINDING.md`
- `docs/research/tf-35f4-sim2-multi-surface-projection.FINDING.md`
- `docs/research/tf-2ld2-sim3-binding-swap-isolation.FINDING.md`
- `docs/research/tf-6w3s-external-effect-adapter-inventory.FINDING.md`

### Canonical SDDs (post-Cycle-2 state)
- `docs/sdds/SDD_FIREGRID_ONE_SUBSTRATE_PRIMITIVE.md` (wave-3 amendment is canonical)
- `docs/cannon/sdds/SDD_FIREGRID_AGENT_BODY_PLAN.md` (channel vs session/control distinction unchanged)
- `docs/cannon/sdds/SDD_FIREGRID_SCHEMA_PROJECTION_CONTRACT.md` (projection contract claim now empirically validated by Sim 2)

### Architecture handoff folder
- `docs/handoffs/sprint-to-private-beta/architecture/04-runtime-boundary-workstreams.md` (Workstream F)
- `docs/handoffs/sprint-to-private-beta/architecture/02-surface-hygiene-gates.md` (Gates A/B/C/D/E; lanes 2/3/4 currently executing)

### Beads
- **Closed (Cycle 1 inputs):** `tf-jbtu`, `tf-35f4` (closure pending bead-state catch-up), `tf-2ld2`, `tf-6w3s`, `tf-482w`
- **Blocked on this synthesis:** `tf-aago`, `tf-zd8s`, `tf-24jn`, `tf-h0ku`, `tf-k138`, `tf-05jj`, `tf-30nu`, `tf-cyet` (via tf-aago), `tf-t2a5` (via tf-h0ku)
- **Adapter-axis carveouts (Phase 2):** `tf-pisb`, `tf-r8ib`, `tf-yxdd`
- **In-flight lane work referenced:** `tf-ypq9` (Gate E), `tf-9sx9` (Gate C), `tf-8oaq` (Gate A), `tf-kb0i` (Gate D, PR #543), `tf-u1zn` (Gate A follow-up), `tf-vw8w` (Workstream D, PR #542), `tf-40wb` (external trigger, merged)
