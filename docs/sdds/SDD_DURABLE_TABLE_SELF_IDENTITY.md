# SDD: DurableTable Self-Identity (TFIND-005)

Status: draft — framing-gated; NO production code until coordinator review + Gurdas framing signoff

Finding: TFIND-005 — `DurableTable.layer` leaks `any` through Layer ROut,
poisoning every host/engine composition that merges a table layer.

## Purpose

`defineDurableTable` erases each table's type identity to `any` at its
return. Every `<Table>.layer(...)` therefore infers
`Layer.Layer<any, DurableTableError, never>`. Merging any such layer into
a host/engine composition collapses that composition's requirements
channel — the `any` silently discharges *unrelated* required tags, so
genuine missing-dependency errors do not surface at the type level.

This SDD establishes the root cause, proves why the two "cheap" fixes
fail (one inert, one **type-unsound**), specifies the canonical fix, and
plans the one-transaction migration.

## The crux — lead here (why the cheap fixes are not options)

Two fixes look obvious. Both are rejected, and *why* the second is
rejected is the load-bearing argument for accepting a breaking change.

### Cheap fix A — `this`-polymorphic `.layer` (INERT, proven)

Give the declared `.layer` a polymorphic `this`:

```ts
readonly layer: <Self>(
  this: Context.Tag<Self, DurableTableService<Schemas>>,
  options: LayerOptions,
) => Layer.Layer<Self, DurableTableError>
```

Implemented on `sidecar/workflow-layer-precision`; full `pnpm typecheck`
17/17 green. A type probe disproved it:

```ts
type IsAny<T> = 0 extends 1 & T ? true : false
const l = WorkflowEngineTable.layer(/* … */)
type ROut = typeof l extends Layer.Layer<infer R, any, any> ? R : never
const _: false = (null as unknown as IsAny<ROut>)  // ERROR: 'true' not assignable to 'false'
```

`ROut` is still `any`. Reason: `WorkflowEngineTable`'s static tag
Identifier was already erased to `any` by the `defineDurableTable`
return cast. A polymorphic `this` infers `Self` *from* `typeof
WorkflowEngineTable`, whose Identifier is `any`, so `Self = any`. You
cannot recover identity that was destroyed upstream. (The green
typecheck also tells us no consumer currently *relies* on the `any` —
relevant to migration risk, below.)

### Cheap fix B — return precise `typeof DurableTableTag` (TYPE-UNSOUND)

Drop the cast and return the precise internal class type so `Self`
flows. This is **worse than the leak** and is the central reason a
breaking API change is justified.

In Effect, a tag's *type-level* identity is its `Self`/Identifier type
parameter — **not** the runtime key string. The internal class is built
once as:

```ts
class DurableTableTag extends Context.Tag(tagKey)<DurableTableTag, DurableTableService<Schemas>>() { … }
```

Every table is produced from this same internal class shape. If
`defineDurableTable` returns `typeof DurableTableTag`, then **all tables
share `DurableTableTag` as their Identifier type**. Structurally:

- `WorkflowEngineTable` ⇒ Identifier `DurableTableTag`
- `RuntimeOutputTable` ⇒ Identifier `DurableTableTag`
- … all six ⇒ the *same* Identifier type

Consequence: `RuntimeOutputTable.layer()` produces
`Layer<DurableTableTag, …>`, which **type-satisfies a requirement for
`WorkflowEngineTable`**. Providing the wrong table's layer would
typecheck. The runtime keys differ (so runtime resolution fails or
mis-resolves), but the type system would no longer catch it. The current
`any` leak is permissive; this would be *actively wrong* — it asserts a
false equivalence between distinct tables. Rejected.

### Conclusion

Per-table identity cannot be expressed while `defineDurableTable(ns,
schemas)` returns a single non-generic class type. The consumer must
contribute its own nominal identity. That requires an API/signature
change — which is why this is architectural, not plumbing.

## Non-goals (explicitly rejected framings)

- **Widening back to `any`** to keep consumers compiling. The leak is
  the bug.
- **Returning `typeof DurableTableTag`** — unsound (see crux B).
- **Per-call-site casts** at the 6 consumers — pushes the unsafe cast
  outward, same erasure, more surface.
- **Fixing consumers that fail typecheck post-change** beyond the
  mechanical idiom migration. If a consumer fails because it genuinely
  required a tag the `any` was silently discharging, that is a NEW
  finding to report, not to paper over (dispatch discipline).

## Design

### Chosen fix — canonical self-referential Tag idiom

Mirror Effect's own `Context.Tag` / `Effect.Service` pattern: the
consumer passes itself as the identity.

Consumer call sites change from:

```ts
export class WorkflowEngineTable extends DurableTable("firegrid.workflow", schemas) {}
```

to:

```ts
export class WorkflowEngineTable extends DurableTable("firegrid.workflow", schemas)<WorkflowEngineTable>() {}
```

`defineDurableTable` becomes curried: the first call binds
`(namespace, schemas)`; the second `<Self>()` call binds the consumer's
own class as the tag Identifier and constructs the class.

### Exact signature change

`packages/effect-durable-operators/src/DurableTable.ts`:

```ts
// before (~986, ~1016)
const defineDurableTable = <const Schemas extends TableSchemas<Schemas>>(
  namespace: string,
  schemas: Schemas,
): DurableTableTagClass<Schemas> => {
  const table = compileTable(namespace, schemas)
  class DurableTableTag extends Context.Tag(tagKey)<DurableTableTag, DurableTableService<Schemas>>() { … }
  return DurableTableTag as unknown as DurableTableTagClass<Schemas>
}

// after
const defineDurableTable =
  <const Schemas extends TableSchemas<Schemas>>(namespace: string, schemas: Schemas) =>
  <Self>(): DurableTableTagClass<Schemas, Self> => {
    const table = compileTable(namespace, schemas)
    class DurableTableTag extends Context.Tag(tagKey)<Self, DurableTableService<Schemas>>() { … }
    return DurableTableTag as unknown as DurableTableTagClass<Schemas, Self>
  }
```

- `DurableTableTagClass<Schemas, Self>` already takes `Self` (currently
  defaulting to `any`); the default is **removed** so omission is a
  compile error, not a silent `any`.
- One residual `as unknown as` cast remains but now carries the *real*
  `Self` — the consumer's nominal class — so no identity is erased.
- `Object.assign(defineDurableTable, { primaryKey, … })` (~1019) is
  unaffected: `DurableTable.primaryKey` etc. remain statics on the outer
  function object; only the call shape of the table factory changes.
- Zero runtime/behavior change: `Layer.scoped(this, …)`, `tagKey`,
  `compileTable`, service construction are untouched. Purely the type of
  the value flowing out, plus a second (type-only) call.

### Why this is sound

Each consumer class is a distinct nominal type. Passing `<Self>` makes
that class its own tag Identifier (exactly how `class X extends
Context.Tag("x")<X, S>()` works). `X.layer()` ⇒ `Layer<X,
DurableTableError>`; `yield* X` ⇒ requirement `X`. Distinct tables are
distinct types — no unification (crux B avoided), no erasure (cheap fix
A avoided).

## Call-site inventory (current origin/main `a38da9781`, post-#322)

**Production — 6 tag classes / 5 files:**

| File | Class |
| --- | --- |
| `packages/runtime/src/workflow-engine/internal/table.ts:76` | `WorkflowEngineTable` |
| `packages/runtime/src/verified-webhook-ingest/table.ts:49` | `VerifiedWebhookFactTable` |
| `packages/runtime/src/agent-event-pipeline/sources/sandbox/supervisor-commands.ts:22` | `SandboxSupervisorCommandTable` |
| `packages/runtime/src/durable-tools/internal/table.ts:97` | `DurableToolsTable` |
| `packages/protocol/src/launch/table.ts:187` | `RuntimeControlPlaneTable` |
| `packages/protocol/src/launch/table.ts:192` | `RuntimeOutputTable` |

**Tests — 14 occurrences / 4 files** (must migrate in the same
transaction or typecheck breaks):

- `packages/effect-durable-operators/test/durable-table.test.ts` (bulk —
  multiple inline `extends DurableTable(...)` classes)
- `packages/effect-durable-operators/test/react-types.test.ts`
- `packages/host-sdk/test/agent-tools/tool-use-to-effect.test.ts`
- `packages/runtime/test/durable-tools/WaitFor.test.ts`

Each migrates mechanically: append `<ClassName>()` to the `extends
DurableTable(...)` clause.

## Sequencing — dependency RESOLVED (challenge to the dispatch)

The dispatch directed: "recommend #322 lands FIRST so this is 6 sites
not 7; scope the SDD for the post-#322 world." **#322 has already
merged.** Current `origin/main` is `a38da9781` ("refactor(protocol):
drop dead RuntimeIngressTable surface (#322)"); #324 also merged
(`82b69699b`). `RuntimeIngressTable` no longer exists (`grep` count 0).

Therefore:

- The sweep is **already** the post-#322 world: 6 classes / 5 files. No
  blocking dependency, no soon-deleted code to migrate.
- **SHA discrepancy flagged:** the dispatch stated origin/main is
  `c67251236`. It is not — `c67251236` is an older docs commit
  ("TFIND-005 blocked …"); the actual tip is `a38da9781`. The worktree
  has been rebased onto the *real* tip, not the cited SHA. Coordinator's
  world model was stale; recommend re-syncing before review.

No fallback plan needed (the contingency it guarded against cannot
occur).

## Migration plan (one transaction)

1. `DurableTable.ts`: curry `defineDurableTable`; thread `Self` into
   `Context.Tag` and the return cast; drop the `Self = any` default on
   `DurableTableTagClass`.
2. Migrate the 6 production classes: append `<ClassName>()`.
3. Migrate the 14 test occurrences: append `<ClassName>()`.
4. No other production code changes. Any consumer that fails typecheck
   for a reason *other* than the missing `<Self>()` idiom = NEW finding,
   reported to coordinator, not fixed here.

Single PR; per-file commits grouped (lib change, runtime sites, protocol
sites, tests).

## Risk and validation

- **Latent leaks:** cheap-fix-A's green 17/17 typecheck shows no consumer
  currently leans on the `any` for `.layer` ROut. Tightening is expected
  to be clean; any surfaced requirement leak is a real pre-existing bug
  to report, not suppress.
- **Verification (macOS — NO `timeout` command; never wrap):**
  - `pnpm typecheck` (turbo, all workspaces) — must stay green
  - `pnpm run lint` (full chain)
  - Affected suites: `effect-durable-operators` (durable-table,
    react-types), `runtime` (workflow-engine, durable-tools/WaitFor,
    verified-webhook-ingest, agent-event-pipeline), `host-sdk`
    (start-runtime, sync-run-integration, authority-context,
    tool-use-to-effect), `protocol`
  - Re-run the `IsAny<ROut>` probe against ≥2 distinct tables and assert
    (a) ROut is the concrete class, (b) two different tables' ROut are
    **not** mutually assignable (proves crux B is closed). Probe is
    throwaway — not committed.

## Acceptance criteria

- `<Table>.layer(...)` infers `Layer<<Table>, DurableTableError>` for all
  6 production tables; `IsAny` probe false; cross-table ROut
  non-assignable.
- Omitting `<Self>()` is a compile error (no silent `any` default).
- Zero runtime/behavior change; all gates green; no scope creep beyond
  the mechanical idiom migration.
- New requirement leaks (if any) filed as separate findings.

## Open question for framing signoff

The fix makes `DurableTable` a two-step (`(ns, schemas)<Self>()`)
factory. This matches Effect's `Context.Tag`/`Effect.Service`
ergonomics, but it is a public API shape change for
`effect-durable-operators`. Confirm the curried-call ergonomic is the
accepted public surface (vs. e.g. an options-object or a named
`.tag<Self>()` method) before any production code is written.
