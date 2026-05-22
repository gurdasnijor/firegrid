# Runtime Shape Falsification — is the table-seam the right shape?

**Purpose.** `SDD_TARGET_TINY_FIREGRID_ARCHITECTURE_REFERENCE.md` asserts a shape: *channel → workflow-owned `DurableTable` → workflow state machine; no deferred mailbox, no request/claim/completion rows.* That shape **seems** right but is unproven on the hard cases (Phase-0A only proved a happy-path vertical). You cannot prove an abstraction "right"; you earn confidence by **attacking its hardest cases and watching whether it holds or needs a bridge.** This doc is that attack, grounded in real seams from the trace corpus.

**The fuzzy convergence target.** The table-seam is validated to the degree it expresses these hard cases **without a bridge**. Each hard case resolved = a unit of earned confidence; the first one that *needs* a bridge is the SDD's own stop-condition (§"Complexity Ground Rules") firing — and a cheap, decisive finding. Run them **in the clean-room reference**, hardest-first.

**How to run each:** extend the reference's `SessionTable` to the case, express the invariant as table-state-over-workflow, and watch for the **failure signal**. A "needs a bridge" failure = the implementation reaches for one of the SDD's forbidden symbols (`appendRuntimeInputDeferred`, `WorkflowEngineTable.deferreds`, a request/claim/completion row, a numbered input-deferred mailbox) to satisfy the invariant.

**Span families that = "a bridge was used"** (the instrument flags these as `bridge_debt`): `workflow_engine.deferred.result`, `host.runtime_input.deferred.append`, `host.runtime_context.input.{append_intent,dispatch_intent}`, `control_request.{claim,completion.read,reconcile_once}`, `activity.claim`.

---

## Risk-ranked hard cases (from the actual corpus)

### HC-1 — Mid-flight cancel/close  ·  **highest risk**
- **Seam (real ops):** `control_request.lifecycle.reconcile_once` (57× in tool trace), `control_request.claim`, `control_request.completion.read` — i.e. today cancel/close routes through the **request→claim→completion** family the SDD wants gone.
- **Invariant:** a cancel issued *while an input is being processed* transitions the session to `cancelling`/`closed` deterministically, observable by the caller, without losing or double-processing the in-flight input; replay-safe.
- **Table-state expression:** cancel is an `inputs` row of `kind:"cancel"` (or a `sessions.status` field); the workflow reads it at its transition point and updates `sessions.status`. Caller observes via the `sessions`/`events` row. No request/claim/completion.
- **"Needs a bridge" failure signal:** if cancel must **preempt** an in-flight activity (interrupt a long-running tool call mid-execution), a table row the body only reads at loop-top **cannot preempt** — you'd need a claim/interrupt signal. The SDD's loop model (`while(true){ read input; transition }`) is *cooperative*; **cooperative cancel is table-expressible, preemptive cancel is not.** This is the sharpest, most-likely-real boundary. **Decisive test:** cancel arriving during a long `tool_use.execute` — does it land cooperatively, or does correctness require interruption?

### HC-2 — Parallel tool calls / result-by-`toolUseId`  ·  **high risk (this is tf-jpcg)**
- **Seam (real ops):** `agent-tool-call.execute` (`tool-call.ts`), `host.agent_tools.tool_use.execute`, result delivered via `workflow_engine.deferred.result` (6,456× in the elicitation trace) — a numbered deferred mailbox.
- **Invariant:** a tool result returns to the exact caller that issued it (correlation by `toolUseId`), **exactly once** (at-most-once), with **N concurrent in-flight** calls, surviving replay.
- **Table-state expression:** a `toolCalls` table keyed by `toolUseId`: `{toolUseId pk, status: requested|running|done, result}`. Caller writes a `requested` row (`insertOrGet` = at-most-once); the workflow body reads unprocessed `requested` rows, executes, writes `done`+result; the caller reads its row **by key** for the result. Correlation = the primary key; concurrency = multiple rows; no deferred.
- **"Needs a bridge" failure signal:** if returning the result requires the caller to hold a **live deferred handle** (because the channel can't read the result row by key after the fact), **or** at-most-once under concurrent retries needs a **claim row** beyond `insertOrGet`. **This is the tf-jpcg adjudication:** if HC-2 expresses cleanly, tf-jpcg should be the `toolCalls`-table seam, *not* the "external await into the workflow" bridge. If it needs a claim/deferred, the SDD shape is incomplete for tool calls — a critical finding.

### HC-3 — `input.await` as a mailbox  ·  **medium risk**
- **Seam (real ops):** `runtime_context.workflow.input.await` + the bridge it rides: `host.runtime_input.deferred.append`, `input.append_intent`, `input.dispatch_intent` (elicitation trace).
- **Invariant:** the workflow receives its next semantic input in order, exactly once, replay-safe.
- **Table-state expression:** this is the SDD's *core* claim — replace `await input/N` with `inputs.rows()` filtered to `sessions.nextInputSequence` and a table cursor. The reference already sketches this.
- **"Needs a bridge" failure signal:** if ordinary input delivery still needs `appendRuntimeInputDeferred` / a numbered deferred to wake the body (rather than a table write + resume). This is the case the SDD is *most committed to* — if it fails here, the whole shape fails. Lowest novelty, but the load-bearing one.

### HC-4 — `wait_for` / `schedule_me` suspension  ·  **low risk (SDD pre-concedes)**
- **Seam (real ops):** `durable_tools.wait_store.wait.{find,upsert}`, `wait_for.upsert_active` (240×), `wait_router.complete_match` — note **`wait_store` is already a `DurableTable`**. Suspension itself is a deferred/`Effect.never` the router completes. **`schedule_me` is NOT in the corpus** (uncovered — see below).
- **Invariant:** durably suspend until an external event matches (`wait_for`) or a time arrives (`schedule_me`); survive restart; resume exactly once; **replay memoization** intact (the tf-7kq8/tf-aseo concern).
- **Table-state expression:** the wait *registration* and *match result* are `waits`-table rows (already true); only the **park** stays a deferred — and **the SDD explicitly allows deferreds for genuine suspended waits.** So the test is narrow: is the wait *state* table-expressed, with only the suspension being a deferred?
- **"Needs a bridge" failure signal:** if the wait *registration* (not the park) needs a numbered input-deferred rather than a `wait_store` row. Likely passes — but verify `input.await` (HC-3) isn't smuggling the registration through the mailbox.

### HC-5 — Child sessions  ·  **out of scope for Phase-0A (flag, don't block)**
- **Seam (real ops):** `runtime-context.session.start`, `session.send.runtime-input`, riding `host.runtime_input.deferred.append` + `append_intent` + `dispatch_intent`.
- **Status:** the SDD **explicitly defers** Host-to-child orchestration (Non-Goals). Child input currently routes through the deferred+intent bridge, and there is a **known capability gap** (no parent→child output channel — see `docs/investigations/2026-05-21-acp-parent-child-output-channel-gap.md`). So this is a **Phase-1 question, not a Phase-0A falsifier.** Record it; don't let it block the shape proof.

---

## Coverage honesty
- **`schedule_me` is uncovered by the corpus** — its workflow (`scheduled-prompt.ts`) was dark across all 3 scenarios. HC-4's time-delivery half is a hypothesis until a `schedule_me` capture exists. tf-sto7 already validated exactly-once future delivery *works*; the open question is whether it expresses as an `inputs` row with `deliverAt` + clock, vs. the current separate `ScheduledPromptWorkflow` (a `Workflow.make`, which `firegrid-no-unclassified-workflow-make` flags).
- HC-1 (cancel) and HC-5 (child) are **lightly** exercised here; capture a dedicated control-plane + multi-context scenario before trusting their verdicts (same §8 gap as the dynamics map).

---

## What each outcome means (the decision)

| Outcome | Reading |
|---|---|
| **All of HC-1..HC-4 express without a bridge** | The table-seam survived its hardest cases → "seems right" upgrades to "earned." Migrate production toward it with confidence; the shrink-loop's `N`↓ now has a trusted destination. |
| **HC-1 needs preemption (likely)** | The shape holds for cooperative flow but needs **one** added primitive for preemptive cancel. That's not "the shape is wrong" — it's "the shape + a named interrupt primitive." Add it to the SDD via its own stop-condition; don't bridge around it. |
| **HC-2 needs a claim/deferred** | The table-seam is insufficient for concurrent tool calls → **tf-jpcg must not ship as the bridge**, and the SDD needs a `toolCalls`-table + correlation primitive before `ToolCallWorkflow` can be deleted. |
| **HC-3 fails** | The core SDD claim fails — stop and redesign the whole reference. |

**The convergence target, stated fuzzily but usefully:** *the table-seam is the right shape iff HC-1..HC-4 each express as workflow-owned-table-state with at most one explicitly-named new primitive (and zero forbidden-symbol bridges).* Run them hardest-first; each pass earns confidence, each failure names the missing primitive. That is the most honest target available before committing the production migration.

---

## Related
- Shape under test: `docs/sdds/SDD_TARGET_TINY_FIREGRID_ARCHITECTURE_REFERENCE.md`
- Measurement: `docs/architecture/runtime-dynamics-map.md` (the seams), `runtime-shrink-loop.md` (the loop)
- Instrument: `scripts/runtime-flow-map.py` (`bridge_debt` classifier = the stop-condition detector)
