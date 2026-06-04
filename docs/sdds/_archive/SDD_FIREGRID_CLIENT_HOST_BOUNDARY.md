> **HISTORICAL (pre-#765).** References paths deleted in #765 (packages/substrate, packages/host-sdk/src/host, and legacy packages/runtime/src/{subscribers,durable-tools,workflow-engine,agent-event-pipeline,agent-tools,runtime-host,composition}); kept for provenance. Current architecture: docs/cannon/.

# SDD: Firegrid Client/Host Control-Plane Boundary

Status: draft — framing for coordinator signoff, NO production code yet
Created: 2026-05-17
Owner: Firegrid Client SDK (sidecar `sidecar/client-host-boundary`)

Resolves (coupled, one workstream):

- Beads DB (`bv --robot-triage`, join key `tfind:002`) → "session creation
  still requires host identity"
- Beads DB (`bv --robot-triage`, join key `tfind:003`) → "no remote start
  request surface"

Feeds (noted, NOT in scope here): TFIND-008 (separate-process e2e). Relates to
TFIND-001 (`launch()` vs session handle) — same root cause, deliberately not
expanded.

Related code (verified, not inferred):

- `packages/client-sdk/src/firegrid.ts` — `createOrLoadSession`,
  `makeSessionHandle.start`, `launch`
- `packages/protocol/src/launch/host-context-authority.ts` —
  `insertLocalRuntimeContext`, `CurrentHostSession`
- `packages/protocol/src/launch/schema.ts` — `RuntimeContextSchema` (required
  `host` binding), `makeRuntimeContext`
- `packages/protocol/src/launch/runtime-start.ts` — `RuntimeStartCapability`
- `packages/protocol/src/runtime-ingress/schema.ts` —
  `RuntimeInputIntentRow` (the existing correct-shape precedent)
- `packages/host-sdk/src/host/commands.ts` — `RuntimeStartCapabilityLive`,
  `startRuntime`, `claimAndRunRuntimeContextWorkflow`
- `packages/cli/src/bin/run.ts`, `apps/factory/src/host.ts` — current
  consumers of `session.start()` (public-surface-stability evidence)

Governing specs touched:

- `SDD_FIREGRID_SESSION_FACT_CLIENT_SURFACES.md` ("the client package …
  receives active start authority through `RuntimeStartCapability`" — this
  SDD proposes amending that line)
- `SDD_FIREGRID_SCHEMA_PROJECTION_CONTRACT.md` (client binding is browser/app
  safe; one schema-owned definition per operation)

---

## 1. The gap is real (verification, not discoverability)

Confirmed by reading the code, not the finding text:

1. **`RuntimeContextSchema` has a required `host` binding.**
   `RuntimeContextSchema` (launch/schema.ts) requires
   `host: RuntimeContextHostBindingSchema` (`hostId`, `streamPrefix`,
   `boundAtMs`). A `RuntimeContext` row **cannot be constructed without a
   host**. `makeRuntimeContext` takes `host` as a required input. This is the
   structural root cause, not an API ergonomics issue.

2. **`createOrLoad` requires `CurrentHostSession` transitively.**
   `createOrLoadSession` → `insertLocalRuntimeContext` →
   `yield* CurrentHostSession` to fill the host binding. The client method's
   own signature carries `CurrentHostSession` in `R`. There is **no other
   client-side path** that creates a context row. `attach()` does *not*
   require it — but `attach()` only returns a handle for an **already
   existing** row; it cannot bootstrap one.

3. **`launch()` has the identical root cause** (also calls
   `insertLocalRuntimeContext`). Noted for the coordinator; **not expanded**
   into this PR (TFIND-001).

4. **`start()` is synchronous host execution, not "request start".**
   `RuntimeStartCapabilityLive.start` →
   `claimAndRunRuntimeContextWorkflow` **runs the RuntimeContext workflow to
   completion in the caller's fiber and returns `RuntimeStartResult`
   (exitCode/signal)**. It is not a control request; it is "execute the agent
   and await terminal exit." That is intrinsically a host-process operation
   and cannot be performed by a remote client in-process.

5. **There is no host-side reconciler.** No daemon observes the control
   plane for new contexts or start requests. Host start is *always* an
   explicit in-process `startRuntime` / `RuntimeStartCapability.start` call.
   The CLI proves the co-location: `hostMcpLayer` merges `FiregridLive` +
   `RuntimeStartCapabilityLive` + `FiregridLocalHostLive` in **one process**.

6. **The correct shape already exists for two sibling operations.**
   `prompt(...)` and `permissions.respond(...)` append
   `RuntimeInputIntentRow` to `RuntimeControlPlaneTable.inputIntents`
   namespace-scoped, with **no host capability and no `CurrentHostSession`**.
   The host observes and sequences them. `SDD_..._SESSION_FACT_CLIENT_SURFACES`
   blesses exactly this: "append protocol-owned client control intents; the
   owning host/workflow converts those intents." Context-create and start are
   the **only** two session operations that still cross the boundary.

Conclusion: TFIND-002 and TFIND-003 are **one seam, not two bugs**. The seam
is: *the client writes namespace-scoped durable control intents and reads
projections; the host owns host-binding and live execution.* Two operations
have not yet been moved onto the seam.

## 2. Public-surface-stability constraint (hard)

`session.start()` returning a **synchronous terminal `RuntimeStartResult`**
has real in-tree consumers:

- `packages/cli/src/bin/run.ts:262` (`firegrid run` — awaits exit code)
- `apps/factory/src/host.ts:393` (awaits the run result)

`client-sdk` public API must stay stable for consumers (incl. firelab).
Any change to `start()`'s return contract (terminal result → async request
ack) is a breaking change to `apps/factory` and the CLI. This constraint, not
the schema, is what bounds the down-payment. It must be a coordinator
decision, not a sidecar default.

## 3. End-state design (the correct shape)

Both operations move onto the existing intent seam:

- **Context create/load → durable context-create request.** Add a
  protocol-owned `RuntimeContextRequest` row (the *unbound* launch intent:
  runtime intent + deterministic `contextId` from `externalKey` + optional
  `createdBy`; **no `host` binding**), written by the client into
  `RuntimeControlPlaneTable`. The host observes a request and **materializes
  the bound `RuntimeContext`** via the existing
  `makeLocalRuntimeContextForHostSession` / `insertLocalRuntimeContext`
  primitive (host-side, where `CurrentHostSession` legitimately lives).
  `client.sessions.createOrLoad()` loses `CurrentHostSession` from its
  signature and returns the handle keyed by the deterministic contextId
  (reads already work off projections; `attach()` already proves the
  handle-without-row-write path).

- **Start → durable start request.** Add a protocol-owned
  `RuntimeStartRequest` row. `handle.start()` writes it and returns an
  **acknowledgement** (request id), not a synchronous `RuntimeStartResult`.
  Terminal status is read through the **existing** projection surfaces
  (`snapshot()` `runs`/`status`, `watchContexts`, `wait.*`). The host
  observes start requests, claims, and runs the existing
  `startRuntime` path.

- **Co-located consumers (CLI, factory) drive start through the *host*
  surface, not the client.** They already compose the host in-process, so
  they call host-sdk `startRuntime(contextId)` (host surface) directly to
  retain synchronous terminal semantics. The **client** surface is
  request-only for everyone. This is what removes the bridge: client = write
  request; host = execute. No path holds both.

This matches the FINDINGS intended split verbatim and reuses the
already-blessed `inputIntents` precedent rather than inventing a new transport.

## 4. No-bridge analysis

The dispatch forbids a bridge between "client holds host capability" and "a
new client intent surface." The risk is shipping **both** a
`createOrLoad(...CurrentHostSession)` and a parallel `requestCreate()` (two
paths, indirection over an unsettled reading). The end-state above avoids it:
there is exactly one client path (write request) and one host path (execute);
CLI/factory migrate to the **host** path, not a client compatibility shim.
The open question is purely *sequencing*, not whether to bridge.

## 5. The dependent that cannot land in this PR

A fully working client-shaped create+start **requires a host-side reconciler**
that (a) observes `RuntimeContextRequest`/`RuntimeStartRequest`, (b)
materializes the bound row, (c) runs `startRuntime`. That reconciler **does
not exist**, is **host-sdk-owned**, and is entangled with TFIND-008
(separate-process e2e) and TFIND-006 (host-sdk-backed config). Building it
here would be the big reshape across a lane boundary and is explicitly out of
this sidecar's discipline.

Therefore the client-surface change and the host-reconciler are **separable**,
exactly as TFIND-007 separated "name the type" from "pin the factory return."
This PR can land the **protocol + client** half; the host half is a tracked
dependent for the coordinator to route (host-sdk lane / TFIND-008).

## 6. Smallest-safe-down-payment — the narrow question for the coordinator

I am **not** pre-committing to the biggest reshape. The narrow framing
decision I need signoff on, before any production code:

**Q1 — Down-payment boundary.** Should this PR land:

- **(A) Protocol request schemas + client write-surface only.** Add
  `RuntimeContextRequest` / `RuntimeStartRequest` to
  `@firegrid/protocol/launch`; repoint `client.sessions.createOrLoad()` to
  write the create-request (drop `CurrentHostSession`); repoint
  `handle.start()` to write the start-request (drop `RuntimeStartCapability`,
  return an ack). Host reconciler + CLI/factory migration tracked as the
  dependent follow-up (host-sdk / TFIND-008). **Risk:** between this PR and
  the host follow-up, no host consumes the requests — `createOrLoad`/`start`
  are inert end-to-end until the host lands. firelab can still assert
  the *durable request is written* (client-side, separate Effect invocation),
  which is precisely the TFIND-004 shape.

- **(B) Defer the client break; only formalize the request schemas now**
  (protocol-only PR), keeping `createOrLoad`/`start` host-mediated until the
  host reconciler is ready, then flip the client in a later coordinated PR
  with CLI/factory in the same transaction (avoids a temporarily-inert public
  API).

- **(C) Something narrower** the coordinator prefers.

**Q2 — `start()` semantic break.** Is changing `session.start()` from
"synchronous terminal `RuntimeStartResult`" to "async request ack + read
terminal via projections" acceptable as a public-surface change, given
`apps/factory` and `packages/cli` depend on the synchronous result? Or must
CLI/factory be migrated to host-side `startRuntime` **in the same PR/transaction**
(SEQUENCING) so the public client surface never regresses for a live consumer?

My recommendation: **end-state = §3; down-payment = (A) for protocol +
client, with the `start()` break gated on Q2.** But (A) ships a
temporarily-inert public method, which may violate Public-Surface-Stability
more than (B) does. That trade is a coordinator call, not mine.

## 7. Adjacent findings (for the coordinator → Beads DB, not this PR)

- **TFIND-001 shares this exact root cause:** `launch()` also requires
  `CurrentHostSession` via `insertLocalRuntimeContext`. The §3 shape
  generalizes to it; deliberately not expanded.
- **`insertLocalRuntimeContext` is already `@deprecated`**
  (`firegrid-runtime-agent-event-pipeline.TRANSACTIONAL_CUTOVER.3-2`). There
  may be an in-flight transactional cutover that this design must reconcile
  with rather than fight. Flagging before code.
- **Governing spec amendment required:**
  `SDD_FIREGRID_SESSION_FACT_CLIENT_SURFACES.md` states the client "receives
  active start authority through `RuntimeStartCapability`." §3 contradicts
  that line; it needs a spec delta, not just code.

## 8. Acceptance gate for this SDD

This document is the framing deliverable. No production code until the
coordinator answers Q1 + Q2. On signoff, the implementation PR will state the
chosen boundary, the typecheck/lint/test plan (changed packages + dependents:
`@firegrid/protocol`, `@firegrid/client-sdk`, and any consumer touched), and
the Beads DB update (coordinator-owned, not this sidecar).
