/**
 * Misuse-resistance NEGATIVE corpus — the `@ts-expect-error` footgun gate.
 *
 * Proof obligation for SDD_FIREGRID_GATEWAY_SEPARATION_OF_CONCERNS §9.2
 * (tf-r06u.27): "the design isn't done until misuse is provably non-compiling."
 *
 * Every `@ts-expect-error` below asserts that a WRONG move against the PUBLIC
 * surface — `@firegrid/client-sdk` client verbs + the `FiregridHost` host
 * composition options — does NOT type-check. This is enforced by `tsc`
 * (`pnpm typecheck`), NOT by vitest: if a footgun ever starts compiling, tsc
 * reports the `@ts-expect-error` as unused and typecheck FAILS — which is the
 * point. "Hard to hold the hammer wrong" becomes a gate, not a hope.
 *
 * PLACEMENT NOTE: this corpus lives in `@firegrid/runtime/test` (NOT
 * `tiny-firegrid/test`) on purpose: `runtime`'s tsconfig includes `test/**`, so
 * `pnpm typecheck` actually evaluates these `@ts-expect-error` directives.
 * `tiny-firegrid`'s tsconfig only includes `src/**`, so an `@ts-expect-error`
 * placed there would be inert (the seed's "compose-to-never" is enforced at
 * runtime via `Effect.scoped`, not by tsc). Importing `@firegrid/client-sdk`
 * here also exercises a dependency `runtime` already declares.
 *
 * Companion gates (this corpus is the SYMBOL/type-surface half of obligation 4;
 * the MODULE-boundary half is already enforced by existing dependency-cruiser
 * rules — `client-sdk-no-runtime` and `host-sdk-no-workflow-or-durable-substrate-scan`
 * in `.dependency-cruiser.cjs`). The type checker is used here because it catches
 * `as`-aliased and `export *` re-exports that a regex/pattern rule would miss.
 *
 * GAPS this corpus deliberately does NOT assert (the surface does not yet
 * enforce them — tracked as follow-up beads / the PR note):
 *   - channel direction / payload typing: the client channel facade is
 *     `(target: string, payload: unknown)`, so a wrong-direction or
 *     substrate-shaped payload still compiles (§9 obligation 5 — unmet).
 *   - `FiregridRuntimeTables` / `firegridRuntimeTableTags`: documented substrate
 *     escape-hatch VALUES still on the client barrel (tf-8oaq).
 */

import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import type { FiregridService } from "@firegrid/client-sdk"
import type * as ClientSdk from "@firegrid/client-sdk"
// A real substrate handle from the host-composition barrel, used to prove it
// CANNOT be fed to a client verb (F5). FiregridHost is the public host factory.
import { FiregridHost, SignalTable } from "../src/unified/host.ts"

// ── F1/F2 — host composition: a missing building block must not compile ──────

// Never invoked; tsc type-checks the body regardless of execution.
const _hostFootguns = () => {
  // F1 — missing the required `durableStreamsBaseUrl` building block.
  FiregridHost(
    // @ts-expect-error `durableStreamsBaseUrl` is required — a half-wired host must not compile
    { namespace: "x", codec: "acp" },
  )

  // F2 — neither an `adapter` Layer nor the `codec` sugar: no runtime block at all.
  FiregridHost(
    // @ts-expect-error options must supply either `adapter` or `codec` — neither given
    { namespace: "x", durableStreamsBaseUrl: "http://localhost:4437" },
  )
}

// ── F4/F5/F6 — client verbs: host-only ops, substrate handles, wrong types ───

const _clientFootguns = (firegrid: FiregridService) => {
  // F4 — host-only lifecycle ops are absent from the client surface.
  // (the calls are also "unsafe" to eslint precisely because the property is an
  // error type — that IS the footgun; the @ts-expect-error is the assertion.)
  /* eslint-disable @typescript-eslint/no-unsafe-call */
  // @ts-expect-error `deregister` is a host-only op, not on the client service
  firegrid.deregister("ctx")
  // @ts-expect-error `startOrAttach` is host adapter-only, not on the client service
  firegrid.startOrAttach("ctx", 1)
  /* eslint-enable @typescript-eslint/no-unsafe-call */

  // F5 — a substrate handle cannot be passed to a typed client verb.
  // @ts-expect-error a substrate `SignalTable` Tag is not a valid SessionCreateOrLoadInput
  firegrid.sessions.createOrLoad(SignalTable)

  // F6 — a wrong-typed request to a typed verb does not compile.
  // @ts-expect-error `prompt` expects a PublicPromptRequest, not a number
  firegrid.prompt(42)
}

// ── F3 — substrate types are NOT on the client public surface ────────────────
// (namespace-member checks: each must fail to resolve from @firegrid/client-sdk)

export type _NoSignalTable =
  // @ts-expect-error `SignalTable` is substrate, absent from the client barrel
  ClientSdk.SignalTable
export type _NoUnifiedTable =
  // @ts-expect-error `UnifiedTable` is substrate, absent from the client barrel
  ClientSdk.UnifiedTable
export type _NoWorkflowEngine =
  // @ts-expect-error `WorkflowEngine` is substrate, absent from the client barrel
  ClientSdk.WorkflowEngine
export type _NoDurableTable =
  // @ts-expect-error `DurableTable` is substrate, absent from the client barrel
  ClientSdk.DurableTable
// The control-plane / output tables are reachable internally via the documented
// `FiregridRuntimeTables` escape-hatch VALUE (tf-8oaq), but their TYPE names must
// not be on the public barrel. dep-cruiser can't see this (they route through
// the allowed `@firegrid/protocol/launch`), so the type checker is the gate.
export type _NoRuntimeControlPlaneTable =
  // @ts-expect-error `RuntimeControlPlaneTable` is substrate, not a named client-barrel export
  ClientSdk.RuntimeControlPlaneTable
export type _NoRuntimeOutputTable =
  // @ts-expect-error `RuntimeOutputTable` is substrate, not a named client-barrel export
  ClientSdk.RuntimeOutputTable

// Reference the never-called footgun closures so noUnusedLocals stays happy
// without executing them (their type errors are evaluated by tsc regardless).
void _hostFootguns
void _clientFootguns

describe("misuse-resistance — negative footgun corpus (enforced by tsc)", () => {
  it("the wrong moves above do not compile (placeholder; real gate is `pnpm typecheck`)", () => {
    expect(typeof FiregridHost).toBe("function")
    expect(Effect.void).toBeDefined()
  })
})
