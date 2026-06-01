# tf-r06u.46 — HostKernel cancel-mediation spike: the kernel emits the terminal signal

Date: 2026-06-01
Owner: tf-r06u.46 (Agent2 / lane-b), workbench spike (carries forward tf-c8cy's validation goal on the unified substrate)
Branch: sidecar/tf-r06u.46-hostkernel-cancel-spike (off origin/sim/unified-kernel-validation)
Evidence: `packages/tiny-firegrid/test/hostkernel-cancel-mediation/cancel-mediation.test.ts` (2/2 green)
De-risks: tf-r06u.35/R2 (cancel/close control plane + HostKernelWorkflow) + the production wire-path/control-plane cutover. Relates: tf-r06u.36 (terminal relay), tf-r06u.45 (emitter cutover), tf-r06u.44 (emitter durability — the dual).

## What was probed

`kernel-owned-write-arm.md`: "there is no concrete `HostKernelWorkflow` today" — it's a target ROLE (a host-side serialized controller that exclusively owns RuntimeContextWorkflow lifecycle). This spike builds the narrowest concrete instance on the unified substrate and proves the MEDIATION: a kernel-mediated control plane drives a per-context `RuntimeContextSessionWorkflow` to TERMINAL on a cancel/close signal, with the router a thin dispatch-intent edge.

## Findings

### F1 — Kernel-mediated cancel reaches TERMINAL via the EXISTING terminal path (mediation, not a new terminal)

The unified `RuntimeContextSessionWorkflow` body already reaches TERMINAL on an `input.kind === "terminal"` (`runtime-context.ts:124`). The spike's `HostKernelCancelWorkflow` (a long-running, idempotency-keyed exclusive owner) consumes a `CancelIntent` and, via the kernel-owned write+arm (`sendSignal` = write the workflow-owned signal row + `resume`), **emits that existing terminal input** to the target session workflow's executionId. The session wakes, consumes it, reaches TERMINAL.

The router/driver is a thin dispatch-intent: it `sendSignal`s the `CancelIntent` to the kernel and owns NO lifecycle. **Exclusive ownership is structural** — the kernel emits the terminal; the per-context session workflow never self-terminates. This is the litmus from the control-plane direction: lifecycle/exclusive-ownership ⇒ model as a workflow, router stays decode/authorize/dispatch-intent.

**Proven (claim 1):** a kernel-dispatched cancel drives the session workflow to `reachedTerminal: true`, `inputsConsumed: 1` (exactly the kernel-emitted terminal).

### F2 — Exactly-once cancel across a replay boundary (the dual of .44)

Re-running over the SAME durable streams + ids (a fresh engine + tables = a restarted process) and re-dispatching the same cancel reaches TERMINAL **exactly once** — `inputsConsumed` unchanged, result identical. The mechanism is durable signal identity: `sendSignal` is `insertOrGet`-keyed on `(executionId, name)` (`signal.ts:133`), and the kernel emits the terminal under a DETERMINISTIC name keyed on the target identity (`kernel-terminal:<ctx>:<attempt>`). So a re-delivered cancel — at both layers (the intent to the kernel, and the terminal to the session) — dedups. Plus the session workflow's `idempotencyKey` memoizes the terminal result.

This is the **dual of tf-r06u.44's emitter durability finding**: there, a relayed ToolResult needs a durable `toolUseId→sequence` identity to be appended-exactly-once; here, a kernel-emitted terminal needs a durable target-keyed signal identity to be delivered-exactly-once. Both: durable identity, not volatile state, is what makes the control/relay action replay-safe (the kernel-owned write+arm / tf-c9r9 shape).

**Proven (claim 2):** replay (rebuild over the same streams) → `reachedTerminal: true`, `inputsConsumed: 1`, result identical to the first pass.

### F3 — SHARED terminal-emission mechanism for .35 (cancel) and .36 (agent-completion)

This spike proves the kernel can **emit** the terminal signal. That is precisely what the R3/.36 audit found **nothing emits today** — the unified session body parks on `readSignalsFor`/`Workflow.suspend` forever unless a terminal input arrives, and (pre-this-work) no producer sends one. So there are **two producers of the SAME terminal input**:

- **cancel/close-driven** (this spike / tf-r06u.35/R2): the kernel emits `terminal` on a cancel signal.
- **agent-completion-driven** (tf-r06u.36 terminal relay): the codec/agent turn-complete emits `terminal` when the agent finishes.

**Recommendation:** .35 and .36 should SHARE one terminal-emission mechanism (the kernel-owned write+arm that emits a `terminal` `SessionInputPayload` keyed by target identity), not build two. The producer differs (cancel intent vs agent completion); the emit + its durable identity + the consumed terminal path are identical. Building it once in the kernel/controller keeps a single durable terminal-emit surface (and a single exactly-once guarantee).

### F4 — Shape C/D + the supersession of tf-c8cy's blocker

The control plane is a workflow (claims/lifecycle/exclusive-ownership ⇒ workflow). The kernel-owned write+arm is Shape C (durable signal-row identity) armed by `resume`. tf-c8cy (the prior validation slice) was blocked NOT by D1 but by a 2026-05-21 Phase-0A sequencing constraint (Host→Child orchestration deemed ahead of the channel→table→read seam, pre-#765/origin-main, #602 parked unmerged). #765 has since landed the unified substrate; this spike validates the same goal natively on it. #602's `host-kernel.ts` is a SHAPE reference only (pre-unified composition) — this is built fresh.

## Triage

Category 2 (implementation gap, informs design): the cancel/close control plane (tf-r06u.35/R2) needs a host kernel/controller that emits the terminal input via the kernel-owned write+arm with durable target-keyed identity; it should be the SAME terminal-emission surface tf-r06u.36 uses for agent-completion. Production cutover gated on the trunk green-up + the kernel-owned write+arm landing (tf-c9r9 shape); new-files-first, host wiring deferred (per Agent4's .8/.9 pattern).

## Methodology note

Workbench proof: a tiny-firegrid sim scenario (`src/simulations/hostkernel-cancel-mediation/`) composes the REAL unified `RuntimeContextSessionWorkflow` + the spike kernel + a fake codec adapter on a real `DurableStreamsWorkflowEngine`; the test imports only the scenario (runtime internals stay behind it — R3 dep-cruise clean). A public-surface client-sdk-driven sim + OTel trace is a follow-up once the cancel route + kernel land in the protocol/host surface.
