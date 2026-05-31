# SDD: Unified Production Codec Adapter (Phase E)

Status: scaffolding landed, real-codec wiring pending end-to-end agent run
Created: 2026-05-31
Owner: Firegrid Runtime
Predecessors:
- `SDD_FIREGRID_UNIFIED_PRODUCTION_WIRING.md` (Phase 3 — adapter Tag, observer, factory, sim-proven loop)
- `docs/architecture/2026-05-31-unified-architecture-mental-model.md`

## Purpose

Phase 3 closed the production loop end-to-end in the simulation using a `FakeCodecAdapter`. This phase wraps the real `sources/codecs/{acp,stdio-jsonl}` behind the same `RuntimeContextSessionAdapter` Tag so production hosts can compose `FiregridHost({adapter: ProductionCodecAdapterLive, ...})` and serve real agent processes.

The structural contract is unchanged from Phase 3 — adapter Tag with three methods, host-scoped service with per-context process registry, output drain to `RuntimeOutputTable.events`. Everything in this SDD is "fill in the real implementation behind the contract".

## What landed

`runtime/src/unified/codec-adapter.ts` — `ProductionCodecAdapterLive`.

### Inputs (R-channel)

```ts
Layer.Layer<
  RuntimeContextSessionAdapter,
  never,
  | RuntimeOutputTable          // where output events are written
  | SandboxProvider             // creates the agent process
  | IdGenerator.IdGenerator     // codec-internal id generation
  | ContextResolverTag          // contextId → RuntimeContext
>
```

### Behavior

| Method | Implementation |
|---|---|
| `startOrAttach(ctxId, attempt)` | Check registry; if absent, resolve context, create sandbox, open byte pipe, build `AcpSession` or `StdioJsonlSession` (chosen by `runtime.config.agentProtocol`), fork output drain into per-context scope, store in registry. |
| `send(ctxId, attempt, input)` | Look up session; decode `input.payloadJson` to `AgentInputEvent` based on `input.kind`; call `session.send(event)`. Body-level kinds (`terminal`, `peer-event`, `scheduled-fire`) short-circuit — no codec call. |
| `deregister(ctxId)` | Close the per-context Scope (kills process, closes codec, stops output drain). Remove from registry. |

### Output drain

`session.outputs` is a `Stream<AgentOutputEvent>` from the codec. The adapter forks a daemon (in the per-context scope) that drains it into `RuntimeOutputTable.events` with monotonically-incrementing sequence numbers and proper envelope encoding (`encodeRuntimeAgentOutputEnvelope`). On scope close (deregister or host shutdown), the drain stops.

### Context resolution

`ContextResolverTag` is a small seam — `{resolve: contextId → Effect<Option<RuntimeContext>>}`. Production hosts compose `ContextResolverFromControlPlaneTableLive` (reads from `RuntimeControlPlaneTable.contexts`); tests can supply a static-map resolver.

This decouples the codec adapter from the table — the adapter file does not depend on `RuntimeControlPlaneTable` directly. Useful for unit tests; also clarifies the responsibility boundary (table is just one possible context source).

## What's pending

These dependencies aren't yet wired into a host that would actually call the adapter end-to-end:

### 1. Context insertion via channels

`HostContextsCreateChannelLive` and `HostSessionsCreateOrLoadChannelLive` in `channel-bindings.ts` currently STUB the response — they don't write to `RuntimeControlPlaneTable.contexts`. Production hosts need these to actually persist contexts so `ContextResolverFromControlPlaneTableLive` can find them.

**Why deferred:** the host-binding fields (`hostId`, `streamPrefix`, `hostSessionId`) have strict schema validation tied to `CurrentHostSession`. Populating them properly requires a host-identity layer that the unified composition doesn't currently provide. Adding it is its own focused increment.

### 2. `FiregridHost` integration

The factory in `host.ts` currently requires `adapter` from the caller (any Layer satisfying `RuntimeContextSessionAdapter`). It does NOT wire `ProductionCodecAdapterLive` as an option. To compose with the factory, callers do:

```ts
FiregridHost({
  adapter: ProductionCodecAdapterLive.pipe(
    Layer.provide(LocalProcessSandboxProvider.layer()),
    Layer.provide(ContextResolverFromControlPlaneTableLive),
    Layer.provide(IdGenerator.layerDefaults), // or similar
  ),
  durableStreamsBaseUrl: "...",
  namespace: "...",
})
```

This works structurally. Whether to add a sugar option like `FiregridHost({ codec: "acp", ... })` is a follow-up ergonomic question.

### 3. Env binding resolution

`RuntimeEnvBinding` carries `{name, ref}` where `ref` points to a secret. The current adapter ignores `envBindings` and lets the sandbox inherit the host process's env. Real production needs a `SecretsResolver` Tag that resolves `ref → value` before the sandbox spawns. The existing `sources/sandbox/secrets.ts` has the resolver shape; wiring it into the codec adapter is a focused 30-line addition.

### 4. MCP server attachment

`RuntimeContext.runtime.config.mcpServers` and `runtimeContextMcp` are not yet read by the adapter. ACP supports MCP server declarations at session start (`AcpSessionOptions.mcpServers`). Wiring them requires also passing `AcpSessionOptions` into the codec layer construction — straightforward, currently omitted to keep the first slice tight.

### 5. End-to-end test against a real agent

The simulation's `production-flow` scenario uses a fake codec that proves the architectural loop. A real-codec test requires running `claude-agent-acp` or similar; that's an integration-test concern (a separate fixture / harness), not a sim concern. Phase E's structural acceptance is "layer builds; tycecheck clean; existing 7/7 + 17/17 sim still green".

## Acceptance criteria

1. ✅ `ProductionCodecAdapterLive` lands in `runtime/src/unified/codec-adapter.ts`.
2. ✅ `ContextResolverTag` + `ContextResolverFromControlPlaneTableLive` provide a clean seam for context lookup.
3. ✅ Existing `unified-kernel-validation` simulation passes 7/7 + 17/17 (no regression).
4. ✅ `pnpm -r exec tsc --noEmit` clean.
5. ⏳ Integration test against a real ACP agent — deferred to a separate harness.

## Out of scope

- Bin entrypoints (`firegrid host`, `firegrid run`). Production wiring is a Layer factory; how it's invoked from a CLI is a separate concern (Phase F if it materializes).
- `@firegrid/host-sdk` repurposing or deletion. Independent.
- `@firegrid/cli` reshape.
- Multi-host orchestration / scaling concerns.

## Progress log

| Date | Note |
|---|---|
| 2026-05-31 | `ProductionCodecAdapterLive` scaffolding landed. Context resolver Tag introduced. ACP + stdio-jsonl both supported via `agentProtocol` discriminator. Existing sim 7/7 + 17/17 green; no regression. |
