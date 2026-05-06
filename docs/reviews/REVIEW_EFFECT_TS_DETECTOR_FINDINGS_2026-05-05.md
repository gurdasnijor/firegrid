# Effect TS Detector Findings - Firegrid - 2026-05-05

## Scope

Ran the ts-morph finder adapter from `effect-ts-detectors` against Firegrid production TypeScript source on 2026-05-05.

Command shape:

```sh
bun -e 'import { findInPath } from "/Users/gnijor/gurdasnijor/claude-skill-effect-ts/effect-ts-detectors/src/index.ts"; /* findInPath("/Users/gnijor/gurdasnijor/firegrid", config) */'
```

Config:

- Included: `**/*.ts`, `**/*.tsx`
- Excluded: `node_modules`, `dist`, declarations, `__tests__`, `*.test.ts(x)`, `test-support`, `semgrep-tests`
- Certainty: definite findings only; potential findings were not included
- Files analyzed: 68
- Violations: 277
- Detector errors: 1

## Executive Findings

1. The largest concrete bucket is typed error modeling: `errors/rule-002` reported 83 uses of `Data.TaggedError` or raw `throw` shapes that the detector wants migrated to `Schema.TaggedError` / `Effect.fail`. This count is inflated because a single class can be reported at both the class and constructor expression, but the pattern is real across substrate/runtime/client/lab code.
2. Conditional style findings dominate the raw count: `conditionals/rule-006` and `conditionals/rule-010` together reported 98 instances. These are mostly nullish checks and ternaries that should be reviewed before changing mechanically; many are small boundary-shape decisions rather than correctness defects.
3. Async escape hatches remain in production code: `async/rule-005` and `async/rule-008` reported 22 instances, notably in stream/client/lab paths. These are better remediation candidates than broad conditional rewrites because they cross the Effect boundary directly.
4. Imperative loops and direct discriminant checks are present but bounded. These are good candidates for focused cleanup after error modeling and async boundary work.
5. One detector crashed on `packages/client/src/firegrid/event-client.ts`: `native-apis/rule-001-array-operations` attempted to construct a violation with an undefined message. Treat that as detector debt before making this scan a blocking Firegrid gate.

## Counts By Rule

| Rule | Count |
| --- | ---: |
| errors/rule-002 | 83 |
| conditionals/rule-006 | 69 |
| conditionals/rule-010 | 29 |
| async/rule-005 | 15 |
| imperative/rule-004 | 12 |
| imperative/rule-005 | 12 |
| schema/rule-015 | 10 |
| discriminated-unions/rule-001 | 8 |
| conditionals/rule-001 | 8 |
| code-style/rule-002 | 7 |
| async/rule-008 | 7 |
| errors/rule-004 | 4 |
| native-apis/rule-003 | 4 |
| errors/rule-006 | 3 |
| errors/rule-005 | 2 |
| native-apis/rule-002 | 2 |
| imperative/rule-002 | 1 |
| imperative/rule-006 | 1 |

## Counts By Workspace

| Workspace | Count |
| --- | ---: |
| packages/substrate | 163 |
| packages/runtime | 48 |
| apps/lab | 37 |
| packages/client | 29 |

## Top Files By Finding Count

| File | Count |
| --- | ---: |
| packages/substrate/src/event-plane/producer.ts | 26 |
| apps/lab/src/lab/RawStreamInspector.tsx | 21 |
| packages/substrate/src/subscribers.ts | 14 |
| packages/client/src/firegrid/operation-client.ts | 13 |
| packages/runtime/src/runtime/internal/event-stream-materializer.ts | 13 |
| packages/runtime/src/runtime/internal/operation-handler.ts | 13 |
| packages/substrate/src/schema/state-machine.ts | 12 |
| packages/substrate/src/event-plane/projection.ts | 10 |
| apps/lab/src/lab/LabEventStreamPanel.tsx | 10 |
| packages/substrate/src/producer.ts | 9 |
| packages/client/src/firegrid/event-client.ts | 9 |
| packages/runtime/src/runtime/internal/runner.ts | 9 |
| packages/substrate/src/operator-errors.ts | 8 |
| packages/substrate/src/operator.ts | 8 |
| packages/substrate/src/stream.ts | 8 |
| packages/substrate/src/waits.ts | 8 |
| packages/substrate/src/choreography/service.ts | 7 |
| packages/substrate/src/choreography/tools.ts | 7 |
| apps/lab/src/main.tsx | 6 |
| packages/substrate/src/choreography/triggers.ts | 6 |

## Detector Error

```text
packages/client/src/firegrid/event-client.ts
native-apis/rule-001-array-operations: NativeApisViolation (Constructor)
└─ ["message"]
   └─ Expected string, actual undefined
```

This is not a Firegrid source error. It means the finder adapter successfully reached the file, but the underlying detector rule has an invalid violation-builder path for at least one matched native API shape.

## Recommended Remediation Order

1. Fix detector crash first if the scan is going to become a CI or review gate. Otherwise one rule can hide findings in affected files.
2. Normalize typed error classes in substrate/runtime/client production code. Prefer one package-level slice at a time because `Schema.TaggedError` changes public error constructors and inferred error channels.
3. Convert async/await boundary functions that interact with storage, process I/O, or clients into explicit Effect-returning APIs, or wrap unavoidable Promise APIs at the edge with `Effect.tryPromise`.
4. Clean imperative loops where the loop is pure transformation or filtering. Avoid changing loops that encode state-machine transitions until there is a targeted test around the transition behavior.
5. Treat conditionals/ternaries as style debt, not automatic correctness debt. Refactor only where `Option`, `Either`, or `Match` improves exhaustiveness or removes duplicated nullish handling.

## Representative Locations

### errors/rule-002
- packages/substrate/src/operator-errors.ts:9:1 - Class extends Data.TaggedError; use Schema.TaggedError
- packages/substrate/src/operator-errors.ts:9:39 - Data.TaggedError; use Schema.TaggedError for full Schema compatibility
- packages/substrate/src/operator-errors.ts:14:1 - Class extends Data.TaggedError; use Schema.TaggedError
- packages/substrate/src/operator-errors.ts:14:46 - Data.TaggedError; use Schema.TaggedError for full Schema compatibility
- packages/substrate/src/operator-errors.ts:20:1 - Class extends Data.TaggedError; use Schema.TaggedError
- packages/substrate/src/operator-errors.ts:20:46 - Data.TaggedError; use Schema.TaggedError for full Schema compatibility
- packages/substrate/src/operator.ts:65:1 - Class extends Data.TaggedError; use Schema.TaggedError
- packages/substrate/src/operator.ts:65:39 - Data.TaggedError; use Schema.TaggedError for full Schema compatibility

### async/rule-005
- packages/substrate/src/stream.ts:52:12 - Async functions should be converted to Effect
- packages/substrate/src/stream.ts:54:9 - Await expressions should be replaced with Effect.flatMap or yield*
- packages/substrate/src/stream.ts:80:1 - Async functions should be converted to Effect
- packages/substrate/src/stream.ts:85:5 - Await expressions should be replaced with Effect.flatMap or yield*
- packages/substrate/src/event-plane/producer.ts:117:14 - Async functions should be converted to Effect
- packages/substrate/src/event-plane/producer.ts:118:21 - Await expressions should be replaced with Effect.flatMap or yield*
- apps/lab/src/lab/LabEventStreamPanel.tsx:92:10 - .then() chains should be replaced with Effect.map/flatMap
- apps/lab/src/lab/RawStreamInspector.tsx:42:17 - Async functions should be converted to Effect

### async/rule-008
- packages/substrate/src/stream.ts:52:12 - async arrow function; use Effect.gen instead
- packages/substrate/src/stream.ts:80:1 - async function declaration; use Effect.gen instead
- packages/substrate/src/event-plane/producer.ts:117:14 - async arrow function; use Effect.gen instead
- apps/lab/src/lab/RawStreamInspector.tsx:42:17 - async arrow function; use Effect.gen instead
- packages/runtime/src/runtime/internal/event-stream-materializer.ts:97:12 - async arrow function; use Effect.gen instead
- packages/runtime/src/runtime/internal/event-stream-materializer.ts:113:34 - async arrow function; use Effect.gen instead
- packages/runtime/src/runtime/internal/stream-resolver.ts:61:16 - async arrow function; use Effect.gen instead

### errors/rule-005
- packages/substrate/src/stream.ts:84:3 - try/catch with await; use Effect.tryPromise instead
- apps/lab/src/lab/RawStreamInspector.tsx:43:7 - try/catch with await; use Effect.tryPromise instead

### errors/rule-006
- packages/substrate/src/stream.ts:84:3 - try/catch blocks should be replaced with Effect.try()
- apps/lab/src/lab/RawStreamInspector.tsx:43:7 - try/catch blocks should be replaced with Effect.try()
- apps/lab/src/lab/RawStreamInspector.tsx:66:9 - catch clause has untyped error parameter

### imperative/rule-004
- packages/substrate/src/operator-errors.ts:32:3 - for...of loop; use Array module functions instead
- packages/substrate/src/retained-records.ts:54:5 - for...of loop; use Array module functions instead
- packages/substrate/src/event-plane/define.ts:44:3 - for...of loop; use Array module functions instead
- packages/substrate/src/event-plane/producer.ts:86:5 - for...of loop; use Array module functions instead
- packages/substrate/src/event-plane/projection.ts:105:3 - for...of loop; use Array module functions instead
- packages/substrate/src/projection/ready-work.ts:16:3 - for...of loop; use Array module functions instead
- packages/substrate/src/schema/state-machine.ts:327:3 - for...of loop; use Array module functions instead
- apps/lab/src/lab/RawStreamInspector.tsx:49:9 - for...of loop; use Array module functions instead

### imperative/rule-005
- packages/substrate/src/operator-errors.ts:32:3 - Use Effect.forEach or Array methods instead of for...of loops
- packages/substrate/src/retained-records.ts:54:5 - Use Effect.forEach or Array methods instead of for...of loops
- packages/substrate/src/event-plane/define.ts:44:3 - Use Effect.forEach or Array methods instead of for...of loops
- packages/substrate/src/event-plane/producer.ts:86:5 - Use Effect.forEach or Array methods instead of for...of loops
- packages/substrate/src/event-plane/projection.ts:105:3 - Use Effect.forEach or Array methods instead of for...of loops
- packages/substrate/src/projection/ready-work.ts:16:3 - Use Effect.forEach or Array methods instead of for...of loops
- packages/substrate/src/schema/state-machine.ts:327:3 - Use Effect.forEach or Array methods instead of for...of loops
- apps/lab/src/lab/RawStreamInspector.tsx:49:9 - Use Effect.forEach or Array methods instead of for...of loops

### code-style/rule-002
- packages/substrate/src/producer.ts:108:9 - 'as unknown as T' double assertion; use Schema validation
- packages/substrate/src/producer.ts:113:14 - 'as unknown as T' double assertion; use Schema validation
- apps/lab/src/main.tsx:24:3 - 'as unknown as T' double assertion; use Schema validation
- packages/substrate/src/event-plane/define.ts:45:17 - 'as unknown as T' double assertion; use Schema validation
- packages/substrate/src/event-plane/producer.ts:74:9 - 'as unknown as T' double assertion; use Schema validation
- packages/substrate/src/event-plane/producer.ts:88:31 - 'as unknown as T' double assertion; use Schema validation
- packages/runtime/src/runtime/internal/event-stream-materializer.ts:153:32 - 'as unknown as T' double assertion; use Schema validation

### discriminated-unions/rule-001
- packages/substrate/src/projection-service.ts:75:9 - Direct ._tag access; use Match.tag() or Schema.is() instead
- packages/substrate/src/choreography/triggers.ts:85:3 - switch on ._tag should use Match.tag() for exhaustive matching
- packages/substrate/src/choreography/triggers.ts:85:11 - Direct ._tag access; use Match.tag() or Schema.is() instead
- apps/lab/src/lab/LabEventStreamPanel.tsx:93:7 - if statement checking ._tag should use Match.tag()
- apps/lab/src/lab/LabEventStreamPanel.tsx:93:11 - Direct ._tag access; use Match.tag() or Schema.is() instead
- packages/runtime/src/runtime/internal/operation-handler.ts:134:11 - if statement checking ._tag should use Match.tag()
- packages/runtime/src/runtime/internal/operation-handler.ts:134:15 - Direct ._tag access; use Match.tag() or Schema.is() instead
- packages/runtime/src/runtime/internal/operation-handler.ts:161:32 - Direct ._tag access; use Match.tag() or Schema.is() instead

### conditionals/rule-006
- packages/substrate/src/internal-claim.ts:54:5 - Null/undefined checks should use Option.match
- packages/substrate/src/internal-claim.ts:77:5 - Null/undefined checks should use Option.match
- packages/substrate/src/operator.ts:115:11 - Null check ternary should use Option.match or Option.getOrElse
- packages/substrate/src/operator.ts:118:11 - Null check ternary should use Option.match or Option.getOrElse
- packages/substrate/src/operator.ts:135:5 - Null/undefined checks should use Option.match
- packages/substrate/src/operator.ts:154:5 - Null/undefined checks should use Option.match
- packages/substrate/src/producer.ts:106:3 - Null/undefined checks should use Option.match
- packages/substrate/src/producer.ts:136:15 - Null check ternary should use Option.match or Option.getOrElse

### conditionals/rule-010
- packages/substrate/src/operator.ts:168:7 - Use Match module or Option instead of ternary operators
- packages/substrate/src/operator.ts:176:9 - Use Match module or Option instead of ternary operators
- packages/substrate/src/projection-service.ts:75:9 - Use Match module or Option instead of ternary operators
- packages/substrate/src/subscribers.ts:334:41 - Use Match module or Option instead of ternary operators
- packages/substrate/src/subscribers.ts:335:42 - Use Match module or Option instead of ternary operators
- packages/substrate/src/subscribers.ts:365:7 - Use Match module or Option instead of ternary operators
- packages/substrate/src/subscribers.ts:371:17 - Use Match module or Option instead of ternary operators
- packages/substrate/src/choreography/service.ts:300:11 - Use Match module or Option instead of ternary operators

## Notes

- The report is definite-only, but the rules are still heuristic. Use findings as review leads, not as proof that every line must change.
- Some rules double-report a single source shape. Counts are useful for prioritization, not exact remediation effort.
- The raw scan output used for this document was written to `/tmp/firegrid-effect-findings-definite.json` during this run.
