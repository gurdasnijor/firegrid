# tf-0awo.31.1 — cap-3 proof: idempotent one-intent → one-participant (post-§12)

**Bead:** `tf-0awo.31.1` (parent `tf-0awo.31`, cap-3) · **Sim:** `comp-sim-idempotent`
**Surface under test:** `firegrid.sessions.createOrLoad` (public client) — factory-vision §7.3
**Re-establishes:** the retired `idempotent-one-intent-pipeline` sim (`tf-mbm`, commit `69a275cab`), in the current methodology (no in-sim verdict; trace + prose finding).
**Run:** `.simulate/runs/2026-06-02T13-36-01-054Z__comp-sim-idempotent/trace.jsonl`
(external ticket ids are per-run UUIDs; the invariant is the collapse pattern — 8 deliveries → 3 distinct participants, the same-key 6 collapsing to 1.)

## Capability

"Map one external intent to one participant." A consumer maps a verified external
`[source, id]` to a durable participant via `createOrLoad`. The redelivery-safety
the §6 choreography relies on: the SAME external intent arriving more than once
(redelivery / retry / operator replay) must collapse to exactly ONE participant,
while a DIFFERENT key stays distinct (a ticket arriving twice must not spawn two
planners).

## Method (public surface only, real host, no backdoor)

`driver.ts` imports `@firegrid/client-sdk` only; `host.ts` is the real
`FiregridHost({ codec: "acp" })` from `@firegrid/runtime/unified`. The driver
issues `createOrLoad` for: the first delivery, a redelivery, **4 concurrent**
replays of the same key, a different entity, and the same entity id under a
different source. start() is never called — this is participant *mapping*, not a
run. The trace is the deliverable: each call emits a
`firegrid.client.session.create_or_load` span with `external_key.*` +
`firegrid.context.id`, plus one summary span of the resolved ids. The sim
computes no verdict.

## Trace evidence (8 `create_or_load` calls)

| external `[source, id]` | resolved participant `contextId` |
|---|---|
| support-desk / TCK-744fa30e… (delivery 1) | `session:support-desk:TCK-744fa30e…` |
| support-desk / TCK-744fa30e… (redelivery) | `session:support-desk:TCK-744fa30e…` |
| support-desk / TCK-744fa30e… (×4 concurrent replays) | `session:support-desk:TCK-744fa30e…` (all four) |
| support-desk / TCK-OTHER-618e648d… | `session:support-desk:TCK-OTHER-618e648d…` |
| billing-desk / TCK-744fa30e… | `session:billing-desk:TCK-744fa30e…` |

## Finding — §7.3 redelivery-safety holds over the public surface

- **Same key → one participant (idempotent), incl. concurrency.** All **6**
  deliveries of `support-desk / TCK-744fa30e…` (first + redelivery + 4
  *concurrent* replays) resolved to the **identical** participant contextId. A
  redelivery/retry/replay storm collapses to one participant.
- **Different entity → distinct participant.** `TCK-OTHER-…` mapped to its own
  contextId, distinct from the first — no over-collapsing.
- **Key is the `[source, id]` pair.** The same id `TCK-744fa30e…` under
  `billing-desk` mapped to a *distinct* `session:billing-desk:…` — no
  cross-source collision.

The participant identity is the public-surface observable (`handle.contextId`),
and it is stable across redeliveries. The single-durable-row guarantee behind it
is the host-owned `HostSessionsCreateOrLoadChannel` deriving a deterministic
`session:${source}:${id}` and writing via `contexts.insertOrGet`
(`channels/host-control.ts`) — keyed on that contextId, so repeated deliveries
upsert one row. The public surface never exposes a way to split one external key
into two participants.

## Epistemic tiers

- **Sim-confirmed (this run):** the six same-key deliveries (incl. 4 concurrent)
  resolve to one contextId; the two distinct keys resolve to two further
  distinct contextIds. Reproduced over the real host, not asserted.
- **Substrate (source, not re-proven here):** that one contextId == one durable
  row is `insertOrGet`'s primary-key idempotency; this sim proves the *public*
  contract (stable participant id per key), which is what the §6 choreography
  consumes.

## Triage

cap-3 capability proof — supports the §6 choreography's redelivery-safety
precondition. Not a defect. The sim is a standing regression instrument: if a
future change let the same external key resolve to two contextIds, the recorded
`participant.*` ids would diverge in the trace.
