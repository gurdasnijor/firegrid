# SDD: Firegrid Host Surface

Status: draft — accepted framing, pending implementation review
Created: 2026-05-17
Owner: Firegrid Host SDK

Related:

- Beads DB (`bv --robot-triage`, join key `tfind:007`) → "Host SDK has layer
  factories, not a named host surface" (the toy-surfaced finding this resolves)
- `packages/host-sdk/src/host/layers.ts`
- Effect precedent: `@effect/platform-node` `NodeContext`, `@effect/platform-bun`
  `BunContext`, `@effect/platform` `HttpLayerRouter.Provided`

## Purpose

`host-sdk` exposes layer factories (`FiregridRuntimeHostLive`,
`FiregridLocalHostLive`, `FiregridRuntimeHostWithWorkflowLive`,
`FiregridRuntimeHostFromConfig`) and a scatter of capability tags owned by
`@firegrid/protocol` / `@firegrid/runtime`. It does **not** export a single
type a reader can point to and say "this is what a Firegrid host provides."
Every consumer — `apps/factory`, `apps/flamecast`, `packages/cli` bins,
host-sdk tests, firegrid scenarios, and now `tiny-firegrid` — re-derives the
host's provided rowset by inference. The toy surfaced this because its
discipline ("compose against public boundaries, return canonical types") has
no canonical host type to return; it had to invent a placeholder.

This SDD defines that named surface. It is a **type-surface addition with zero
behavior change**: no new runtime construct, no new service, no consumer
migration.

## Non-goals (explicitly rejected framings)

The original finding suggested a `Host` `Context.Tag` + `HostService`
interface enumerating host operations + a `Host.layer(config)` facade. **This
SDD rejects that shape.** Reasons:

1. The host is a *composition*, not a callable service. Its operations already
   exist as stable, separately-owned tags/functions: `RuntimeStartCapability`
   (start), the `Firegrid` client (prompt/wait), `appendRuntimeIngress`. There
   is no object you call host methods on.
2. A `Host` service enumerating those would be a **bridge** over capabilities
   that already have stable contracts — it commits to an unsettled "host is a
   service" reading and adds indirection that duplicates existing surfaces.
3. Effect itself never models a composed-layer surface as a service. The
   canonical pattern (`NodeContext`, `BunContext`, `HttpLayerRouter.Provided`)
   is a `@category models` **union type alias** co-exported with an explicitly
   annotated `Layer.Layer<ThatType>`. We follow precedent.

A `Host`-as-service reshape, if ever wanted, is tracked as a future finding,
not done here (Smallest Safe Down-Payment).

## Design

### The named type

Add to `host-sdk`, mirroring `NodeContext`:

```ts
/** @category models */
export type FiregridHost =
  | RuntimeStartCapability
  | CurrentHostSession
  | RuntimeControlPlaneTable
  | RuntimeOutputTable
```

Consumers annotate their own host handle with it:

```ts
const host: Layer.Layer<FiregridHost, …> =
  FiregridRuntimeHostLive({ … })
```

This is sound by `ROut` contravariance (below) without any change to the
factory signatures.

### Factory return annotation — DEFERRED (entangled with Finding 3)

The original plan also annotated the factory return types to
`Layer.Layer<FiregridHost, …>`. **Implementation surfaced that this is not
landable in isolation.** `FiregridRuntimeHostLive` currently *infers*
`Layer<any, DurableTableError, never>` — its `ROut` is `any`, which is the
open Finding 3 leak ("Workflow layer composition leaks type precision")
manifesting at this exact export. The host-sdk **test suite depends on that
`any`**: tests `Effect.provide(program, FiregridRuntimeHostWithWorkflowLive(…))`
where `program` requires host-*internal* tags
(`RuntimeContextWorkflowSession`, `RuntimeContextEngineRegistry`, …); the
`any` `ROut` silently discharges them. Pinning the factory return to *any*
precise type — the narrow public subset **or** the full provided union —
makes those internal requirements resurface and the test suite fails to
typecheck (`R` = `any` → not `never`).

Conclusion: naming the surface (this PR) and pinning the factory return are
**separable**, and the latter is **blocked on Finding 3**. The named type
alone fully closes the toy-surfaced Finding 1 ("one exported type a reader /
the toy can return"). The factory annotation is tracked as the second step,
gated on Finding 3 resolution. This is the Smallest Safe Down-Payment: it
does not commit to a precision-fix reading of the workflow composition that
is not yet settled.

### Why a narrowing annotation is sound

`FiregridRuntimeHostLive` actually provides `FiregridHost | <internal tags>`
(`RuntimeInputIntentDispatcher`, `RuntimeContextWorkflowSession`,
`RuntimeControlPlaneRecorder`, `PerContextRuntimeOutputWriter`,
`AgentToolHost`, `SandboxStdinEmissionClaim`,
`SandboxSupervisorCommandTable`, `RuntimeContextEngineRegistry`,
`RuntimeHostConfig`, `LocalProcessSandboxProvider`). `Layer`'s `ROut` is
**contravariant** (`effect/Layer`: `interface Layer<in ROut, …>`,
`Types.Contravariant<ROut>`). Therefore `Layer<FiregridHost | Internal>` is
assignable to `Layer<FiregridHost>`: the internal tags remain provided at
runtime but are erased from the type contract. This is exactly how
`NodeContext` declares precisely its public union over an implementation that
may compose more.

### Membership rule

`FiregridHost` unions a tag iff it is **(a)** provided by the host layer,
**(b)** already exported through a public entrypoint, and **(c)** something a
host *consumer* legitimately reads. Applying the rule:

| Tag | Provided | Public entrypoint | In `FiregridHost`? |
|---|---|---|---|
| `RuntimeStartCapability` | yes | `@firegrid/protocol/launch` | **yes** |
| `CurrentHostSession` | yes | `@firegrid/protocol/launch` | **yes** |
| `RuntimeControlPlaneTable` | yes | `@firegrid/protocol/launch` | **yes** |
| `RuntimeOutputTable` | yes | `@firegrid/protocol/launch` | **yes** |
| `RuntimeEnvResolverPolicy` | yes (provideMerge) | host-sdk index | **no** — supplied *to* the host, not consumed *from* it; fails (c). Stays the factory's `RIn`, not its `ROut` contract. |
| `RuntimeInputIntentDispatcher`, `RuntimeContextWorkflowSession`, `RuntimeControlPlaneRecorder`, `PerContextRuntimeOutputWriter`, `AgentToolHost`, `SandboxStdinEmissionClaim`, `SandboxSupervisorCommandTable`, `RuntimeContextEngineRegistry`, `RuntimeHostConfig`, `LocalProcessSandboxProvider` | yes | none (host-sdk internal) | **no** — fails (b); naming them would freeze internals as public surface (Public Surface Stability). |

This keeps `FiregridHost` to exactly the four protocol-public durable/control
surfaces a host consumer legitimately depends on.

## Risk and validation

Narrowing the *exported* type hides internal tags from the type system even
though they remain provided. A consumer whose program's required context
depends on a now-hidden internal tag *supplied by the host layer* would break
at compile time (runtime is unaffected).

Acceptance gate before merge:

1. `pnpm -w typecheck` (or package-scoped equivalent) passes across the repo
   with the annotation in place.
2. If any consumer fails to compile, it is reaching past the intended public
   host surface into an internal tag. That is **a new finding** (consumer
   boundary violation), recorded in Beads — not silently absorbed by
   widening `FiregridHost`. Scope of *this* PR does not expand to fix it.

Consumer scope for the landing PR (accepted): **type only, no migration.**
The annotation is non-breaking for well-behaved consumers; they gain a name
to adopt at their own pace. `tiny-firegrid` adoption is driven separately by
the maintainer, not by this PR.

## Acceptance criteria (as landed)

- `FiregridHost` exported from `@firegrid/host-sdk` as a `@category models`
  type, following the `NodeContext` shape. ✅
- Factory return annotation **deferred**, gated on Finding 3 (rationale
  above). Factory signatures unchanged. ✅
- `host-sdk` typecheck + full test suite green (96/96); no consumer
  migrated; consumer annotation against `FiregridHost` verified sound via
  contravariance probe. ✅
- New finding recorded: **host-sdk test suite depends on the Finding 3
  `any` `ROut` leak**, which links Finding 1's second step to Finding 3.
- Beads DB entry `tfind:007` carries the current state for "Host SDK has
  layer factories, not a named host surface"; use
  `FINDINGS_TRIAGE_RUBRIC.md` for the triage methodology.
