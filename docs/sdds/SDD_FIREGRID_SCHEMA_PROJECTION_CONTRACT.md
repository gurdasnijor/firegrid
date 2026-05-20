# Protocol Schema Contract For Channels
(formerly: SDD: Firegrid Schema Projection Contract)

**Status: SUBORDINATE to `SDD_FIREGRID_ONE_SUBSTRATE_PRIMITIVE.md`.**

Date: original 2026-05-13 · re-scoped 2026-05-20
Pillar SDD: `docs/sdds/SDD_FIREGRID_ONE_SUBSTRATE_PRIMITIVE.md`
Original full document: in git history of this file. Do not pick up the
original 700+ line plan (operation-catalog wrappers, per-binding-package
projection design, multi-projection-package convergence target) as
load-bearing. Most of it is absorbed by the channel architecture; the
slim contract below is what survives.

## TL;DR — The Re-Scoping

> Schema projection solved surface divergence at the **data-contract
> layer**. The channel architecture solves it at the **interaction-
> contract layer**.

Schema projection isn't wrong — it was one layer too low to solve the
whole sprawl problem. The schemas-as-source-of-truth rule survives; the
operation-catalog and per-binding-projection-design layers don't.

New model:

```text
protocol schemas
  → channel registrations / typed transport contract
  → client SDK / agent verbs / CLI / MCP / future REST / gRPC projections
  → runtime binding over DurableTable / workflows / adapters
```

This document defines the schema-layer rules that the channel
architecture depends on. Channels are the pillar; schemas are the
data-contract substrate channels carry.

## The Five Surviving Rules

These are the load-bearing rules from the original schema-projection
SDD. They survive the channel-architecture supersession and remain
enforceable.

### Rule 1 — Protocol owns shared schemas

`@firegrid/protocol` is the home for:

- Operation input/output schemas (channel request/response shapes)
- Row schemas for DurableTable collections that multiple packages
  depend on
- Normalized observation schemas (client-visible event shapes)
- Stable observation source name constants
- Any schema that more than one package depends on as a stable contract

`@firegrid/protocol` is NOT the home for:

- Runtime-internal table schemas (workflow engine state:
  `executions`, `activityClaims`, `deferreds`, `clockWakeups`)
- Substrate-internal coordination types
- Single-package implementation details

The rule: a schema goes in protocol only when more than one package
depends on its shape AND the dependency is part of a stable contract.

### Rule 2 — Channels carry protocol-owned schemas

When a channel is registered:

```ts
makeCallableChannel({
  target: "host.sessions.createOrLoad",
  requestSchema: SessionCreateOrLoadInputSchema,   // from @firegrid/protocol
  responseSchema: SessionCreateOrLoadOutputSchema, // from @firegrid/protocol
  call: (req) => ...,
})
```

the `requestSchema` / `responseSchema` / `schema` fields MUST reference
schemas owned by `@firegrid/protocol` (for any operation that's part
of a public contract). Channels don't define new schemas; they carry
existing ones.

This is what gives channels their cross-binding consistency: every
projection of a given channel sees the same typed payload, because
they all reference the same protocol-owned schema.

### Rule 3 — Projections bind channels into surface-specific APIs

Binding packages (`@firegrid/client-sdk`, `@firegrid/host-sdk`'s
agent-tool projections, `@firegrid/cli`, future
`@firegrid/rest`/`@firegrid/grpc`/`@firegrid/jsonrpc`) implement
**channel-verb projections** in their transport-specific shape:

- client-sdk: typed Effect methods that dispatch through channels
- agent verbs: `wait_for` / `send` / `call` over agent-visible channels
- CLI commands: command-and-flag projections of channel verbs
- MCP tools: tool descriptions backed by channel verbs
- REST endpoints (future): HTTP routes that decode → call → encode
  over channel verbs

Each binding picks transport and ergonomic style; the underlying
operation model is the channel layer. **Surface-specific naming and
sugar is fine; surface-specific operation semantics is not.**

### Rule 4 — Projection packages must not define independent semantic catalogs

A binding package MUST NOT:

- Define its own operation input/output schemas parallel to protocol's
- Define its own observation-source enumeration
- Define its own workflow handle types as public API
- Expose `DurableTable` facades or workflow-engine handles as the
  caller-facing semantic API

Specific anti-patterns this rule prevents (each was a real concern from
the original SDD that still applies):

- `client-sdk/src/operations.ts` defining its own
  `FiregridClientOperations` parallel to
  `@firegrid/protocol/session-facade/operations.ts` — collapse to
  re-export from protocol
- CLI commands defining a separate "launch configuration" vocabulary
  parallel to protocol's launch schemas — CLI flags should lower to
  protocol's runtime config types (`local.jsonl({...})` etc.)
- MCP tool definitions reusing similar-but-not-identical schemas
  alongside the protocol's — bind to the same schema instance

Under the channel architecture, this rule is **structurally enforced**:
the channel registry is the single source of channel registrations;
bindings consume from it, they don't define alongside it.

### Rule 5 — Schema evolution is the protocol's responsibility

(This rule was implicit in the original SDD; making it explicit as a
load-bearing concern.)

`@firegrid/protocol`'s schemas evolve over time. The evolution policy
lives here:

- **Additive evolution (preferred)**: protocol minor versions add
  optional fields, new operations, new observation sources. Bindings
  pass these through transparently; older binding consumers see them
  as `unknown`/`undefined` and ignore them.
- **Breaking evolution**: protocol major versions remove or rename
  fields, change required-ness, or restructure operations. Requires
  coordinated upgrade across all bindings + cutover plan.
- **Deprecation window**: deprecated fields/operations live for at
  least one minor version with `@deprecated` JSDoc on the schema
  annotation, AND the schema's runtime validation continues to
  accept them.
- **Bindings handle version skew**: projection packages accept N-1
  protocol minor versions where structurally compatible.

Specific guidance for channel registrations: when a channel's
request/response schema evolves, the channel target string stays
stable; the schemas change beneath it. Older clients that hold the
older schema reference continue to work for additive changes; breaking
changes warrant a new channel target with the old one deprecated.

This rule needs concrete operational details before private beta —
specifically, how protocol package versions are stamped, what the
deprecation cycle looks like in PRs, and what tooling generates
deprecation reports.

## Continued Effect Schema usage (surviving from the original SDD)

The original SDD called out that Effect Schema is the validation /
documentation / metadata mechanism throughout. **This continues
unchanged under the channel architecture.**

Effect Schema usage that bindings continue to depend on:

- **Validation at projection boundaries**: REST endpoints decode HTTP
  bodies via `Schema.decodeUnknown(channel.requestSchema)`; MCP tools
  validate input via the same mechanism; CLI commands validate flags
- **Documentation/metadata generation**: tool descriptions for MCP,
  OpenAPI specs for REST, CLI help text — all generated from Schema
  annotations on protocol-owned schemas
- **Decoding/encoding for transports**: every binding's decode and
  encode steps consume the protocol-owned Schema
- **Cross-language ports** (future): protocol schemas + Effect Schema
  annotations are the source for generating non-TypeScript clients

The data-contract layer is genuinely shared infrastructure. The
interaction-contract layer (channels) builds on top of it.

## What was absorbed by the channel architecture

The following from the original SDD is **absorbed by the channel
layer**. Do NOT implement these as separate abstractions; they're
provided by channel registrations:

| Original concept | Now provided by |
| --- | --- |
| `defineFiregridOperation(...)` wrapper | Channel registration constructors (`makeCallableChannel({...})` etc.) |
| `FiregridClientOperations` aggregated catalog | Channel registry (per-channel `Context.Tag + Layer` per tf-kddg; `ChannelInventory` for MCP-edge string lookup) |
| Per-binding-package design sections | Channel verbs are mechanically projected per binding; surface-specific ergonomic sugar is the only per-binding design |
| "Transactional binding cutover" handshake | Not needed — channel registrations are composable Layers, not a published catalog |
| Operation enumeration mechanism | Listing channel registrations from the registry |
| "client method vs MCP tool vs CLI command" as separate semantic decisions | Each is a transport projection of the same channel verb; the semantic decision happens once at channel registration |

## What's still architectural about packaging

The original SDD framed multi-package projection split as a
**load-bearing architectural target**. That over-claimed. Refined view:

**Packaging IS still architectural** insofar as it:

- Enforces dependency boundaries (e.g., `@firegrid/client-sdk` must
  remain browser/edge-safe — no Node-only dependencies; this is a
  package-boundary concern, not a semantic concern)
- Encodes environment constraints (REST server depends on Node HTTP;
  client SDK depends on browser fetch; etc.)
- Defines version coordination boundaries (each published package has
  its own semver cycle)

**What stops being architectural under the channel model**:

- The **semantic design** of each binding (REST, CLI, MCP, client SDK
  can differ in transport and ergonomics, not in the underlying
  operation model)
- Whether bindings live in their own published packages OR stay grouped
  (host-sdk's agent-tool bindings, for instance, could split into
  `@firegrid/agent-tools` later — but that's a packaging decision, not
  a correctness one)
- Cross-binding semantic consistency (it falls out of channels by
  construction; no per-binding-pair design pass needed)

The package graph from the original SDD —
`protocol → client-sdk → agent-tools → CLI → REST → gRPC → JSON-RPC → runtime` —
remains a useful future target for environment-specific dependency
isolation, but **its existence is no longer required for semantic
correctness**. The semantic correctness is provided by the channel
layer, regardless of how bindings are packaged.

## Where to look for what

| Concern | Now lives in |
| --- | --- |
| Schemas themselves (the catalog) | `@firegrid/protocol` |
| Schema-layer rules (this doc's Rules 1-5) | This document |
| Transport layer (channel verbs, directions, registrations) | `docs/sdds/SDD_FIREGRID_ONE_SUBSTRATE_PRIMITIVE.md` |
| Per-channel Tag+Layer mechanics | `tf-kddg` work + channel-architecture SDD |
| Substrate primitive (DurableTable) | `SDD_FIREGRID_ONE_SUBSTRATE_PRIMITIVE.md` + `packages/effect-durable-operators/src/DurableTable.ts` |
| Agent-surface verb constraint (small fixed verb set) | `SDD_FIREGRID_AGENT_BODY_PLAN.md` |
| Host-SDK / runtime / protocol firewall | `docs/architecture/host-sdk-runtime-boundary.md` (and cannon copy) |
| Validation spike for the channel architecture | `docs/research/one-substrate-primitive-validation-spike.md` |

## Migration for in-flight work referencing this SDD

If a bead or PR cites this SDD as load-bearing for its design:

- **Schemas-in-protocol work** → continues; Rule 1 survives
- **Bindings-can't-define-parallel-catalogs work** → continues;
  Rule 4 survives, now structurally enforced via channel registry
- **Channel-binding-uses-protocol-schemas work** → continues; Rule 2
  survives and gets stronger with channel architecture
- **Schema evolution / versioning work** → continues; Rule 5 needs
  concrete operational details before private beta
- **`defineFiregridOperation(...)` mechanics** → STOP. Absorbed. Re-route
  as channel registration work under the pillar SDD.
- **`FiregridClientOperations` aggregation mechanics** → STOP. Absorbed.
  Use the channel registry.
- **"Split bindings into separate published projection packages"
  architectural work** → re-evaluate. May be valid as ergonomic
  packaging (which is fine and worth pursuing for environment-specific
  dependency isolation), but is no longer load-bearing for semantic
  correctness. Don't dispatch as if it were architecturally required.
- **`tf-aago` (projection-surface cleanup)** → re-scope under the
  channel architecture. Most of its scope is dramatically smaller
  post-channel-cutover.

## Cross-references

- `docs/sdds/SDD_FIREGRID_ONE_SUBSTRATE_PRIMITIVE.md` — pillar SDD
  (channels as typed transport over DurableTable)
- `docs/sdds/SDD_FIREGRID_AGENT_BODY_PLAN.md` — agent surface verb
  set + channels-vs-control-capabilities distinction
- `docs/architecture/host-sdk-runtime-boundary.md` — package firewall
- `docs/research/one-substrate-primitive-validation-spike.md` —
  spike validating the channel architecture (run before any deletion
  lift-and-shift)
- Git history of this file — original 700+ line schema-projection plan
  preserved for historical context; not to be picked up as load-bearing
