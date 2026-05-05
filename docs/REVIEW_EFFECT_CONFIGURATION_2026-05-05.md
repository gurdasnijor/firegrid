# Effect-TS Configuration Review — 2026-05-05

## Summary

Firegrid does not use Effect's `Config` module. Configuration is exclusively passed as plain TypeScript shapes (`{ streamUrl, contentType?, clientId? }`) constructed at the binary edge in `packages/runtime/bin/firegrid.ts` from a single direct `process.env` read. This is a small repo for the topic — config surface is narrow and largely consists of one piece of state (the substrate stream URL) being threaded through twelve+ layer factories. The honest net judgment: **adopting Effect Config is worthwhile but the win is modest and concentrated in one place** (the bin), not in the many consumer-side `*Config` shapes. The real leverage is (a) replacing the `process.env["DURABLE_STREAMS_URL"]` read with a `Config.string("DURABLE_STREAMS_URL").pipe(Config.option)` so the boot-mode decision becomes typed and testable via `ConfigProvider.fromMap`, and (b) consolidating the runtime-context `{ streamUrl, contentType }` into a single `RuntimeConfig` Layer whose Live reads from `Config.*` and whose Test reads from `ConfigProvider.fromMap`. The downstream consumer shapes (`SubstrateProducerConfig`, `ProjectionLiveConfig`, `EventPlaneLayerConfig`, etc.) are not natural Config targets — they are layer-factory parameters, not environment values. Forcing `Config.*` on them would invert dependency direction and add ceremony without test or safety benefit.

Quick stats:
- Plain config shapes carrying `streamUrl`: **22** (interface declarations and inline parameter shapes; see "Plain config shapes" for sources)
- Direct `process.env` reads in package source (excluding tests/scripts/Vite framework): **1** — `packages/runtime/bin/firegrid.ts:74`
- `Config.*` usages anywhere in source: **0**
- `ConfigProvider.*` usages: **0**
- `Redacted` / `Config.redacted` usages: **0**

## Findings by concept

### Process.env reads

There is exactly one process-edge environment read in package source:

- `packages/runtime/bin/firegrid.ts:74` — `const attachedUrl = process.env["DURABLE_STREAMS_URL"]`

This is a `Config.string("DURABLE_STREAMS_URL").pipe(Config.option)` candidate. The current shape compares `attachedUrl !== undefined && attachedUrl.length > 0` to choose between `FiregridRuntimeBoot.attached(...)` and `FiregridRuntimeBoot.embeddedDev(...)`. With Effect Config the equivalent is:

- read as `Config.option(Config.string("DURABLE_STREAMS_URL"))` → `Effect<Option<string>>`,
- branch on `Option.match` to choose the boot layer.

Empty-string handling becomes more explicit: `Config.string` already fails on missing/empty, so `Config.option` cleanly distinguishes "not set" from "set". The current `length > 0` check papers over the difference between "unset" and "set to empty".

The rest of the codebase has no `process.env` reads. `apps/lab/src/main.tsx:25` reads `import.meta.env["VITE_DURABLE_STREAMS_URL"]` — explicitly out of scope (Vite framework boundary).

### Plain config shapes

Twelve interface declarations carry the same `{ streamUrl, contentType? }` skeleton, plus close variants:

Substrate:
- `packages/substrate/src/producer.ts:26` — `SubstrateProducerConfig`
- `packages/substrate/src/stream.ts:15` — `OpenSubstrateDbOptions`
- `packages/substrate/src/facade/projection.ts:64` — `ProjectionLiveConfig`
- `packages/substrate/src/facade/work.ts:58` — `WorkClaimLiveConfig`
- `packages/substrate/src/event-plane/projection.ts:74` — `MakePlaneProjectionArgs`
- `packages/substrate/src/event-plane/producer.ts:149` — `MakePlaneProducerArgs`
- `packages/substrate/src/event-plane/layer.ts:17` — `EventPlaneLayerConfig`
- `packages/substrate/src/operator.ts:75`, `subscribers.ts:42`, `waits.ts:110`, `internal-claim.ts:24`, `choreography/service.ts:62`, `choreography/tools.ts:48` — internal `streamUrl` + `contentType?` parameter shapes

Runtime:
- `packages/runtime/src/runtime/layer.ts:97` — `AttachedRuntimeOptions`
- `packages/runtime/src/runtime/layer.ts:107` — `EmbeddedDevRuntimeOptions`
- `packages/runtime/src/runtime/runtime-context.ts:19` — `RuntimeContextService`
- `packages/runtime/src/runtime/service.ts:14` — `FiregridRuntimeStreamIdentity`
- `packages/runtime/src/runtime/internal/stream-resolver.ts:82` — `DurableStreamAdminCreateInput`

Client:
- `packages/client/src/firegrid/client.ts:10` — `FiregridClientConfig`
- `packages/client/src/firegrid/event-client.ts:28` — `EventStreamClientConfig`
- `packages/client/src/client/service.ts:20` — `SubstrateClientConfig`
- `packages/client/src/client/work.ts:86` — `WorkClientConfig` (per grep)

Lab:
- `apps/lab/src/lab/LabEventStreamClient.ts:22` — `LabEventStreamClientConfig`

These are **layer-factory parameters**, not environment-derived values. The skill's `Config.all({ ... })` example covers cases where a layer reads its own values from env; here the values come from the parent layer (the runtime resolves the URL once and threads it to children via `RuntimeContext`). Migrating each interface to `Config.all` would mean every Layer factory becomes an env reader, which conflicts with the runtime-process design (`packages/runtime/src/runtime/layer.ts:25` — "process configuration belongs at the binary process edge"). The right consolidation target is **`RuntimeContext` itself** (`packages/runtime/src/runtime/runtime-context.ts`): the runtime could expose a single `RuntimeConfig` Layer whose Live reads `Config.*` once, and child layers continue to receive plain values through `RuntimeContext` as today. The interface count would drop only marginally (the interfaces remain at the substrate boundary), but the env→layer pipeline becomes the canonical point of validation and test override.

### Sensitive values

No fields in any config shape are sensitive in the current local-dev topology:
- `streamUrl` for `127.0.0.1:<auto-port>` (embedded-dev) carries no auth.
- `streamUrl` for an attached durable streams instance *may* carry auth tokens or signed query params in production. Today there is no production attached deployment, so this is forward-looking.
- `clientId` (`FiregridClientConfig.clientId`, `EventStreamClientConfig.clientId`, `SubstrateClientConfig.clientId`) is identification, not authentication — not a `Config.redacted` candidate.
- `contentType` is a MIME type — not sensitive.

If/when production attached topology lands, the `DURABLE_STREAMS_URL` read in `bin/firegrid.ts` becomes a `Config.redacted("DURABLE_STREAMS_URL")` candidate and the `RuntimeContext.streamUrl` field would carry `Redacted<string>`, with `Redacted.value(...)` extraction at the single point that constructs the `DurableStream` client (e.g., `packages/substrate/src/producer.ts:118`, `packages/client/src/firegrid/event-client.ts:109`). Two-to-three call sites — small blast radius. Worth keeping in the back pocket but not worth doing speculatively today.

### Schema validation of config

No config values currently flow through `Schema`. Candidates:
- `streamUrl` could be validated as `Schema.URL` or a string with a regex filter (`http://` or `https://` with non-empty host). Today an empty string passes `length > 0` but `new URL(...)` later throws — surfacing as a generic `RuntimeStartupError` from `internal/stream-resolver.ts:67`.
- `contentType` defaults to `"application/json"` (`packages/substrate/src/producer.ts:120`, `packages/substrate/src/stream.ts:33`). Could be a literal-or-string schema; in practice the default branch is exercised universally so the validation gain is near-zero.
- Embedded-dev `port` (`packages/runtime/src/runtime/layer.ts:114`, `internal/stream-resolver.ts:144`) is a `number` defaulting to `0` (OS-assigned). A `Schema.Number.pipe(Schema.int(), Schema.between(0, 65535))` would be principled but adds little since `0` and OS-bind both work and the value is internal.

The leverage: validating `streamUrl` shape once at the bin via `Config.string("DURABLE_STREAMS_URL").pipe(Config.mapOrFail(...))` would replace the `length > 0` heuristic with a typed parse failure that produces a `ConfigError` rather than a downstream `RuntimeStartupError` with a generic cause.

### Configuration-via-Layer pattern

The skill's "Complete Example" recommends an `AppConfig` Layer.effect that yields a typed config record from `Config.*`. Firegrid already has the right shape — `RuntimeContext` (`packages/runtime/src/runtime/runtime-context.ts`) is exactly the per-process config Tag — but its Live values are constructed at `packages/runtime/src/runtime/layer.ts:67-72` from caller-supplied layer options (`AttachedRuntimeOptions.streamUrl`, etc.) rather than from `Config.*`. The natural shape:

- Add a `RuntimeConfigLive: Layer.Layer<RuntimeContext, ConfigError>` that reads `streamUrl`, `contentType`, `processId` (default: `generateProcessId()`) via `Config.all`.
- Keep `FiregridRuntimeBoot.{attached, embeddedDev}` as today for tests and programmatic callers; have `bin/firegrid.ts` choose between them based on the `Config.option` value of `DURABLE_STREAMS_URL`.
- Tests already build runtimes via `FiregridRuntimeBoot.embeddedDev({...})` with explicit options — **no migration cost** for tests.

This preserves the current design rule ("process configuration belongs at the binary process edge") while making the binary itself idiomatic Effect rather than a `process.env` consumer with a manual `length > 0` branch.

### Test config

Tests pass plain config shapes directly (e.g., `FiregridRuntimeBoot.embeddedDev({ streamName: "test" })`). This is fine — tests should not need `ConfigProvider.fromMap` for values they construct in code. The `ConfigProvider.fromMap` testing pattern only pays off for **components that yield from `Config.*` directly**. Today, no source code yields from `Config.*`, so there is nothing to override. If `bin/firegrid.ts` adopts `Config.option`, an integration test for the boot-mode decision (currently absent — the bin itself has no test) would become trivial via `Effect.provide(Layer.setConfigProvider(ConfigProvider.fromMap(new Map([["DURABLE_STREAMS_URL", "http://x:1/y"]]))))`. That is the only new test surface unlocked.

## Out of scope

- `apps/lab/src/main.tsx:25` — `import.meta.env["VITE_DURABLE_STREAMS_URL"]` (Vite framework boundary).
- `apps/lab/vite.config.ts` and other tool configs — not application config.
- `packages/runtime/bin/firegrid.ts:143` — `process.argv.slice(2)` (CLI arg parsing, not environment configuration; `Config` is for env-style key-value, not positional/`--` args).

## Top 5 highest-leverage idiomatic improvements (ranked)

1. **`bin/firegrid.ts:74` — replace `process.env["DURABLE_STREAMS_URL"]` with `Config.option(Config.string("DURABLE_STREAMS_URL"))`.** Adds proper "unset vs empty" distinction, produces typed `ConfigError`, makes the boot-mode decision testable. **Cost: ~10 LOC change.** Unblocks: testable boot decision; cleaner error path on malformed URL; future `Config.redacted` migration when prod-attached lands.

2. **Introduce `RuntimeConfigLive: Layer.Layer<RuntimeContext, ConfigError>` reading from `Config.*`** — sit it alongside the existing `FiregridRuntimeBoot.attached/embeddedDev` factories rather than replacing them. The bin uses `RuntimeConfigLive`; tests and programmatic callers continue to use the explicit-option factories. **Cost: ~30 LOC new code, 0 LOC change to existing call sites.** Unblocks: idiomatic env→runtime pipeline; the "real" Effect Config story for this codebase.

3. **Validate `streamUrl` once via `Config.mapOrFail(s => parseURL(s))` at the bin.** Replaces the `length > 0` heuristic with a typed parse, producing `ConfigError.InvalidData` instead of a deep `RuntimeStartupError` from `stream-resolver.ts:67`. **Cost: ~10 LOC.** Unblocks: clean error message for misconfigured deploys; deterministic test for the bad-URL case.

4. **(Forward-looking, do not act on yet) Migrate `streamUrl` to `Redacted<string>` end-to-end** when production attached topology with auth tokens lands. Touches ~3 `DurableStream` constructor sites (`producer.ts:118`, `event-client.ts:109`, `stream.ts:30`) plus `RuntimeContextService.streamUrl`. **Cost: ~15 LOC at the value-extraction sites.** Unblocks: safe `Effect.log` of `RuntimeContext` without leaking auth.

5. **Document the design rule in a comment block at `runtime/layer.ts`**: "Layer factories take plain values; `RuntimeConfigLive` is the one-and-only `Config.*` reader; the substrate/client `*Config` interfaces are intentionally NOT environment-readers." This is non-code but matters: without it the next contributor will reflexively `Config.string("STREAM_URL")` inside `SubstrateProducerLive` and break the "single env reader" invariant. **Cost: ~10 LOC of comment.** Unblocks nothing technical; prevents drift.

## What this would unlock

- **`Config.redacted` at the bin** unlocks safe `yield* Effect.log` of the resolved boot config — currently `bin/firegrid.ts:82` writes the raw stream URL to stdout, which is fine in dev but a leak vector once auth tokens are in the URL.
- **`ConfigProvider.fromMap` in tests** unlocks deterministic tests for the boot-mode decision currently uncovered (the `attachedUrl !== undefined && attachedUrl.length > 0` branch in `bin/firegrid.ts:76`). Without this migration there is no clean way to test the bin's boot-mode logic.
- **`RuntimeConfigLive` as a Layer** unlocks an environment-driven runtime composition story that today must go through `process.env` reads at the binary edge. Multiple deployment topologies (attached prod, embedded dev, embedded test) become "swap the `ConfigProvider`" rather than "swap the `FiregridRuntimeBoot.*` factory call".
- **Schema-validated config** unlocks deterministic startup-failure messages — `ConfigError.InvalidData` carries the path and reason; the current `RuntimeStartupError` with a `cause: unknown` does not.

## What strict-baseline already enforces vs what would need new gates

The existing static-quality gates (per `docs/REVIEW_EFFECT_CODE_STYLE_2026-05-05.md` and the detector run) do not touch configuration directly:

- The detector inventory at `/tmp/effect-detect-packages.txt` is sparse on Config-related signals because there is nothing to detect — no `Config.*`, no `process.env` outside the bin, no `ConfigProvider` overrides.
- No existing rule forbids `process.env` reads outside `bin/`. Adding such a rule is straightforward (a grep-based detector or a Semgrep pattern: `process.env` not under `bin/`, not under tests, not under `vite.config.ts`) and would be a reasonable **candidate for a future strict gate** if/when the team commits to "all env reads go through `Config.*`".
- A second candidate gate: forbid `Config.string` or `Config.number` outside a single `runtime-config.ts` module. This enforces the design rule from improvement #5 above (single env reader). Again, **candidate only** — do not flip without the underlying refactor (#2) landing first.
- A third candidate: require any field named or typed as a token/secret (e.g., regex match on `*token*`, `*secret*`, `*key*`, `*password*` in interface declarations) to be `Redacted<string>` rather than `string`. Today there are no such fields, so the gate would be vacuously green; it becomes meaningful only after improvement #4.

None of these gates exist today. None should be added today. They are listed so the next reviewer (or the eventual config refactor PR) knows where the natural enforcement points are.
