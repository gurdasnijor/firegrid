# tf-asvu schema-projection fifth move rationale

## Move

Remove production binding dependencies on protocol operation-entry wrappers:

- `packages/host-sdk/src/agent-tools/bindings/tools.ts` now binds Effect AI
  tools directly from `@firegrid/protocol/agent-tools` schema values;
- tool names and descriptions are read from Effect Schema annotations through
  `@firegrid/protocol/projection`;
- `packages/client-sdk/src/operations.ts` now exposes a plain local schema
  grouping instead of re-exporting `FiregridClientOperations` from protocol;
- tests assert the toolkit projection no longer needs
  `FiregridOperationEntry`.

The protocol operation-entry catalogs remain as compatibility and protocol-side
grouping surfaces for now.

## Why This Slice

This is the smallest remaining actionable piece of inventory items 1 and 2 after
the projection helper moved to `@firegrid/protocol/projection`. Production
bindings should consume protocol schemas and annotations, not the operation-entry
wrapper.

Evidence:

- the original inventory flags production dependence on
  `FiregridOperationEntry` / `defineFiregridOperation` at
  [docs/research/tf-krts-schema-projection-inventory.FINDING.md:19](./tf-krts-schema-projection-inventory.FINDING.md);
- `firegrid-schema-projection-contract.SCHEMA_CATALOG.5` requires production
  bindings not to depend on `FiregridOperationEntry` or
  `defineFiregridOperation`;
- `firegrid-schema-projection-contract.TOOL_PROJECTION.3` requires agent tool
  metadata to be derived from the schema catalog rather than duplicated in tool
  code.

## Remaining Inventory

The remaining mismatches are larger than a first-move slice:

- deleting `FiregridAgentToolOperations` and protocol
  `FiregridClientOperations` requires a protocol catalog cutover because those
  modules still use `defineFiregridOperation` internally for compatibility;
- moving `RuntimeControlPlaneTable` / `RuntimeOutputTable` out of protocol is a
  transport/table-facade split touching client, host, runtime, and tests;
- host-sdk workflow/execution items overlap runtime-substrate refactors and
  should be coordinated as execution-boundary work, not another schema-only
  move.

Recommended next step: re-baseline the inventory against current `main` and
dispatch the remaining items as explicit boundary refactors rather than
continuing opportunistic schema moves.
