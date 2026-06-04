# tf-cxwu.2 — §12 Slice A: flip the default floor to DurableStreams + migrate callers

**Status: DONE.** `FiregridRuntime`'s floor is now the `DurableStreams` hole
(Seam 1); the spec narrowed; every direct caller migrated; full `pnpm preflight`
green (35/35 tasks incl. the tf-cxwu.1 gate test, `lint:deps` airgap, and the
UKV end-to-end trace gate). The provide-order closure shape proven in tf-cxwu.1
held — **no caller needed a composition change.**

## What changed

**The floor (Seam 1).** `runtimeProvideFloor` is now a value `Layer` that
`yield*`s `DurableStreams` and sources each table/engine `streamOptions` from
`ds.streamOptions(StreamName.X)` over the closed `StreamName` set (no
`contextId`). `McpEndpoint` (`FiregridRuntimeContextMcpBaseUrlLive`) stays a
**member** of the merged floor (the tf-cxwu.1 load-bearing rule). The floor's
R-channel is `DurableStreams`.

**The default flip.** `FiregridRuntime(spec, adapter)` now carries
`R = DurableStreams` (no longer self-contained). The caller closes the hole:
`.pipe(Layer.provide(DurableStreamsLive.{configuredWith|configured}))`.

**The spec narrowed.** `durableStreamsBaseUrl` and `headers` left
`FiregridRuntimeSpec` (now `{ namespace, hostId?, toolExecutor?, envPolicy? }`).
They moved into the backend Live. The narrowing is the forcing function: a stale
`durableStreamsBaseUrl` in a spec literal now fails the excess-property check, so
no caller can silently keep the old shape.

**`FiregridHost` back-compat shim.** Still takes `durableStreamsBaseUrl` (a new
`FiregridHostOptionsBase` re-adds it + `headers`) and closes the hole itself via
`DurableStreamsLive.configuredWith`, staying `R = never`. The
`misuse-resistance-footguns` F1 `@ts-expect-error` (base URL required) still
holds.

## Callers migrated (every direct `FiregridRuntime` call site)

- **15 firelab sim `host.ts`**: channel-completion-contracts,
  child-output-existing-channel-router, codex-acp-tool-calls,
  comp-derisk-ordering, comp-sim-idempotent, control-plane-cancel-close,
  cross-agent-delegation, factory-capstone, mcp-production-task-projection,
  mcp-task-projection-gateway, natural-exit-terminal, op-registry-prompt-keystone,
  shape-c-terminal-ordering, unified-kernel-validation, verified-webhook-wait.
  Each: drop `durableStreamsBaseUrl` from the spec literal + append
  `.pipe(Layer.provide(DurableStreamsLive.configuredWith({ baseUrl:
  env.durableStreamsBaseUrl, namespace: env.namespace })))`. Purely mechanical.
- **`bin/_compose.ts`** (the CLI host): same shape, `configuredWith` with the
  already-resolved embedded-or-configured base URL. The acp/host/run bins flow
  from `_compose`, so they closed automatically.
- **`FiregridHost`** shim: closes the hole internally (above).

`control-plane-cancel-close` additionally needed its return annotation changed
from `ReturnType<typeof FiregridRuntime>` (now `R = DurableStreams`) to
`Layer.Layer<FiregridHost, unknown>` (`R = never`), since it returns the
hole-closed Layer — still a one-line, mechanical fix.

## Two findings (deviations from the task's prediction — neither a blocker)

1. **Sims use `configuredWith(env.durableStreamsBaseUrl)`, NOT `embedded`.** The
   task predicted sims would use `DurableStreamsLive.embedded`. They cannot: the
   firelab runner (`runner/runtime.ts`) manages a SINGLE
   `DurableStreamTestServer` (or a configured base URL) and hands the same
   `baseUrl` to BOTH the sim host (`hostEnv.durableStreamsBaseUrl`) AND the
   driver/client. An `embedded` Live that started its own in-process server would
   put the host on a DIFFERENT server from the driver → no communication. The
   correct mechanical migration keeps host and driver on the shared server via
   `configuredWith(env.durableStreamsBaseUrl)` — identical URLs to pre-cutover,
   zero behavior change. (`embedded` remains the right shape only for a
   self-contained sim that owns its own server — e.g. the tf-cxwu.1 gate test,
   which keeps its local embedded Live.) Still one line per caller, no
   composition change.

2. **The spike's `streamOptionsFor` naming was spike-local and had to be
   corrected for production.** The merged tf-cxwu.1 `durable-streams.ts` resolved
   `StreamName.ControlPlane`/`Output` to `${ns}.firegrid.control-plane` /
   `${ns}.firegrid.output`. But the client-sdk reads the control-plane / output
   streams via the canonical builders, whose physical names are
   `${ns}.firegrid.runtime` / `${ns}.firegrid.runtimeOutput`
   (`namespaceRuntimeStreamName` / `namespaceRuntimeOutputStreamName`). Host and
   client MUST agree on stream URLs, so `streamOptionsFor` now maps the logical
   `StreamName` set → the existing canonical physical names (control-plane→runtime,
   output→runtimeOutput, unified/engine unchanged, signals reserved). This is
   behavior-preserving against pre-cutover (the floor produces exactly the URLs
   the old `tableLayer`/`engineLayer` built); the spike's naming worked only
   because the spike had no real client reading via the protocol builders. This
   was necessary cutover work, not a closure-shape relook.

## Verification

- `pnpm preflight` — 35/35 tasks green (lint, lint:dead, lint:dup, **lint:deps
  airgap** — `DurableStreams` stays in `protocol`, no `client → runtime` edge,
  typecheck 15/15, test, diagnostics, `trace:seams:ukv`).
- `tf-cxwu-1-modularity-compile-spike.test.ts` — the two-line Prod/Sim still
  compile + launch with `R = never`.
- `trace:seams:ukv` — the migrated `unified-kernel-validation` host drives a
  REAL ACP agent end-to-end (real codec initialize/new_session/prompt/exit, real
  subprocess spawn, real adapter start/attach/send/deregister, real workflow
  engine) against a real `DurableStreamTestServer` — proving the migration is
  behavior-preserving, not a backdoor.
