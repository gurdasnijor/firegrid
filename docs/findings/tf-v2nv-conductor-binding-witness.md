# tf-v2nv — Fluent ACP conductor binding witness

**Date:** 2026-06-05
**Sim:** `packages/firelab/src/simulations/fluent-acp-conductor-binding/`
**Verdict:** `production-path-covered`

## Why

The conductor unit/integration tests (`packages/fluent-runtime/test/acp-conductor.test.ts`) fake `ConductorSessionPort`, so they prove ACP-call routing but not that editor calls become **durable, product-visible fluent-runtime facts**. This firelab witness closes that gap with no fakes on the runtime side.

## What it exercises (no faked port)

A real ACP SDK editor-side client (`acp.ClientSideConnection`) drives, over an in-memory `acp.Stream`, into the production `connectFiregridAcpConductor`, backed by `makeConductorSessionPortFromRuntime` over `FluentRuntimeLive` against firelab's `DurableStreamTestServer`:

```
editor (acp.ClientSideConnection) → acp.Stream → FiregridAcpConductor (acp.Agent)
  → ConductorSessionPort (makeConductorSessionPortFromRuntime) → FluentStore → durable streams
```

The editor performs `initialize → newSession → prompt → cancel`. The **driver is airgapped** (firelab rule: imports only `@firegrid/client-sdk` + `effect`); it reads the durable session stream over HTTP and asserts the product facts independently of host internals.

## Computed verdict (forge-proof FluentStore substrate spans)

| Gate | Span | Result |
|---|---|---|
| session_create | `fluent_runtime.store.session.create` | ✓ (1×) |
| event_append | `fluent_runtime.store.session.append_event` | ✓ (**2×** — prompt + cancel) |
| durable_write | `firegrid.durable_streams.http.request` | ✓ (4×) |

Corroboration: `firegrid.sim.fluent_acp_conductor_binding.host.run` ✓. These names are emitted only by the host-side store/transport (the driver never instantiates them), so their existence proves the conductor's ACP calls reached fluent-runtime — not driver-only assertions.

## Driver-observed durable facts (product-visible)

Read back from the durable session stream: `session.created`, `session.event_appended {name: "acp/prompt.accepted"}`, `session.event_appended {name: "acp/session.cancelled"}`. Outcome: `DriverCompleted`.

## Scope

Intentionally NOT covered here (future slices): downstream ACP delegation, native resume / replay-suppression, parking tools, Zed/CLI stdio packaging.

Reproduce: `pnpm --filter firelab simulate:run fluent-acp-conductor-binding`.
