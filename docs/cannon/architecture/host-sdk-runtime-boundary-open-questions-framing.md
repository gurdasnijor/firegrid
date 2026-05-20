# Host SDK / Runtime Boundary Open Questions

Status: framing for `tf-gc7c`
Date: 2026-05-20
Canonical source: `docs/architecture/host-sdk-runtime-boundary.md`

This document answers the four open boundary questions from the canonical
host-sdk/runtime firewall framing. The intent is to remove ambiguity before the
implementation lanes move files across package boundaries.

## Summary Decisions

| Question | Decision | Downstream lanes unblocked |
| --- | --- | --- |
| Q1: create `@firegrid/host-runtime`? | No for this wave. Use `@firegrid/runtime` as the execution-substrate home. | `tf-rvt5`, `tf-7knr`, `tf-2y01` |
| Q2: channel metadata schemas to protocol now? | Wait until `tf-kddg` stabilizes the Tag/Layer channel shape, then move stable wire metadata to protocol. | `tf-kddg`, `tf-0r95`, `tf-2y01` |
| Q3: verified-webhook fact schemas to protocol? | Yes when the first client/agent/CLI binding needs to observe those facts. | `tf-0r95`, webhook-as-channel work, dark-factory follow-ons |
| Q4: rename `FiregridRuntimeHostLive`? | Keep the name for now. Preserve the host composition entry point while internals move. | All boundary lanes |

## Q1: Package Home For Host Runtime Code

Decision: do not introduce a new `@firegrid/host-runtime` package in this wave.
The canonical framing already has the right three-tier split:

1. `@firegrid/protocol`: schemas and wire contracts.
2. `@firegrid/host-sdk`: binding and host-author composition surface.
3. `@firegrid/runtime`: execution substrate.

Adding a fourth package now would create a second boundary question before the
first one has landed. The lower-tier workflow definitions, durable authorities,
agent-event pipeline pieces, and execution services should move into
`@firegrid/runtime` first. If `@firegrid/runtime` later develops two incompatible
audiences, such as reusable engine substrate versus host-specific execution
plumbing, that is the point to split a package.

This unblocks `tf-rvt5` by giving it a concrete destination for workflow
definitions and runtime substrate modules. It also unblocks `tf-7knr` by making
runtime-owned execution services the target for the agent-tool execution split,
and it gives `tf-2y01` a simpler import-guardrail rule: runtime must not import
host-sdk, and host-sdk should only import sanctioned runtime APIs.

## Q2: Channel Metadata Schema Ownership

Decision: channel metadata wire schemas belong in `@firegrid/protocol`, but not
until `tf-kddg` stabilizes the channel Tag/Layer shape.

The gate is evidence from `tf-kddg` that the channel surface has settled:

- The central `ChannelRegistry` service is gone or reduced to an MCP-edge
  inventory adapter.
- Channels are provided as per-channel `Context.Tag` services and composed with
  Layers.
- The host/app edge can expose a channel inventory for MCP/tool listing without
  passing workflow handles, stream URLs, table names, or engine services upward.
- The shape distinguishes channel definition metadata from live channel
  implementations.

Once those properties hold, the stable metadata used across bindings, such as
channel target names, direction, row schema identity, and tool-listing metadata,
should move to `@firegrid/protocol`. Live Layers, host composition, and concrete
channel implementations remain in binding or runtime packages depending on
which side of the firewall they sit on.

This unblocks `tf-kddg` by not forcing protocol extraction before its shape is
known, while giving `tf-0r95` and `tf-2y01` a clear follow-up boundary.

## Q3: Verified Webhook Fact Schemas

Decision: verified-webhook fact schemas move to `@firegrid/protocol` when the
first public observer outside runtime needs them.

Runtime should continue to own the verified-webhook ingest implementation:
signature verification, durable writes, and substrate access are execution-tier
concerns. The schema crosses into protocol when a binding needs to observe or
project those facts, for example:

- an agent-visible webhook channel such as `Channel<LinearWebhook>`;
- client-sdk or session-handle observation of webhook facts;
- CLI inspection of webhook events;
- dark-factory or another external driver consuming webhook facts through the
  public channel surface.

At that threshold, the stable fact/projection schema should move to protocol in
the same PR or immediately before the first public binding lands. The runtime
implementation then imports the protocol schema, writes durable rows, and exposes
a runtime-owned source that host/app channel Layers can wrap.

This unblocks webhook-as-channel work and keeps `tf-0r95` from baking a
host-sdk-local schema into an agent-facing surface.

## Q4: `FiregridRuntimeHostLive` Naming

Decision: keep `FiregridRuntimeHostLive` for this refactor wave.

The name is imperfect, but it is already the host-author composition entry point
and the canonical doc's consumer-story rule is preservation: users should still
compose a top-level host layer, while the services behind that layer move below
the SDK boundary. Renaming the entry point during the package-boundary refactor
would add API churn without improving the separation of responsibilities.

A future rename can be considered after the boundary moves and guardrails land,
with an alias period if compatibility matters. Possible names such as
`FiregridHostLive` or `FiregridLocalRuntimeHostLive` are secondary to the current
goal: keep the binding surface stable while runtime execution moves underneath
it.

This avoids unnecessary churn for `tf-rvt5`, `tf-7knr`, `tf-2y01`, and `tf-0r95`.

## Sequencing Recommendation

Use these decisions as the dispatch contract:

1. Move lower-tier execution code to `@firegrid/runtime`, not to a new package.
2. Let `tf-kddg` settle the channel Tag/Layer and inventory surface before
   extracting channel metadata schemas to protocol.
3. Move verified-webhook fact schemas to protocol at the first public
   cross-binding observer.
4. Keep `FiregridRuntimeHostLive` stable while the internals are relocated.

The key guardrail is unchanged from the canonical doc: do not dispatch a broad
"move host-sdk/src/host to runtime" task. Each move should name the exported
contract it leaves behind in host-sdk and the runtime-owned service it lowers
onto.
