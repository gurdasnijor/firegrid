# Fluent Architecture Boundary

Doc-Class: internal-contract
Status: active
Owner: Firegrid Architecture

This document is the current package-boundary contract for Fluent Firegrid. It
intentionally does **not** define a production host, control plane, Worker
topology, or `fluent-runtime` deployment role.

The current design objective is narrower:

1. keep `packages/fluent-firegrid` as the application authoring API;
2. push generic durable mechanics into `packages/durable-streams`;
3. defer product ingress, harness/session hosting, and external entity
   operations until the authoring API and substrate contracts are settled.

## What Is `fluent-runtime`?

`fluent-runtime` is not a current architecture role.

The package name may still appear in old code, older feature specs, or
historical diagrams, but those references must not be read as an accepted
boundary. In the current design, `fluent-runtime` must not be used as a
catch-all for:

- Durable Streams clients exposed to authored application code;
- claim, ack, lease, cursor, retry, or wake ownership;
- generic timer scheduling;
- generic predicate matching;
- product HTTP routes or provider webhook acceptance;
- MCP/ACP servers or harness lifecycle;
- entity control APIs such as send, fork, tag, schedule, read, head, or delete.

If a later package binds authored definitions to a real deployment, it should be
named and designed from its concrete responsibility, such as product ingress,
harness adaptation, or a test runner. That future binding is out of scope for
the current `fluent-firegrid` API contract.

## Current Package Roles

| Package / layer | Owns now | Must not own now |
|---|---|---|
| `packages/fluent-firegrid` | typed service/object/workflow definitions, handler descriptors, `run`, replay schemas, deterministic step keys, local Effect composition, durable wait/timer/invoke vocabulary over abstract capabilities | Durable Streams clients, stream URLs, listeners, workers, claim/ack APIs, leases, timer wheels, predicate scanners, ingress, control APIs |
| `packages/durable-streams` fork | append/read/tail/head, fork/close/TTL, producer fencing/dedupe, named consumers, wake/claim/ack/release, leases, retry, subscription-webhook delivery, generic scheduled wake or predicate/subscription machinery when available | Firegrid product semantics, harness protocol fidelity, product route policy |
| Effect | computation, local concurrency, interruption, finalizers, dependency services, Schema, controlled Clock/Random services | durable storage, wake ownership, replay persistence |
| future deployment binding | not designed yet; may later connect definitions to product ingress, Durable Streams endpoints, read models, and harness adapters | substrate mechanics that belong in Durable Streams; authoring APIs that belong in `fluent-firegrid` |

## Dependency Rule

```text
application code -> fluent-firegrid
fluent-firegrid  -> no deployment binding, no Durable Streams clients
durable mechanics -> packages/durable-streams
deployment binding -> deferred
```

The root authoring package may depend only on abstract durable capabilities,
such as a `StepJournal`, `TimerJournal`, `WaitJournal`, or `ChildJournal`
contract. Those contracts describe what an authored Effect body needs; they are
not implementation packages and do not imply a `fluent-runtime` process.

## External Ingress Status

External ingress is not part of the current `fluent-firegrid` contract.

Older diagrams that placed a `fluent-runtime EventIngress` box between product
routes and Durable Streams are superseded. They made `fluent-runtime` look like
a concrete product/runtime API while also assigning it substrate-like matching
and wake work. That is the boundary confusion this design is removing.

The current split is:

| Concern | Current owner |
|---|---|
| Product HTTP route / Worker | deferred product ingress binding |
| Raw body capture and provider-specific acceptance policy | deferred source adapter or product ingress binding |
| Provider payload decoding, delivery id, event key | deferred source adapter |
| Idempotent append / producer fencing / duplicate delivery suppression | `packages/durable-streams` |
| Generic cursor, wake, claim, ack, lease, retry | `packages/durable-streams` |
| Generic predicate-over-stream matching, if it is generic | `packages/durable-streams` or a named Durable Streams substrate extension |
| Product-specific matching or session redrive | deferred product/deployment binding, after the substrate contract is named |
| Authored handler body | `packages/fluent-firegrid` definition invoked with abstract durable capabilities |

So the admitted future shape is not "`fluent-runtime EventIngress`". It is a
set of separately named contracts:

```text
product ingress binding
  accept/reject provider delivery
  derive product event
      │
      ▼
Durable Streams substrate
  fenced append / dedupe
  generic wake / claim / ack / lease / retry
  generic scheduled or predicate primitive if available
      │
      ▼
deferred product binding
  consume named substrate result
  invoke authored fluent-firegrid handler if needed
  append product-specific outcome only after its substrate contract is clear
```

The important negative rule: `fluent-firegrid` does not implement the ingress
path, and no package named `fluent-runtime` should be assumed to own it by
default.

## Durable Wait And Timer Status

`fluent-firegrid` may expose durable wait and timer vocabulary only as authoring
vocabulary over abstract durable capabilities.

It must not implement:

- process-local sleeps as durable timers;
- a timer wheel;
- a predicate scanner;
- a cursor store;
- a wake queue;
- a lease table;
- a Durable Streams proxy.

If the mechanism can be described without Firegrid product nouns, it is a
Durable Streams substrate candidate. If the mechanism requires Firegrid product
nouns, it belongs to a later product/deployment binding and must not shape the
root authoring package.

## Read With These Documents

- [`README.md`](README.md): doc-set index and pushdown boundary diagram.
- [`fluent-firegrid-design.md`](fluent-firegrid-design.md): thin
  `fluent-firegrid` authoring API contract.
- [`substrate-protocol.md`](substrate-protocol.md): Durable Streams operation
  sequences and substrate candidates.

Older feature specs and historical diagrams may still mention
`fluent-runtime`, host-fronted topology, or EventIngress. Treat those as
provisional backlog context unless they are rewritten to match this boundary.
