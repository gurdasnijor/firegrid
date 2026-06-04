# Vendored: durable-streams/durable-streams — `packages/coding-agents` (partial)

Read-only reference material for agents, **not** a dependency. `repos/**` is
excluded from all gates (eslint, knip, typecheck, dep-cruiser) and from the pnpm
workspace; never import from here.

Only `packages/coding-agents` + its design specs (`docs/superpowers/specs`) are
vendored (not the whole durable-streams repo). It is a plain vendored copy,
**not** a `git subtree`.

## Source

- Upstream: https://github.com/durable-streams/durable-streams
- PR: #317 — https://github.com/durable-streams/durable-streams/pull/317
- Commit (PR head): `244fcccbfc7b7f4508989c511b74201e669c6162`

## Paths included

| Here | Upstream |
|---|---|
| `packages/coding-agents/` | `packages/coding-agents` |
| `docs/superpowers/specs/` | `docs/superpowers/specs` (the coding-agents + ACP-bridge design specs) |

## Refresh

```sh
# PR-head SHAs are not fetchable by SHA — use the PR ref:
git fetch https://github.com/durable-streams/durable-streams refs/pull/317/head
git archive FETCH_HEAD packages/coding-agents docs/superpowers/specs | tar -x -C /tmp/ds
# replace repos/durable-streams/{packages/coding-agents,docs/superpowers/specs} with the
# extracted copies under /tmp/ds, then update the Commit hash above.
```
