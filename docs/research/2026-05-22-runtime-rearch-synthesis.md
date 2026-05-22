# Runtime re-architecture — synthesis (Q5)

**Author:** OLA, synthesizing the four first-principles briefs (CC1–CC4). **Date:** 2026-05-22.
**Status:** research. **Observations and trade-offs only — no recommendations, no options, no sequencing.**
The architect decides what to do with this.

**Inputs (all source-verified, file:line):**
- Q1 — `docs/research/2026-05-22-rearch-Q1-workflow-input-requirements.md` (what the body needs from inputs)
- Q2 — `docs/research/2026-05-22-rearch-Q2-tool-call-requirements.md` (what the body needs from tool calls)
- Q3 — `docs/research/2026-05-22-rearch-Q3-engine-guarantee-boundary.md` (engine guarantees + boundary)
- Q4 — `docs/research/2026-05-22-rearch-Q4-substrate-guarantees.md` (substrate guarantees)

---

## 1. The one observation everything else follows from

The durable substrate is **two layers with different contracts**, and they are not interchangeable:

- **Stream layer** (Durable Streams): per-stream **total order**, server-assigned monotonic lexicographic **offsets**, gap-free/duplicate-free snapshot boundary, idempotent-producer exactly-once (Q4 §1–§2). This layer **is an ordered log.**
- **Keyed-state layer** (State Protocol → `DurableTable`): a **last-write-wins `key → value` map**. Events apply in stream order, but the projection **collapses history and discards arrival order** — `rows()` is primary-key-sorted, `ChangeEvent` carries no offset to the materializer, `Found` drops the offset (Q4 §3; Q1 `DurableTable.ts:99-101`). This layer **is a table, explicitly not a log** (Q4 §3.3).

The runtime re-architecture's input model requires **log** semantics. Q1 derives it cleanly from the consumer: the body awaits *exactly* `last+1` over a single cursor (`runtime-context.ts:823`), which requires a **total order (R1), dense gap-free ordinals (R2), point-addressable reads (R3), faithful arrival order (R4)** — i.e. "an arrival-ordered, dense, point-addressable append-log read" (Q1 §3). The proposed table-seam cutover builds that on the **keyed-state layer, which discards exactly the property (R4) being required.**

**The architect's hypothesis is confirmed at the requirements level: we are modeling an ordered-log need on a keyed-state primitive — and the substrate already contains the log we need, one layer down, with the exact ordering guarantee.** The order is not missing from the system; it is *discarded at the projection boundary the SDD chose.*

This is the answer to the triggering question ("are we making wrong assumptions about task processing?"): the load-bearing assumption is that workflow input / task delivery can be modeled as keyed table state. Task and input delivery are intrinsically a log; the assumption is the smell.

---

## 2. The intersection: what each facet needs × what each layer provides

| Need (Q1/Q2) | Stream layer | Keyed-state layer | Engine (Q3) |
|---|---|---|---|
| **Input: total + dense + arrival order, point-read** (R1–R4) | provides total order + offsets (Q4 §1) | **discards arrival order** (Q4 §3) | does not provide order; punts it below itself (Q3 §3) |
| **Input: idempotent / multi-author write** (R5/R8) | idempotent producer (Q4 §2) | PK dedup `insertOrGet` (Q4 §2) | n/a |
| **Input: durable replay cursor + wakeup** (R6/R7) | offsets are durable positions | point-`get`; cursor must be app-state | wakeup free & deferred-free (`Workflow.suspend`+`engine.resume`, **0 deferred rows**, Q3 §2) |
| **Tool result: correlate to caller by `toolUseId`, at-most-once** (Q2 R2/R3) | — | **PK point-get by `toolUseId` is exactly this** (identity, not order) | result is a memoized activity/row read |
| **Tool: durability** (Q2 R1) | — | — | durable only where the *lowering* suspends (3/11 tools, Q2 E6) |

Reading across the matrix, the facets split cleanly by what they actually need:

- **Inputs need the log** (order). The keyed layer can't give it; the stream layer can.
- **Tool results need identity** (`toolUseId` → result), which the keyed layer gives correctly. Tool calls do **not** need the ordering machinery at all.
- **Both** depend on engine guarantees that **stop short** of what either shape assumes (Q3 §3).

---

## 3. The "ordering crisis" is mostly a property of the proposed cutover, not the running system

Two findings combine to a non-obvious observation:

- Q4 §4: **all 13 `insertOrGet` call sites are identity-use** (PK dedup). The three that read past `_tag` inspect explicit row columns (`workerId`, `deadlineMs`, `payloadSha256`), **not** the missing offset. No running caller depends on table-arrival-order.
- Q1 §2: today, input order is supplied by **a single host-scoped serializer** (`RuntimeInputIntentDispatcherLive`, `runtime-context-workflow-runtime.ts:410-429`) plus a **deferred-scan allocator** (`appendRuntimeInputDeferred` computes `max(sequence)+1` by scanning, `runtime-input-deferred.ts:75-130`). Order comes from the serializer, **not the table.**

So the running system gets ordering from a single-writer serializer, and nothing in production reads order out of a `DurableTable`. The ordering problem surfaced (#654) **because the proposed cutover deletes the serializer and tries to recover order from the keyed projection** — which never carried it.

**Honest caveat (Q1 OQ1):** "the running system is fine" is too strong. The serializer path's *reconcile* branch orders by `createdAt` wall-clock (`runtime-context-workflow-runtime.ts:92-98`), which the tf-vrz6 STOP rejects as "not a reliable total order (skew/ties)" — and the SDD itself says cross-author ordering "must be tested explicitly," i.e. it is **currently untested**. So the cutover does not *invent* an ordering problem from nothing; it **removes a paper-over (single-writer + timestamp sort) that may itself be unsound, and forces the question into the open.**

---

## 4. The original D1 / D2 framings dissolve

The prior decision doc framed two problems: "D1 needs an ordering authority," "D2 needs a tool-call seam discriminant." The research dissolves both — they were the wrong shape of question.

**D1 ("ordering authority for inputs") dissolves.** There is no missing authority to *choose*: the per-stream append offset **is** a server-assigned total order (Q4 §1), and it already exists under every `DurableTable`. The question is not "pick an ordering authority"; it is **"do inputs live on the layer that has the order (the stream/log), or do we keep manufacturing order above a layer that discards it (the keyed table + a serializer)?"** Every escape route the cutover tried is a symptom of fighting the layer: P3-A recovers order from PK-sorted `rows()` (fails — tf-vrz6), P2 re-grows the serializer, P1/tf-i05u wants a CAS the substrate doesn't offer, P3-B re-surfaces the stream offset the table dropped (Q1 §3). All four are the same move: trying to put a log back on top of a table.

**D2 ("tool-call seam discriminant") dissolves differently — into two unrelated things.** Q2 shows the tool-result requirement is **identity-correlation by `toolUseId`** (R3), which the keyed layer serves correctly (point-get by key). Tool calls need **no ordering**. What's actually true of the tool path: (a) it's a **shape** problem — `ToolCallWorkflow` is "an accidental request/response mailbox dressed as a durable workflow" that over-provisions durability (only 3/11 lowerings suspend durably, Q2 E6), and (b) its fragility is **inherited from the owning body's output-read replay storm** (tf-7kq8, Q2 E7) — an *output observation* amplification, not a tool-input ordering problem. The "discriminant" question (`ToolUseRequest` vs `ToolUseObservation`, Q2 E5) is real but is a *contract* decision about who executes ACP tool calls in-body — orthogonal to the substrate-layer question.

---

## 5. The four distinct axes the D1/D2 framing conflated

The strongest structural observation: what looked like two decisions is **four independent axes**. Conflating them is why successive reviews kept finding bigger holes.

1. **Layer choice for inputs** — keyed-state vs ordered-log. (Q1, Q4 §3.) The substrate has both; the SDD picked the order-discarding one for an order-needing use.
2. **Engine atomic-write+resume and restart recovery** — *independent of axis 1*. Q3 §3: there is **no atomic "write-row-then-resume"** (writer does `insert` then *separately* `resume`; crash between → row durable, wakeup lost), and **table-row-waiting suspensions are NOT re-armed on host restart** (only clock wakeups are, Q3 §3.2). Whatever layer inputs live on, these engine gaps exist.
3. **Tool-call shape + at-most-once identity** — `toolUseId`-keyed result-return; needs identity, not order (Q2). Independent of axis 1.
4. **Output-read replay amplification** (tf-7kq8) — the body's output observation re-walks history O(resumes×history) (Q2 E7; Q3 §3 "bounded replay" gap). Both the tool path and any input path *ride on* this, but it is its own problem and its own fix (durable cursor / loop-state, tf-aseo/tf-q4uz).

D1 mashed axes 1+2; D2 mashed axes 3+4. They do not share a critical path, and three of the four (2, 3, 4) are **independent of the TABLE-vs-STREAM layer question** entirely.

---

## 6. Load-bearing open questions (none closed by this research)

In rough order of how much they could change the picture:

1. **Is per-context cross-author arrival order actually a product requirement, or an artifact?** (Q1 OQ.) R4 is asserted as "preserve today's semantics," but the SDD says cross-author ordering is **untested**, and the current reconcile path orders by wall-clock. **If cross-author arrival order is not a real requirement — if per-author FIFO with arbitrary cross-author merge suffices — the entire D1/axis-1 problem may be over-specified**, and a far weaker primitive serves. This single question can collapse or confirm the hardest part of the re-arch. It cannot be answered from code; it needs a product/semantics decision and probably telemetry on whether any consumer depends on interleaving (e.g. permission-response vs prompt).
2. **Is the per-stream append offset monotonic under *concurrent* producers, or only per-producer?** (Q1 OQ, Q4 OQ3.) `appendWithProducer` uses `epoch=0, seq=0` (`DurableTable.ts:521-522`). P3-B's viability — and any "inputs on the stream layer" path — depends entirely on this, and **it was not verified** by the research. Q4 also flags the `Duplicate` 204 offset is ambiguous (frontier vs original write position) and unverified against the server.
3. ~~The local uncommitted `DurableTable.ts` edit drops `Inserted.offset`.~~ **CORRECTED — not real.** This was a stale-checkout artifact: CC4 read this checkout's working tree, which is 17 commits behind origin and predates **#658 (tf-qtfb)** — the PR that *added* `Inserted.offset`. On `origin/main` the offset **is present and intact** (`InsertOrGetResult` line 100, impl `:812`); the working tree is clean (no edit). The escape hatch was deliberately added, not removed — optionality for axis 1 is preserved. (Lesson: CC4 and this synthesis were drafted from a checkout behind origin; the substantive Q4 findings — 13/13 identity-use, the TABLE-vs-STREAM distinction — are unaffected, but verify offset-field claims against `origin/main`, not this tree.)
4. **Engine: atomic append+resume and suspension-recovery-on-restart** (Q3 OQ1/OQ2) — needed regardless of axis 1; currently absent.
5. **Must tf-7kq8 (bounded output replay) land before routing tool calls through the owning body?** (Q2 OQ3.) Routing results through a replay-storming body inherits the hang.
6. **`wait_for_any` is in-memory `Effect.raceAll`, not durable, today** (Q2 E6 / tf-0xe4) — lost on restart even now; in the blast radius but independent.

---

## 7. What this research could not reach

- **Intent of the original keyed-table input bet.** Whether the SDD chose `DurableTable` for inputs deliberately (knowing it discards order, planning to re-surface the offset) or by analogy to resource-state. Named, not guessed.
- **Production telemetry** on whether cross-author input interleaving is ever observed/depended-on (OQ1) — the most decision-relevant unknown, and unreachable from source.
- **Server-side offset semantics under concurrency** (OQ2) — requires a probe against the Durable Streams server, not type-reading.
- **Whether `effect-durable-streams` `Reader` can expose per-item offsets to a workflow body** at the granularity inputs-as-log would need: Q4 §1 found `Reader.read` returns decoded values without per-item offsets (offsets surface at batch/snapshot boundary only) — so "inputs on the stream layer" may itself require a reader change. Not investigated in depth.

---

## Bottom line (observation, not recommendation)

The system is using a keyed-state materialized view (a ksql-style TABLE) for two needs of different shape: **input/task delivery, which is intrinsically an ordered log** (the substrate has the log; the projection discards its order), and **tool-result correlation, which is intrinsically keyed identity** (the projection serves it correctly). The "ordering crisis" is the collision between the log-shaped need and the table-shaped layer the cutover targets — surfaced, not caused, by removing the single-writer serializer that currently papers over it (possibly unsoundly). The two prior decisions were four axes; only one of them is the TABLE-vs-STREAM layer question, and the most decision-relevant fact — whether cross-author arrival order is even a real requirement — is unverified and unanswerable from code.
