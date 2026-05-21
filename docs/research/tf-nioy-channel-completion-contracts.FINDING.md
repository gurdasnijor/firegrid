# tf-nioy: Channel Completion Contracts

Date: 2026-05-21
Status: evaluation spike
Probe: `packages/tiny-firegrid/src/simulations/channel-completion-contracts/probe.ts`
Tests: `packages/tiny-firegrid/test/channel-completion-contracts/probe.test.ts`
SDD target: `docs/sdds/SDD_FIREGRID_DURABLE_CHANNELS_SYNC_ASYNC.md`

## Question

How should a channel operation express completion so router-backed edges can
map operation outcomes to transport responses such as ACP `PromptResponse` and
`stopReason`?

The completion contract must not be a public `isComplete` boolean, caller
supplied wait option, or public await-mode enum. Those are call-site controls;
completion belongs to the operation contract.

## Probe Summary

The tiny-firegrid probe models four placements:

| Candidate | Router inspectable before dispatch | Edge can map transport response | Verdict |
|---|---:|---:|---|
| Call-site flags | No | No | Reject |
| Schema annotations / metadata | No | Partial | Supporting input |
| Channel / route descriptor metadata | Yes | Yes | Supporting input |
| Return / receipt schema | No | Yes, after invocation | Supporting input |

The recommended shape is **channel route descriptor metadata plus terminal
return / receipt schema**.

The route descriptor declares that the operation has completion semantics and
names the terminal evidence contract. The receipt schema carries the evidence:
for the probe, `Done` and `Rejected` terminal tags. An ACP edge can inspect
`router.descriptor.metadata.completion` before dispatch, decode the returned
receipt after dispatch, and map `Done` / `Rejected` to `PromptResponse` fields.

## Candidate Notes

### 1. Call-Site Flags

Rejected. A flag such as `expectedReject` is not part of the operation
contract. It can contradict the actual receipt and is not visible in router
metadata. It also pushes transport policy into callers.

The probe demonstrates divergence directly: a caller can set
`expectedReject: true` while the operation receipt is `Done`.

### 2. Schema Annotations

Useful but not canonical. Effect Schema annotations can be discovered from AST
metadata, matching the `DurableTable.primaryKey` pattern where a schema field
carries machine-readable metadata.

This is a good derivation mechanism for schema-owned facts, but completion is
not only a schema-owned fact. It is route-specific: target, verb, direction,
and transport projection all matter. A shared receipt schema can be used by
multiple routes with different edge behavior.

### 3. Channel / Route Descriptor Metadata

Recommended as the canonical inspectable placement. The router and edge
adapters already consume route descriptors for target, direction, verbs, and
schema projection. Completion metadata belongs beside those fields because it
answers the same question: what does invoking this route mean to an edge?

This placement lets ACP/Zed, MCP, CLI, HTTP, and future edges inspect the
contract without importing runtime bindings or trusting call-site options.

### 4. Return / Receipt Schema

Required but not sufficient alone. The receipt is the evidence: it carries
terminal tags such as `Done` and `Rejected` and any transport-relevant fields
such as an ACP stop reason.

However, a receipt schema by itself does not tell the edge that this route's
result is terminal completion evidence. The descriptor must declare that
relationship.

## Recommendation

Represent completion as an operation/channel contract:

1. Route descriptor metadata declares completion semantics for dispatched
   routes.
2. Return / receipt schemas carry terminal evidence.
3. Schema annotations may be used as a derivation helper, but they are not the
   edge-facing contract.
4. Call-site flags are rejected.

Follow-on implementation should add protocol-owned route completion metadata
and runtime router projection support. This bead intentionally does not change
production APIs.

## ACP Edge Implication

The ACP edge should not infer prompt completion from a caller option or from a
generic success value. It should inspect route metadata:

```text
router.descriptor.routes[target].metadata.completion
  -> dispatch route
  -> decode receipt schema
  -> map Done / Rejected to ACP PromptResponse + stopReason
```

If a route lacks completion metadata, the edge should treat the result as a
plain route result, not as prompt completion.
