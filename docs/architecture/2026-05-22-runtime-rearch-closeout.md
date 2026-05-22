# Runtime re-architecture — close-out: what's settled, what's actionable, what to simulate

**Date:** 2026-05-22. **Supersedes** the "two blocking decisions" framing (dead) and is the action layer over the synthesis (`2026-05-22-runtime-rearch-synthesis.md`) + the four briefs (`rearch-Q1..Q4`). **Discipline:** every remaining unknown is paired with a `packages/tiny-firegrid` simulation that settles it empirically — no decisions made blind.

---

## 1. Settled (evidence, not inference)

| Finding | Status | Evidence |
|---|---|---|
| **Cross-author input arrival order is an artifact, not a requirement** | settled (code) | body forwards every input independently; the only correlation (permission) is id-keyed and order-*insensitive* both directions — `runtime-context.ts` `transitionInputEvent:632-666` / `transitionOutputEvent:679-690`; `author` is never read anywhere |
| **A context can hold >1 unprocessed input** (ordering not vacuous) | settled (code) | ungated `insertOrGet` writes + serial drainer `runMergedEventLoop:907-940`; the dense-sequence+cursor design presupposes a queue |
| **…but the body imposes no ordering requirement** | settled (code) | same transition evidence; order-sensitivity exists only at the *agent* boundary |
| **Substrate: per-stream total order + offsets + idempotent dedup** | settled (conformance) | `effect-durable-streams` passes the upstream producer/ordering/idempotent conformance cases (autoclaim, multi-producer, concurrent-requests, sequence-validation); local `test/conformance/` corroborates |
| **`insertOrGet` at-most-once seam is clean** | settled (code+conformance) | all 13 sites are identity-use (PK dedup); the 3 reading past `_tag` read explicit columns, not the missing offset (Q4 §4) — and PK-dedup *is* the conformance-verified idempotent producer |
| **`Inserted.offset` "regression"** | non-issue | a stale-checkout phantom: #658 *added* the offset on `origin/main`; it is intact (Q4 OQ1 corrected) |

**The headline:** the substrate is two layers — an ordered **stream** (has total order, conformance-proven) and a keyed **table** (last-write-wins, discards arrival order). We were modeling an input need on the table and trying to recover an order **that the body doesn't actually require.** The "ordering authority" problem was solving a non-requirement.

---

## 2. The four axes — actionable

The "two decisions" were four independent axes. Three need no decision; one does.

### Axis 1 — inputs → **collapsed to the simplest shape**
No ordering authority required. Inputs live on the keyed table; the body `Workflow.suspend`s and consumes (consumption order is irrelevant to the body — proven). The residual is **weak per-source FIFO at the agent boundary** (many cheap solutions; a design detail, not a blocker) and **cancel/interrupt semantics** (HC-1, a separate lifecycle path).
- **Bead moves:** unblock `tf-vrz6 → tf-9rpy` with the plain table-consume shape (no serializer, no arrival-order). **Close `tf-qtfb` / P3-B / the append-offset-recovery line as solving a non-required problem** — the tf-vrz6 STOP is resolved by *retiring the requirement*, not by a substrate change.

### Axis 2 — engine durability → **the one genuine open design call**
A suspended body can miss durable work: write-row and `engine.resume` are two steps with no transaction (crash between → input durable, wake-up lost), and table-row-waiting suspensions are **not** re-armed on restart (only clock wakeups are) — Q3 §3. Independent of axis 1; applies whatever shape inputs take. **This is the only thing that needs deciding — and §3 turns it into a measured choice, not a blind one.**

### Axis 3 — tool calls → in flight, shape known
Tool-result correlation is **identity** (`toolUseId` point-get), which the table serves; `ToolCallWorkflow` is the wrong shape (over-provisioned durability — only 3/11 lowerings suspend, Q2 E6). `tf-jpcg` is building the in-body seam. **Bead move:** continue; gate `ToolCallWorkflow` deletion (`tf-vfq9`) on the seam existing.

### Axis 4 — output-read replay storm → in flight, independent
tf-7kq8: O(resumes×history) re-walk; the proximate cause of live-edge timeouts. `tf-aseo`/durable-cursor track. **Bead move:** continue; highest reliability impact, unrelated to ordering.

**`N` reduction comes from axes 3+4** (delete `ToolCallWorkflow`, fix replay) — neither blocked. Axis 1 unblocks trivially. Only axis 2 needs a call.

---

## 3. Remaining unknowns → the simulation that settles each

Per the tiny-firegrid method: build a sim, get empirical data, verify/falsify. Each open item below maps to a sim (new or an extension of an existing one).

### S1 — durability gap (axis 2) · **highest value** · new sim `input-suspend-crash-recovery`
Falsify/confirm the gap CC3 inferred from code, then measure candidate fixes.
- **Setup:** real `DurableStreamsWorkflowEngine`; a body that `Workflow.suspend`s waiting on a workflow-owned input row (the tf-e5rf shape).
- **Probe A (crash between write and resume):** write the input row, then crash/drop the process *before* `engine.resume`; reconstruct the engine; **assert** whether the body ever processes the input. Expected falsification target: "input is durable but silently never processed."
- **Probe B (restart while parked):** suspend the body, restart the engine with the input row already present; **assert** whether the body is re-armed without a new external write.
- **Then A/B the fixes in the same harness:** (i) an atomic append-and-arm primitive, (ii) a restart "pending-suspension recovery sweep," (iii) kernel-owned writer owning both halves. The sim turns the architect's axis-2 decision into "pick the variant that's GREEN."
- Note: `tiny-input-append-wakeup` proved the *happy-path* wakeup only (and on the superseded write-time-sequence shape, Q1) — it does **not** exercise crash/restart. This sim is the missing half.

### S2 — axis-1 collapse confirmation · extend `target-architecture-reference`
Prove the simplest shape is sufficient *without* any ordering machinery.
- **Setup:** body suspends + PK-consumes its owned input table; **no serializer, no arrival-order, no append-offset.**
- **Feed the realistic input set:** a prompt; a permission-response that arrives *before* its request; a scheduled self-prompt (author=`workflow`); a second same-source prompt.
- **Assert:** all handled correctly; permission pairs by id regardless of arrival; **no dropped or mis-applied input.** GREEN ⇒ axis-1 collapse confirmed empirically (cross-author order genuinely unneeded).

### S3 — per-source FIFO at the agent boundary · extend `acp-tool-elicitation` (live, env-gated)
The weak residual: does the agent's behavior depend on same-source input order?
- **Setup:** the live ACP harness with prompt-queueing; deliver two same-source prompts.
- **Assert:** whether output differs by delivery order. If it does, per-source FIFO is real (and cheaply satisfiable); if not, even per-source order is moot. Low priority (weak either way), but settles it with real-agent data rather than assumption.

### S4 — cancel/interrupt semantics (HC-1) · new sim `cancel-midturn`
- **Setup:** drive a context with a prompt (turn in flight), then a cancel concurrently.
- **Assert:** the cancel applies cooperatively and the outcome is deterministic; confirm whether cancel rides the input cursor or a separate lifecycle path (the 5-min classification, settled behaviorally). Determines whether cancel ordering is an input concern or a lifecycle concern.

### S5 — tool-result identity roundtrip (axis 3) · existing `tool-result-roundtrip` / `tf-jpcg`
Already in the seam work: assert `toolUseId`-keyed result-return is at-most-once + replay-safe via the in-body seam, *without* a per-call `ToolCallWorkflow`. Confirms axis-3's shape empirically.

---

## 4. The single decision left for the architect

**Axis 2's mechanism** — and even that is now empirical: run **S1**, see whether the gap is real (it almost certainly is), and pick the variant (atomic-append-and-arm / recovery-sweep / kernel-owned-writer) that comes back GREEN under crash + restart. Everything else is either settled or in flight.

## 5. Bead-level summary
- **Unblock:** `tf-vrz6 → tf-9rpy` with the plain table-consume input shape.
- **Close as non-required:** `tf-qtfb` / P3-B append-offset-recovery (solving an ordering need that doesn't exist).
- **Build:** `input-suspend-crash-recovery` (S1) — the axis-2 decider; extend `target-architecture-reference` (S2) — the axis-1 confirmation.
- **Continue:** `tf-jpcg` (axis 3), `tf-aseo`/tf-7kq8 (axis 4).
- **Retire:** the "two blocking decisions" doc — wrong-shaped, superseded by this.

## Sources
- `docs/research/2026-05-22-runtime-rearch-synthesis.md` + `rearch-Q1..Q4`
- `runtime-context.ts` `transitionInputEvent`/`transitionOutputEvent`/`runMergedEventLoop` (origin/main)
- `effect-durable-streams/test/conformance/` + upstream producer/idempotent conformance cases
- Q3 §3 (engine guarantee boundary); `tf-e5rf`/#651 (wakeup proven); tf-vrz6 STOP (#654)
