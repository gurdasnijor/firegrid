# Firegrid Gateway — Separation-of-Concerns SDD (§4 tier split)

Status: draft (DESIGN half of S-REFACTOR; implementation is D1/B1-gated)
Created: 2026-06-01
Bead: tf-r06u.22 (resolves Q5 → closes tf-r06u.2)
Owner: Agent1 lane
Audience: implementers of the post-#765 gateway refactor; reviewers of the D1 cutover decision
Grounding: RFC §4 (`docs/rfcs/2026-05-31-firegrid-durable-acp-acpx-alignment.md`) + companion
`docs/rfcs/2026-05-31-acp-durability-conformance.md`. File:line citations are to the **#765 unified-kernel
branch** (`sim/unified-kernel-validation`, worktree `firegrid-worktrees/pr765-review`), verified 2026-06-01.

> **Scope discipline.** This is a *design* SDD: it specifies the target tier boundaries, the symbol-level
> moves, the two-registry resolution of Q5, and the agent-face promotion — but it authors **no production
> code**. The refactor *implementation* is gated on **D1** (the #765 disposition: is #765 a main cutover or a
> validation artifact). One registry field (`newSessionMeta` / MCP-surfacing) is additionally gated on **B1**
> (`tf-r06u.12`, the per-dialect MCP-surfacing spike) and is left as a typed TODO here. Designing now shortens
> the post-D1 critical path without pre-committing the impl.

---

## 1. Executive summary

#765 collapsed the runtime to `Channel + DurableTable + Workflow + signal` — but it fused **three orthogonal
concerns into one in-process Layer graph**: the durable substrate, the ACP gateway edges (both protocol roles),
and the agent-runtime/process management. The fusion is concentrated in one function body,
`buildSessionForContext` (`unified/codec-adapter.ts:235-325`), and one hardcoded dispatch,
the codec ternary (`codec-adapter.ts:299`). The agent-face half of the gateway (`AcpStdioEdge`,
`sources/codecs/acp/stdio-edge.ts`) is **orphaned** — it has no production consumer and is never composed
into `FiregridHost`.

This SDD specifies the clean three-tier split that the RFC §4 calls for:

```
┌─ Tier 1 · Durable substrate ───────────────────────────────────────────────┐
│  Channel + DurableTable + Workflow + signal + the unified subscribers       │
│  Consumes the runtime ONLY through the RuntimeContextSessionAdapter Tag.     │
│  Knows nothing about ACP or OS processes.                                    │
└───────────────────────────┬─────────────────────────────────────────────────┘
                            │  RuntimeContextSessionAdapter  (startOrAttach/send/deregister)
┌───────────────────────────┴─────────────────────────────────────────────────┐
│  Tier 2 · ACP gateway edges (BOTH roles, symmetric, first-class)             │
│   · agent face  — AcpStdioEdge  (promoted from orphan into FiregridHost)     │
│   · client face — AcpSessionLive / StdioJsonlSessionLive (codecs)            │
│  Owns protocol edges + the durable session binding. Does NOT spawn processes.│
└───────────────────────────┬─────────────────────────────────────────────────┘
                            │  SandboxProvider  (create/openBytePipe/lifecycle)
┌───────────────────────────┴─────────────────────────────────────────────────┐
│  Tier 3 · Pluggable agent-runtime / process management                       │
│  LocalProcessSandboxProvider + the spawn/env/lifecycle half of the adapter.  │
│  A swappable backend (local process, remote sandbox, persistent service)     │
│  behind a stable contract; blind to ACP.                                      │
└──────────────────────────────────────────────────────────────────────────────┘
```

Two concrete enabling moves carry the split:
1. **Split `ProductionCodecAdapterLive`** along its own latent seams: `{resolve-context} ⟂ {spawn-runtime} ⟂ {bind-codec}`.
2. **Replace the codec ternary with two orthogonal registries** (Q5): `protocol → codec` and `name → runtime-row`.

And one structural debt-payoff: **promote the orphaned `AcpStdioEdge` into `FiregridHost`**, wiring its three
unimplemented methods (`cancel`/`authenticate`/`loadSession`) to durable kernel signals.

This single refactor is the shared enabler for the acpx adapter fleet (RFC §6), non-ACP agents (RFC §6.5), the
local→remote handoff (§4.5), and the agent-face conformance gate (Direction B) — so its leverage is high, but
it must not land before D1 resolves whether #765 is cutover-bound or a validation artifact.

## 2. Non-goals

- **No implementation.** No production code, no Layer rewiring, no deletions. Design only.
- **No new agent-tool semantics.** Choreography-tool dispatch (`spawn`/`wait_for`/etc.) is a separate
  completeness bead; this SDD only specifies *where* the dispatch surface lives in the tier model.
- **No freezing of the `newSessionMeta` / MCP-surfacing registry field** — typed TODO, B1-gated (§7.4).
- **No multi-node placement.** The runtime tier is designed as a swappable Tag boundary; whether a backend is
  in-process or out-of-process behind a wire is RFC Q4 / D4, out of scope here.
- **No `session/cancel` semantics design.** The cancel *keystone* is `tf-r06u.13`; this SDD only specifies the
  agent-face `cancel` method's *wiring point* to that keystone (§6.3).

## 3. Background — the three conflations (grounded)

`FiregridHost` (`unified/host.ts:231`) is already partly clean: it composes substrate + workflows + channels +
observer, and takes the runtime backend as an **injected** `RuntimeContextSessionAdapter` Layer
(`host.ts:236-238`, `adapter.ts:88-92`). That adapter Tag — `startOrAttach`/`send`/`deregister`
(`adapter.ts:68-92`) — is a genuine, already-correct seam between Tier 1 and Tiers 2/3. The split builds on it.

The conflations the split must resolve (RFC §4, re-verified):

| # | Conflation | Evidence (#765 branch) |
|---|---|---|
| 1 | One function body does **resolve-context + spawn-runtime + bind-codec** | `buildSessionForContext` resolves env (`codec-adapter.ts:248-262`), spawns the sandbox + opens the byte pipe (`:264-281`), *and* picks+builds the codec (`:299-317`) |
| 2 | Codec dispatch is a **hardcoded ternary**, not a registry | `codec-adapter.ts:299`: `agentProtocol === "raw" ? StdioJsonlSessionLive(...) : AcpSessionLive(...)` — the entire "agent runtime registry" |
| 3 | The ACP **agent face is orphaned** from the substrate | `AcpStdioEdge` (`stdio-edge.ts:157`) has no non-test consumer; `FiregridHost` never composes it; it reaches the substrate only sideways via `HostPlaneChannelRouter.dispatch` (`stdio-edge.ts:224,280`), and `initialize` advertises `loadSession:false` (`:238`) while `authenticate` (`:257`) and `cancel` (`:386`) `reject()` |

The cost of *not* splitting: every new adapter or backend patches `buildSessionForContext`; the agent face stays
unreachable; and the local→remote handoff (§4.5) is impossible because execution placement is welded into the
gateway/substrate.

## 4. Target tier architecture — symbol-level moves

The tiers are defined by **what each may depend on**, enforced by the existing Tag seams. "Move" below means
*which module/Layer the symbol belongs to after the split*; several symbols already sit correctly and only need
the fused body decomposed around them.

| Symbol (current location) | Tier after split | Action |
|---|---|---|
| `RuntimeContextSessionAdapter` Tag (`adapter.ts`) | 1↔2 seam | **Keep** — the load-bearing boundary; unchanged contract |
| `FiregridHost` composition (`host.ts:231`) | 1 (composition root) | **Keep**; gains the promoted agent-face tier (§6) + registry wiring (§5) |
| unified subscribers/workflows (`subscribers/*`), `signal.ts`, `tables.ts`, `RuntimeOutputTable`, `RuntimeControlPlaneTable`, `JournalObserverLive` | 1 | **Keep** — pure substrate; no ACP/process knowledge |
| `buildSessionForContext` resolve half — `resolver.resolve` (`codec-adapter.ts:349`), `sandboxConfigForContext` (`:164`), `resolveSpawnEnvVars`/`RuntimeEnvResolverPolicy` (`:248-262`), `ContextResolverTag` (`:88`), `ContextResolverFromControlPlaneTableLive` (`:470`) | 1→2 (resolve-context stage) | **Extract** into a `resolve-context` seam (§5.1) |
| `buildSessionForContext` spawn half — `sandboxProvider.create`/`openBytePipe` (`:264-281`), `SandboxProvider` Tag, `LocalProcessSandboxProvider` (`local-process.ts:315`, `kill` `:419`) | 3 | **Extract** into the runtime tier behind `SandboxProvider` (§5.2) |
| `buildSessionForContext` bind half — codec ternary (`:299`), `Layer.buildWithScope` (`:307`), `mcpServersForAcp` (`:184`), `drainOutputsToJournal` (`:133,320`) | 2 (client face) | **Extract** into a `bind-codec` seam driven by the codec registry (§5.3) |
| `AcpSessionLive` (`codecs/acp/index.ts`), `StdioJsonlSessionLive` (`codecs/stdio-jsonl/index.ts`), `AgentSessionService`/`AgentSession` (`codecs/contract.ts:39,56`) | 2 (client face) | **Keep**; registered in the protocol→codec registry (§5.3) — `AgentSessionService` is the already-protocol-agnostic generalization point |
| `AcpStdioEdge` / `FiregridAcpStdioAgent` (`stdio-edge.ts:157,218`) | 2 (agent face) | **Promote** into `FiregridHost`; wire `cancel`/`authenticate`/`loadSession` (§6) |
| `SandboxProvider` Tag + `SandboxConfig`/`SandboxCommand`/`Sandbox` (`SandboxProvider.ts`) | 3 (contract) | **Keep** — already the runtime-tier contract (`create`/`openBytePipe`/`capabilities`) |

Dependency rule (the design invariant): **Tier 1 may name only the `RuntimeContextSessionAdapter` Tag; Tier 2
may name Tier 1 Tags + the `SandboxProvider` Tag; Tier 3 names neither ACP nor substrate.** A reviewer can
falsify the split mechanically: grep Tier 1 for `acp`/`Sandbox`/`process` imports (should be none), and grep
Tier 3 for `Acp`/`Channel`/`Workflow` imports (should be none).

## 5. The `ProductionCodecAdapterLive` split

Today `ProductionCodecAdapterLive` (`codec-adapter.ts:327`) is one `Layer.scoped` whose `startOrAttach` calls one
fused `buildSessionForContext`. The split decomposes that body into three staged seams, composed in order. The
*adapter remains the Tier-1↔runtime implementation*; the difference is that each stage is an independently
substitutable unit, so "new backend / new protocol" becomes *register*, not *edit the body*.

### 5.1 Stage A — resolve-context (Tier-1-facing)
Input: `contextId`. Output: a `ResolvedRuntimeSpec` = `{ context: RuntimeContext, argv, cwd, envVars, mcpDecls }`.
- Reuses `ContextResolverTag` (`:88`) unchanged — already a Tag seam; production binds
  `ContextResolverFromControlPlaneTableLive` (`:470`), tests bind a static-map resolver.
- Folds in `sandboxConfigForContext` (`:164`) and env resolution (`resolveSpawnEnvVars` under
  `RuntimeEnvResolverPolicy`, `:248-262`).
- Knows nothing about *which* codec or *which* sandbox backend — it only produces the spec.

### 5.2 Stage B — spawn-runtime (Tier 3)
Input: `ResolvedRuntimeSpec`. Output: a `RuntimeHandle` = `{ byteStream, sandbox, close }`.
- Selected by the **runtime-row registry** (§7.3): the row picks the `SandboxProvider` backend and supplies
  spawn parameters; for #765 the only backend is `LocalProcessSandboxProvider`.
- Calls `sandboxProvider.create` (`:264`) + `openBytePipe` (`:272`) into the per-context scope; lifecycle
  (`kill`, `local-process.ts:419`) is owned here.
- **This is the swappable seam for local→remote (§4.5):** a remote/cloud `SandboxProvider` is a different row;
  nothing else in the stack changes, and durable state survives because it lives in Tier 1's streams, not the
  process.

### 5.3 Stage C — bind-codec (Tier 2 client face)
Input: `RuntimeHandle` + the resolved `agentProtocol` + `mcpDecls`. Output: an `AgentSessionService`
(`contract.ts:39`) plus the journal drain.
- Selected by the **protocol→codec registry** (§7.2), replacing the `:299` ternary: `agentProtocol` keys a codec
  factory `(byteStream, codecOptions) → Layer<AgentSession>`. `acp → AcpSessionLive`, `raw → StdioJsonlSessionLive`.
- Retains `Layer.buildWithScope` (`:307`) tying the codec to the context scope, and `drainOutputsToJournal`
  (`:133`) pumping `session.outputs` → `RuntimeOutputTable.events`.
- `mcpServersForAcp` (`:184`) is a codec-specific option-builder; it moves *into* the ACP codec entry of the
  registry, not the shared body (a non-ACP codec has no MCP slot).

Composition: `startOrAttach = resolveContext ▸ spawnRuntime ▸ bindCodec ▸ register`. The registry returns the
`(codecFactory, runtimeRow)` pair; the staged pipeline is otherwise backend/protocol-agnostic. The adapter's
`send`/`deregister` (`:374`,`:436`) are unchanged — they already operate on the registry entry's
`AgentSessionService` + scope.

## 6. Promote the orphaned `AcpStdioEdge` into `FiregridHost`

`AcpStdioEdge` is the **agent face** (the upward ACP role): Zed/acpx drive it. It is fully built but unreachable.
`AcpStdioEdgeLive` (`stdio-edge.ts:614`) declares its requirements as
`HostPlaneChannelRouter | HostContextsChannel | SessionAgentOutputChannel` (`:619`) — and **the unified host
binds none of `HostPlaneChannelRouter` / `SessionAgentOutputChannel`** (verified: `UnifiedChannelBindingsLive`
binds neither). So promotion is not just "add it to the mergeAll"; it has a hard dependency on wiring those
channels.

### 6.1 Promotion shape
- Add the agent-face tier to `FiregridHost` composition (`host.ts:259-271`) as an **optional, first-class** Layer
  (an `apps/`-style binary composes the real stdio streams; the Layer itself is host-resident).
- Bind `HostPlaneChannelRouter` + `SessionAgentOutputChannel` into the unified host. **This intersects the
  read-side + parent→child completeness beads** — the agent face *consumes* exactly the routes those beads wire.
  Promotion should therefore be sequenced *after* (or jointly with) read-side wiring, not before.

### 6.2 `loadSession` → transcript-fold (read-side dependency)
`initialize` advertises `loadSession:false` (`:238`). The companion conformance RFC C1 sharpens this: ACP
`session/load` MUST replay the **entire ordered transcript** as `session/update`s. That requires folding the two
durable stores (`SignalTable` inputs ∪ `RuntimeOutputTable` outputs) into one ordered stream — the *transcript
fold*, which the read-side wiring must produce (not just point-reads). Design: flip `loadSession` to `true` only
once the transcript-fold read API exists; until then it stays `false` and is a named gap, not a silent lie.

### 6.3 `cancel` → cancel keystone (durable fan-out)
`cancel` (`:386`) `reject()`s today. Conformance RFC C4: cancel is a **durable fan-out** — respond to *all*
pending `request_permission` with `cancelled` *and* mark *all* non-finished tool calls `cancelled`, exactly-once,
crash-safe mid-cancel. Design: the agent-face `cancel` method **signals the cancel keystone** (`tf-r06u.13`),
which owns the durable run-lifecycle terminal + the fan-out over parked `PermissionRoundtripWorkflow` /
in-flight `ToolDispatchWorkflow`. This SDD specifies only the *wiring point* (cancel → kernel signal); the
fan-out semantics are tf-r06u.13's.

### 6.4 `authenticate` → one shared flow
`authenticate` (`:257`) `reject()`s. The divergence spike (B-lane) found both adapters used **ambient env-var
creds**; the unbuilt path is hit only by an OAuth-required adapter. Design: a single shared `authenticate` flow
(not per-dialect), reachable from the agent face — lowest priority of the three, no current forcing function.

### 6.5 Read-side channels — snapshot ⟂ stream must not drift (one shared projection)

The agent face's `loadSession`/`session/list`/`history` (and acpx/Zed parity) consume the gateway's **read-side**
channels — and #765 exposes that read surface in **two channel shapes over the same durable tables**:

| Channel (`channel-bindings.ts`) | Kind | Response/element | Backing rows |
|---|---|---|---|
| `HostContextsChannelLive` (`:439`) | `makeIngressChannel` (stream) | `RuntimeContextSchema` | `RuntimeControlPlaneTable.contexts` |
| `SessionLifecycleChannelLive` (`:482`) | `makeIngressChannel` (stream, `forSession`) | `RuntimeRunEventSchema` | `RuntimeControlPlaneTable.runs` |
| `HostContextSnapshotChannelLive` (`:448`) | `makeCallableChannel` (current-state) | `RuntimeContextSnapshotSchema` = `{contextId, runs, events, logs, agentOutputs}` | `RuntimeControlPlaneTable` (contexts+runs) **+** `RuntimeOutputTable` (events+logs+agentOutputs) |
| `HostSessionSnapshotChannelLive` (`:465`) | `makeCallableChannel` | `RuntimeContextSnapshotSchema` | same |

All four are stubbed today (empty arrays / `Stream.empty`, `:440-505`) — so the wiring contract is still open, and
this is the moment to lock it.

**DESIGN RULE (drift-free read-side — A2 / tf-r06u.6 wiring contract):** the snapshot CallableChannel MUST be
computed by folding the **same projection** the ingress streams expose — **one shared projection function over the
tables, never a parallel read path.** Concretely, the read-side wiring defines a single
`project(contextId) → {runs, events, logs, agentOutputs}` over `RuntimeControlPlaneTable` + `RuntimeOutputTable`;
the **ingress streams emit that projection incrementally** (row-by-row, cursored), and the **snapshot returns the
fold of it** at the current frontier. There must be exactly one place that reads the tables.

**Invariant (the falsifier, see §9):** `snapshot(ctx) ≡ fold(stream(ctx))` for every `ctx`. If the snapshot has an
independent query that can diverge from the stream's projection, the design is violated — that divergence is
precisely the class of bug (current-state says X, replayed history says Y) the gateway exists to prevent, and it
is what ACP `session/load` (conformance C1, the transcript-fold) cannot tolerate.

**Snapshot: distinct channel, derived implementation (resolves the RFC "third read shape" flag).** The RFC
channel-discipline note (RFC §8, and the read-side RFC §5.1) flags `HostContextSnapshot` as a *suspect third read
shape* — "justify on
ergonomics or derive from the events fold." Resolution: **keep it as a distinct `CallableChannel`** (it earns its
surface: a synchronous "current state at the frontier" read is a real ergonomic need a stream subscription serves
awkwardly) **but implement it as `fold(projection(ctx))`, not a parallel point-read.** So: distinct *channel
surface*, single *projection source*. This is the both/and that satisfies the litmus — the snapshot is justified
*and* derived, so it cannot drift. (If a future reviewer finds the snapshot adds no ergonomic value over a
bounded stream read, the cheaper move is to drop the channel and derive on the client — but the no-drift rule
holds either way because there is still one projection.)

This pins the **read-side wiring contract for A2 / tf-r06u.6**: that bead must land the single `project(...)`
function consumed by both the ingress streams and the snapshot callable — not two table readers.

## 7. Q5 resolution — two orthogonal registries (closes tf-r06u.2)

RFC Q5: *should "agent protocol" (ACP vs raw) and "runtime/process backend" be one key or independent
registries?* **Resolution: two orthogonal registries.** The keys are genuinely independent — you can run
ACP-over-local-process, ACP-over-remote-sandbox, or raw-over-local-process — so collapsing them to one key would
re-introduce the very `buildSessionForContext` coupling this SDD removes.

### 7.1 Why orthogonal (the falsifiable claim)
`agentProtocol` answers *how do we speak to the subprocess's bytes* (Stage C). The runtime backend answers
*where/how is the process spawned* (Stage B). They compose as a product, not a sum. One key forces `N_protocols
× M_backends` enum entries; two registries keep it `N + M`. (Falsifier: if no real deployment ever needs a
protocol×backend combination that isn't 1:1, a single key would suffice — but the local→remote handoff §4.5
already requires the same `acp` protocol over *two* backends, which refutes 1:1.)

### 7.2 Registry I — `protocol → codec`
Key: `agentProtocol` (`"acp" | "raw" | …`). Value: a codec factory.
```
CodecEntry = {
  protocol: AgentProtocol            // "acp" | "raw" | future
  makeSession: (byteStream, codecOptions) => Layer<AgentSession, AgentCodecError>
  buildCodecOptions?: (spec: ResolvedRuntimeSpec) => CodecOptions   // e.g. mcpServersForAcp for acp
  toolUseMode: AgentToolUseMode      // from AgentSessionService.meta
}
```
`acp → AcpSessionLive` (+ `mcpServersForAcp` option-builder), `raw → StdioJsonlSessionLive` (no MCP slot).
This is a pure structural lift of the `:299` ternary; no new behavior.

### 7.3 Registry II — `name → runtime-row`
Key: a runtime/adapter **name** (e.g. `codex`, `claude`). Value: the row that makes fleet onboarding *config*.
```
RuntimeRow = {
  name: string
  command: SpawnCommandSpec          // argv/env derivation for the backend
  credentialEnv?: EnvBindingPolicy    // authorized (binding -> host-env) pairs; default denyAll
  sandboxBackend: SandboxProviderRef  // selects the Tier-3 SandboxProvider (local-process | remote | …)
  modeMap?: ToolModeMap               // provider_executed vs observation_only mapping
  // newSessionMeta:  ⟵ TYPED TODO — DO NOT DEFINE HERE (§7.4)
}
```
Per the divergence spike, the per-dialect cost is one row; the only per-dialect *code* today is the claude
`session/new._meta` coax — which is the `newSessionMeta` field, deliberately left open below.

### 7.4 The `newSessionMeta` / MCP-surfacing field — TYPED TODO (B1-gated)
```
// TODO(tf-r06u.12 / B1): newSessionMeta?: (req) => SessionMeta
// The per-dialect MCP-surfacing coax (claude needs _meta.disableBuiltInTools + alwaysLoad;
// codex defers MCP by a different, UN-RUN mechanism). This is the ONLY field whose shape is
// unproven. The B1 spike (attach Firegrid's MCP catalog; drive a wait_for/schedule_me turn
// through EACH adapter; assert the tool is callable by the LLM) MUST run before this field's
// contract is frozen. Until then: type it as an opaque `(req) => unknown` escape hatch, do not
// stabilize its schema, and do not let any consumer depend on its shape.
```
Defining the rest of `RuntimeRow` while leaving this one field as a typed TODO is exactly the "config not code"
verdict's boundary: the design is settled except the one measurement-gap field.

### 7.5 Composition
`FiregridHost` resolves `(agentProtocol, runtimeName)` from the context's `runtime.config` and looks up
`(CodecEntry, RuntimeRow)`. The two lookups are independent; the staged pipeline (§5) consumes both. This closes
**tf-r06u.2** (Q5).

## 8. Sequencing — what is gated on what

| Workstream | Gate | Rationale |
|---|---|---|
| **This design SDD** (tiers, splits, Q5, promotion shape) | **none — unblocked now** | Design is falsifiable against current code; shortens the post-D1 path |
| Stage A/B/C extraction + registry impl | **D1** (#765 disposition) | The refactor edits #765 substrate; must not proceed until #765 is dispositioned as cutover-bound (path A) vs validation artifact |
| Agent-face promotion (§6) | **D1 + read-side wiring** | Promotion *consumes* `HostPlaneChannelRouter` + `SessionAgentOutputChannel`; those are the read-side / parent→child completeness beads |
| `loadSession:true` (§6.2) | **transcript-fold** (read-side, conformance C1) | Cannot advertise `true` until the fold read API exists |
| `cancel` wiring (§6.3) | **`tf-r06u.13`** (cancel keystone) | Agent-face `cancel` signals the keystone; keystone owns the durable fan-out |
| `newSessionMeta` field freeze (§7.4) | **B1 / `tf-r06u.12`** | Per-dialect MCP-surfacing reach unproven for codex; do not freeze |
| In/out-of-process runtime backend boundary | **RFC Q4 / D4** | Whether a Tier-3 backend needs a wire protocol is a distribution decision, out of scope |

Net: everything *designable* is in this SDD now; everything *buildable* waits on D1, with three finer gates
(read-side, cancel keystone, B1) on specific sub-parts.

## 9. Falsifiers (how to prove this design wrong)

- **Tier purity is unachievable.** If Tier 1 cannot be expressed without importing `acp`/`Sandbox`/`process`
  symbols (grep test, §4), the `RuntimeContextSessionAdapter` seam is insufficient and needs widening — falsifies
  the "already-clean seam" premise.
- **Q5 should be one key after all.** If every real deployment is protocol×backend 1:1 (no shared protocol across
  backends, no shared backend across protocols), two registries are over-engineering. The §4.5 local→remote
  handoff (same `acp` over local + remote) is the standing counter-evidence; lose that and Q5 collapses.
- **The codec-adapter does not cleanly tri-sect.** If `resolve`/`spawn`/`bind` share hidden state beyond the
  `ResolvedRuntimeSpec` / `RuntimeHandle` / `AgentSessionService` hand-offs (e.g. the codec needs the resolver
  mid-spawn), the staged pipeline is wrong and the boundary must move.
- **Agent-face promotion needs more than the two channels.** If composing `AcpStdioEdgeLive` into `FiregridHost`
  surfaces requirements beyond `HostPlaneChannelRouter` + `SessionAgentOutputChannel` + `HostContextsChannel`,
  the promotion is larger than scoped and the read-side dependency understated.
- **`cancel` cannot be a thin signal.** If the agent-face `cancel` must itself perform the fan-out (rather than
  signaling tf-r06u.13), the keystone boundary is wrong.
- **`newSessionMeta` is load-bearing for non-MCP behavior.** If the field turns out to carry dialect behavior
  beyond MCP-surfacing, leaving it a typed TODO blocks more than the B1 spike — re-scope.
- **Read-side snapshot ⟂ stream drift (§6.5).** Property test: for every `ctx`, `snapshot(ctx) ≡ fold(stream(ctx))`.
  If they can differ, the snapshot has a second, independent table read and the one-projection rule is violated —
  the design (and the `session/load` transcript-fold, conformance C1) is wrong until they share one `project(...)`.

## 10. Cross-references

- RFC §4 (separation of concerns), §4.5 (local→remote handoff), §6/§6.5 (fleet + non-ACP), §12 Q4/Q5.
- Companion `2026-05-31-acp-durability-conformance.md` — C1 (loadSession transcript-fold), C4 (cancel fan-out),
  C8 (MCP-surfacing gate).
- Beads: **closes tf-r06u.2** (Q5); cross-refs **tf-r06u.13** (cancel keystone), **tf-r06u.12 / B1** (MCP-surfacing
  spike — `newSessionMeta` gate), **A2 / tf-r06u.6** (read-side wiring — the §6.5 one-projection / no-drift
  contract this SDD pins), and the D1 disposition + the three completeness beads (read-side / parent→child
  agent_output / choreography-tool dispatch) in the D1 memo.
- Existing SDDs: `SDD_FIREGRID_UNIFIED_PRODUCTION_WIRING.md`, `SDD_FIREGRID_UNIFIED_PRODUCTION_CODEC_ADAPTER.md`
  (the §B/Phase-E wiring this refactor restructures).

## 11. ACID anchor

New behavior introduced by the *implementation* of this design should tie back to
`features/firegrid/firegrid-workflow-driven-runtime.feature.yaml`
(`firegrid-workflow-driven-runtime.PHASE_0_TARGET_REFERENCE.*`) via `firegrid.contract.id`, consistent with the
RFC's spec/ACID anchoring rule. This SDD adds no ACIDs itself (design only); the extraction PRs should annotate
the new seam boundaries (`firegrid.seam.kind = process` for Tier 3, `relay`/`transform` for the staged
pipeline, `authority` for the agent-face permission/cancel wiring).
