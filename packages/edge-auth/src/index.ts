/**
 * @firegrid/edge-auth — Brookhaven G1 (tf-r06u.33).
 *
 * A thin token -> opaque-handle authorizing layer IN FRONT of the durable-
 * streams read/append surface. durable-streams leaves auth/authz out of scope
 * (PROTOCOL §12.1); this adds tenant-scoped, revocable capability tokens that
 * resolve opaque handles to scoped streams server-side — WITHOUT becoming a
 * gateway (the substrate stays the single read-authority). See
 * `docs/analysis/2026-06-01-brookhaven-roblox-solution-map.md` §C-4 and
 * `docs/analysis/2026-06-01-brookhaven-consumer-contract.md` §6/§9.
 */
export * from "./schema.ts"
export * from "./sign.ts"
export * from "./handle.ts"
export * from "./issue.ts"
export * from "./forwarder.ts"
export * from "./resolver.ts"
export * from "./http.ts"
