# Fluent Firegrid Tutorial Examples

This folder tracks the shape of Restate sdk-gen's tutorial examples while
staying honest to the current fluent-firegrid slice.

Spec refs: `fluent-firegrid-keystone.EXAMPLES.1`,
`fluent-firegrid-keystone.EXAMPLES.2`,
`fluent-firegrid-keystone.EXAMPLES.4`.

Implemented:

- `src/01-basics.ts` — a Firegrid-shaped durable step pipeline using
  free `run` and `all` inside generator operations.
- `src/02-spawn.ts` — routine-backed Futures composed with
  `all`, `race`, and `select`.
- `src/03-timeout.ts` — timeout branching with
  `select({ done, timeout: sleep(...) })`.
- `src/09-workflows.ts` — a workflow-shaped surface using
  `workflow({ name, handlers })`.

Deferred until the package exposes the matching primitives:

| family | missing substrate |
|---|---|
| retry | journaled retry policy and attempt classification |
| saga | durable compensation steps and compensation ordering helpers |
| cancellation | durable cancellation events and AbortSignal fanout |
| state | state/sharedState log fold and keyed workflow/object routing |
| clients | typed service/object/workflow call and send descriptors |
| workflow promises | workflowPromise, attach, key, and shared workflow handler semantics |
| interfaces | descriptor-only contracts and codegen/client projection |
| serdes | runtime input/output serde hooks |

`src/server.ts` exports a registry instead of starting an HTTP endpoint because
fluent-firegrid does not have an endpoint/server package yet.

The workflow tier is intentionally narrower than Restate's workflow tutorial:
it models workflow handlers over one caller-supplied journal endpoint. Workflow
promises, workflow keys, attach/cancel, and shared workflow handlers are still
deferred.
