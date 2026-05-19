# SDD: Client Control-Plane Stream URL Surface

## §0 — The load-bearing question, read this first

**If `@firegrid/client-sdk` exposes `FiregridRuntimeTables.ControlPlane` for browser/live table composition, must it also expose the matching client-safe control-plane stream URL builder, or should consumers avoid direct table-layer construction and use only `FiregridControlPlaneTableLive` / `FiregridStandaloneLive`?**

This is the TFIND-046 / Beads `tf-76s` framing question. Current status lives in the Beads DB (`bv --robot-triage` / `br`, join key `tfind:046`); deleted Markdown ledgers are not authoritative.

Triage verdict: **category 1 — real production gap, capability missing**. A real non-Firegrid client SDK consumer building a browser/live control-plane query can import `FiregridRuntimeTables.ControlPlane`, but cannot build that table's layer from the same client package because `runtimeControlPlaneStreamUrl` is only exported from `@firegrid/protocol/launch`. This is not toy test cleanness; it is the same surface a Flamecast-style `useDurableTable(FiregridRuntimeTables.ControlPlane)` app needs for a real live query.

Coordinator recommendation: choose **B: expose the namespace-scoped control-plane URL helper through `@firegrid/client-sdk`, narrowly and explicitly, without exporting host-owned stream builders as a bundle**. The minimal sound change is a client-safe re-export or client-named wrapper for `runtimeControlPlaneStreamUrl`, plus documentation that this helper is for the namespace control plane only. Do not use TFIND-046 to expose `hostOwnedStreamUrl` or per-context output URL builders to browser consumers.

## Status

Status: Gurdas signed off narrow Option B. This PR now carries the implementation record plus the client SDK public-surface fix.

Finding: TFIND-046, Beads `tf-76s`, label `tfind:046`, factory-supports, priority P3.

Related specs:

- `firegrid-client-api`
- `firegrid-client-projection-api`
- `firegrid-host-context-authority.SCHEMA_STREAM_AUTHORITY.2`
- `firegrid-schema-projection-contract`

## Evidence

`packages/client-sdk/src/firegrid.ts:12-30` imports `runtimeControlPlaneStreamUrl` from `@firegrid/protocol/launch` inside the client SDK. `packages/client-sdk/src/firegrid.ts:267-297` uses that helper to derive the control-plane stream URL when `FiregridConfig` supplies `durableStreamsBaseUrl + namespace`.

The same file exposes the low-level table tags at `packages/client-sdk/src/firegrid.ts:229-237`: `FiregridRuntimeTables.ControlPlane` is the protocol `RuntimeControlPlaneTable`, and `firegridRuntimeTableTags` includes it for advanced table composition.

The package barrel does not expose the URL helper. `packages/client-sdk/src/index.ts:1-26` exports `FiregridControlPlaneTableLive`, `FiregridRuntimeTables`, `firegridRuntimeTableTags`, `local`, and client types, but not `runtimeControlPlaneStreamUrl` or a client-named equivalent.

The README endorses a real consumer pattern. `packages/client-sdk/README.md:206-249` shows a browser UI using `DurableTableProvider`, `useDurableTable(FiregridRuntimeTables.ControlPlane)`, and `FiregridControlPlaneTableLive` for live control-plane reads. The pattern is production-facing, not test-only.

The tiny migration note records the reach-past in consumer-shaped code. `packages/tiny-firegrid/test/MIGRATION_NOTES.md:25-35` says the tests compose `FiregridRuntimeTables.ControlPlane` from the client SDK but still import `runtimeControlPlaneStreamUrl` from `@firegrid/protocol/launch` to build the table layer, matching the Flamecast live-query shape.

The production-consuming tiny tests show the exact reach-past: `packages/tiny-firegrid/test/multi-context-production-consuming-pipeline.test.ts:3-14` imports client SDK tables but imports `runtimeControlPlaneStreamUrl` from protocol, and `:42-54` uses it to construct `FiregridRuntimeTables.ControlPlane.layer(...)`.

The protocol helper itself is namespace-scoped. `packages/protocol/src/launch/authority.ts:500-505` encodes `{ baseUrl, namespace }` into the runtime control-plane stream URL. It does not require host identity, context identity, or runtime ownership.

Host SDK already re-exports this helper from its public host surface at `packages/host-sdk/src/host/index.ts:8-20`, alongside host-owned stream helpers. That is appropriate for host code, but it leaves the client package asymmetric: the client can expose the control-plane table tag and use the helper internally, yet app code cannot import the helper from the client surface.

## Options

### A. Keep the helper protocol-only

Under A, consumers that need to construct `FiregridRuntimeTables.ControlPlane.layer(...)` import `runtimeControlPlaneStreamUrl` from `@firegrid/protocol/launch`.

Benefits:

- No client SDK API growth.
- Avoids adding another export that may look like low-level stream authority.
- Keeps URL-schema helpers centralized in protocol.

Costs:

- Leaves a public client SDK table tag without the matching public client SDK constructor needed to layer it.
- Forces real browser/live-query consumers to learn and import a protocol launch helper for a client projection concern.
- Conflicts with the client/host split direction: app code should not have to inspect lower protocol packages to assemble the client SDK's own advertised live table surface.

Choose A only if Gurdas wants `FiregridRuntimeTables.ControlPlane.layer(...)` to be considered an advanced protocol-level escape hatch, despite its client SDK export and README live-query pattern.

### B. Expose the namespace control-plane URL helper through client SDK

Under B, `@firegrid/client-sdk` exports the same namespace-scoped control-plane URL helper it already uses internally, either as `runtimeControlPlaneStreamUrl` or as a client-named wrapper such as `firegridControlPlaneStreamUrl`.

Benefits:

- Minimal, local, and directly matches the missing public surface.
- Keeps consumer-shaped live-table code within `@firegrid/client-sdk` for the control-plane path.
- Does not expose host-owned construction authority; the helper only needs `baseUrl + namespace`.
- Matches existing internal client config resolution, so the package does not introduce a second URL authority.

Costs:

- Exposes a low-level Durable Streams URL helper from the client package.
- If named exactly `runtimeControlPlaneStreamUrl`, the client package leaks protocol vocabulary; if wrapped with a client name, there are two names for the same helper.
- Does not solve host-owned output table live-query ergonomics, which remain intentionally derived from context host binding.

Choose B if TFIND-046 is scoped to the concrete gap: client SDK table tag plus client-safe namespace control-plane URL construction.

### C. Hide URL construction behind a higher-level client table factory

Under C, the client SDK does not export the URL helper. Instead it exports a function/layer constructor such as `firegridControlPlaneTableLayer(options)` that builds `FiregridRuntimeTables.ControlPlane.layer(...)` internally.

Benefits:

- Avoids making raw stream URL construction part of the client API.
- Gives React/live-query consumers a single client-owned factory surface.
- Can encode content type, headers, and tx timeout consistently with `FiregridControlPlaneTableLive`.

Costs:

- More API design than the P3 finding needs.
- Duplicates part of `FiregridControlPlaneTableLive` unless the existing layer is reshaped.
- May not help consumers whose table-provider integration specifically wants the tag and a manually composed DurableTable layer.

Choose C if signoff wants a more ergonomic table-layer factory instead of exposing the URL helper directly.

## Recommendation

The coordinator recommendation is **B, narrowly**.

The control-plane stream URL is not host-owned runtime authority. It is namespace-scoped client projection plumbing, and the client SDK already derives it internally from `durableStreamsBaseUrl + namespace`. A re-export or thin wrapper gives real app consumers the missing half of the public table-tag surface without crossing into host-owned facts.

The implementation should deliberately avoid broad protocol helper re-exports. In particular:

1. Export only the control-plane helper needed to layer `FiregridRuntimeTables.ControlPlane`.
2. Do not export `hostOwnedStreamUrl`, `runtimeContextOutputStreamUrl`, or host stream-prefix builders from the client SDK as part of this finding.
3. Document the intended split: namespace control-plane live queries can be client-composed; host-owned output/ingress streams remain resolved from context/session surfaces.
4. Add a compile/import test or README example proving consumer-shaped code can import the table tag and URL helper from `@firegrid/client-sdk` without importing `@firegrid/protocol/launch`.

## Relation To The Client/Host Boundary

TFIND-046 is adjacent to the #332 client/host split family, but it is narrower. The bad shape is not that clients need a host-owned URL. The bad shape is that the client SDK exposes a client-safe control-plane table tag while withholding the client-safe namespace URL helper needed to instantiate it in advanced live-table compositions.

That distinction matters for signoff. Exposing the control-plane helper does not authorize browser clients to predict per-context host-owned output or ingress streams. Those remain derived from runtime context host bindings and higher-level session/client operations.

## Secondary Questions After §0

1. Should the export keep the protocol name `runtimeControlPlaneStreamUrl`, or use a client-facing alias and optionally re-export the protocol name for compatibility?
2. Should `FiregridControlPlaneTableLive` remain the preferred path in docs, with the URL helper documented only for advanced DurableTable provider composition?
3. Should tests under `packages/tiny-firegrid/test/*production*` switch to the client SDK import after signoff, or should the first implementation prove only package export/type availability?
4. Should `@firegrid/client-sdk/firegrid` and the root `@firegrid/client-sdk` barrel both expose the helper?
5. Is a future C-style `firegridControlPlaneTableLayer(...)` worth a separate ergonomic issue after the narrow re-export lands?

## Acceptance Bar For The Follow-Up Implementation

The implementation PR that follows this framing should prove:

- consumer-shaped code can import `FiregridRuntimeTables` and the control-plane URL helper from `@firegrid/client-sdk`;
- no client SDK export exposes host-owned stream URL construction as part of TFIND-046;
- existing `FiregridControlPlaneTableLive` and `FiregridStandaloneLive` behavior is unchanged;
- docs or tests show the live control-plane table composition without importing `@firegrid/protocol/launch`.
