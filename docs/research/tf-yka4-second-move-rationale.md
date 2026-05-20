# tf-yka4 schema-projection second move rationale

## Move

Move `FiregridRuntimeObservationSourceNames` out of the agent-tool schema module and into a neutral protocol observation module:

- new owner: `packages/protocol/src/observations/schema.ts`;
- public subpath: `@firegrid/protocol/observations`;
- compatibility shim: `packages/protocol/src/agent-tools/schema.ts` still re-exports the same value and type.

This implements the observation-source half of item 2 from the tf-krts inventory. The operation-wrapper half of that item is intentionally left for a later catalog cutover because it touches all operation entries rather than one shared type.

## Why This Slice

The observation source-name catalog is binding-facing protocol metadata, not an agent-tool input/output shape. Keeping it in `agent-tools/schema.ts` forced session-facade code to import an agent-tool module just to name client read projections.

Current evidence:

- the inventory flagged the mixed ownership at [docs/research/tf-krts-schema-projection-inventory.FINDING.md:22](./tf-krts-schema-projection-inventory.FINDING.md);
- session-facade projection code uses `FiregridRuntimeObservationSourceNames.agentOutputEvents` for normalized agent-output observations;
- the canonical boundary says protocol owns normalized observation schemas and binding-facing metadata, while agent-tool files should stay focused on schema projection to tool surfaces.

## Compatibility

Existing imports from `@firegrid/protocol/agent-tools` continue to resolve through a re-export. New code should import observation source names from `@firegrid/protocol/observations`.
