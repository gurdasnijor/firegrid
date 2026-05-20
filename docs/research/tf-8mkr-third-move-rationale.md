# tf-8mkr schema-projection third move rationale

## Move

Project the stable verified-webhook fact contract through protocol:

- new protocol owner: `packages/protocol/src/verified-webhook/schema.ts`;
- public subpath: `@firegrid/protocol/verified-webhook`;
- runtime compatibility: `packages/runtime/src/verified-webhook-ingest/keys.ts`, `table.ts`, and runtime root exports continue exposing the same public names.

The runtime package still owns signature verification, ingestion, key encoding for durable table primary keys, `VerifiedWebhookFactTable`, and table layer options.

## Why This Slice

This is item 11 from the tf-krts inventory and is still actionable after the workflow migration work landed. The fact schema is a binding-facing row/projection contract, while the durable table and ingest adapter are runtime substrate.

Evidence:

- the inventory flagged runtime co-exporting fact schema and table implementation at [docs/research/tf-krts-schema-projection-inventory.FINDING.md:58](./tf-krts-schema-projection-inventory.FINDING.md);
- the canonical boundary says protocol owns durable row schemas multiple packages agree on, while runtime owns verified webhook ingestion implementation and durable tables;
- current runtime callers can keep importing from `@firegrid/runtime` or runtime source paths because the old exports remain.

## Compatibility

The runtime durable table uses a private table-row schema that applies `DurableTable.primaryKey` to the same protocol-owned fact fields. This preserves table behavior while making the product fact shape importable without reaching into runtime.
