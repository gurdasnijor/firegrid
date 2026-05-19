# FINDING — tf-p7w: write-topology exonerated; reconciler-side visibility is the real locus (HARD HALT)

Status authority: bead `tf-p7w`. Sharpens `tf-4ni` (#393) and `tf-auk`
(#396). **HARD HALT** per dispatch HALT-RULE — sim left honestly RED, not
papered.

## What was tried (three faithful, independent mechanisms)

The directive localized the cause as "host agent-tool-seam control-request
rows do not propagate into the durable backing the reconciler queries;
the client context/start path to the same logical table does." Three
distinct write mechanisms were implemented and run end-to-end:

1. **tf-4ni** — raw `captured.controlTable.lifecycleRequests.insertOrGet`
   inside the tool-use activity. Sim RED, `lifecycle_request_count:0`.
2. **tf-auk (Option A)** — append forked onto a daemon fiber detached
   from the tool-use activity (`Effect.forkDaemon` + `Fiber.join`),
   committed off the activity. Sim RED, `lifecycle_request_count:0`.
3. **tf-p7w** — append through a **fresh client-EQUIVALENT
   `RuntimeControlPlaneTable.layer({ streamOptions: { url:
   runtimeControlPlaneStreamUrl({baseUrl, namespace}) } })`** in its own
   `Effect.scoped` — byte-for-byte the proven client write topology
   (same stream URL, same `insertOrGet`, `awaitTxId`-confirmed). Sim
   **RED, `lifecycle_request_count:0`**.

In every run the `firegrid.host.agent_tool.session_cancel` span is
**status success** with the correct `contextId`, the agent demonstrably
emits the `session_cancel` tool_use (`firegrid.runtime-context.tool.
lifecycle-1` span), and *in the same run* the reconciler sees
client-written `context_request_count:1` / `start_request_count:1`.

## Decision-grade conclusion: it is NOT the host-seam write

Replicating the client's exact durable-streams write topology (same
stream, same API, txid-confirmed, outside any activity) STILL does not
surface the row to the reconciler, while genuine client writes to that
same stream DO surface in the same process and run. The host-seam write
path is therefore **exonerated**. The divergence is reconciler/
materialization-side, not write-side.

Narrowed locus (for the next decision — NOT auto-resolved here): in the
standalone sim the client (`FiregridStandaloneLive`) and the host
reconciler each materialize their **own** `RuntimeControlPlaneTable`
instance over the same control-plane stream. A client-instance write is
ingested by the reconciler-instance as a fresh inbound stream event. An
in-process write performed through *any* table instance composed in the
host scope is **not** surfaced to the reconciler instance's materialized
view of `lifecycleRequests` — yet the *client* path's `contextRequests`/
`startRequests` writes are. The remaining unknown is why the
control-plane stream's `context`/`start` rows reach the reconciler
materialization while a `lifecycle` row written to the identical stream
URL does not: candidate causes are (a) a per-collection materialization /
subscription set on the reconciler's `RuntimeControlPlaneTable` that does
not include `lifecycleRequests` despite the schema/membership being
present, (b) a stream-name/encoding divergence for the new collection
vs the established ones, or (c) a materialization-loopback dedupe for
same-stream writes that the established collections avoid via their
client-origin. This requires a substrate-level investigation of
`DurableTable` collection materialization/subscription — it is a fresh
decision, not a Gap-3 seam tweak.

### Hypothesis (a) RULED OUT — collection IS materialized like the others

Checked: `DurableTable` derives its `collections` (per-collection facades
+ materialized view) directly from the `schemas` map.
`runtimeControlPlaneSchemas` lists `lifecycleRequests` alongside
`contextRequests`/`startRequests`; the reconciler's
`table.lifecycleRequests.query(...)` span runs (the collection exists and
is queryable). So this is **not** a missing per-collection registration /
subscription — `lifecycleRequests` is compiled and materialized by the
exact same mechanism as the working collections. That removes the only
"one-line fix" branch and confirms the blocker is substrate-deep:
candidate (c) — a materialization ingestion/loopback divergence for the
new collection's stream events vs the established client-origin ones —
which requires substrate-level investigation of `DurableTable` stream
ingestion, not a Gap-3 wiring change.

## Disposition

Substrate (protocol + reconciler arm) and the client-equivalent host
write are recorded as the candidate implementation (additive, typecheck
green) but **NOT shipped as proven** — sim honestly RED. No self-merge.
This PR is the HALT + sharpened-finding artifact. Recommended next step
(decision-owner, not auto-picked): instrument/inspect the reconciler's
`RuntimeControlPlaneTable` materialization for `lifecycleRequests`
specifically (subscription set + stream name) against the established
`contextRequests`/`startRequests` collections — the divergence is there,
not at the agent-tool seam.
