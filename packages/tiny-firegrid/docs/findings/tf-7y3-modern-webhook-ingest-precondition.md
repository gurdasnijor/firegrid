# FINDING — tf-7y3: factory-vision §8 gap for verified-webhook-ingest

Status: DELIVERED. The §7.1 attempt sim was built and run through the
PUBLIC Firegrid client/host surface only (no `src/configurations/` import,
no `@firegrid/runtime` verified-webhook-ingest adapter, no ownership
redesign). Two sub-capabilities are publicly expressible; three are NOT
expressible without reaching past the public surface. Per factory-vision
§8 the attempt is the evidence: this records a precise substrate gap.

Sim: `packages/tiny-firegrid/src/simulations/verified-webhook-ingest-pipeline.ts`
(registered). Trace artifact is the deliverable.

## Attempt: external event -> durable verified fact, public surface only

A real product consumer was wired as: product owns route/secret/status and
verifies HMAC itself; Firegrid public surface is asked to provide the
deterministic `[source,externalEventKey]` keyed, idempotent, conflict-
rejecting, observable durable fact.

## Empirical result (sim run, completed)

| Sub-capability                         | Public-surface verdict |
|----------------------------------------|------------------------|
| HMAC verify on public surface          | NO (`hmacVerifyOnPublicSurface=false`) — product code only; no HMAC/verify symbol on `@firegrid/client-sdk` or `@firegrid/host-sdk`. |
| Deterministic `[source,key]` handle    | YES (`deterministicSourceKey=true`) — `sessions.createOrLoad` derives a stable `ctx_ext_<base64url([source,id])>` (`firegrid.ts:543`, `sessionContextIdForExternalKey`). |
| Idempotent insert-or-get               | YES (`idempotentInsertOrGet=true`) — same externalKey twice -> identical contextId; one durable handle. |
| Conflict rejection on differing payload | NO (`conflictRejection=false`) — proven: same key + different payload hash (`hashA=43cd6862` vs `hashB=cc603e86`) -> `rejected=false, silentlyAliasedToSameContext=true`. `createOrLoad` keys ONLY on `[source,id]`; payload is never bound to the key; no conflict primitive. |
| Fact observable to a public `wait_for` | NO (`factObservableViaPublicWait=false`) — only `wait.forAgentOutput` / `wait.forPermissionRequest` exist publicly; neither is a wait over a verified product fact (an ingest produces no agent output). |

Overall: `publicSurfaceExpressible=false`.

## The precise gap (the §8 information)

The public surface CAN express a deterministic, idempotent
`[source,externalEventKey]` durable handle (the runtime CONTEXT created by
`sessions.createOrLoad`). It CANNOT, without reaching past the public
surface into the runtime-owned `@firegrid/runtime` verified-webhook-ingest
adapter:

1. verify the webhook HMAC (absent from the public surface — product- or
   runtime-owned);
2. bind the payload to the key and REJECT a same-key / different-payload
   re-ingest (the closest public primitive, `createOrLoad`, silently
   aliases differing payloads to the same context — a correctness hazard
   if misused as a "verified fact");
3. observe the verified fact through a public `wait_for` (no fact-level
   public wait exists; only agent-output/permission waits).

## Ownership note (unchanged)

This is a substrate-gap finding, NOT an ownership redesign and NOT a
migration of the runtime adapter. Whether these three should become neutral
public substrate primitives, or remain runtime-owned with a product seam,
is a coordinator/OWNERSHIP.md decision. The toy does not pre-decide it.

## Routing

Coordinator decision (structured loop, `signoff:pending`):
- accept as the §7.1/§8 deliverable and file the three gaps; and/or
- decide whether to promote a neutral public verified-fact primitive
  (deterministic-keyed, payload-bound, conflict-rejecting, wait-observable)
  vs. keep it runtime-owned behind a product seam.

No papering, no reach-past taken. Attempt made, gap recorded with evidence.
