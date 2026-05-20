# Analysis B — Public Surface & Type Liveness

Generated 2026-05-20T10:09:08.164Z. Mechanical. 744 declared
types, three liveness columns added to `catalog.json`. No remediation.

## Method & honesty

- `is_public_export`: reachable from a package entry point
  (`package.json` `exports`/`main`), re-exports resolved by ts-morph
  `getExportedDeclarations()` (resolves `export *`). Entry files not
  found / resolution gaps: **0**. NOTE: a package
  whose entry does `export * from "./…"` makes everything transitively
  reachable PUBLIC by this definition — PUBLIC = *entry-reachable*, not
  *curated API*. Read the per-package table with that in mind.
- `is_value_referenced`: a reference in a value/expression position
  (heuristic — type-reference, type-query, import/export specifier and
  `implements` heritage are treated as type-only; everything else in an
  expression slot is value). Imperfect for ambiguous slots; stated.
- `is_test_referenced`: a reference from `*.test`/`*.spec`/`**/test/**`.
- **Plumbing excluded.** Import/export specifiers, re-export clauses and
  namespace im/exports are not counted as references — a type's own
  `export { X }` is not a "use". Without this, nothing is ever DEAD or
  TEST-ONLY (every exported type re-references itself through plumbing).
- Reference resolution via ts-morph `findReferencesAsNodes`; failures:
  **0** (counted, excluded — not silently dropped).
- Classification precedence: PUBLIC (entry-reachable) ▸ CROSS-PACKAGE
  (non-test referrer in another package, not public) ▸ INTERNAL
  (non-test referrer only in declaring package) ▸ TEST-ONLY ▸ DEAD
  (zero references anywhere). `is_value_referenced` is reported as a
  column but is orthogonal to the class (a type can be public yet only
  type-referenced).

## Totals by classification

| class | count | meaning |
|---|---|---|
| PUBLIC | 451 | reachable from a package entry point |
| CROSS-PACKAGE | 12 | consumed by another package but **not** via its public entry |
| INTERNAL | 281 | referenced only within its declaring package (non-test) |
| TEST-ONLY | 0 | referenced only from test files |
| DEAD | 0 | zero references anywhere |
| **total** | **744** | |

value-referenced (any class): 275 ·
test-referenced: 0

## Per-package surface

| package | total | PUBLIC | INTERNAL | CROSS-PKG | TEST-ONLY | DEAD |
|---|---|---|---|---|---|---|
| packages/cli | 8 | 1 | 7 | 0 | 0 | 0 |
| packages/client-sdk | 24 | 21 | 3 | 0 | 0 | 0 |
| packages/effect-durable-operators | 30 | 9 | 20 | 1 | 0 | 0 |
| packages/effect-durable-streams | 46 | 29 | 17 | 0 | 0 | 0 |
| packages/host-sdk | 107 | 40 | 56 | 11 | 0 | 0 |
| packages/protocol | 237 | 225 | 12 | 0 | 0 | 0 |
| packages/runtime | 155 | 123 | 32 | 0 | 0 | 0 |
| packages/tiny-firegrid | 137 | 3 | 134 | 0 | 0 | 0 |

## CROSS-PACKAGE — consumed past a package's public entry (first 30)

- `packages/effect-durable-operators::LayerOptions` (interface)
- `packages/host-sdk::RuntimeHostConfig` (context-tag)
- `packages/host-sdk::PerContextRuntimeOutputWriter` (context-tag)
- `packages/host-sdk::PerContextRuntimeOutputWriterLive` (layer-instance)
- `packages/host-sdk::PerContextRuntimeAgentOutputAfterEventsLive` (layer-instance)
- `packages/host-sdk::ActiveRuntimeContextEngine` (interface)
- `packages/host-sdk::RuntimeContextEngineRegistry` (context-tag)
- `packages/host-sdk::RuntimeContextWorkflowSession` (context-tag)
- `packages/host-sdk::RuntimeContextWorkflowExecutionEnv` (type-alias)
- `packages/host-sdk::RuntimeExitEvidence` (type-alias)
- `packages/host-sdk::RuntimeContextWorkflowPayload` (schema-struct)
- `packages/host-sdk::StartRuntimeResultSchema` (schema-struct)


## DEAD — zero resolved references (first 30)

(none)


## TEST-ONLY (first 30)

(none)

