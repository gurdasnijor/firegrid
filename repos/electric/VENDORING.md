# Vendored: electric-sql/electric (agents subsystem — partial)

Read-only reference material for agents, **not** a dependency. `repos/**` is
excluded from all gates (eslint, knip, typecheck, dep-cruiser); never import from
here — use real package deps resolved through `node_modules`.

This is a **partial** snapshot — only the Electric *agents* subsystem, not the
whole monorepo (the full repo is ~208 MB, 180 MB of which is the docs website).
It is therefore a plain vendored copy, **not** a `git subtree` (so `git subtree
pull` does not apply — refresh manually, see below).

## Source

- Upstream: https://github.com/electric-sql/electric
- Branch: `main`
- Commit: `9fdf96ad58799438785a0aa993d6dff7e74af2dc`

## Paths included (upstream-relative, mirrored here)

| Here | Upstream |
|---|---|
| `website/docs/agents/` | `website/docs/agents` |
| `packages/agents/` | `packages/agents` |
| `packages/agents-server/` | `packages/agents-server` |
| `packages/agents-runtime/` | `packages/agents-runtime` |
| `packages/agents-server-conformance-tests/` | `packages/agents-server-conformance-tests` |

## Refresh

```sh
# from a clean checkout, in a worktree:
git fetch https://github.com/electric-sql/electric main
# extract the same paths at the new ref into repos/electric/, replacing this dir,
# then update the Commit hash above.
```
