# Architecture Archaeology — ast-grep rule pack (Phase 1)

Syntactic inventory of accreted substrate smells. **Findings are
information, not defects** — no grading; the footprint across the codebase
is the point. Humans/agents judge with the data.

## Run

```bash
pnpm analysis:leaf       # → tooling/analysis/baseline/leaf-findings.{json,md}
```

Reproducible: same tree in → same output. Scope: `packages/{host-sdk,
runtime,client-sdk,protocol,tiny-firegrid}/src`.

## Add a rule

Drop `tooling/ast-grep/rules/<id>.yml` (ast-grep rule schema). It's picked
up automatically (`sgconfig.yml` → `ruleDirs: [rules]`). Keep `severity:
info`, write a neutral `note:` (what the pattern *is*, not whether it's
wrong). The rules are checked-in institutional knowledge.

## ast-grep vs ts-morph (the split)

ast-grep covers patterns that are *syntactic shapes* — no symbol/type
resolution. The moment a query must resolve a type, follow references
across files, or compare two type-union memberships, it is **ts-morph
(Phase 2/3)**, not ast-grep. Don't force ts-morph work into ast-grep.

## Phase 1 coverage & honest limitations

| Finding | Rule | Status |
|---|---|---|
| 1 Effect.context in Layer builder | `effect-context-in-layer-builder` | syntactic ✓ — but the **capture→re-provision join is Phase 2** (ts-morph finding 2); this only flags the capture |
| 3 service self-reference via getter | `service-self-reference-getter` | **0 matches, and that is real** — `grep` confirms no `get x(){return self}` shape exists in host-sdk/runtime. The smell is expressed via type-level recursion, not this syntax → deferred to **Phase 2 ts-morph finding 10** (recursive service refs). Absence here ≠ absence of the smell. |
| 5 type-safety escape hatches | `type-safety-eslint-disable` | syntactic ✓ |
| 6 double-launder cast | `double-launder-cast` | syntactic ✓ |
| 7 manual scope mgmt | `manual-scope-buildwithscope` | syntactic ✓ |
| 8 TFIND / spec anchors | `tfind-anchor-comment` | syntactic ✓ — read as a per-file density heat map, not line-by-line |

Findings 2, 4, 9, 10 and all of Deliverable 2 (composition graphs) are
Phase 2/3 (ts-morph) — **not built**; gated on the Phase 1 evaluation.
