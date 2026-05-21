# tf-aago — client-sdk + CLI projection-surface rewire plan

Status: PLANNING (execution HELD on tf-zd8s landing the final per-channel Tag set)
Owner: Lane 5 (opus)
Bead: tf-aago (P1)
Dep: HARD on tf-zd8s (lane 3) — finalize per-channel Tag+Layer set + retire ChannelInventory. Do NOT rewire against the transitional ChannelInventory shape.
Synthesis: docs/handoffs/one-substrate-cycle-2-synthesis.md §1.2 #3, §1.3, §3
Sim 2 template: docs/research/tf-35f4-sim2-multi-surface-projection.FINDING.md (createOrLoad already rewired through HostSessionsCreateOrLoadChannel.binding.call; protocol/launch/host-session-create-or-load-request.ts binding factory pattern)

This document is the STABLE analysis. Only the exact Tag names + import
paths firm up when tf-zd8s lands; the method→verb mapping and the
substrate-dispatch inventory do not change.

## Acceptance recap

- `packages/client-sdk/src/firegrid.ts` materially shrinks (~1165 LOC today → ~150 target; the 500→150 figure in the synthesis predates Sim 1/2 additions)
- `packages/client-sdk/src/operations.ts` collapsed (re-export)
- `rg "@firegrid/host-sdk" packages/client-sdk/src` → 0
- all existing client-sdk tests pass
- `pnpm preflight` green before task-exit

## 1. Method → channel-verb mapping (client-sdk/src/firegrid.ts)

Legend: ✓EXISTS = Tag already in `@firegrid/protocol/channels`; ⏳LANE3 = needs the final Tag from tf-zd8s; n/a = no substrate I/O (pure handle factory, SDD synchronous-handle exception).

| Method | Current substrate dispatch (helper → DurableTable op) | Verb | Target channel | Tag status |
| --- | --- | --- | --- | --- |
| `firegrid.launch(req)` | `createContextRequest` → `appendRuntimeContextRequest` → `control.contextRequests.insertOrGet` | `call` | contexts-create callable (contextId is client-minted via `makeContextId()`, NOT externalKey-derived — distinct from createOrLoad) | ⏳LANE3 (`HostContextsCreateChannel` or equiv) |
| `firegrid.sessions.createOrLoad(req)` | DONE — `hostSessionsCreateOrLoadChannel.binding.call(req)` | `call` | `HostSessionsCreateOrLoadChannel` | ✓EXISTS |
| `firegrid.sessions.attach(req)` | `makeSessionHandle(decoded.sessionId)` — pure value constructor, no I/O | — | — | n/a (SDD: synchronous handle factory lowers nowhere) |
| `firegrid.sessions.prompt(req)` | `appendRuntimeInputIntent({kind:"message"})` → `control.inputIntents.insertOrGet` | `send` | host-scoped prompt egress | ⏳LANE3 (`HostPromptChannel`) |
| `firegrid.prompt(req)` (top-level) | `appendRuntimeInputIntent(promptToRuntimeIngressRequest(decoded))` | `send` | host-scoped prompt egress | ⏳LANE3 (`HostPromptChannel`) |
| `firegrid.permissions.respond(req)` | `appendDecodedPermissionResponseIntent` → `appendRuntimeInputIntent({kind:"required_action_result"})` | `call` | permission respond callable — top-level form carries `contextId` in the request; `SessionPermissionChannelRequestSchema` currently does NOT include contextId (it is session-scoped). Reconcile with lane 3: either (a) a host-scoped `HostPermissionRespondChannel` whose request includes contextId, or (b) extend SessionPermissionChannel for both. | ⏳LANE3 (reconcile) |
| `firegrid.watchContexts(pred)` | `control.contexts.rows()` filtered by predicate | `wait_for`/stream (ingress) | contexts ingress | ⏳LANE3 (`HostContextsChannel`) |
| `firegrid.open(contextId)` | synchronous `RuntimeContextHandle` constructor, no I/O | — | — | n/a |
| `session.whenReady` | `waitUntilContextReady(sessionId)` — reads lifecycle/run projection | `wait_for` (ingress) | session-lifecycle ingress (host-sdk has `SessionSelfLifecycleChannel` but it is host-side; client needs a projection) | ⏳LANE3 |
| `session.prompt(req)` | `appendRuntimeInputIntent({kind:"message"})` | `send` | session-scoped prompt egress | ⏳LANE3 (`SessionPromptChannel`) |
| `session.start()` | `appendRuntimeStartRequest` → `control.startRequests.insertOrGet` (+ `makeRuntimeStartRequestAck`) | `call` | start callable | ⏳LANE3 (`HostSessionsStartChannel`) |
| `session.snapshot()` | `readSnapshot(sessionId)` — `get` + `query` over N tables | `call` (Pattern 2 direct-query) | snapshot callable | ⏳LANE3 (`HostSessionSnapshotChannel`) |
| `session.wait.forAgentOutput(req)` | DONE — `clientSessionAgentOutputChannel(output)` + `waitForIngressChannelProjection` | `wait_for` (ingress) | `SessionAgentOutputChannel` | ✓EXISTS |
| `session.wait.forPermissionRequest(req)` | reads agentOutput stream filtered to PermissionRequest observations | `wait_for` (ingress, derived) | `SessionAgentOutputChannel` (filterMap to PermissionRequest) | ✓EXISTS (derived; no new Tag) |
| `session.permissions.respond(req)` | `appendDecodedPermissionResponseIntent` (contextId from handle scope) | `call` | `SessionPermissionChannel` (session-scoped — contextId implicit) | ✓EXISTS |
| `session.permissions.autoApprove(policy)` | `autoApproveSessionPermissions({wait, permissions:{respond}}, policy)` | `Layer.scoped(SessionPermissionChannel, policyBinding)` | `SessionPermissionChannel` (Sim 3 binding-swap pattern) | ✓EXISTS |

### Substrate-dispatch helpers slated for deletion/relocation

These local helpers in firegrid.ts are the grab-bag the rewire collapses. Each becomes a channel `binding.{call,append,stream}` dispatch; the DurableTable insertOrGet logic moves into a protocol/launch binding factory (Sim 2's `requestHostSessionCreateOrLoad` template) consumed by the channel's Live Layer:

- `appendRuntimeInputIntent` (control.inputIntents.insertOrGet) → prompt egress binding + permission-respond callable binding
- `appendRuntimeContextRequest` / `createContextRequest` (control.contextRequests.insertOrGet) → contexts-create callable binding (launch) — note createOrLoad already uses the channel
- `appendRuntimeStartRequest` (control.startRequests.insertOrGet) → start callable binding
- `appendPermissionResponseIntent` / `appendDecodedPermissionResponseIntent` / `permissionResponseInput` → permission-respond callable binding
- `readSnapshot` + `snapshotFromJournal` → snapshot callable (Pattern 2) binding — KEEP read composition; only the dispatch wrapper changes

### The "client-sdk MUST NOT import host-sdk" invariant (Sim 2 proved viable)

The binding factories live in `@firegrid/protocol/launch/*-request.ts` (they take a `RuntimeControlPlaneTableService` arg — a protocol-owned Tag — and compose protocol primitives; they do NOT import host-sdk). The standalone-default Live Layers live in `packages/client-sdk/src/channels/*-default.ts` and `Layer.effect` the protocol Tag using the protocol factory. Production hosts override with host-sdk Live Layers via composition. Net: client-sdk source imports `@firegrid/protocol/*` only.

Current standalone-default precedent: `packages/client-sdk/src/channels/host-sessions-create-or-load-default.ts` (Sim 2). Replicate per new channel. §1.2 #5 slates the createOrLoad default for eventual deletion once production composition routes through host-sdk's Live Layer — but that is tf-cyet (Phase 3), NOT tf-aago. Keep the standalone-default Layers in tf-aago so client-sdk standalone tests pass.

## 2. operations.ts collapse (independent of channels — session-facade alignment)

`packages/client-sdk/src/operations.ts` (64 LOC) duplicates `FiregridClientOperations` already exported from `@firegrid/protocol/session-facade` (via `operations.ts` → index.ts). The protocol version uses `defineFiregridOperation` returning `{inputSchema, outputSchema, metadata, description, examples}` — a SUPERSET of the client version's `{inputSchema, outputSchema}`. All client callers only access `.inputSchema` (firegrid.ts:428,435,442,449,456,463,472,481) and the projection test accesses `.inputSchema`. SAFE to collapse.

Plan:
- Replace `packages/client-sdk/src/operations.ts` body with a re-export:
  - `export { FiregridClientOperations } from "@firegrid/protocol/session-facade"`
  - keep the type re-exports currently in operations.ts (`PermissionRespondInput`, `PermissionRespondOutput`, `SessionPromptToolInput`, `SessionPromptToolOutput`) — already re-exported from protocol agent-tools; point them at protocol.
- No firegrid.ts import change needed (it imports from `./operations.ts` which now re-exports), OR repoint firegrid.ts directly at `@firegrid/protocol/session-facade` and delete operations.ts entirely. Prefer DELETE + repoint for a true collapse; verify `packages/client-sdk/src/index.ts` re-export of FiregridClientOperations is updated.
- Verify `firegrid.projection.test.ts` still passes (it asserts `.inputSchema` identity against protocol schemas — the protocol FiregridClientOperations uses the SAME schema instances, so `toBe` identity holds).

NOTE: although operations.ts collapse is channel-independent, bundle it into the same tf-aago PR for atomicity. Do not commit separately before tf-zd8s (keep the worktree single-commit-on-unblock).

## 3. CLI run.ts collapse (packages/cli/src/bin/run.ts, 710 LOC)

The CLI is a HOST PROCESS (firegrid-host-sdk.PACKAGE_GRAPH.5) — it MAY import host-sdk host authority. So the "no host-sdk" invariant does NOT apply to the CLI; only to client-sdk.

Already in desired shape (NO change needed):
- `launchConfigToPublicRuntimeIntent` already maps presets → `local.jsonl({argv,...})`. There is NO separate config DSL. Agent presets (`--agent codex-acp`) already lower to the protocol-owned `local` builder. ✓ acceptance item 3 already satisfied structurally.

In-scope collapse (gated on lane 3 prompt channel):
- `executeRun` (run.ts:244-279) mixes client projection (`firegrid.sessions.createOrLoad`, `session.whenReady`) with host execution (`appendRuntimeIngress`, `startRuntime`). The initial-prompt append uses host-sdk `appendRuntimeIngress`; once the prompt egress channel lands it becomes `firegrid.prompt`/`session.prompt` client dispatch. `startRuntime` is genuine host execution (the CLI runs the workflow in-process) and STAYS as host authority — it is not a client projection.

GATED — do NOT touch (tf-yxdd):
- The embedded `DurableStreamTestServer` start/stop lifecycle (run.ts:316-340 + the `--embedded` dev-server path). That is tf-yxdd's classification decision.

CLI net change in tf-aago: small — repoint the initial-prompt append from host-sdk `appendRuntimeIngress` to the client prompt channel IF that keeps the host-execution semantics (CLI still owns startRuntime). If the prompt-channel routing would change the in-process append semantics, leave `appendRuntimeIngress` and note it. Decide at execution time against lane 3's final prompt-channel shape.

## 4. Execution order (when tf-zd8s lands + coordinator pings)

1. `git fetch origin main && git rebase origin/main` (onto tf-zd8s's final channel shape)
2. Re-read `@firegrid/protocol/channels` to confirm final Tag names; update the ⏳LANE3 rows of §1 with the actual Tag identifiers.
3. operations.ts collapse (§2) — independent, do first as a clean baseline.
4. Per-channel: add protocol/launch binding factory (if lane 3 didn't) + client-sdk standalone-default Layer + rewire the firegrid.ts method body to `binding.{call,append,stream}`. Order: prompt (egress, 3 methods) → start (callable) → launch (callable) → permission top-level (reconcile contextId) → snapshot (Pattern 2) → watchContexts/whenReady (ingress).
5. Delete the now-unused append helpers from firegrid.ts.
6. CLI §3 prompt-append repoint (if applicable).
7. `rg "@firegrid/host-sdk" packages/client-sdk/src` → assert 0.
8. `pnpm preflight` green.
9. `bash scripts/task-exit.sh tf-aago`.

## 5. Coordination flags — RESOLVED (coordinator recommendations, pending lane-3 final confirm)

- **Q1 Tag ownership — RESOLVED (coordinator recommendation):** tf-zd8s authors ALL 7 missing contract Tags + their Live Layers; tf-aago authors NO new contract Tags — pure client-side projection. The 7 Tags: `HostContextsCreate`, `HostPrompt`, `SessionPrompt`, `HostSessionsStart`, `HostContextSnapshot`, `HostSessionSnapshot`, `HostContexts`, `SessionLifecycle`. (Listed 8 names; the snapshot pair covers context vs session snapshot.) → Execution change vs §1/§4: I do NOT write protocol/launch binding factories; I consume lane 3's Tags + Live Layers and write only the client-side dispatch + standalone-default wiring needed for client-sdk tests. Confirm at execute time whether lane 3's Live Layers cover standalone client composition or whether client-sdk still needs thin standalone-default Layers (Sim 2 precedent suggests the latter for non-host-process callers).
- **Q2 permission contextId — RESOLVED (coordinator recommendation):** option (a) — a separate `HostPermissionRespondChannel` carrying `contextId` in its request, per the SDD Three-Layer Chain table (HostPermissionRespond + SessionPermission are distinct rows). → top-level `firegrid.permissions.respond` lowers to `HostPermissionRespondChannel.binding.call`; session-scoped `session.permissions.respond` keeps `SessionPermissionChannel`.
- tf-cyet (Phase 3) decides whether the standalone-default Layers get deleted (production routes through host-sdk Live Layers). NOT tf-aago scope — keep the defaults.

Both recommendations await lane-3 final confirmation; coordinator will relay the confirmed Tag inventory alongside the "tf-zd8s landed, rebase + execute" signal. Update the ⏳LANE3 rows of §1 with the confirmed Tag identifiers at that point.
