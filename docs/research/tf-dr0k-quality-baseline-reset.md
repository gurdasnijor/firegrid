# tf-dr0k Quality Baseline Reset

`tf-dr0k` is the post-wave quality gate. The intent is not to preserve every
current residual as a new normal. Each residual is handled in one of two ways:

- real product quality debt is zeroed where feasible, or carried only behind a
  named carveout with a reduction path;
- tooling or irrelevant-process false positives are excluded precisely with a
  per-item rationale, and are not treated as product cleanup blockers.

The final jscpd baseline reset in #570 lands after the parallel duplicate-code
lane reports its final floor: `tf-ytx4`. Effect diagnostics are folded into
#570.

## Before / After

| Gate | Previous baseline | #570 result | Disposition |
| --- | ---: | ---: | --- |
| `lint:dup` / jscpd duplicated lines | 51 | pending | Real product debt, zeroing in `tf-ytx4` |
| `lint:dead` / knip issues | 0 | 0 | Zero |
| `effect:diagnostics` errors | 1 | 0 | Zero |
| `effect:diagnostics` warnings | 30 | 29 | Product warning zeroed; residual is test/advisory carveout |
| `effect:diagnostics` messages | 91 | 83 | Product messages reduced; residual is advisory carveout |
| `lint:semgrep` ERROR findings | 3 | 0 | Zero |
| `lint:effect-quality` `forOfInPackageSourceCount` | 13 | 0 | Zero |

## Zeroed In #570

- `firegrid-no-date-now`: `packages/effect-durable-streams/src/protocol/Http.ts`
  now computes `Retry-After` deltas from `Clock.currentTimeMillis` instead of
  `Date.now()`.
- `firegrid-no-random-durable-identity`:
  `packages/runtime/src/workflow-engine/DurableStreamsWorkflowEngine.ts` no
  longer defaults worker identity from `crypto.randomUUID()`. The fallback is
  deterministic from the configured workflow stream URL; callers that need
  distinct concurrent workers should continue supplying `workerId`.
- `forOfInPackageSourceCount`: all production `for...of` sites counted by the
  Effect-quality metric were converted to non-`for...of` forms.
- Effect diagnostic error:
  `packages/host-sdk/src/host/runtime-context-workflow-runtime.ts` now accounts
  for the `Tracer.ParentSpan` requirement in workflow support layer context.
- Effect diagnostic production warning:
  `packages/host-sdk/src/host/agent-tool-host-live.ts` now rejects unsupported
  approval channels with the typed `ToolExecutionFailed` path instead of
  placing a raw `Error` in the Effect failure channel.

## Explicit Carveouts

### Real Product Debt

#### `tf-ytx4` — jscpd duplicate-code residual

The pre-zeroing jscpd floor was 48 duplicated lines across seven clone groups:

- `packages/runtime/src/workflow-engine/internal/engine-runtime.ts`
- `packages/runtime/src/agent-adapters/acp/adapter.ts`
- `packages/runtime/src/verified-webhook-ingest/adapter.ts`
- `packages/protocol/src/runtime-ingress/schema.ts`
- `packages/protocol/src/launch/host-control-request.ts`
- `packages/protocol/src/launch/host-session-create-or-load-request.ts`

These are real duplicate-code findings. `tf-ytx4` owns reducing the jscpd floor
to zero by extracting shared helpers or deleting duplicated structure. #570's
final `.jscpd.json` baseline must reflect the post-`tf-ytx4` floor.

### Tooling / Irrelevant-Process False Positives

False positives are acceptable only when the exclusion is precise and named.
They do not become blockers for the product baseline reset.

- Effect diagnostics baseline matching now keys diagnostics by project, file,
  severity, code, and message, while preserving line and column in the baseline
  for human review. This prevents comment-only edits from creating synthetic
  regressions when the same semantic diagnostic shifts line number.
- Legacy `check:docs` and `check:specs` preflight gates were removed from the
  code-quality path. They were process-era checks, not code-quality gates, and
  they should not block the post-wave product quality reset.

#### Effect diagnostic residual floor

The final Effect diagnostic floor in #570 is 0 errors, 29 warnings, and 83
messages. The remaining warnings are test-only diagnostics:

- `globalErrorInEffectFailure` (13): test fixtures intentionally model failure
  paths with plain `Error` values while asserting higher-level behavior.
- `multipleEffectProvide` (15): test harnesses compose small layers inline to
  keep setup local to each assertion; these are not product-layer lifecycle
  paths.
- `lazyPromiseInEffectSync` (1): test-only stream adapter helper; it does not
  affect durable runtime behavior.

The remaining messages are advisory style diagnostics, retained as precise
baseline entries rather than product blockers:

- `unnecessaryFailYieldableError` (29): mechanical yieldable-error cleanup
  across durable stream/protocol helpers. No runtime semantics are changed by
  leaving these as-is.
- `schemaStructWithTag` (22): schema-constructor advisory. The existing schema
  shapes remain stable wire contracts; converting them is a schema-maintenance
  sweep, not part of this gate.
- `preferSchemaOverJson` (17): JSON codec sites in protocol and tests. Several
  are boundary-level wire-format codecs where raw JSON handling is intentional.
- `effectSucceedWithVoid` (6), `unnecessaryPipeChain` (3),
  `unnecessaryEffectGen` (2), and `effectFnOpportunity` (1): local style
  suggestions with no product-quality impact.
- `tryCatchInEffectGen` (3): durable-table tests assert thrown collection
  mutation behavior directly; converting the harness would obscure the tested
  invariant without improving product code.
