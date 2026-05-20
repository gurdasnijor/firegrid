# Analysis C — tiny-firegrid Reach Subgraph

Generated 2026-05-20T10:09:03.801Z. Mechanical. Forward closure of the
type-composition graph from every type declared in `packages/tiny-firegrid`
(137 roots). No interpretation, no remediation.

DOT: `tiny-firegrid-reach.dot` (closure, filtered to roots + degree ≥ 2,
unreached substrate PUBLIC in a dashed sidebar), `tiny-firegrid-reach-full.dot` (entire closure, 271 nodes).

## Honesty

- Edges are the same symbol-resolved type-composition edges as the
  initial map (identifier resolution; `as`-casts / string-literal /
  mapped-type indirection not traversed — reach is a **lower bound**).
- PUBLIC classification joined from `catalog.json` (Analysis B):
  **NOT available — run build-surface.ts first**.
- "substrate" = `packages/*` excluding `packages/tiny-firegrid`; deleted app workspaces are excluded
  and excluded. Substrate packages: `packages/cli`, `packages/client-sdk`, `packages/effect-durable-operators`, `packages/effect-durable-streams`, `packages/host-sdk`, `packages/protocol`, `packages/runtime`.

## Reach

- tiny-firegrid roots: **137**
- total types reached (transitive closure): **271**
- of the 744 declared types, that is **36%**

## Coverage of each package's PUBLIC surface

| package | declared | PUBLIC | PUBLIC reached | % PUBLIC reached | any reached |
|---|---|---|---|---|---|
| packages/cli | 8 | 0 | 0 | 0% | 0 |
| packages/client-sdk | 24 | 0 | 0 | 0% | 15 |
| packages/effect-durable-operators | 30 | 0 | 0 | 0% | 1 |
| packages/effect-durable-streams | 46 | 0 | 0 | 0% | 0 |
| packages/host-sdk | 107 | 0 | 0 | 0% | 10 |
| packages/protocol | 237 | 0 | 0 | 0% | 80 |
| packages/runtime | 155 | 0 | 0 | 0% | 28 |
| packages/tiny-firegrid (roots) | 137 | 0 | 0 | 0% | 137 |

## Substrate PUBLIC types NOT reached by tiny-firegrid (coverage gaps)

**0** substrate public types are never exercised by
the proving ground:

(none)


## Substrate types reached that are NOT PUBLIC (reaching into internals)

**0** non-public substrate types are reached by the
tiny-firegrid closure (boundary touch — internal symbols exercised
without going through a package entry point):

(none)

