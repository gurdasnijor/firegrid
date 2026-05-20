# tf-wzrr schema-projection first move rationale

## Move

Move the normalized agent-output envelope/projection contract out of runtime ownership by making `packages/runtime/src/agent-event-pipeline/events/output.ts` a compatibility shim over `@firegrid/protocol/session-facade`.

This implements one item from the tf-krts inventory only: runtime's duplicate public agent-output observation contract.

## Why This Slice

This is the smallest actionable boundary move because protocol already owns the richer normalized projection:

- protocol defines `RuntimeAgentOutputEnvelopeSchema` and the strict decoder at [packages/protocol/src/session-facade/schema.ts:214](../../packages/protocol/src/session-facade/schema.ts) and [packages/protocol/src/session-facade/schema.ts:430](../../packages/protocol/src/session-facade/schema.ts);
- protocol defines `RuntimeAgentOutputObservationSchema` at [packages/protocol/src/session-facade/schema.ts:276](../../packages/protocol/src/session-facade/schema.ts);
- the tf-krts inventory recorded the pre-move runtime duplicate at [docs/research/tf-krts-schema-projection-inventory.FINDING.md:54](./tf-krts-schema-projection-inventory.FINDING.md).

The canonical firewall says protocol owns normalized observation schemas for client reads and agent-visible events, while runtime owns event pipeline mechanics and authority tags. See [docs/architecture/host-sdk-runtime-boundary.md:101](../architecture/host-sdk-runtime-boundary.md) and [docs/architecture/host-sdk-runtime-boundary.md:151](../architecture/host-sdk-runtime-boundary.md).

## Compatibility

Existing imports from `@firegrid/runtime/events` and the runtime root still resolve because the runtime file re-exports the protocol symbols. This avoids breaking downstream callers in the first-move slice while making the ownership direction visible in code.

Follow-up slices can migrate binding-facing callers to `@firegrid/protocol/session-facade` directly, then remove the runtime shim.
