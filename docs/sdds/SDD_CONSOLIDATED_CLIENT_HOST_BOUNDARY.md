# SDD: Consolidated Client/Host Boundary

Status: draft - framing only, no production code
Created: 2026-05-18
Owner: Firegrid Client SDK / Host SDK boundary

## Decision

TFIND-001, TFIND-002, TFIND-003, TFIND-038, and TFIND-039 are one root
problem: client-shaped configurations still reach past the client boundary to
create a host-bound context and start it.

The headline binary is:

1. **Client writes durable intent + host-side reconciler**
2. **Host auto-starts eligible contexts**

This SDD frames that binary for Gurdas signoff. It does not change production
code and does not update the findings ledger.

## Verified Root

Code read for this framing:

- `packages/client-sdk/src/firegrid.ts`
  - `launch()` returns `RuntimeContextHandle` (`contextId` + `snapshot`) and
    calls `insertLocalRuntimeContext`, so it requires `CurrentHostSession`.
  - `sessions.createOrLoad()` returns `FiregridSessionHandle`, but also calls
    `insertLocalRuntimeContext`, so it requires `CurrentHostSession`.
  - `sessions.attach()` can return `FiregridSessionHandle` without host
    authority, but only after a context/session id already exists.
  - `FiregridSessionHandle.start()` requires `RuntimeStartCapability`.

- `packages/protocol/src/launch/host-context-authority.ts`
  - `insertLocalRuntimeContext()` reads `CurrentHostSession`, creates a
    host-bound `RuntimeContext`, and upserts it into the control-plane table.

- `packages/protocol/src/launch/control-request.ts`
  - #327 already added inert `RuntimeContextRequestRow` and
    `RuntimeStartRequestRow` protocol rows.
  - Those rows have no host binding and are explicitly reserved for the later
    client/CLI/factory flip plus host reconciler transaction.

- Beads DB (`bv --robot-triage`, join keys `tfind:038` and `tfind:039`)
  - TFIND-038: client session creation cannot express arbitrary public runtime
    intent (argv/env/ACP/MCP).
  - TFIND-039: client SDK has no client-visible start trigger.

## Option 1: Client Intent + Host Reconciler

Mechanism:

- Client `launch()` and `sessions.createOrLoad()` write a
  `RuntimeContextRequestRow` containing the full public runtime intent,
  including argv/env bindings and agent protocol/MCP configuration needed by
  TFIND-038.
- Client `session.start()` writes a `RuntimeStartRequestRow`.
- A host-side reconciler observes those requests, binds contexts with
  `CurrentHostSession`, claims start requests, and runs the existing host start
  path.
- Co-located tools that need synchronous terminal results, such as CLI/factory,
  move to a host-owned start surface instead of keeping host authority on the
  client handle.

How #327 fits:

- #327's `RuntimeContextRequestRow` is the create/load request half.
- #327's `RuntimeStartRequestRow` is the explicit start request half.
- Both are currently inert by design; this option makes them live.

Blast radius:

- Protocol: likely enrich `RuntimeContextRequestRow.runtime` if current public
  runtime intent cannot carry all TFIND-038 ACP/MCP data.
- Client SDK: remove `CurrentHostSession` from create/load/launch paths and
  remove `RuntimeStartCapability` from the client start path.
- Host SDK: add the reconciler that materializes context requests and claims
  start requests.
- CLI/factory: migrate synchronous execution to host-owned APIs if the public
  client `start()` becomes request/ack shaped.
- Tests/firelab: replace reach-past context upserts and direct host start
  extraction with client writes plus host reconciliation.

How it ends the reach-past:

- TFIND-001: `launch()` no longer needs to be a host-bound context primitive;
  it can either return a session handle or remain a context helper backed by
  the same request seam.
- TFIND-002: `sessions.createOrLoad()` no longer needs `CurrentHostSession`.
- TFIND-003 / TFIND-039: clients get an explicit durable start trigger instead
  of extracting `RuntimeStartCapability`.
- TFIND-004: tests can compose client and host as separate actors.
- TFIND-008: the same seam supports separate-process end-to-end tests.
- TFIND-038: arbitrary public runtime intent moves through the client-visible
  request row instead of manual `RuntimeContext` construction.

## Option 2: Host Auto-Starts Eligible Contexts

Mechanism:

- Client `launch()` and `sessions.createOrLoad()` still write
  `RuntimeContextRequestRow`.
- A host-side reconciler materializes host-bound contexts.
- Instead of requiring a client start request, the host automatically starts
  contexts that match an eligibility policy, for example newly materialized
  contexts, contexts with pending input, or contexts with a start-on-create
  flag.

How #327 fits:

- `RuntimeContextRequestRow` remains central.
- `RuntimeStartRequestRow` becomes optional, reserved for explicit restart or
  manual start semantics, or is superseded by eligibility policy.

Blast radius:

- Protocol: define durable eligibility policy inputs, possibly on
  `RuntimeContextRequestRow`.
- Host SDK: reconciler must own auto-start policy, idempotency, retry, and
  suppression of accidental duplicate runs.
- Client SDK: can drop client start authority, but `session.start()` semantics
  become unclear unless it becomes a no-op/readiness helper or is deprecated.
- Product semantics: creating/loading a context may cause execution without an
  explicit client start command.

How it ends the reach-past:

- TFIND-001 / TFIND-002 / TFIND-038 are addressed the same way as Option 1:
  client writes an unbound context request instead of constructing a bound row.
- TFIND-003 / TFIND-039 are addressed by removing the need for a client-visible
  start trigger.
- TFIND-004 / TFIND-008 improve if the host reconciler is the only authority
  that materializes and starts contexts.

Risk:

- The start decision moves from explicit client intent to host policy. That is
  a larger semantic choice than making #327's explicit start request live.
- Eligibility needs product rules before code: when does a context start, when
  does it not start, how does a client request delayed creation, and how are
  duplicate starts prevented?

## Recommendation

Recommend **Option 1: client writes durable intent + host-side reconciler**.

Reasons:

- It directly activates the #327 rows instead of sidelining
  `RuntimeStartRequestRow`.
- It preserves explicit user/client intent for start, which is easier to audit,
  test, retry, and reason about than host policy.
- It gives TFIND-039 a concrete public answer: the client-visible start trigger
  is the durable start request.
- It keeps host authority where it belongs: the host binds contexts and runs
  workflows, but the client records what it is asking for.
- It avoids inventing a second parallel bridge. There is one client path
  (durable requests) and one host path (reconciliation/execution).

Option 2 should be chosen only if Gurdas wants "context creation implies
execution when eligible" as a product rule. That rule is bigger than the
current reach-past fix and should be signed off explicitly before any code.

## Framing Questions

1. Choose the binary: explicit client start request (Option 1) or host
   auto-start eligibility (Option 2).

2. If Option 1: should `session.start()` return a request ack, or should the
   client keep a compatibility wait helper while CLI/factory move to host-owned
   synchronous start?

3. For TFIND-001: should `launch()` eventually return `FiregridSessionHandle`,
   or remain a context-only helper with `sessions.attach({ sessionId:
   contextId })` as the session path?

4. For TFIND-038: confirm the public runtime intent shape that must fit inside
   `RuntimeContextRequestRow` for ACP/MCP configurations.

## Non-Goals

- No production code in #332 before signoff.
- No separate TFIND-001 fix; it is the `launch()` face of this same boundary.
- No new bridge API such as `launchSession()` or a parallel host-bound client
  path.
- No findings ledger edit in this PR unless the coordinator explicitly asks
  for the SDD-only ledger update.
