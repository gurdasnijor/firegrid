# tf-k94k Durable Streams Consumer Substrate Source Proof

## Summary

The published-package path is unavailable, but the source-checkout conformance
path is executable.

Firegrid currently depends on `@durable-streams/server@0.3.7`, and npm reports
`0.3.7` as the latest published version. That package does not expose the
Durable Streams PR #343 `/consumers` API. This is only a package-path blocker.

The PR #343 server surface exists at upstream commit
`5f3bae712a82219608138a53e60a223c2a7dd43c`, and its own source-checkout
conformance suite passes against the real `packages/server/src/server.ts`
`DurableStreamTestServer` from that checkout.

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

## Source-Checkout Proof

The direct source proof used a disposable checkout outside Firegrid:

```sh
rm -rf /tmp/durable-streams-pr343-merged
git clone https://github.com/durable-streams/durable-streams.git \
  /tmp/durable-streams-pr343-merged
git -C /tmp/durable-streams-pr343-merged \
  fetch origin pull/343/head:pr-343-source-proof
git -C /tmp/durable-streams-pr343-merged checkout pr-343-source-proof
git -C /tmp/durable-streams-pr343-merged rev-parse HEAD
```

Head verified:

```text
5f3bae712a82219608138a53e60a223c2a7dd43c
```

Up-to-date check:

```sh
git -C /tmp/durable-streams-pr343-merged fetch origin main
git -C /tmp/durable-streams-pr343-merged rev-list --left-right --count HEAD...origin/main
git -C /tmp/durable-streams-pr343-merged merge --no-edit origin/main
```

Result:

```text
2	28
Automatic merge failed; fix conflicts and then commit the result.
```

The PR head is behind upstream `main`, and a merge has broad upstream conflicts
in workflow, protocol, caddy, client, server, state, and lockfile files. For
this Firegrid lane, the conformance proof therefore ran against the exact PR
#343 commit requested by the PO.

Install and conformance command:

```sh
pnpm install --frozen-lockfile
pnpm exec vitest run --project server \
  packages/server/test/conformance.test.ts \
  --reporter=verbose
```

Result:

```text
Test Files  1 passed (1)
Tests       743 passed (743)
Duration    98.46s
```

The upstream server Vitest config aliases `@durable-streams/server` to
`./packages/server/src`, so the run exercised the real PR #343 source server,
not Firegrid's published `@durable-streams/server@0.3.7` package and not a mock
server.

Coverage observed in the passing run:

- Webhook subscription conformance under both in-memory and file-backed server
  implementations, including subscription delivery, signed notification,
  callback, ack, done, re-wake, token rejection, malformed requests, race
  cases, and property-based wake cycles.
- L1 named consumer conformance: registration, idempotent registration,
  acquire, ack, heartbeat, stale epoch/token rejection, offset regression,
  lease TTL, multi-stream offsets, release, delete, and exhaustive valid
  action sequences.
- L2/B pull-wake conformance: wake events, claimed events, no wake while
  reading, no wake without preference, missing wake stream behavior, cursor
  persistence, lease-expiry re-wake, competing worker claims, worker reconnect,
  bogus wake/claimed events, contention edges, and property-based action
  sequences.

## Expected Package API Seam

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

The next package-integrated step is a dependency update to a reproducible
Durable Streams package containing PR #343. Until then, source-checkout
conformance is the valid proof path, and Firegrid must not reimplement the
consumer lease, cursor, pull queue, webhook retry, or task-claim substrate.
