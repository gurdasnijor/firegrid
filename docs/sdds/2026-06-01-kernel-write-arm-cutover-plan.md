# Kernel-Write-Arm Production Cutover Plan

Doc-Class: dispatchable
Status: active (execution blueprint; gated on trunk-green)
Date: 2026-06-01
Owner: Agent2 / lane-b (consolidates the .44 + .46 spike findings)
Cluster: tf-r06u.35 / .36 / .37 / .45 / .47 / .48
Spikes: tf-r06u.44 (PR #773), tf-r06u.46 (PR #775)
Authority: `docs/cannon/architecture/kernel-owned-write-arm.md`, `docs/architecture/shape-c-vs-shape-d.md`

## §1 Purpose + gating preamble

#765 landed the unified substrate as a **validation skeleton**. Per the
transactional-cutover canon it stays a skeleton until this cluster lands: the
host-owned control/relay legs the deletion audit flagged (R2 cancel/close, R3
terminal-completion, R14 restart re-arm) have ZERO production consumers today.
This plan makes the cluster execution-ready the moment the trunk greens.

**Hard gates:**
- **Trunk-green** — Agent1 tf-r06u.5 (effect-diagnostics / lint:dup / lint:dead +
  the `permission-and-tool.ts:71/:190` workflow classification). Nothing in this
  cluster lands before the trunk is green.
- **tf-c9r9-shape** — the kernel-owned write+arm (`kernel-owned-write-arm.md`).
  tf-c9r9 is **CLOSED as a reference/sim** (PRs #665/#666); there is still **no
  concrete `HostKernelWorkflow` in production**. This cluster IS the
  production-wiring lift tf-c9r9 ran ahead of.

**Posture:** new-files-first wherever possible; the only shared-file edits are
the `FiregridHost` composition (§5, sequenced) and `observers.ts` (.36's
Terminated branch). The cluster does **not** touch `permission-and-tool.ts`
(Agent1's region) — clean.

## §2 The cluster + build order

Dependency-ordered. The first two are coupled (§refinement A); producers land on
top of both.

```
  ┌─ FOUNDATION (build adjacent — the RECOVERABLE durable base) ─────────────┐
  │  tf-r06u.47  shared terminal-emit surface   ── BUILD FIRST (build-once)   │
  │  tf-r06u.37  recoverPendingSignals → FiregridHost (restart re-arm)        │
  └──────────────────────────────────────────────────────────────────────────┘
        │  producers land ONLY on top of BOTH .47 + .37
        ▼
  ┌─ PRODUCERS / DELIVERY ───────────────────────────────────────────────────┐
  │  tf-r06u.35 (R2)  cancel/close producer       — HostKernelCancelWorkflow   │
  │  tf-r06u.36 (R3)  agent-completion producer   — Terminated/TurnComplete    │
  │  tf-r06u.45       wire-path tool-result emitter (durable toolUseId→seq)    │
  └──────────────────────────────────────────────────────────────────────────┘

  tf-r06u.48  bounded spawn handler (related; Decision-A; shared unit) — §8
```

**`.47` + `.37` are ONE recoverable foundation, not sequential-with-a-gap.**
The exactly-once-**across-restart** guarantee tf-r06u.46 proved DEPENDS on
`recoverPendingSignals` re-arming a domain-signal-parked body on restart. The
unified engine recovers ONLY clock wakeups today (`engine-runtime.ts:527`);
`recoverPendingSignals` (`unified/signal.ts:197`) is correct + sim-proven but has
**zero production callers** (R14). So `.47` shipped WITHOUT `.37` emits correctly
at runtime but **silently loses the restart-durability the spike proved** — after
a crash, the parked body is never re-armed. Build `.47` + `.37` adjacent as the
recoverable foundation; do not land a producer until both are in.

## §3 The recurring principle — single shared unit, multiple producers / delivery-shapes

This is the load-bearing decision the plan locks so the lanes cannot diverge into
per-path reimplementations. Three instances, one shape:

| Shared unit (build ONCE) | Producers / delivery shapes (build on top) |
|---|---|
| **terminal-emit surface** (.47): kernel-owned write+arm emitting a `terminal` `SessionInputPayload` keyed by TARGET identity, consumed at `runtime-context.ts:124` | **2 producers:** .35 cancel/close (CancelIntent) · .36 agent-completion (Terminated/TurnComplete). *Producer differs; emit + durable identity + consumed path identical.* |
| **tool-dispatch lowering** (.28 `FiregridAgentToolExecutor`, typed arm `(input)=>Effect<Output,ToolError>`) | **2 delivery shapes:** .45 wire relay (Shape C, durable observation) · .28 MCP-entry (Shape D, `tools/call` response). *Lowering identical; only delivery/durability differs.* |
| **spawn handler** (.48, bounded create+start+return-handle) | **2 reach paths:** .9 wire-path router · .28 mcp-host executor arm. *One shared unit, not router-private.* |

**Rule:** the producer/delivery layer is thin and path-specific; the shared unit
owns the durable mechanism + its exactly-once identity. A lane that finds itself
re-implementing the emit / lowering / handler per path is building the wrong
thing — reach for the shared unit.

## §4 Per-piece — spike-proved → production mapping + seams

### tf-r06u.47 — shared terminal-emit surface (BUILD FIRST)
- **Spike-proved (.46, PR #775 F1/F2/F3):** a long-running kernel
  (`HostKernelCancelWorkflow` in the spike) emits the EXISTING terminal input via
  the kernel-owned write+arm (`sendSignal` = write the workflow-owned signal row +
  `resume`); a re-delivered emit dedups via `insertOrGet`-keyed `(executionId,
  name)` under a deterministic target-keyed name → exactly-once.
- **Production mapping:** a host kernel/controller exposes `emitTerminal(target)`
  — write a `terminal` `SessionInputPayload` keyed by target identity, arm the
  owning `RuntimeContextSessionWorkflow`. New file(s); the `sendSignal` primitive
  already exists.
- **Seams:** emits INTO `runtime-context.ts:124` (consumed path — **no edit**);
  uses `signal.ts` `sendSignal`/`insertOrGet` (no edit); installed in
  `FiregridHost` (§5).

### tf-r06u.37 — recoverPendingSignals → FiregridHost (restart re-arm)
- **Mapping:** wire the existing, sim-proven `recoverPendingSignals`
  (`unified/signal.ts:197`) into `FiregridHost` startup so domain-signal-parked
  bodies re-arm on restart (today only clock wakeups recover).
- **Seams:** `FiregridHost` composition (§5); a `WorkflowCatalog` of the host's
  workflows (incl. the kernel + `RuntimeContextSessionWorkflow`). New wiring; no
  edit to `signal.ts`.

### tf-r06u.35 — cancel/close producer (R2)
- **Spike-proved (.46 F1):** kernel-mediated cancel drives the per-context
  workflow to TERMINAL; router = thin dispatch-intent (owns no lifecycle).
- **Mapping:** a cancel/close route decodes + authorizes + signals the kernel a
  `CancelIntent`; the kernel calls the shared `.47` `emitTerminal`. The
  cancel/close request schema already ships (`control-request.ts:141`) with zero
  consumer — this is its consumer. Producer on top of `.47`+`.37`.
- **Seams:** new route + kernel install in `FiregridHost` (§5); reuses `.47`.

### tf-r06u.36 — agent-completion producer (R3)
- **Mapping:** add the missing `Terminated`/`TurnComplete` branch in
  `observers.ts` (today only `PermissionRequest`/`ToolUse` are handled); on
  agent turn-complete, call the shared `.47` `emitTerminal` → the body breaks its
  loop → the after-loop `deregister` Activity fires (fixes the per-context process
  leak). Producer on top of `.47`+`.37`.
- **Seams:** `observers.ts` (add branch — the one genuine non-host edit); reuses
  `.47`.

### tf-r06u.45 — wire-path tool-result emitter (durable toolUseId→sequence)
- **Spike-proved (.44, PR #773 F1/F2):** the codec's live `sequenceRef`
  (`codec-adapter.ts:143`) is VOLATILE; `RuntimeOutputTable.events` is keyed by
  `sequence`, so a replayed relay re-numbers + duplicates. A **durable
  `toolUseId→sequence` assignment** makes the relayed ToolResult observation
  appended-exactly-once + offset-readable across replay (Shape C).
- **Mapping:** the wire-path emitter (delivery shape of the .28 shared executor)
  assigns the output sequence durably keyed by `toolUseId`, then `insertOrGet`s
  the `ToolResult` observation (`event.part: Prompt.ToolResultPart`, the .41 arm).
- **Seams:** the wire-path emitter (codec-adapter region); the .41 observation arm
  (Agent3, protocol). Independent of the terminal-emit foundation.

## §5 Seam inventory + collision map — `FiregridHost` is the convergence point

**The real collision surface is `FiregridHost` composition**, where FOUR things
land. They must follow ONE coherent composition sequence — NOT N independent
`host.ts` edits racing the same region:

```
  FiregridHost composition (prescribed order):
    1. tf-r06u.9   — SessionAgentOutput channel wiring         (Agent4 lane)
    2. tf-r06u.37  — recoverPendingSignals(catalog) at startup ─┐ fold into
    3. tf-r06u.47  — kernel/controller install (terminal-emit) ─┤ the SAME
    4. tf-r06u.35  — cancel/close route → kernel signal         ─┘ region, in order
```

- **Sequence rule:** `.9`'s SessionAgentOutput composition lands first (Agent4);
  then `.37` recover-wiring + `.47`/`.35` kernel install **fold into the same
  composition region** as a single coherent block, built on the `.9` base — so the
  lanes don't race. Whoever lands `.9` leaves the kernel-install seam marked;
  `.37`/`.47`/`.35` extend it, not re-open it.
- **Non-host seams (low collision):** `runtime-context.ts:124` = emit-INTO only
  (no edit); `observers.ts` = `.36`'s Terminated branch (additive); `signal.ts`
  `sendSignal`/`recoverPendingSignals` = consumed as-is (no edit); the wire-path
  emitter (`.45`) + the `.41` observation arm = the codec/protocol region,
  independent of the host block.
- **NOT in this set (clean):** Agent1 tf-r06u.5's `permission-and-tool.ts:71/:190`
  — the cluster never edits it. Confirmed no collision.

## §6 Gating matrix

| Piece | Trunk-green | tf-c9r9-shape wiring | new-files-first / buildable-now-shape |
|---|---|---|---|
| .47 terminal-emit | required | YES (write+arm + restart needs .37) | new files; emit logic buildable now |
| .37 recover→host | required | YES (it IS the write+arm restart leg) | thin host wiring (folds into §5) |
| .35 cancel producer | required | on top of .47/.37 | new route + kernel signal; new-files-first |
| .36 agent-completion | required | on top of .47/.37 | `observers.ts` branch + reuse .47 |
| .45 wire emitter | required | durable assignment (Shape C; tf-c9r9-shape identity) | emitter region; needs .41 arm (Agent3) |
| .48 spawn handler | required | Decision-A buildable WITHOUT tf-c9r9 (no await); B-await needs it | §8 |

## §7 Acceptance / proof carry-forward

Each production piece carries forward the assertion its spike already proved —
the spike tests are the template for the production tests:

| Production piece | Spike proof (carry forward) | Production assertion |
|---|---|---|
| .47 terminal-emit | .46 PR#775 claim 1 (mediation → reachedTerminal) + claim 2 (exactly-once across replay) | kernel `emitTerminal` drives `RuntimeContextSessionWorkflow` to TERMINAL; re-emit across a restart boundary = one terminal |
| .37 recover→host | .46 claim 2 DEPENDS on it (restart re-arm) | a domain-signal-parked body re-arms after a `FiregridHost` restart (not just live resume) |
| .35 cancel | .46 claim 1 (router thin, kernel exclusive) | cancel route → kernel → TERMINAL; router owns no lifecycle |
| .36 agent-completion | .46 F3 (same terminal-emit surface) | agent Terminated/TurnComplete → terminal → `deregister` fires (no process leak) |
| .45 wire emitter | .44 PR#773 F1 (durable toolUseId→sequence) + F2 (offset re-read across replay) | relayed ToolResult appended-exactly-once at a stable offset across restart |

**Carry-forward rule:** a production piece is not done until it re-greens its
spike's assertion against the real composition (not the workbench model).

## §8 Open decisions + follow-on

- **tf-r06u.48 (spawn handler) — Decision A vs B-await.** Coordinator-lean = **A**:
  add a non-legacy bounded spawn op + handle-shaped output `{childContextId,
  started}`; the agent awaits via `wait_for(session.agent_output)` (the .8
  authorized route). Buildable WITHOUT tf-c9r9 (no await-terminal). It's a public
  agent-tool contract change (ripples to client-sdk/projections). B-await keeps
  await-terminal but needs the unsolved domain-signal suspension. Either way the
  handler is the **shared unit** (§3) reached by .9's router + .28's mcp-host
  executor — build once.
- **tf-6jdb (upstream `@effect/rpc`).** Follow-on AFTER this cluster: push the
  single-response behavior upstream so `RpcServer.layerProtocolHttp` doesn't
  batch-wrap a lone non-batch response, retiring the .28 `MCP_TRANSPORT_COMPAT.1`
  workaround. Independent of the kernel cluster.

## Summary

Build the **recoverable foundation** (.47 + .37, adjacent) first, then the thin
producers/delivery shapes (.35, .36, .45) on top. Keep every shared unit
single-sourced (§3). Land all `FiregridHost` changes through one prescribed
composition sequence (§5) so the lanes converge instead of racing. Each piece
re-greens its spike's proof (§7). Gate the whole cluster on trunk-green; it then
lands fast and coherent.
