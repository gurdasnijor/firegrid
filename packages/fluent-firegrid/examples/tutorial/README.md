# Fluent Firegrid Tutorial Examples

This folder tracks the shape of Restate sdk-gen's tutorial examples while
staying honest to the current fluent-firegrid slice.

Spec refs: `fluent-firegrid-keystone.EXAMPLES.1`,
`fluent-firegrid-keystone.EXAMPLES.2`.

Implemented:

- `src/01-basics.ts` — a Firegrid-shaped durable step pipeline using
  `execute(ctx, gen(... yield* run(...)))`.

Deferred until the package exposes the matching primitives:

- spawn
- timeout / sleep
- retry policy
- saga compensation
- cancellation
- state
- clients
- workflows
- typed interfaces / serdes

`src/server.ts` exports a registry instead of starting an HTTP endpoint because
fluent-firegrid does not have an endpoint/server package yet.
