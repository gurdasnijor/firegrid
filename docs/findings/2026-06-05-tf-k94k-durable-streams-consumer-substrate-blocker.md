# tf-k94k Durable Streams Consumer Substrate Source Proof

## Summary

The published-package path is unavailable, but the source-checkout conformance
path is executable.

The Firegrid fork `main` integration branch now includes the rebased PR #343
consumer substrate plus one Firegrid packaging commit for Git dependency
consumption. Firegrid pins that integration line at
`4a5efcf35d67bf16697b2f965860cffdebde1dcb`.

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

## Firegrid Fork Proof

Firegrid fork:

- URL: `https://github.com/gurdasnijor/durable-streams`
- Integration branch: `main`
- Import/staging branch: `firegrid/pr343-consumer-substrate`
- Seed SHA: `5f3bae712a82219608138a53e60a223c2a7dd43c`
- Rebased upstream-import SHA: `9116edc55f7a989ae2c75f872364c946a1409eeb`
- Current integration SHA: `4a5efcf35d67bf16697b2f965860cffdebde1dcb`
- Upstream base checked: `https://github.com/durable-streams/durable-streams`
  `main` at `82f9963a`

Fork checkout commands:

```sh
rm -rf /tmp/gurdasnijor-durable-streams-firegrid-pr343
git clone https://github.com/gurdasnijor/durable-streams.git \
  /tmp/gurdasnijor-durable-streams-firegrid-pr343
git -C /tmp/gurdasnijor-durable-streams-firegrid-pr343 \
  checkout main
git -C /tmp/gurdasnijor-durable-streams-firegrid-pr343 \
  remote add upstream https://github.com/durable-streams/durable-streams.git
git -C /tmp/gurdasnijor-durable-streams-firegrid-pr343 fetch upstream main
git -C /tmp/gurdasnijor-durable-streams-firegrid-pr343 rev-parse HEAD
git -C /tmp/gurdasnijor-durable-streams-firegrid-pr343 \
  rev-list --left-right --count HEAD...upstream/main
```

Fork status:

```text
HEAD: 4a5efcf35d67bf16697b2f965860cffdebde1dcb
Ahead/behind upstream/main: 3	0
origin/main: 4a5efcf35d67bf16697b2f965860cffdebde1dcb
origin/firegrid/pr343-consumer-substrate: 9116edc55f7a989ae2c75f872364c946a1409eeb
```

The import branch was rebased onto upstream `main`; the previous broad merge
conflicts were resolved by preserving current upstream metadata, storage,
reserved subscription, state, client, Caddy, and workflow changes, then
layering the PR #343 TypeScript server consumer substrate and conformance files
on top. After validation, it was fast-forward merged into
`gurdasnijor/durable-streams main`, making fork `main` Firegrid's curated
Durable Streams integration line. The staging branch was pushed with
`--force-with-lease` because the rebase rewrote the old fork head.

The additional integration-branch commit force-adds the generated
`packages/server/dist` files for `@durable-streams/server`. That packaging
commit is not part of upstream PR #343; it exists so Firegrid can consume the
fork through pnpm's Git subdirectory dependency path while the package remains
unpublished.

Fork conformance command:

```sh
pnpm install --frozen-lockfile
pnpm --filter @durable-streams/client build
pnpm --filter @durable-streams/state build
pnpm --filter @durable-streams/server-conformance-tests typecheck
pnpm --filter @durable-streams/server-conformance-tests build
pnpm --filter @durable-streams/server typecheck
pnpm exec vitest run --project server \
  packages/server/test/conformance.test.ts \
  --reporter=verbose
```

Fork conformance result:

```text
Test Files  1 passed (1)
Tests       725 passed (725)
Duration    76.98s
```

As with the direct upstream source proof, the fork's Vitest config aliases
`@durable-streams/server` to `./packages/server/src`, so this run exercised the
real fork source server and upstream conformance tests, not Firegrid's npm
package dependency and not a mock.

## Fork Merge Status

Resolved. The fork `main` integration branch is now up to date with upstream
`main` and carries two selected upstream PR #343 commits plus one Firegrid
packaging commit on top:

```text
4a5efcf3 build: include server dist for Firegrid git pin
9116edc5 feat: implement layer consumer spec & webhooks
33a81e1d docs: introduce layered consumer spec into the protocol
82f9963a upstream/main
```

Key resolution choices:

- `PROTOCOL.md` stayed on upstream `main` to preserve the newer reserved
  subscription protocol. PR #343's long-form protocol text remains in
  `docs/layered-consumer-spec.md` and `docs/webhooks-rfc.md`.
- PR #343 TypeScript server L1/L2 substrate was preserved:
  `consumer-manager.ts`, `consumer-routes.ts`, `consumer-store.ts`,
  `consumer-types.ts`, `pull-wake-manager.ts`, `webhook-manager.ts`,
  `webhook-routes.ts`, `webhook-store.ts`, `webhook-telemetry.ts`, and
  `webhook-types.ts`.
- Upstream reserved subscription APIs stayed mounted under `__ds`; PR #343
  `/consumers` routes and direct webhook wake paths were added alongside them.
- The crypto module now supports both upstream Ed25519/JWKS webhook signatures
  and PR #343 HMAC webhook-secret signatures.
- Old PR branch CI/example/client/state/Caddy churn was dropped in favor of
  upstream `main`; only the server/conformance substrate needed for Firegrid's
  proof remains.

Focused type validation:

```sh
pnpm --filter @durable-streams/client build
pnpm --filter @durable-streams/state build
pnpm --filter @durable-streams/server-conformance-tests typecheck
pnpm --filter @durable-streams/server-conformance-tests build
pnpm --filter @durable-streams/server typecheck
```

Result: all focused type/build checks passed.
`pnpm install --frozen-lockfile` was re-run after the fork push and passed
against the updated fork lockfile.

## Dependency Strategy

Short term:

- Treat `gurdasnijor/durable-streams#main` at
  `4a5efcf35d67bf16697b2f965860cffdebde1dcb` as Firegrid's reproducible
  source substrate proof and package pin.
- Firegrid consumes `@durable-streams/server` from that exact fork SHA using
  pnpm's Git subdirectory dependency path.
- Firegrid has a package-pinned claimed-wake witness at
  `packages/effect-durable-streams/test/conformance/consumer-substrate.integration.test.ts`.

Package-pinned witness command:

```sh
pnpm --filter effect-durable-streams exec vitest run \
  test/conformance/consumer-substrate.integration.test.ts \
  --reporter=verbose
```

Result:

```text
Test Files  1 passed (1)
Tests       1 passed (1)
```

Next implementation dependency step:

- Keep the in-repo conformance adapters pointed at the real
  `DurableStreamTestServer` from the pinned package path, and continue leaving
  the upstream conformance-test package itself as a source-checkout proof until
  it is published or otherwise materialized.
- Do not import from Firegrid `repos/`, and do not rebuild L1/L2 substrate
  mechanics inside fluent-runtime.

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

The package-integrated path now has a reproducible `@durable-streams/server`
pin containing PR #343. Source-checkout conformance remains the proof path for
the upstream conformance-test package until it is published or otherwise
materialized, and Firegrid must not reimplement the consumer lease, cursor,
pull queue, webhook retry, or task-claim substrate.
