# Q4 — Substrate guarantees: what Durable Streams / State / DurableTable actually promise

**Author:** CC4 (first-principles research brief, 1 of 4 feeding the runtime re-architecture doc)
**Date:** 2026-05-22
**Status:** research input — does not block

This brief pins down, from primary sources, the *guarantees the substrate gives* vs. *the guarantees callers assume*. The headline: the substrate gives **per-stream total order + offsets** at the stream layer, but the **keyed projection layer (State Protocol / DurableTable) deliberately throws arrival order away** — it is a last-write-wins key→value map. Every production `insertOrGet` caller is using it for *identity* (PK dedup), and none depends on the discarded ordering. The seam is clean today; the risk is future callers mistaking a `DurableTable` for an ordered log.

---

## 1. Stream guarantees (the base layer)

Source: `packages/effect-durable-streams/src/{Reader,Writer}.ts`, `@durable-streams/client` README + `reading-streams` SKILL, conformance tests under `packages/effect-durable-streams/test/conformance/`.

- **Per-stream total order (FIFO append==read).** Items read back in append order. Pinned by `smoke.test.ts:30` *"creates a stream, appends, and collects"* (alice@0, bob@1) and the live tests `live.test.ts:27/59` (long-poll and SSE both deliver `[0,1,2]` in order).
- **Server-assigned, monotonic, lexicographically-sortable offsets.** Offsets are an `X_Y` zero-padded string form (e.g. `1_0`, `5_42`) returned in the `stream-next-offset` response header (`classified-producer-append.test.ts:67`). They advance monotonically; reconnect resumes from the *updated* offset, never the original (`sse-edge-cases.test.ts:195`).
- **Resumable + gap-free/duplicate-free snapshot boundary.** `Reader.snapshotThenFollow` captures the terminal offset of catch-up and resumes `live` from exactly there, so a concurrent append lands in `snapshot` xor `live`, never both/neither. Pinned by `live.test.ts:90` *"snapshotThenFollow is gap-free AND duplicate-free under concurrent appends"* (20 seed + 20 concurrent = 40 exactly-once) and `live.test.ts:151`.
- **What the base layer does NOT promise:**
  - **No cross-stream ordering.** Every conformance test isolates one stream URL; total order is *per stream* only. There is no global clock across streams.
  - **The Effect `Reader.read` does not expose per-item offsets.** It returns `Stream.Stream<A>` of *decoded values* (`Reader.ts:16`). Offsets surface only at batch granularity in the raw client subscriber (`batch.offset`) and at the snapshot/live *boundary* (`snapshotThenFollow` → `finalOffset`). A consumer that needs each item's offset must use the raw client batch API, not the Effect wrapper.

## 2. Dedup guarantees (exactly-once writes)

Source: `Writer.appendWithProducer` (`Writer.ts:74`), `IdempotentProducer` (client README), `classified-producer-append.test.ts`.

- **Idempotent producer = exactly-once on `(producerId, producerEpoch, producerSeq)`.** First append to a tuple → HTTP 200 → `{_tag: "Appended", offset}`. A replay of the same tuple → HTTP 204 → `{_tag: "Duplicate", offset}`; the server writes nothing. Pinned by `classified-producer-append.test.ts:35` (*"first producer append returns Appended and duplicate returns Duplicate"*) and `live.test.ts:187` (*"survives restart with overlapping seqs (server dedupes)"* — epoch0 seq0/1 dropped, seq2/3 written, read `[0,1,2,3]`).
- **Epoch fencing:** HTTP 403 → `StaleEpoch`; out-of-order seq → HTTP 409 → `SequenceGap` (`Writer.ts:95-108`). So the producer also rejects gaps, not just duplicates.
- **DurableTable layers PK dedup on top of this.** `insertOrGet` derives a deterministic `producerId = "durable-table:<durableType>:<hex(encodedKey)>"` with `epoch=0, seq=0` (`DurableTable.ts:504-543`, `appendInsertWithPrimaryKeyFence`). The first writer of a primary key wins (`Appended` → `Inserted`); every subsequent writer of that key gets `Duplicate` → `Found`. This is **at-most-once-per-primary-key identity**, explicitly *"not a lock, claim, mutex, semaphore, lease, or general coordination primitive"* (`DurableTable.ts:120-123`). Convergence under contention is pinned by `durable-table.test.ts:398` (*"concurrent insertOrGet … converge across at least 20 races"* — exactly one `Inserted`) and `:474` (*"never silently overwrites an existing row"* — `Found` returns the *winner's* row, not the loser's proposal: `:437`).

## 3. State-materialization guarantees — and what they are NOT

Source: `STATE-PROTOCOL.md` §6, `@durable-streams/state` `dist/index.d.ts` (`MaterializedState`, `ChangeEvent`, `Operation`).

The State Protocol is a **change-event vocabulary** (`insert`/`update`/`delete`/`upsert`, keyed by `type`+`key`) materialized into an in-memory **`type → (key → latest value)` map** (`MaterializedState` class, `index.d.ts:71`; `apply`/`applyBatch`/`get`/`getType`).

- **Guaranteed:** events are applied **in stream order** (§6.1), so the materialized value for a key is **last-write-wins** by stream position. Read-after-write within a handle is consistent once `awaitTxId(txid)` resolves (`DurableTable.ts:375`, pinned by `durable-table.test.ts:536`). Action sequencing survives cold-start replay (`:204`).
- **Explicitly NOT guaranteed:**
  1. **No offset on the row.** `MaterializedState` stores `key → value` only; there is no per-row arrival position. On origin/main `insertOrGet` returns the append `offset` on the **`Inserted`** branch (the row's arrival sequence at first write), but **`Found` carries no offset** — the comment at `DurableTable.ts` ~819-825 (origin/main) is explicit: *"the duplicate (idempotent-fenced) response reports no append position (it wrote nothing), and the winning row's original arrival offset is not stored on the row. Callers that need the original arrival order must capture the Inserted offset at first write."* (Note: the local working tree has an in-progress edit that drops the `offset` from `Inserted` entirely — see Open Questions.)
  2. **No cross-key arrival ordering.** The map collapses history; you cannot ask "which key was created first" from the projection. `rows()` emits via `subscribeChanges` in *materialization/update* order with `includeInitialState` (`DurableTable.ts:722-752`), not a replay of stream-arrival order, and skips deletes/null values.
  3. **No temporal/event-log semantics.** `update`/`delete` mutate the single live value; prior values are gone unless an explicit `old_value`/column carries them. A `DurableTable` is a **table**, not a **log**.

## 4. Dependency check — the `insertOrGet` call sites (identity vs ordering)

I classified every production caller. The question for each: does it rely on **PK dedup identity** (fine) or on **arrival ordering** (which the keyed table does not provide)?

| Site (`packages/…`) | Table | Uses result for | Verdict |
|---|---|---|---|
| host-sdk `host/agent-tool-host-live.ts:488` | lifecycleRequests | discards (`asVoid`) | identity |
| host-sdk `host/commands.ts:121` | inputIntents | `Found?row:intent` | identity |
| protocol `launch/host-context-request-binding.ts:28` | contextRequests | discards | identity |
| protocol `launch/host-control-request.ts:72` | inputIntents | `Found?row:stamped` | identity |
| protocol `launch/host-control-request.ts:160` | startRequests | `_tag==="Inserted"` → ack bool | identity |
| runtime `agent-event-pipeline/authorities/scheduled-prompt-append.ts:41` | inputIntents | discards | identity |
| runtime `agent-event-pipeline/sources/sandbox/supervisor-commands.ts:50` | stdinEmissionClaims | `Inserted→true / Found→false` | identity |
| runtime `authorities/runtime-control-plane-recorder.ts:122` | controlRequestCompletions | `Found?row:row` | identity |
| runtime `authorities/runtime-control-plane-recorder.ts:241` | contexts | `Found?row:ctx` | identity |
| runtime `channels/session-permission.ts:54` | inputIntents | `row.intentId` | identity |
| runtime `verified-webhook-ingest/adapter.ts:414` | verifiedWebhookFacts | `Found` → compare `row.payloadSha256` | identity (column compare) |
| runtime `workflow-engine/internal/engine-runtime.ts:63` | activityClaims | `claim.workerId === workerId` | identity (column compare) |
| runtime `workflow-engine/internal/engine-runtime.ts:483` | clockWakeups | `Found` → read `existing.status/deadlineMs` | identity (column compare) |

**All 13 sites are identity-use.** The three that read more than `_tag` (`activityClaims`, `clockWakeups`, `verifiedWebhookFacts`) inspect **explicit, durably-stored row columns** — `workerId`, `deadlineMs`/`status`, `payloadSha256` — *not* the missing arrival offset:

- **activityClaims** (`engine-runtime.ts:69-79`): PK fence elects exactly one winner; the caller learns "did I win?" by comparing the stored `workerId` column. This is the textbook-correct use of `insertOrGet`. No offset needed.
- **clockWakeups** (`:484-490`): `deadlineMs` is host-computed at write time (`nowMs + duration`, `:480`) and stored as a **column**; the `Found` branch reads that column to decide whether to reschedule. It is reading data, not arrival order.
- **verifiedWebhookFacts** (`adapter.ts:425-442`): compares the stored `payloadSha256` column to distinguish a true idempotent duplicate from a key-collision-with-different-payload (`Conflict`). Content conflict-detection, not sequencing.

**Conclusion: the seam is clean.** No production caller depends on the arrival-ordering property that the keyed table fails to provide. (An earlier automated pass mis-flagged the latter three as "ordering-use"; direct source reading shows they read row columns, which is exactly what a key→value table is for.)

## 5. Open questions

1. **Local working-tree edit drops the `Inserted.offset`.** Origin/main returns `{_tag:"Inserted", offset}`; the uncommitted local `DurableTable.ts` returns bare `{_tag:"Inserted"}`. If the re-arch wants "capture arrival offset at first write" as the *sanctioned* way to get ordering from a keyed table, that capability is being removed. **Decide before merge:** is `Inserted.offset` part of the supported contract, or is the table strictly identity-only? No current caller reads it (§4), so dropping it is safe *today* — but it forecloses the documented escape hatch.
2. **No conformance test pins "Found carries no offset" / "no arrival order on rows".** §1–§3 negatives are inferred from types + comments, not asserted. A negative test (e.g. *"rows() does not reflect stream-arrival order across keys"*) would make the seam a tripwire instead of a footgun for future callers.
3. **`Duplicate` offset ambiguity.** `Writer.appendWithProducer` returns `{_tag:"Duplicate", offset: res.nextOffset}` (`Writer.ts:93`), but the `DurableTable` comment asserts `result.offset` is *empty* on the duplicate path. Is `nextOffset` the current frontier (not the original write's position) or genuinely empty on a 204? Worth confirming against the server before any code trusts a `Duplicate` offset.
4. **If the re-arch needs an ordered, replayable control log** (e.g. for the HostKernelWorkflow control plane), it must use a **stream** (`Reader.read` + per-batch offset) directly, not a `DurableTable`. The table is the right primitive for "exactly one row per key"; it is the wrong primitive for "the sequence of things that happened."
