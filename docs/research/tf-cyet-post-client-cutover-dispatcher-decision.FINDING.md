# tf-cyet Post-Client-Cutover Dispatcher Decision

## Verdict

Outcome 1. The dispatcher should not be formalized as a public durable-RPC substrate. After tf-aago, the client public methods that create contexts, start sessions, and respond to permissions dispatch through protocol channel Tags; the remaining control-request row machinery is the runtime-internal implementation behind callable channel bindings.

## Evidence

The Cycle 2 synthesis recommended Outcome 1 once tf-aago landed: client methods should use channel dispatch, while the dispatcher becomes the internal binding behind `call(channel, req)` (`docs/handoffs/one-substrate-cycle-2-synthesis.md:162`, `docs/handoffs/one-substrate-cycle-2-synthesis.md:164`).

Post-tf-aago, the client captures callable channel Tags at service construction for the channel-routed methods: `HostContextsCreateChannel`, `HostSessionsStartChannel`, and `HostPermissionRespondChannel` (`packages/client-sdk/src/firegrid.ts:536`, `packages/client-sdk/src/firegrid.ts:537`, `packages/client-sdk/src/firegrid.ts:538`). The concrete call sites now use those bindings for launch, session start, and permission response (`packages/client-sdk/src/firegrid.ts:980`, `packages/client-sdk/src/firegrid.ts:997`, `packages/client-sdk/src/firegrid.ts:1026`). `HostSessionsCreateOrLoadChannel` was already on the Sim 2 channel path (`packages/client-sdk/src/firegrid.ts:528`).

The direct request-row residual is prompt only. `appendRuntimeInputIntent` still writes `control.inputIntents.insertOrGet(...)` (`packages/client-sdk/src/firegrid.ts:768`) and is called by top-level/session prompt paths (`packages/client-sdk/src/firegrid.ts:906`, `packages/client-sdk/src/firegrid.ts:995`, `packages/client-sdk/src/firegrid.ts:1008`). This is intentionally held for tf-fyyk because the current prompt egress channels return void, while public prompt methods return stored-row shaped acknowledgements.

The runtime control-plane implementation remains necessary, but below the application surface. It subscribes to durable request rows through `RuntimeControlRequests` (`packages/runtime/src/authorities/runtime-control-plane-recorder.ts:104`, `packages/runtime/src/authorities/runtime-control-plane-recorder.ts:105`, `packages/runtime/src/authorities/runtime-control-plane-recorder.ts:106`) and dispatches them through the runtime-owned reconciler loop (`packages/runtime/src/control-plane/control-request-dispatcher.ts:754`, `packages/runtime/src/control-plane/control-request-dispatcher.ts:763`, `packages/runtime/src/control-plane/control-request-dispatcher.ts:769`). Host-sdk composes that runtime layer internally (`packages/host-sdk/src/host/layers.ts:327`).

## Decision

Keep the dispatcher as runtime-internal control-plane plumbing. Do not bless the row dispatcher as an application-facing durable-RPC substrate. The public contract is protocol channel Tags; host-sdk/runtime bindings may still lower callable channels to control request rows internally.

Keep the client-sdk standalone channel defaults for now. They are channel bindings for standalone/non-host composition, not a second public transport (`packages/client-sdk/src/channels/host-control-default.ts:34`). Production host composition can override them with host-sdk Live Layers.

## Follow-Up

tf-fyyk owns the prompt egress-return decision. When that lands, the remaining direct `appendRuntimeInputIntent` prompt path can move behind `HostPromptChannel` / `SessionPromptChannel` or an explicit return-bearing prompt contract, completing the direct-write retirement.
