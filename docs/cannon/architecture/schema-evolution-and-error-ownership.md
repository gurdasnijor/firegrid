# Schema Evolution And Error Ownership

Status: Draft companion policy

This note is the proposed fold-in text for
`docs/cannon/sdds/SDD_FIREGRID_SCHEMA_PROJECTION_CONTRACT.md` sections
`Schema Evolution` and `Error Ownership`.

It resolves the two surface-hygiene gaps called out by the private-beta
architecture review:

- Finding 3, error ownership:
  `docs/handoffs/sprint-to-private-beta/02b-COMPANION_ARCHITECTURE_ASSESSMENT.md:169`
- Finding 5, schema versioning:
  `docs/handoffs/sprint-to-private-beta/02b-COMPANION_ARCHITECTURE_ASSESSMENT.md:230`

The short handoff version already names the intended rules in
`docs/handoffs/sprint-to-private-beta/architecture/03-projection-contracts.md:70`
and
`docs/handoffs/sprint-to-private-beta/architecture/03-projection-contracts.md:89`.
This document is the canonical expansion for review.

## Schema Evolution

`@firegrid/protocol` is the schema source of truth for Firegrid public and
semi-public contracts. During private beta, protocol minor versions are
additive by default:

- new optional fields may be added in a minor version;
- new operation schemas, observation schemas, channel targets, and fact schemas
  may be added in a minor version;
- new literal variants may be added only when older projections can ignore or
  preserve them, or when the projection package documents the fallback behavior;
- required fields, removed fields, renamed fields, narrowed literals, changed
  primary-key encodings, and changed event semantics are breaking changes unless
  the same release includes an explicit migration note.

Breaking protocol changes require one of:

- a major version;
- an explicit migration note in the SDD or release notes before the PR merges;
- a documented beta exception that names the affected projection packages and
  the exact compatibility window being cut.

Projection packages should accept at least the immediately prior compatible
protocol minor version when practical. "Accept" means the projection can decode,
preserve, ignore, or adapt the prior minor shape without silently corrupting
state. The compatibility mechanism can be a schema union, a decoder that maps
old rows into the current in-memory shape, an alias for an old observation
source name, or a documented deprecation adapter. If N-1 compatibility is not
practical, the PR must say why and must include the migration note required for a
breaking change.

Durable row schemas that participate in replay have a stricter rule: each row
family must either include a version field or have a migration story. A replay
participating row is any durable row that must be decoded later to rebuild
state, resume a workflow, deliver queued work, or derive public observations.
For those rows, schema evolution must choose one of:

- carry an explicit `schemaVersion`, `rowVersion`, or domain-specific version
  field;
- make the new field optional or defaultable so old rows continue to decode;
- decode old and current row versions through a migration union before the row
  reaches execution code;
- reproject from retained source records instead of migrating the row in place;
- state that the row is not replay compatible and document the operational
  cleanup required before the new shape ships.

Current examples show why this needs to be explicit before private beta:

- `RuntimeIngressInputRowSchema` is a replay-facing runtime ingress row with no
  explicit version field today
  (`packages/protocol/src/runtime-ingress/schema.ts:85`).
- `RuntimeInputIntentRowSchema` is client-written durable input authority and
  also has no explicit version field today
  (`packages/protocol/src/runtime-ingress/schema.ts:99`).
- `RuntimeContextRowSchema` is durable control-plane identity state with an
  implicit shape version today (`packages/protocol/src/launch/table.ts:161`).
- `VerifiedWebhookFactSchema` and `LinearWebhookFactSchema` are protocol-owned
  fact projections with implicit beta shapes today
  (`packages/protocol/src/verified-webhook/schema.ts:28` and
  `packages/protocol/src/verified-webhook/schema.ts:82`).

Those examples are not automatically wrong. They are beta contracts or internal
implementation details that need labels and, for replay rows, either a version
field or a migration story before they become stable public contracts.

Every schema-bearing doc should label the schema in one of three buckets:

- **Stable public contract**: users, apps, or external integrations may depend
  on the shape across minor versions. Additive minor changes are allowed;
  breaking changes require a major version or a formally documented migration.
- **Beta contract**: private-beta users may depend on the shape, but the release
  may still use explicit beta migration notes for breaks. Additive minor changes
  remain the default.
- **Internal implementation detail**: the shape is owned by runtime,
  host/runtime composition, a provider adapter, or a projection implementation.
  It is not a public API, but replay-facing durable rows still need a version or
  migration story.

Schema labels should appear close to the schema SDD, architecture note, package
README, or release note that introduces the contract. The label is part of the
review surface: when a PR exports a new schema without a label, reviewers should
ask whether the schema is stable public, beta, or internal before approving it.

## Error Ownership

Errors are schema contracts too. The same projection-boundary rule applies to
`Schema.TaggedError` as to operation, observation, channel, and durable-row
schemas.

The ownership rule is:

- shared domain or projection errors live in `@firegrid/protocol`;
- runtime-internal failure types live in `@firegrid/runtime`;
- binding-edge errors live in the projection package that owns that binding
  edge.

Shared domain or projection errors are errors that multiple packages must
produce or handle with the same semantics. These belong in protocol even when a
runtime or host implementation is the first producer. Current matching examples
are the host-context authority errors in protocol:
`ContextNotFound`, `ContextNotLocal`, and `CurrentHostStopped` are defined in
`packages/protocol/src/launch/host-context-authority.ts:77`,
`packages/protocol/src/launch/host-context-authority.ts:84`, and
`packages/protocol/src/launch/host-context-authority.ts:93`.

Runtime-internal failure types are execution, workflow, provider, adapter,
ingress, or runtime-state failures whose payloads describe runtime mechanics
rather than a cross-binding product outcome. Current matching examples:

- `RuntimeContextError` lives in runtime at
  `packages/runtime/src/runtime-errors.ts:3`. This matches the rule because it
  describes runtime context execution failures.
- `RuntimeIngressError` lives in runtime at
  `packages/runtime/src/runtime-errors.ts:34`. This matches the rule because it
  describes runtime ingress append/sequence failures. The host-sdk compatibility
  re-export at `packages/host-sdk/src/host/index.ts:85` does not make host-sdk
  the owner.

Binding-edge errors are failures introduced by a projection's lookup, routing,
transport binding, or ergonomic API layer. They stay with the projection unless
the same error becomes a shared protocol outcome. Current matching example:

- `UnknownChannelTarget` lives in host-sdk at
  `packages/host-sdk/src/host/channel.ts:38`. This matches the rule while it is
  a host/channel binding lookup failure for a locally installed channel target.

Promotion is explicit. If a runtime-internal or binding-edge error becomes a
value that client-sdk, CLI, REST, gRPC, JSON-RPC, app code, and host-sdk must
all understand, the error moves to `@firegrid/protocol` or gains a
protocol-owned counterpart. Re-exporting an error from another package is a
compatibility tactic, not an ownership transfer.

Do not create duplicate tagged errors with the same semantic meaning in
multiple packages. A new error PR should answer three review questions:

1. Is this a shared domain/projection outcome? If yes, define it in protocol.
2. Is this runtime execution or substrate failure? If yes, define it in runtime.
3. Is this only a binding-edge lookup or projection failure? If yes, define it
   in the owning projection package.

If the answer changes later, move the owner in the same PR that changes the
public semantics and update the schema label or migration note.
