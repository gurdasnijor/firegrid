# tf-lq80 schema-projection fourth move rationale

## Move

Project Firegrid schema-projection annotation helpers through a neutral
protocol subpath:

- new protocol owner: `packages/protocol/src/projection/schema.ts`;
- public subpath: `@firegrid/protocol/projection`;
- compatibility: `@firegrid/protocol/operations` and
  `@firegrid/protocol/agent-tools` continue re-exporting the existing names.

This intentionally does not remove `FiregridOperationEntry` or
`defineFiregridOperation`; that is a larger catalog cutover because current
tool and session operation catalogs still use operation entries.

## Why This Slice

This is the smallest remaining actionable piece of inventory items 1 and 2.
The projection annotation is protocol schema metadata, while the operation
entry wrapper is a compatibility catalog shape. Moving the annotation helper
first lets schemas and future bindings depend on metadata without importing the
operation wrapper module.

Evidence:

- the inventory flags the operation wrapper and projection metadata coupling at
  [docs/research/tf-krts-schema-projection-inventory.FINDING.md:19](./tf-krts-schema-projection-inventory.FINDING.md);
- `firegrid-schema-projection-contract.SCHEMA_CATALOG.4` says Firegrid-specific
  projection metadata is a custom Schema annotation;
- `firegrid-schema-projection-contract.SCHEMA_CATALOG.5` says production
  bindings should not depend on the operation-entry wrapper.

## Compatibility

The old imports remain valid during the migration:

- `@firegrid/protocol/operations` still exports projection helpers and
  operation-entry helpers;
- `@firegrid/protocol/agent-tools` still exports the same names as a
  compatibility surface for existing callers.

New protocol schema code should import projection metadata helpers from
`@firegrid/protocol/projection`.
