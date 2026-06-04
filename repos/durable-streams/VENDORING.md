# Vendored: durable-streams/durable-streams — `packages/coding-agents` (partial)

Read-only reference material for agents, **not** a dependency. `repos/**` is
excluded from all gates (eslint, knip, typecheck, dep-cruiser) and from the pnpm
workspace; never import from here.

Only `packages/coding-agents` is vendored (not the whole durable-streams repo).
It is a plain vendored copy, **not** a `git subtree`.

## Source

- Upstream: https://github.com/durable-streams/durable-streams
- PR: #317 — https://github.com/durable-streams/durable-streams/pull/317
- Commit (PR head): `244fcccbfc7b7f4508989c511b74201e669c6162`

## Paths included

| Here | Upstream |
|---|---|
| `packages/coding-agents/` | `packages/coding-agents` |

## Refresh

```sh
# PR-head SHAs are not fetchable by SHA — use the PR ref:
git fetch https://github.com/durable-streams/durable-streams refs/pull/317/head
git archive FETCH_HEAD packages/coding-agents | tar -x -C /tmp/ca
# replace repos/durable-streams/packages/coding-agents with /tmp/ca/packages/coding-agents,
# then update the Commit hash above.
```
