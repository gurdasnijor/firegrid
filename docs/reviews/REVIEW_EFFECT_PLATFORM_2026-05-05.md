# Effect-TS Platform Review — 2026-05-05

## Summary

Firegrid's `@effect/platform` surface is intentionally small. The runtime binary (`packages/runtime/bin/firegrid.ts`) is a positive example: it imports `Command`, `Terminal`, and `CommandExecutor` from `@effect/platform`, drives the child process via `Command.make` / `Command.env` / `Command.exitCode`, writes diagnostic lines through `Terminal.Terminal.display`, provides `NodeContext.layer` from `@effect/platform-node` once at the binary edge, and runs the program through `NodeRuntime.runMain`. That is the canonical shape the platform skill recommends, and it is already in place.

Beyond the binary, the rest of the codebase touches platform-adjacent capabilities only sparingly:

- No production source uses `@effect/platform/FileSystem`, `HttpClient`, `HttpServer`, or `KeyValueStore` — none of those domains are present in production today (file I/O appears only in test helpers and Vite config; HTTP transport is delegated to `@durable-streams/client`, an application-protocol client outside the `@effect/platform/HttpClient` boundary).
- Two `node:*` direct imports remain in production: `node:crypto.randomUUID` (substrate kernel and runtime identity) and one `process.env` read at the binary. Both are already tracked elsewhere (R9/L3 in `REVIEW_FIREGRID_2026-05-05.md`; the env read is also the focus of the configuration review).

Quick stats:

- `@effect/platform` import sites in production: **1** file (`packages/runtime/bin/firegrid.ts`).
- `@effect/platform-node` import sites in production: **1** file (same binary).
- `node:crypto.randomUUID` direct imports in production: **4** files.
- `process.env` reads in production: **1** site (`bin/firegrid.ts:74`).
- `process.argv` reads in production: **1** site (`bin/firegrid.ts:143`, used to construct `parseArgs`).
- Subprocess/shellout sites: **1** (the `firegrid dev` child spawn in `bin/firegrid.ts:124`, already routed through `Command.make`).
- `FileSystem`, `KeyValueStore`, `HttpClient`, `HttpServer` usages: **0** each.

The remaining gaps are narrow and largely boundary-of-purity items, not functional ones.

## Findings by concept

### Command and child-process execution

`packages/runtime/bin/firegrid.ts:124-134` builds the dev-mode child via `Command.make(head, ...rest)` piped through `Command.env({ DURABLE_STREAMS_URL, VITE_DURABLE_STREAMS_URL })`, three `Command.std{in,out,err}("inherit")` calls, and `Command.exitCode(command)` to await. The child-exit branch is encoded as a `Data.TaggedError("ChildExitError")` (`bin/firegrid.ts:7-9`) and returned via the error channel. This is exactly what the platform skill prescribes: no `child_process.spawn`, no `execa`, no manual stdio plumbing.

A grep for `child_process|spawn|execa|execSync` across `packages/` and `apps/` returns no other production sites — this is the only subprocess surface in the repo. No further migration is owed here.

### Terminal usage

The same binary funnels its stdout through `Terminal.Terminal`. The helper at `bin/firegrid.ts:67-70`:

```
const writeStdout = (line: string) =>
  Effect.flatMap(Terminal.Terminal, (terminal) =>
    terminal.display(`${line}\n`),
  )
```

is used for the four diagnostic lines (`runDefault` and `runDev`). The `program` value is typed `Effect.Effect<void, unknown, Terminal.Terminal | CommandExecutor.CommandExecutor>` (`bin/firegrid.ts:148-152`), making the platform requirements explicit, and `NodeContext.layer` satisfies both at `bin/firegrid.ts:154`. There is no `console.log` / `process.stdout.write` in production code (the codebase has no other terminal write sites at all). No further work owed.

### `process.env` and `process.argv` reads

Two reads remain at the binary edge:

- `bin/firegrid.ts:74` — `process.env["DURABLE_STREAMS_URL"]`. This is the boot-mode discriminator. Already flagged in `REVIEW_EFFECT_CONFIGURATION_2026-05-05.md` as the single direct env read in production. The right idiomatic shape is `Config.option(Config.string("DURABLE_STREAMS_URL"))` plus `Option.match` on the resulting effect — replacing the brittle `attachedUrl !== undefined && attachedUrl.length > 0` check with a typed presence test and giving tests a `ConfigProvider.fromMap` seam.
- `bin/firegrid.ts:143` — `process.argv.slice(2)` feeding `parseArgs`. Argv is harder to argue about: `@effect/platform/Command` is the wrong tool (it builds outgoing commands, not parses incoming argv), and `@effect/cli` would be a structural dependency for what is presently a two-branch parser (`default` vs `dev -- ...`). Acceptable as-is; flag only as a "consider `@effect/cli` if the command grows beyond two subcommands".

Cross-reference: configuration review owns the `DURABLE_STREAMS_URL` rewrite. No new finding here.

### `node:crypto.randomUUID` direct usage

Four production sites import `randomUUID` from `node:crypto`:

- `packages/substrate/src/producer.ts:1, 133` — `runId` default in `declareWork`.
- `packages/substrate/src/internal-claim.ts:1, 61` — `claimId` for `attemptClaim`, with a `claimIdOverride` test seam already threaded through.
- `packages/substrate/src/waits.ts:108, 176, 192, 224` — `completionId` for `sleep`, `waitFor`, `scheduleWork`.
- `packages/runtime/src/boot/identity.ts:1, 10` — `generateProcessId` returning `firegrid:${randomUUID()}`.

This is the same R9/L3 finding tracked in `REVIEW_FIREGRID_2026-05-05.md:41`. As of this review there is no closing change — the `node:crypto` imports are still in tree. The platform skill does not call out `randomUUID` directly (it is not in `@effect/platform`); the canonical Effect-side replacement is either `Effect.Random` (`Effect.uuid` if available in the version-pinned API) or a small `IdGen` `Context.Tag` service that `LiveLayer` implements with `crypto.randomUUID` and `TestLayer` implements with a deterministic counter. The latter pattern is what the test seam in `internal-claim.ts:30` (the `claimIdOverride` field) is already approximating per call-site — promoting that seam to a service would let `producer.ts` and `waits.ts` drop their direct `node:crypto` dependency for free and would let kernel tests assert exact UUID values without overrides at every entry point.

There is also an in-band `Math.random` ID generator at `packages/client/src/firegrid/event-client.ts:103-104`:

```
const nextEventId = (): string =>
  `${Date.now()}:${Math.random().toString(36).slice(2)}`
```

This is browser-safe by design (the client surface is bundled for the browser per the comment block at `event-client.ts:19-26`), but it shares the same purity-boundary issue as the kernel's `randomUUID`: a non-Effect random source. Folded into the same `IdGen` service work, this site would naturally migrate; on its own it is not worth a separate fix.

### `FileSystem` opportunities

A `find … | xargs grep -l` for `node:fs|node:path|node:url|from "fs"|from "path"|from "url"` across `packages/` and `apps/` (excluding `__tests__/` and `*.test.ts`) returns **zero** production matches. There are no production file reads or writes; therefore no `@effect/platform/FileSystem` migration is owed. The skill's "Reading Files" / "Writing Files" / "Directory Operations" sections are not applicable in this repo right now.

### `KeyValueStore` opportunities

No production code uses any local key-value persistence — all durable state lives in Durable Streams (the substrate's append-only log) and projections rebuilt from it (`stream.ts`, `projection.ts`). `@effect/platform/KeyValueStore` is not a fit for this architecture: the substrate is its persistence layer. Zero usage is correct.

### `HttpClient` / `HttpServer` status

- **HttpClient (0 sites)**: outgoing wire transport is encapsulated by `@durable-streams/client`'s `DurableStream` class (used at `packages/client/src/firegrid/event-client.ts:7,109`, `packages/client/src/firegrid/operation-client.ts`, `packages/substrate/src/producer.ts`, `internal-claim.ts:48`, `waits.ts:125`, and `apps/lab/src/lab/RawStreamInspector.tsx:1,44`). As the brief calls out, this is a peer to `@effect/platform/HttpClient`, not a candidate for migration: durable-streams is an application-protocol session client (offsets, head, jsonStream, live follow), not a generic HTTP fetch wrapper. Re-implementing it on top of `HttpClient` would lose the protocol guarantees the kernel relies on. Leave as-is.
- **HttpServer (0 sites)**: there is no HTTP server in firegrid production code — the runtime binary blocks on `Effect.never` after wiring the layer (`bin/firegrid.ts:86`), and the dev server is the embedded `DurableStreamTestServer` provided by `embeddedDev` (constructed inside `FiregridRuntimeBoot.embeddedDev` rather than at the bin). No `@effect/platform/HttpServer` migration applies.

The lab's `RawStreamInspector.tsx` was specifically called out for review. It uses `DurableStream.connect` then `session.jsonStream()` inside a React `useEffect` callback. This is application-protocol consumption (offset cursor, live follow), not an HTTP fetch, so `HttpClient` is the wrong destination. The bigger style observation — that the inspector wraps a `cancelled` boolean and `void run()` instead of using `Stream.fromAsyncIterable` + `Effect.runFork` with proper finalization — is a streams/runtime concern, not a platform concern.

### Path/URL handling

No production site imports `node:path` or `node:url`. URLs in production are transported as opaque strings (`streamUrl: string` everywhere). This means there is no correctness risk from inconsistent path/URL parsing, and no `@effect/platform`-native `Path` or URL helper is owed.

### Direct `node:*` imports — production summary

Combining the above, the only production `node:*` imports in firegrid are:

- `node:crypto` — 4 files (producer, internal-claim, waits, runtime/boot/identity). Tracked R9/L3, still open.

That is the entire production-surface gap.

### `@effect/platform-node` Layer placement

`NodeContext.layer` is provided exactly once, at the binary edge (`bin/firegrid.ts:154`), via `program.pipe(Effect.provide(NodeContext.layer))`, and `program` is `satisfies Effect.Effect<void, unknown, Terminal.Terminal | CommandExecutor.CommandExecutor>` — so the requirements are surfaced explicitly and discharged at the boundary. The scoped subroutines (`runDefault`, `runDev`) are wrapped in `Effect.scoped` and inherit the platform layer through composition. This matches the skill's "Provide platform layers" best-practice and "Use Effect.scoped for resources" guidance.

## Out of scope

Per the brief and the existing handoff:

- Test helpers in `packages/*/src/__tests__/**` and `*.test.ts` files using `node:fs` / `node:path` / `node:url` — tooling, not production.
- `apps/lab/vite.config.ts` — Vite framework boundary.
- `apps/lab/src/main.tsx` `import.meta.env["VITE_DURABLE_STREAMS_URL"]` — Vite framework boundary.
- `@durable-streams/client` — application-protocol transport, not `@effect/platform/HttpClient`.

## Top 3 improvements

1. **Promote an `IdGen` service to retire the four `node:crypto` imports.** A `Context.Tag` with `LiveLayer` (`crypto.randomUUID`) and `TestLayer` (deterministic counter) closes R9/L3 across `producer.ts`, `internal-claim.ts`, `waits.ts`, and `runtime/boot/identity.ts` in one pass, drops `claimIdOverride` plumbing, and brings the in-band `event-client.ts:103-104` Math.random fallback under the same abstraction (with a browser-safe layer variant). Highest-leverage platform-adjacent change.
2. **Replace `process.env["DURABLE_STREAMS_URL"]` at `bin/firegrid.ts:74` with `Config.option(Config.string("DURABLE_STREAMS_URL"))`.** Already owned by the configuration review; including it here for completeness because it is the only remaining process-edge env read and it sits next to the `@effect/platform` Command/Terminal usage that is otherwise idiomatic. Adds a `ConfigProvider.fromMap` test seam for the boot-mode discriminator.
3. **Refactor `apps/lab/src/lab/RawStreamInspector.tsx:36-77` from raw `useEffect` + `cancelled` flag to a `Stream.fromAsyncIterable` consumed through a React-bridged Effect runtime.** Not a platform-service migration (the underlying client stays `@durable-streams/client`), but it removes the imperative cancellation flag and aligns with the same Effect.scoped pattern the bin already follows. Lower priority than items 1 and 2; flagged because the brief specifically asked.

## What strict-baseline already enforces

The post-R0-R-STRICT-BASELINE settings have already locked in the items below — no follow-up needed:

- `bin/firegrid.ts` runs through `NodeRuntime.runMain` with `NodeContext.layer` provided at the boundary; the program type explicitly tracks `Terminal.Terminal | CommandExecutor.CommandExecutor` requirements (`bin/firegrid.ts:148-152`).
- All terminal output goes through `Terminal.Terminal.display` (`bin/firegrid.ts:67-70`); there are no `console.log` writers in production.
- Subprocess execution is fully through `Command.make` / `Command.env` / `Command.exitCode` (`bin/firegrid.ts:124-134`); no `child_process` or `execa` usage anywhere.
- Child-exit failure modes are typed as `Data.TaggedError("ChildExitError")` (`bin/firegrid.ts:7-9`) and surfaced through the Effect error channel.
- Scoped-resource discipline at the bin: both subcommand bodies are wrapped in `Effect.scoped` (`bin/firegrid.ts:72`, `:91`), so finalizers from `FiregridRuntimeBoot.embeddedDev` (the embedded Durable Streams test server) and from the spawned `Command` run deterministically on shutdown.
