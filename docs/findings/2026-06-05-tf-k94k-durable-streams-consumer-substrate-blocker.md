# tf-k94k Durable Streams Consumer Substrate Blocker

## Summary

`tf-k94k` is blocked before fluent-runtime implementation. The requested gate is
the Durable Streams PR #343 named-consumer / pull-wake / webhook conformance
surface, but the currently selected package in this repo is
`@durable-streams/server@0.3.7`, and npm reports `0.3.7` as the latest
published version.

The PR #343 server surface exists at upstream commit
`5f3bae712a82219608138a53e60a223c2a7dd43c`, but it is not available through the
repo's package dependency graph.

## Evidence

Current dependency:

- Root `package.json`: `@durable-streams/server` is pinned to `0.3.7`.
- `pnpm view @durable-streams/server versions --json` lists versions through
  `0.3.7` only.

Live probe against the selected package:

- `POST /consumers` returns `404` with body `Stream not found`.
- `PUT /v1/stream/__ds/subscriptions/{id}` returns `201`, proving the installed
  package exposes the older reserved subscription API instead of PR #343's
  `/consumers` API.

Installed package shape:

- Has `src/subscription-routes.ts` and `src/subscription-manager.ts`.
- Does not have PR #343 `ConsumerRoutes`, `ConsumerManager`, or
  `PullWakeManager`.
- The installed pull-wake claim path returns a token but does not write the
  PR #343 `claimed` event to the wake stream.

## Expected API Seam

The dependency required to proceed must make these PR #343 files available from
the real Durable Streams server package, not from a Firegrid mock:

- `packages/server/src/consumer-routes.ts`
- `packages/server/src/consumer-manager.ts`
- `packages/server/src/consumer-store.ts`
- `packages/server/src/pull-wake-manager.ts`
- `packages/server/src/webhook-manager.ts`
- `packages/server-conformance-tests/src/consumer-tests.ts`
- `packages/server-conformance-tests/src/pull-wake-tests.ts`
- `packages/server-conformance-tests/src/webhook-dsl.ts`

The package-level test gate should then import:

- `runConsumerConformanceTests`
- `runPullWakeConformanceTests`
- the webhook conformance scenarios / DSL from PR #343

and run them against the real upstream `DurableStreamTestServer` with
`webhooks: true`.

Minimum HTTP surface expected by the conformance suite:

- `POST /consumers`
- `GET /consumers/{id}`
- `DELETE /consumers/{id}`
- `POST /consumers/{id}/acquire`
- `POST /consumers/{id}/ack`
- `POST /consumers/{id}/release`
- `PUT /consumers/{id}/wake`
- pull-wake events written to the configured wake stream:
  - `{ "type": "wake", "stream": "...", "consumer": "...", ... }`
  - `{ "type": "claimed", "stream": "...", "worker": "...", "epoch": ..., ... }`

## Consequence

Implementing fluent-runtime claimed-wake code against
`@durable-streams/server@0.3.7` would validate a different substrate than the
one specified by `features/fluent/substrate/fluent-durable-streams-consumer-substrate.feature`.
That would either rebuild missing semantics in Firegrid or hide the absence of
the upstream claimed-event / named-consumer protocol.

The next unblocked step is a dependency update to a reproducible Durable
Streams package containing PR #343. After that lands, remove the pending skip in
`packages/effect-durable-streams/test/conformance/consumer-substrate.pending.test.ts`,
wire the upstream conformance runners, and only then add the fluent-runtime
claimed-wake witness.
