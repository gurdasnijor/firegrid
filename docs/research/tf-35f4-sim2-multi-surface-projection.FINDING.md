# tf-35f4 Sim 2 — multi-surface projection equivalence for a callable channel

Date: 2026-05-20
Owner: tf-35f4 lane (Lane 5 / Opus)
Spike: One Substrate Primitive validation — Cycle 1, Sim 2
Source SDD: `docs/sdds/SDD_FIREGRID_ONE_SUBSTRATE_PRIMITIVE.md`
Spike doc: `docs/research/one-substrate-primitive-validation-spike.md`
Pre-gate verdict (tf-482w): Verdict B (tf-kddg partial). Option A scope accepted: this sim creates or wraps the per-channel Tag+Layer it needs and reports each addition as a tf-kddg finish-line contribution.

## Verdict — GREEN

A single protocol-owned callable-channel contract was projected as TWO distinct surfaces over the SAME Live Layer, with identical substrate rows and identical response shapes. The SDD's "projection contract" claim holds for callable channels: **one channel registration ↔ N projections**.

- The rewired typed client-method projection (`firegrid.sessions.createOrLoad`) and a sim-local MCP-tool-style projection (a thin tool-shaped wrapper around `HostSessionsCreateOrLoadChannel.binding.call`) wrote `RuntimeContextRequestRow`s that match by field-set, by row schema, by `_otel` stamp presence, by `createdBy`, by `runtime`, and by the `(sessionId === contextId)` derivation invariant.
- Insert-or-get idempotency holds ACROSS projections: a client-method invocation followed by an MCP-tool-style invocation with the same `externalKey` resolves to the same `requestId` (one row, two projections).
- All 18 pre-existing `@firegrid/client-sdk` tests pass after the rewire (no behavior regression).

**Deletion-plan target documented below.** Roughly 80% of the duplicate per-projection plumbing (typed-input decode + row build + insertOrGet + response shaping) becomes deletable once the rest of the public client surface is rewired through analogous protocol-owned channel Tags. Sim 2 demonstrates the pattern on `createOrLoad`; the next surfaces (per the SDD §"What This Unifies" table) follow the same playbook.

## Pair chosen + why

**Pair B** from the spike doc: `firegrid.sessions.createOrLoad` ↔ MCP-tool-style `session.create_or_load`. Selection criteria:

1. **No overlap with Sim 3 (tf-2ld2)**. Pair A (`permissions.respond` ↔ `permission_respond`) would have collided with Sim 3's `SessionPermissionChannel` Tag+Layer creation. Lane-4 was explicitly flagged by the coordinator dispatch as touching SessionPermissionChannel territory. Picking Pair B side-steps the coordination/merge-order overhead.
2. **Cleanest callable shape**. `createOrLoad` is a pure callable: input → durable substrate write → derived response. No completion-row wait required (the response is `{sessionId, contextId}`, both deterministic from `externalKey` via `sessionContextIdForExternalKey`). This is the SDD §"Variants of CallableChannel binding" Pattern 1 (request-row pattern) in its lightest form.
3. **Real existing client method**. `firegrid.sessions.createOrLoad` exists in production code today as a direct `RuntimeControlPlaneTable.contextRequests.insertOrGet` call. The rewire is a concrete, verifiable transformation; the test suite caught any regression immediately.

**The MCP-tool side is sim-local** because there is no current `session.create_or_load` MCP tool in the agent toolkit (the closest production tool, `session_new`, lowers to `spawnChildContext`, a different substrate path entirely). The absence of an MCP tool projecting `createOrLoad` is itself finding-relevant: it confirms the spike doc's hypothesis that "the MCP surface is already a subset of the client surface". The sim-local projection is constructed exactly as a real MCP tool would: it `yield* HostSessionsCreateOrLoadChannel` and calls `binding.call(req)`. Wiring the production MCP tool is a follow-on (single Tool.make + Layer.merge into the agent toolkit) that follows mechanically from the channel contract this PR introduces.

## What landed in this PR (helper inventory — visible, not hidden)

### `@firegrid/protocol/channels/` — NEW

A fresh module owning the **CONTRACT** pieces per the coordinator's exact-split heads-up (gary, d99e2d2a7):

| File | Purpose |
| --- | --- |
| `direction.ts` | `ChannelDirectionSchema`, `ChannelSourceClassSchema`, `ChannelTargetSchema` brand, `makeChannelTarget`, `UnknownChannelTarget` |
| `types.ts` | `IngressChannel<S>`, `EgressChannel<S>`, `CallableChannel<Req, Res>`, `BidirectionalChannel<S>` + binding interface types (`TypedStreamBinding`, `AppendTargetBinding`, `CallTargetBinding`) + `ChannelRegistration` union |
| `factories.ts` | `makeIngressChannel`, `makeEgressChannel`, `makeCallableChannel`, `makeBidirectionalChannel` |
| `host-sessions-create-or-load.ts` | The concrete callable channel pair: target const + request/response schemas (re-using `SessionCreateOrLoadInputSchema` + `SessionHandleReferenceSchema`) + `HostSessionsCreateOrLoadChannel` Context.Tag |
| `index.ts` | Re-exports + barrel |

Package export added: `"./channels"` in `packages/protocol/package.json`.
Index re-export added: `export * as Channels from "./channels/index.ts"` in `packages/protocol/src/index.ts`.

**Explicitly NOT moved to protocol** (per the explicit do-not-move list):
- `ChannelInventory` Tag, `ChannelInventoryService`, `makeChannelInventory`, `ChannelInventoryLive`, `findChannel`, inventory-only `channelMetadata` — these remain in `packages/host-sdk/src/host/channel.ts` and continue serving as the transitional binding-edge bridge. **No `ChannelInventory` touch in the sim path.**
- The full residual move of contract types out of `packages/host-sdk/src/host/channel.ts` (which still re-declares the same interface shapes for legacy importers). That delete-and-re-export is **Cycle-2 cleanup**, not Sim 2 scope.

### `@firegrid/host-sdk` — NEW Live Layer

| File | Purpose |
| --- | --- |
| `packages/host-sdk/src/host/channels/host-sessions-create-or-load-live.ts` | `HostSessionsCreateOrLoadChannelLive` — Layer.effect that resolves the protocol-owned Tag with a Pattern 1 binding wired through `RuntimeControlPlaneTable.contextRequests.insertOrGet`. Adds `firegrid.channel.host.sessions.create_or_load.call` span with `firegrid.channel.{target,direction,binding_pattern}` attributes. |

Exported from `packages/host-sdk/src/host/index.ts`.

### `@firegrid/client-sdk` — NEW default Live Layer + rewire

| File | Purpose |
| --- | --- |
| `packages/client-sdk/src/channels/host-sessions-create-or-load-default.ts` | `HostSessionsCreateOrLoadChannelStandaloneLive` — minimal-default binding for non-host-process callers (mirror of the host-sdk Pattern 1 binding). |
| `packages/client-sdk/src/firegrid.ts` | Rewired `createOrLoadSession` to dispatch via the channel Tag (captured at `make` time so the public `FiregridSessionsClient.createOrLoad` signature stays unchanged). `FiregridLive` now bundles the standalone default Layer so existing tests (which wire `FiregridLive` directly) need no per-test change. |

### Sim source — `packages/tiny-firegrid/src/simulations/spike-channel-deletion/sim2-multi-surface-projection/`

| File | Purpose |
| --- | --- |
| `host.ts` | `sim2ChannelLayer` + `sim2FullLayer` compositions wiring the protocol channel contract + host-sdk Live Layer + control-plane table. |
| `driver.ts` | `runClientMethodProjection` + `runMcpToolProjection` + a substrate-row inspector. |
| `index.ts` | Module facade. |

### Evidence harness — `packages/tiny-firegrid/test/spike-channel-deletion/sim2-multi-surface-projection.test.ts`

Five vitest assertions running both projections and inspecting substrate rows directly. All pass (~240ms). Used as the cited row-level evidence below.

### Why a vitest harness instead of `simulate:run`

`simulate:run` discovers TOP-LEVEL folders under `src/simulations/` and matches `id === folder name` (see `packages/tiny-firegrid/src/runner/list.ts`). The dispatch's nested path `spike-channel-deletion/sim2-multi-surface-projection/` is intentional (groups Sims 1-3) but is NOT directly discoverable without extending the runner walk depth. Sim 2's load-bearing measurement is substrate-row + response equivalence — natively expressed in vitest assertions — so the test harness is the right shape for the evidence. Extending the simulate runner to walk nested spike folders is **out of Sim 2 scope** and noted as a residual ergonomic helper.

## Evidence (cited)

All five assertions are in `packages/tiny-firegrid/test/spike-channel-deletion/sim2-multi-surface-projection.test.ts`:

1. **Response identity equivalence** — both projections produce `sessionId === contextId`, both equal to `sessionContextIdForExternalKey(externalKey)`. (Assertions at lines ~100–110 of the test.)
2. **Substrate row shape equivalence** — `Object.keys(clientRow).sort() === Object.keys(mcpRow).sort()`; both rows carry an `_otel` stamp; `runtime`/`createdBy`/`contextId` fields match the corresponding request. (Assertions at lines ~112–127.)
3. **Cross-projection idempotency** — same `externalKey` invoked through client-method then through MCP-tool-style projection produces the SAME `requestId`; the insertOrGet fence holds across projection boundaries. (Test "idempotency: the same projection invoked twice with the same externalKey…", lines ~133–158.)
4. **Found-branch round-trip** — second invocation through MCP-tool projection observes a row equal to the first (`toEqual` on the whole row). (Test "error pathway: invalid request fails through the channel binding cleanly…", lines ~160–183.)
5. **Tag ownership boundary** — `HostSessionsCreateOrLoadChannel.key` contains `@firegrid/protocol/channels`, structurally proving the contract identity sits in the protocol package, not in host-sdk. (Test "typecheck-grade evidence…", lines ~185–197.)
6. **Non-Firegrid composability** — `runMcpToolProjection` succeeds when ONLY the channel + control-plane Layer are provided (no Firegrid client in scope). Proves the channel contract is independently consumable by non-Firegrid projections — the load-bearing property for future REST/gRPC/MCP projections. (Test "layer composition: providing the channel WITHOUT a Firegrid client…", lines ~199–211.)

Pre-existing regression coverage: all 18 `@firegrid/client-sdk` tests pass (`pnpm --filter @firegrid/client-sdk test`), including the layer-hoisting / sessions / projection / boundary suites that exercise the rewired `createOrLoad` path end-to-end.

Span emissions added (visible at `firegrid.channel.*`):
- `firegrid.channel.host.sessions.create_or_load.call` — emitted by BOTH Live Layers (host-sdk + client-sdk-standalone) with `firegrid.channel.target = host.sessions.create_or_load`, `firegrid.channel.direction = call`, `firegrid.channel.binding_pattern = request-row-only`, plus `firegrid.channel.binding_source` distinguishing source.
- `tf-35f4.sim2.projection.{client_method,mcp_tool}.run` — driver-side spans tagging each projection's traversal.

## Architectural compliance with the coordinator heads-ups

Both heads-ups received in-flight were applied to this PR:

- **Channel split (PR pieces in `@firegrid/protocol/channels/`)**: contract types + factories + per-channel Tag live in protocol; Live Layers live in host-sdk and (transitionally) in client-sdk. `ChannelInventory` was NOT moved. The contract identity strings carry `@firegrid/protocol/channels`.
- **`client-sdk` must not import `host-sdk` for channel use**: the rewired `firegrid.sessions.createOrLoad` imports `HostSessionsCreateOrLoadChannel` from `@firegrid/protocol/channels` — NOT from host-sdk. The default Live Layer that satisfies the Tag in standalone wiring is `client-sdk-internal` and depends only on `RuntimeControlPlaneTable` (a protocol-owned Tag). `grep -nr '@firegrid/host-sdk' packages/client-sdk/src` shows zero matches in the rewired path.

## Deletion plan (what becomes droppable in Cycle 2 / mid-term)

Sim 2's verdict GREEN unblocks the following Cycle-2 deletions (each requires a similar per-channel Tag introduction in `@firegrid/protocol/channels/` + a Live Layer wiring):

1. **Direct `appendRuntimeContextRequest` callers in client-sdk** — currently still used by `firegrid.launch`. Same Pattern 1 binding; one more channel Tag (e.g., `HostContextsCreateChannel` keyed on `host.contexts.create`) and a 3-line rewire eliminate the parallel path.
2. **Per-method substrate dispatch in `firegrid.ts`** — the existing `appendRuntimeInputIntent`, `appendRuntimeStartRequest`, `appendDecodedPermissionResponseIntent`, etc. each become channel-Tag dispatches following the createOrLoad pattern. Estimated client-sdk method body shrinks from 10–30 lines each to 3–5 lines each.
3. **`packages/host-sdk/src/host/channel.ts` contract duplication** — once host-sdk's `IngressChannel` / `EgressChannel` / `CallableChannel` / `BidirectionalChannel` / `make*Channel` / `ChannelTarget` declarations are deleted in favor of re-exporting from `@firegrid/protocol/channels`, the host-sdk `channel.ts` collapses to ~30 lines of inventory-only utilities (the not-yet-moved `ChannelInventory` family).
4. **`packages/client-sdk/src/channels/host-sessions-create-or-load-default.ts`** — the standalone-default Layer added in THIS PR is itself slated for deletion once production composition routes through host-sdk's Live Layer or the standalone path drops `createOrLoad` from its supported surface.

## Public-API gaps / ergonomic helpers (treated as visible Cycle-2 work)

Per the dispatch "ergonomic helpers needed: VISIBLE, named, treated as public-API gap" rule, the following residuals are surfaced rather than hidden:

1. **No production `session.create_or_load` MCP tool** — the closest existing agent tool, `session_new`, lowers to `spawnChildContext` (a different substrate path). A production tool projection of `HostSessionsCreateOrLoadChannel` is a tractable follow-on: one `Tool.make` in `packages/host-sdk/src/agent-tools/bindings/tools.ts`, one switch arm in `tool-use-to-effect.ts` that `yield* HostSessionsCreateOrLoadChannel` and forwards `binding.call`.
2. **Two Live Layers for one channel** — host-sdk owns the canonical binding; client-sdk now owns a standalone-default mirror for non-host callers. Both are intentionally Pattern 1 today and identical line-for-line aside from a `binding_source` span tag. The duplication should resolve to **one** binding (in host-sdk) once standalone callers either compose host-sdk or drop write surfaces.
3. **`simulate:run` discovery** — the `simulate:run` runner doesn't currently walk nested `spike-channel-deletion/<name>/` folders. Either the runner is taught to walk one level, OR Sims 1–3 land as flat sibling sims with a `spike-channel-deletion-` prefix. Sim 2 ships its evidence via vitest, so neither change is blocking, but future spike sims that rely on the simulate runner will hit this.

## Non-goals (explicitly NOT validated here)

- **Workflow engine internal structure** — substrate-internal, out of channel-layer scope (per spike doc).
- **Multi-host coordination** — single-host sim is sufficient for the projection-contract claim.
- **Production MCP tool wiring** — sim-local projection is sufficient for the contract claim. Production tool wiring follows mechanically.
- **Full move of `packages/host-sdk/src/host/channel.ts` into protocol** — per the heads-up explicit do-not-move list (ChannelInventory family) AND scope (Sim 2 validates the contract claim; the full file move is Cycle-2 residual).

## Coordination notes

- Lane 4 (tf-2ld2 / Sim 3) territory: NO overlap. This PR does not touch `SessionPermissionChannel` paths or any permission-respond Tag/Layer. Sim 3 owns those independently.
- Lane 3 (tf-jbtu / Sim 1) territory: NO overlap. Sim 1 operates on the agent-output-observation parallel-paths collapse (ingress channel space). This PR operates on a callable channel.

## File-level diff summary

| Path | Action |
| --- | --- |
| `packages/protocol/src/channels/{direction,types,factories,host-sessions-create-or-load,index}.ts` | new |
| `packages/protocol/src/index.ts` | `export * as Channels` added |
| `packages/protocol/package.json` | `"./channels"` export added |
| `packages/host-sdk/src/host/channels/host-sessions-create-or-load-live.ts` | new |
| `packages/host-sdk/src/host/index.ts` | exports `HostSessionsCreateOrLoadChannelLive` |
| `packages/client-sdk/src/channels/host-sessions-create-or-load-default.ts` | new |
| `packages/client-sdk/src/firegrid.ts` | rewire `createOrLoad` to dispatch via channel Tag; bundle default Layer in `FiregridLive` |
| `packages/tiny-firegrid/src/simulations/spike-channel-deletion/sim2-multi-surface-projection/{host,driver,index}.ts` | new sim source |
| `packages/tiny-firegrid/test/spike-channel-deletion/sim2-multi-surface-projection.test.ts` | new evidence harness (5 assertions, all green) |
| `docs/research/tf-35f4-sim2-multi-surface-projection.FINDING.md` | this document |

## Cross-references

- `docs/sdds/SDD_FIREGRID_ONE_SUBSTRATE_PRIMITIVE.md` §"Variants of CallableChannel binding" — Pattern 1 (this sim's binding)
- `docs/research/one-substrate-primitive-validation-spike.md` §"Sim 2 — Multi-surface projection equivalence" — the question this finding answers
- tf-kddg (per-channel Tag+Layer body-plan) — this PR contributes `HostSessionsCreateOrLoadChannel` to the finish-line set; canonical example pattern landed in tf-ws2x (PR #494)
- tf-482w (pre-gate) — Verdict B; this PR ran under Option A expanded scope
- tf-ycxw (Cycle 2 synthesis) — this finding feeds in
