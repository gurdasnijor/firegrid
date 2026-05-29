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

- [**External webhooks (Linear, GitHub, …) — channel-as-observation**](durable-webhook-facts-and-wait-for.md) —
  use `makeVerifiedWebhookSource({source, factSchema, ingest, route})` per
  provider. Multi-provider: merge through `mergeWebhookSourceChannels`.
  ~30 lines per adapter.
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
