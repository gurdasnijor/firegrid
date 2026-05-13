# `effect-durable-operators` — Known Issues

Bugs and surprising-but-intentional behaviors in `DurableTable` that consumers
have hit. Each entry has a workaround. New entries are appended; resolved
entries are kept (marked **Resolved**) for at least a release cycle to help
people who lived through the bug recognize the fix.

---

## 1. `DurableTableCollectionFacade.get` misses rows with composite primary keys

**Status:** Open.
**First observed by:** Firegrid `wait_for` implementation
(`packages/runtime/src/durable-tools/`, PR #171).

### Symptom

A collection whose primary key is declared with `Schema.transformOrFail` (a
typed composite key encoded as a JSON-tuple string) is upserted successfully:

```ts
yield* table.waits.upsert({
  waitKey: { executionId: "exec-1", name: "approval" },
  /* ... */
})
```

But `.get` on the same key returns `Option.none`:

```ts
const got = yield* table.waits.get({ executionId: "exec-1", name: "approval" })
// Option.isNone(got) === true   ❌
```

Meanwhile, `.query.toArray` does return the row, decoded correctly:

```ts
const rows = yield* table.waits.query((coll) => coll.toArray)
// rows[0].waitKey === { executionId: "exec-1", name: "approval" }   ✅
```

### Root cause (suspected)

The `.get` path encodes the key through `Schema.encodeSync` and looks the
encoded string up in the TanStack collection's internal index. The internal
index appears to be keyed by something other than the same encoded string
(possibly stringified differently, or built before the encoding hook
finalized). `.query.toArray` round-trips through the read path, which decodes
correctly.

This has not yet been bisected against an upstream version (`@tanstack/db`,
`@durable-streams/state`, or Effect Schema).

### Workaround

Route all lookups through a `.query.toArray.find(...)` scan:

```ts
const findByKey = <Row, Key>(
  facade: DurableTableCollectionFacade<Row, Key>,
  match: (row: Row) => boolean,
) =>
  Effect.map(
    facade.query((coll) => coll.toArray),
    (rows) => Option.fromNullable(rows.find(match)),
  )

// Usage:
const wait = yield* findByKey(
  table.waits,
  (r) => r.waitKey.executionId === "exec-1" && r.waitKey.name === "approval",
)
```

This is O(rows) per lookup but acceptable for short-lived rows (waits,
deliveries, etc.). The Firegrid `wait_for` router exports a `findWaitByKey`
helper that follows this pattern; cross-reference
`packages/runtime/src/durable-tools/internal/table.ts` for the canonical
shape.

### Resolution plan

A follow-up PR should:

1. Reproduce in a focused unit test under
   `packages/effect-durable-operators/test/`.
2. Bisect `@tanstack/db` and `@durable-streams/state` versions to identify the
   regression (or confirm it has been present since composite-key support
   landed).
3. Either fix the `.get` index lookup to use the same encoding pass as
   write/query, or document that `.get` requires string-primitive keys only
   and direct composite-key consumers to a sanctioned `findByKey` helper.
4. Once `.get` is reliable, the `findWaitByKey` workaround in Firegrid's
   durable-tools package should be deleted in the same PR cycle.

---

## 2. `DurableTable.layer` cannot replace an in-scope handle

**Status:** Open by design (documented for clarity).

### Symptom

Calling `DurableTable.layer(...)` twice inside the same scope produces two
distinct services. There is no in-scope "swap to a new stream URL" path. Hot
config reload requires closing the outer scope and re-acquiring.

### Why this is by design

A layer swap mid-scope would need to coordinate preload, txid in-flight, and
the materializer close in a way that's safe under concurrent reads. The
v0 stance is that backing stream URL is application configuration and
changes only on restart.

### Workaround

Restart the application or service scope. For tests, build a fresh layer
per test and provide it via `Effect.scoped`.

---

## 3. `Schema.optional` fields on retained collections

**Status:** Documented behavior.

### Symptom

An optional field on a row schema (`Schema.optional(Schema.String)`) is
omitted from the row when not supplied. `subscribeChanges` events carry the
row as-is, including the absent field. Trigger DSLs that walk `row.payload`
must therefore treat absent fields as non-matches, not as `undefined`.

### Workaround

If you need a defaulted view, decode the row through a different schema (with
defaults) in the consumer, or normalize at write time. Do not assume the
collection re-applies defaults on read.

---

## How to add an entry to this file

When you hit a `DurableTable` (or wider operators-package) bug that survives
a re-read of the docs:

1. Add an entry here with **Status**, **Symptom**, **Root cause** (or
   "unknown"), **Workaround**, and **Resolution plan** sections.
2. Cross-reference the consuming package's runtime workaround so future
   maintainers can delete it when the upstream fix lands.
3. If the bug has a runtime workaround that other packages should adopt
   (like `findByKey`), promote the helper to a shared location in
   `effect-durable-operators` *once* a second consumer needs it.
