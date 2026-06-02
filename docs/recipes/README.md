# Firegrid Recipes

Focused cookbook entries for product and runtime engineers wiring current
Firegrid primitives into product-owned surfaces.

The Acai feature files in `../../features/firegrid/` remain the formal
contract. Recipes should stay small, link to their backing implementation
evidence, and avoid introducing new product behavior.

**If you are about to add a "connector," "adapter," "ingress writer," or
similar wrapper around a wire-edge concern: check this directory first.**
Most external integrations land as a `ChannelTarget` + `IngressChannel`
binding on existing primitives; the recipes show the canonical shape.

## Runtime Recipes

- [**Client SDK ↔ channel targets**](client-sdk-channel-targets.md) —
  every public `firegrid` client method routes through a typed
  `ChannelTarget`. The mapping table is the dispatch contract; the
  procedure shows how to add a new client method without inventing a
  new path.
- [**External webhooks (Linear, GitHub, …) — channel-as-observation**](durable-webhook-facts-and-wait-for.md) —
  use `makeVerifiedWebhookSource({source, factSchema, ingest, route})` per
  provider. Multi-provider: merge through `mergeWebhookSourceChannels`.
  ~30 lines per adapter.
- [**Agent-to-agent observation**](agent-to-agent-observation.md) —
  two patterns: (1) observe another agent's output stream via `wait_for`
  on `session.agent_output` with the target's `contextId`; (2) react to
  a named peer event via `wait_for` on a `CallerOwnedFactStreams` source.
  Both reuse existing primitives — no parent-child-specific channel.
- [Runtime permission resume](runtime-permission-resume.md) —
  same channel-as-observation pattern for permission resumption.

## How to add a recipe

A recipe earns a slot when:

1. The same wiring shape recurs across two or more product hosts or
   simulations, AND
2. The runtime primitive supporting it is already public-facing, AND
3. Reinvention has already happened, or is plausibly imminent.

Recipes do NOT introduce new runtime primitives. If a pattern needs a new
abstraction, that's an SDD, not a recipe.
