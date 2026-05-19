# FINDING — tf-7y3: no modern PUBLIC surface for verified-webhook-ingest

Status: HARD HALT (precondition failed — capability does not exist on the
public surface). No simulation was built; building one would require a
forbidden reach-past.

## Dispatch claim under test

> Build a MODERN verified-webhook-ingest simulation … through the PUBLIC
> Firegrid surface (NOT the old `packages/runtime/src/verified-webhook-ingest`
> runtime adapter — use the modern client/host surface). Firegrid owns HMAC
> verify + deterministic `[source,externalEventKey]` keying + idempotent
> insert-or-get + conflict rejection; product owns route/secret/status.

## Ground-truth evidence (origin/main, this worktree)

1. The verified-webhook-ingest capability exists in exactly one place:
   `packages/runtime/src/verified-webhook-ingest/`
   (`adapter.ts`, `keys.ts`, `table.ts`, `index.ts`, `README.md`).

2. It is re-exported only from the runtime package:
   `packages/runtime/src/index.ts:108–122` —
   `ingestVerifiedWebhook`, `VerifiedWebhookFactTable`,
   `VerifiedWebhookFactKeySchema`, `VerifiedWebhookIngestConfig`,
   `VerifiedWebhookIngestError`, `verifiedWebhookFactTableLayerOptions`, etc.

3. The PUBLIC client/host surface has NO such capability:
   - `packages/client-sdk/src/firegrid.ts`: the only `insertOrGet` calls are
     for runtime control-plane intents (`inputIntents`, `contextRequests`,
     `startRequests`) — not a webhook/verified-fact API. No `hmac`,
     `webhook`, `externalEventKey`, or verified-fact symbol anywhere in
     `packages/client-sdk/src` or `packages/host-sdk/src`.
   - `DurableTableHeaders` appears on client/host only as a config/header
     type, not as a public DurableTable insert-or-get/conflict primitive a
     product could call to create a verified webhook fact.
   - `wait_for` on the public surface is only an in-session **agent tool
     binding** (`packages/host-sdk/src/agent-tools/bindings/tools.ts:129`,
     `WaitForTool`), not a public client waiter over an arbitrary verified
     webhook fact.

4. The old adapter's own README contradicts the dispatch's ownership
   framing: it states the tracer is "not a Firegrid webhook product",
   Firegrid does "not own HTTP routes … source secrets …", and HMAC
   verification lives in the runtime-owned `ingestVerifiedWebhook`
   verifier/translator — i.e. runtime-owned, not a PUBLIC client/host
   product surface.

## Why this is a HARD HALT, not a build

A "modern public-surface" simulation is not expressible. The only two ways
to make it run both violate the dispatch and the toy-build discipline:

- (a) Import `@firegrid/runtime`'s `ingestVerifiedWebhook` /
  `VerifiedWebhookFactTable` — the explicitly-forbidden old adapter
  (reach-past into runtime internals).
- (b) Re-implement runtime-owned HMAC verify + `[source,externalEventKey]`
  keying + idempotent insert-or-get + conflict rejection by hand inside the
  toy — papering over a missing public capability (the TFIND-049 / Slice-4
  burn: "modeling open ≠ capability built").

Either path produces a green sim that misrepresents the public surface as
owning a capability it does not expose.

## What the substrate is actually missing (the architectural ask)

For factory-vision §7.1 to be buildable on the public surface as dispatched,
Firegrid would need a PUBLIC client/host primitive that lets a product:

- present an already-routed external request + a product-held secret and
  have Firegrid perform HMAC verification (verifier owned by Firegrid,
  secret owned by product);
- derive the deterministic `[source, externalEventKey]` fact key;
- idempotently insert-or-get the verified fact (same key twice → one fact);
- reject a same-key / different-payload-hash conflict;
- expose the verified fact to a public `wait_for`/observe path
  (not the in-session agent tool binding).

None of these are on `@firegrid/client-sdk` or `@firegrid/host-sdk` today.
Whether they SHOULD be public substrate vs. remain runtime-owned is an
ownership decision for the coordinator (cf. the Firegrid-substrate-boundary
rule and OWNERSHIP.md), not something a toy should pre-decide by reaching
past.

## Recommended routing

Coordinator decision required (structured decision loop). Options:

1. Re-scope tf-7y3 to a SUBSTRATE GAP finding: "no public verified-webhook
   ingest surface; only runtime-adapter exists" — and (separately) decide
   whether to promote a neutral public primitive.
2. If a `wait_for`-observable verified-fact path is wanted as a *toy probe*
   of the EXISTING runtime adapter, that is a different (allowed) task that
   explicitly targets `@firegrid/runtime` — not "the modern public
   surface", and must be re-dispatched as such.

No papering, no reach-past taken. Halted and surfaced.
