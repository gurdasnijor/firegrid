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
| (c) | STRUCTURAL substrate-leak guard | `scripts/public-surface-substrate-leak-check.mjs` | wired into `pnpm lint` (+ `lint:public-surface-leak`) |

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

## (c) Structural guard — substrate cannot leak onto the public barrels

`public-surface-substrate-leak-check.mjs` scans the public barrels
(`client-sdk` + `host-sdk`) and fails if a banned substrate symbol is
re-exported, with an explicit ALLOWLIST for documented escape hatches (each
tied to its tracking bead). Verified: clean run passes (reporting the tracked
debt); a negative control (re-exporting `SignalTable` from `host-sdk`) fails the
gate. Wired into `pnpm lint`.

Scope: guards re-EXPORTED NAMES (the common leak vector). Deep transitive
signature analysis (a substrate type inside an exported function signature) is a
future enhancement that would use the TS compiler API.

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
   `runtimeControlPlaneStreamUrl` re-export `RuntimeControlPlaneTable` /
   `RuntimeOutputTable`. The guard ALLOWLISTS them (tracked debt) rather than
   passing them silently; narrowing them behind channels is tf-8oaq.

## How to run

```
# (a) negative corpus + (b) positive — typecheck gate:
pnpm --filter @firegrid/runtime typecheck
# (b) positive runtime proof:
pnpm --filter @firegrid/runtime exec vitest run test/misuse-resistance-positive-lifecycle.test.ts
# (c) structural guard:
pnpm run lint:public-surface-leak
```

Pairs with the discipline PR (R1–R4 + methodology workbench / misuse-resistance
sections): together they make "hard to hold the hammer wrong" a CI gate.
