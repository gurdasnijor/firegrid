/**
 * ACP stdio-edge LAUNCHABILITY gate — the type-level acceptance for tf-0awo.21 §6.
 *
 * The edge composition in `bin/acp.ts` previously ended in
 * `… as unknown as Layer.Layer<AcpStdioEdge, unknown, never>`. That cast asserted
 * launchability instead of proving it. This corpus proves it by construction,
 * enforced by `tsc` (`pnpm typecheck`), NOT by vitest assertions:
 *
 *   POSITIVE — the un-cast composition (edge ← CLI composition, OTel error
 *   orDie'd at its boundary in `_compose.ts`) MUST inhabit
 *   `Layer.Layer<AcpStdioEdge, never, never>`. If a residual requirement or a
 *   typed error ever reappears, the `expectTypeOf` below stops matching and
 *   typecheck FAILS — the cast can never silently return.
 *
 *   NEGATIVE — a deliberately UNDER-provided composition (the edge layer with
 *   the CLI composition NOT provided) still requires the host channels, so it is
 *   NOT `Layer<…, never, never>`. The `@ts-expect-error` asserts that mismatch;
 *   if the under-provided layer ever type-checked as launchable, the directive
 *   goes unused and typecheck FAILS.
 *
 * PLACEMENT: `@firegrid/runtime/test` — runtime's tsconfig includes `test/**`, so
 * `pnpm typecheck` actually evaluates the `expectTypeOf` / `@ts-expect-error`
 * directives here (mirrors misuse-resistance-footguns.test.ts). A `.type-test`
 * under tiny-firegrid would be inert.
 */

import type { PublicLaunchRuntimeIntent } from "@firegrid/protocol/launch"
import { Layer } from "effect"
import { describe, expect, expectTypeOf, it } from "vitest"
import { FiregridCliCompositionLive } from "../src/bin/_compose.ts"
import { type AcpStdioEdge, AcpStdioEdgeLive } from "../src/sources/codecs/acp/stdio-edge.ts"

// Type-only operands: building the Layer values is lazy (no I/O), and the
// closures below are never invoked — tsc evaluates their bodies regardless.
declare const input: ReadableStream<Uint8Array>
declare const output: WritableStream<Uint8Array>
declare const runtimeIntent: PublicLaunchRuntimeIntent

// Only a fully-provided, error-free layer (R → never, E → never) is accepted —
// i.e. one that `Layer.launch` / `Effect.provide` can consume without leaking a
// requirement or a typed error. This is the launchability constraint.
const requireLaunchable = <A>(
  layer: Layer.Layer<A, never, never>,
): Layer.Layer<A, never, never> => layer

const _launchabilityGate = () => {
  // POSITIVE: edge ← CLI composition is launchable (R → never, E → never).
  const composition = AcpStdioEdgeLive({
    input,
    output,
    runtime: () => runtimeIntent,
    permissionPolicy: "deny",
  }).pipe(
    Layer.provide(FiregridCliCompositionLive({})),
  )
  expectTypeOf(composition).toEqualTypeOf<
    Layer.Layer<AcpStdioEdge, never, never>
  >()
  // …and it satisfies the launchability constraint (must compile clean).
  void requireLaunchable(composition)

  // NEGATIVE: without the CLI composition, the edge still requires
  // HostPlaneChannelRouter | HostContextsChannel | SessionAgentOutputChannel
  // (R ≠ never), so it is NOT launchable and must fail the constraint.
  const underProvided = AcpStdioEdgeLive({
    input,
    output,
    runtime: () => runtimeIntent,
    permissionPolicy: "deny",
  })
  // @ts-expect-error under-provided: the three host channels are unmet (R ≠ never), so it is not launchable
  void requireLaunchable(underProvided)
}

// Reference the never-called closure so noUnusedLocals stays happy; tsc still
// evaluates its body (where the gate lives).
void _launchabilityGate

describe("acp stdio-edge launchability (enforced by tsc)", () => {
  it("the un-cast edge composition is Layer<AcpStdioEdge, never, never> (real gate is `pnpm typecheck`)", () => {
    expect(typeof AcpStdioEdgeLive).toBe("function")
    expect(typeof FiregridCliCompositionLive).toBe("function")
  })
})
