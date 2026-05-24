// Public subpath: `@firegrid/protocol/acp`.
//
// Pure, CLI-safe ACP vocabulary. No Effect, no Layer, no Schema, no
// runtime/host-sdk imports — protocol-tier shared types/constants only.
//
// Wave (CC4-unblock): the `firegrid acp` CLI command + the host-sdk ACP
// stdio edge both reach for the same three-policy alphabet
// (`forward | deny | allow`). Living in `@firegrid/protocol/acp` lets
// the CLI consume the symbols without crossing the host-sdk boundary;
// host-sdk continues to own the edge that ENFORCES the policy. The
// constants are reproduced here (not re-exported from host-sdk) per the
// no-host-sdk-edit clean-break directive on this lane.

/**
 * The ACP edge's permission-handling policy. Selects WHICH decision the
 * edge dispatches through the same `host.permissions.respond` route;
 * never who owns the permission authority.
 *
 *   - `"forward"` — the safe default. The edge forwards the
 *     PermissionRequest to the client and waits for the typed decision.
 *   - `"deny"` — auto-deny without prompting (operator opt-in for
 *     locked-down hosts).
 *   - `"allow"` — auto-allow without prompting (intentional operator
 *     choice, never the default).
 */
export type AcpPermissionPolicy = "forward" | "deny" | "allow"

/**
 * The canonical alphabet of permission policies. Mirrors the
 * `AcpPermissionPolicy` union order; consumers that need to enumerate
 * the valid string set (CLI option enums, validation tables, help text)
 * should derive from this constant rather than re-encoding the union.
 */
export const acpPermissionPolicies: ReadonlyArray<AcpPermissionPolicy> = [
  "forward",
  "deny",
  "allow",
]

/**
 * The safe default policy when no explicit choice is provided. Matches
 * the ACP edge's runtime fallback at `permissionPolicy ??
 * defaultAcpPermissionPolicy`.
 */
export const defaultAcpPermissionPolicy: AcpPermissionPolicy = "forward"
