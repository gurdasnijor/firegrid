# Misuse-resistance proof suite (tf-r06u.27) — PR note

Demonstrates the §9 misuse-resistance design of
`SDD_FIREGRID_GATEWAY_SEPARATION_OF_CONCERNS` against the **current** public
surface: makes "hard to hold the hammer wrong" a **gate**, not a hope. Three
artifacts, each verified.

Base: `sim/unified-kernel-validation` (#765 trunk).

## Artifacts

| # | Artifact | File | Gated by |
|---|---|---|---|
| (a) | NEGATIVE `@ts-expect-error` footgun corpus | `packages/runtime/test/misuse-resistance-footguns.test.ts` | `pnpm typecheck` (runtime) |
| (b) | POSITIVE full-lifecycle expressibility + composition proof | `packages/runtime/test/misuse-resistance-positive-lifecycle.test.ts` | `pnpm typecheck` + `vitest` (real server) |
| (c) | STRUCTURAL substrate-leak gate | the F3 block of the corpus (the **type checker**) — no bespoke script | `pnpm typecheck` (runtime) |

### Placement decision (important)
The corpus lives in **`packages/runtime/test/`**, NOT `tiny-firegrid/test/` as
the dispatch suggested — because **`tiny-firegrid`'s tsconfig excludes `test/`**
(`include: ["src/**/*.ts"]`), so an `@ts-expect-error` there is **inert** (never
seen by `tsc`). `runtime`'s tsconfig includes `test/**`, so `pnpm typecheck`
actually evaluates the directives. Importing `@firegrid/client-sdk` here also
consumes a dependency `runtime` already declares (currently flagged unused by
knip). Verified by a sanity control: injecting a real unsuppressed type error
makes `tsc` fail citing the file; removing it returns to green with all
`@ts-expect-error` directives active (none unused).

## (a) Footguns now provably NON-COMPILING (the wins)

Each is a genuine `tsc` error suppressed by `@ts-expect-error`; if any starts
compiling, typecheck fails.

| ID | Misuse (against the public surface) | Why it can't compile |
|---|---|---|
| **F1** | `FiregridHost({ namespace, codec })` — omit `durableStreamsBaseUrl` | required option missing → a half-wired host doesn't type-check |
| **F2** | `FiregridHost({ namespace, durableStreamsBaseUrl })` — neither `adapter` nor `codec` | options union requires a runtime block |
| **F3** | `import`/reference `SignalTable` / `UnifiedTable` / `WorkflowEngine` / `DurableTable` from `@firegrid/client-sdk` | substrate is not on the client barrel |
| **F4** | `firegrid.deregister(...)` / `firegrid.startOrAttach(...)` | host-only ops absent from the client service |
| **F5** | `firegrid.sessions.createOrLoad(SignalTable)` | a substrate handle is not a valid typed request |
| **F6** | `firegrid.prompt(42)` | wrong request type to a typed verb |

Maps to §9.1 obligations: F1/F2 → (1) total composition; F3/F5 → (4) no
substrate in public signatures; F4 → (5) client can't express host-only ops;
F6 → typed-verb safety.

## (b) Positive proof — the full lifecycle IS expressible through client-sdk only

- **Expressibility (compile-gated):** `fullLifecycleThroughClientSdk` drives
  `createOrLoad → start → prompt → wait.forAgentOutput → permissions.respond →
  snapshot` using ONLY `@firegrid/client-sdk` verbs + public input types; its
  sole requirement is the `Firegrid` Tag (no substrate in scope).
- **Composition (compile-gated):** `_compositionProof` asserts the host env
  `FiregridLive ∘ FiregridHost ∘ FiregridConfig` is a total
  `Layer<Firegrid, _, never>` — requirement channel `never`. If the env left any
  requirement (leaked substrate Tag, unbound channel), it would not compile.
  This is the pit-of-success expressed in types: the client needs nothing but
  the public surface.
- **Runtime (trace-not-verdict):** over a real `DurableStreamTestServer`, the
  same env is built airgapped (recorder adapter — no subprocess) and the
  `Firegrid` client service is materialized — proving the surface composes
  against a real durable backend, not just in the type-checker.

Scope (honest): this proves **expressibility + composition + real
materialization**. It does NOT drive a live full turn (agent output / permission
rendezvous) — that is the production-flow ACP scenario's job and depends on
read-side + choreography-dispatch wiring tracked as the #765 completeness beads.
Coupling this proof to that incomplete wiring would weaken it; the value here is
the surface proof.

## (c) Structural gate — substrate cannot leak onto the public barrels

**The type checker IS the structural gate** (the F3 block of the negative
corpus), not a bespoke script. An earlier draft hand-rolled a regex
`public-surface-substrate-leak-check.mjs`; per review ("better static tooling
solutions available here") it was **removed**. The reasons the type system is
the right tool here:

- **It is symbol-aware and resolution-correct.** F3 asserts `SignalTable`,
  `UnifiedTable`, `WorkflowEngine`, `DurableTable`, `RuntimeControlPlaneTable`,
  `RuntimeOutputTable` are not on the `@firegrid/client-sdk` barrel via
  `@ts-expect-error ClientSdk.<Name>`. This catches `as`-aliased and `export *`
  re-exports that a regex or a semgrep export-pattern would miss.
- **dependency-cruiser does NOT reliably cover this.** I tested the existing
  `client-sdk-no-runtime` rule as a control: appending
  `export { SignalTable } from "@firegrid/runtime/unified"` to the client barrel
  and running the full CI cruise (`depcruise … packages`) produced **no
  violation** — workspace packages resolve through the `node_modules` symlink
  under `doNotFollow: node_modules`, so the `^packages/runtime/src` `to` path
  never matches. (A pre-existing rule limitation, flagged, not fixed here.) The
  type checker has no such blind spot — it resolves the package `exports` → src
  and knows the symbol isn't there.

The module-boundary intent of dep-cruiser still holds for *intra-package* tiers
(it gates runtime's own folder tiers well); it's the cross-workspace barrel
re-export that needs the type gate.

Residual (honest): F3 enumerates the key substrate symbols rather than a fully
generic net. A generic "no substrate-named export on the barrel" rule would need
an escape-hatch allowlist regardless of tool (semgrep/ast-grep/regex), because
the tf-8oaq escape hatches are legitimately present today — so it buys little
over the enumerated type gate. Adding symbols to F3 is a one-line change.

## What still compiles that arguably SHOULDN'T (gaps the suite surfaced)

The proof suite is also a measurement. Two misuses are **not yet** non-compiling
— honest follow-ups, not silently passed:

1. **Channel direction / payload are not type-enforced (§9 obligation 5 — UNMET
   at the client facade).** `FiregridChannelsClient.send/call/waitFor` are typed
   `(target: string, payload: unknown)`. A wrong-direction call, or a
   substrate-shaped `unknown` payload, still compiles. Closing this needs
   direction-typed channel targets on the public client surface. → follow-up
   bead.
2. **Documented substrate escape hatches still on the client barrel (tf-8oaq).**
   `FiregridRuntimeTables` / `firegridRuntimeTableTags` /
   `runtimeControlPlaneStreamUrl` are escape-hatch VALUES wrapping
   `RuntimeControlPlaneTable` / `RuntimeOutputTable`. F3 asserts the substrate
   TYPE names are not on the barrel; narrowing the value escape hatches behind
   channels is tf-8oaq.

## How to run

```
# (a) negative corpus + (b) positive + (c) F3 type gate — all via typecheck:
pnpm --filter @firegrid/runtime typecheck
# (b) positive runtime proof:
pnpm --filter @firegrid/runtime exec vitest run test/misuse-resistance-positive-lifecycle.test.ts
```

Pairs with the discipline PR (R1–R4 + methodology workbench / misuse-resistance
sections): together they make "hard to hold the hammer wrong" a CI gate.
