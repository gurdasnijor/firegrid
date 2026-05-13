# `effect-durable-operators` — Known Issues

Bugs and surprising-but-intentional behaviors in `DurableTable` that consumers
have hit. Each entry has a workaround. New entries are appended; resolved
entries are kept (marked **Resolved**) for at least a release cycle to help
people who lived through the bug recognize the fix.

---

## 1. `DurableTableCollectionFacade.get` misses rows with composite primary keys

**Status:** Resolved (Phase 0 DurableTable hardening).
**First observed by:** Firegrid `wait_for` implementation
(`packages/runtime/src/durable-tools/`, PR #171).

### Resolution

`encodeRowForStore` replaces the primary-key field on the stored row with its
schema-encoded string form before handing the row to TanStack DB, so the
internal index and the `.get(encodedKey)` lookup agree on the same wire
string. The pinned regression test for `Schema.transformOrFail` JSON-tuple
composite keys lives at:

- `packages/effect-durable-operators/test/durable-table.test.ts` —
  effect-durable-operators.TABLE.25

Consumers can call `.get(key)` directly. The `findWaitByKey` `.query.toArray`
scan in `packages/runtime/src/durable-tools/internal/table.ts` is the prior
workaround; it can be deleted in a follow-up runtime PR. Phase 0 hardening
intentionally does not bundle that runtime cleanup.

### Symptom (historical)

A collection whose primary key was declared with `Schema.transformOrFail` (a
typed composite key encoded as a JSON-tuple string) upserted successfully,
but `.get` on the same key returned `Option.none` while `.query.toArray`
returned the row decoded correctly.

### Root cause

The row stored in TanStack DB had its primary-key field set to the decoded
object, not the encoded string. TanStack derived the index key by
`String(row.primaryKey)` which produced `"[object Object]"`. `.get`
correctly encoded its lookup argument to the JSON-tuple string and missed.
The fix pre-encodes the primary-key field on the row at write time so the
index is keyed by the same string `.get` produces.

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

## 4. Synchronous boundary failures currently throw `FiberFailure`

**Status:** Resolved (Phase 0 DurableTable hardening).

### Resolution

`DurableTable` collection-view mutation rejection
(`DurableTable.ts → rejectMutation`) and React hook failure boundaries
(`react.ts → failReactHook`) now throw the typed error object directly:

```ts
throw new DurableTableError({ table, cause: ... })   // collection mutation
throw error                                          // React hook
```

Consumers can `instanceof DurableTableError` collection-view mutation
failures, and React error boundaries observe the original error rather than a
FiberFailure wrapper. Effect failures are reserved for actual Effect-returning
APIs.

Pinned by:

- effect-durable-operators.TABLE.23 (collection mutation rejection)
- effect-durable-operators.REACT.5 (React hook failure)

---

## 5. Primary-key encode path silently stringifies non-string encoded values

**Status:** Resolved (Phase 0 DurableTable hardening).

### Resolution

The `String(...)` fallback was removed from both the package-owned
`DurableTable.primaryKey` Schema.transform encode and the
`compileTable.encodePrimaryKey` action helper. Non-string encoded primary-key
values now fall through to `requireString`, which raises a typed
`DurableTableError` naming the durable type and field, e.g.

```text
DurableTable("badKey.rows") primary-key field "id" must encode to a string;
got number
```

Pinned by effect-durable-operators.TABLE.24.

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
