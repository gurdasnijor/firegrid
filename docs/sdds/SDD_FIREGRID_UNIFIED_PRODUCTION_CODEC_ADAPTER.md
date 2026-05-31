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

### 1. Context insertion via channels — DONE (Phase H)

`HostContextsCreateChannelLive` now persists context rows to `RuntimeControlPlaneTable.contexts` with proper host binding constructed via `CurrentHostSession`. `buildCurrentHostSessionLayer` in `host-identity.ts` handles the brand-validated host id + stream prefix derivation. `FiregridHost` provides `CurrentHostSession` automatically — production hosts get persistent contexts free.

### 2. `FiregridHost` integration — DONE (Phase H)

`FiregridHost({codec: "acp", durableStreamsBaseUrl, namespace})` is the one-line production stack:

```ts
FiregridHost({
  codec: "acp",
  durableStreamsBaseUrl: "http://durable-streams:4437",
  namespace: "my-host",
})
```

Composes: `ProductionCodecAdapterLive` + `LocalProcessSandboxProvider` + `NodeContext.layer` + `IdGenerator.defaultIdGenerator` + `ContextResolverFromControlPlaneTableLive` + `RuntimeEnvResolverPolicy.denyAll` + the full unified substrate. The signaling channel bindings (`UnifiedSignalingChannelBindingsLive`) are layered over the stub `UnifiedChannelBindingsLive` so `firegrid.prompt/session.prompt/sessions.start/permissions.respond` actually deliver signals to the workflow bodies. `hostId` is optionally configurable; defaults to `${namespace}-host`.

The original `adapter:` discriminated-union option still works for sims and non-ACP hosts. The two shapes share `FiregridHostOptionsBase` so options like `headers`, `hostId`, `toolExecutor` work for both.

### 3. Env binding resolution

`RuntimeEnvBinding` carries `{name, ref}` where `ref` points to a secret. The current adapter ignores `envBindings` and lets the sandbox inherit the host process's env. Real production needs a `SecretsResolver` Tag that resolves `ref → value` before the sandbox spawns. The existing `sources/sandbox/secrets.ts` has the resolver shape; wiring it into the codec adapter is a focused 30-line addition.

### 4. MCP server attachment

`RuntimeContext.runtime.config.mcpServers` and `runtimeContextMcp` are not yet read by the adapter. ACP supports MCP server declarations at session start (`AcpSessionOptions.mcpServers`). Wiring them requires also passing `AcpSessionOptions` into the codec layer construction — straightforward, currently omitted to keep the first slice tight.

### 5. End-to-end test against a real agent

Phase F landed scenario 8 — drives the real `AcpSessionLive` codec through an in-process `FixtureAgent` over `TransformStream` byte pipes. Sees the full ACP wire flow (initialize → newSession → prompt → session_updates → exit) and confirms the production adapter handles it cleanly. Sample run: 8/8 scenarios + 21/21 OTel seams (the 5 codec-level seams added: `acp.initialize`, `acp.new_session`, `acp.prompt`, `acp.session_update`, `acp.exit`).

Scenario 9 lands the **live-canary subprocess** behind `FIREGRID_UKV_RUN_ACP_LIVE=1`. Instead of spawning `claude-agent-acp` directly (which requires API credentials), it spawns `tiny-firegrid/src/bin/fake-acp-agent-process.ts` — a Node entry that wraps `FixtureAgent` over `process.stdin` / `process.stdout`. The codec sees genuine subprocess bytes; the agent on the other side speaks real ACP without needing credentials. Swapping in the actual `claude-agent-acp` binary is a one-line change in the resolver's `argv` once credentials are available — the surrounding stack is unchanged.

### 6. Architectural finding: tool-result feedback is codec-specific

Scenario 8 surfaced a real architectural constraint: **ACP rejects `ToolResult` as a free-standing input** (`ACP ToolResult input is out-of-band for this codec slice`). ACP agents execute tools internally; the codec writes `ToolUse` observations to the journal so other observers can see what the agent did, but the agent has already executed and there's nothing to feed back.

This means `JournalObserverLive`'s tool-dispatch trigger + auto-relay pattern is valid for codecs that **delegate tool dispatch externally** (the unified-kernel-validation `FakeCodecAdapter` does this, scenario 7 proves the loop). For ACP-style codecs that **own tool dispatch internally**, scenario 8 demonstrates the host should NOT compose `JournalObserverLive` (or the observer should filter `ToolUse` rows by codec capability).

The host composition therefore has two reasonable shapes:
- **External-tool-dispatch codecs** (e.g. raw byte stream, custom protocols): `FiregridHost({adapter, ...}).pipe(Layer.provide(JournalObserverLive))` — the observer triggers tool dispatch + relay.
- **Internal-tool-dispatch codecs** (ACP, future MCP-bridged agents): `FiregridHost({adapter, ...})` without the observer. The agent owns tool execution; the observer's tool-dispatch trigger isn't needed.

A future iteration could express this declaratively (codec capability flag opting in/out of external dispatch), but the manual composition is currently sufficient and documents the choice at the call site.

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
| 2026-05-31 | Phase F: scenario 8 (`production-flow-acp`) lands end-to-end through the **REAL ACP codec** via in-process `FixtureAgent` (lifted from runtime test prior art). Drives `ProductionCodecAdapterLive` with a fake `SandboxProvider` returning a `TransformStream`-backed `AgentByteStream` — same code path production uses with `LocalProcessSandboxProvider`, only the byte transport is in-process. Proves: (a) the adapter Layer builds with real deps (SandboxProvider + IdGenerator + ContextResolverTag), (b) `AcpSessionLive` decodes real JSON-RPC framing correctly, (c) the per-context process registry + scope-bound output drain work against the real codec, (d) `agent_message_chunk`, `tool_call`, `tool_call_update` ACP protocol events all flow through into `RuntimeOutputTable.events` as typed observations. **Sim: 8/8 scenarios + 17/17 invariants green; seam coverage: 21/21 (added 5 codec-layer ACP seams)**. |
| 2026-05-31 | Phase G: scenario 9 (`production-flow-acp-live`) lands behind `FIREGRID_UKV_RUN_ACP_LIVE=1`. **Real subprocess** via `LocalProcessSandboxProvider` running `src/bin/fake-acp-agent-process.ts` — a Node binary that bootstraps `FixtureAgent` over `process.stdin` / `process.stdout` (web-stream-wrapped via `node:stream.Readable.toWeb`). Same production code path that runs `claude-agent-acp` in production; the fake binary stands in to skip API credentials. Proves the full real-process stack: `LocalProcessSandboxProvider.openBytePipe` + real Node `spawn` + real stdio bytes + `AcpSessionLive` JSON-RPC framing over those bytes + `ProductionCodecAdapterLive` registry + scope-bound output drain. **Sim with flag: 9/9 scenarios + 17/17 invariants green; seam coverage: 22/22 including the env-gated subprocess seam.** Default sim still 8/8 + 21/21 mandatory + 1 optional skipped. |
| 2026-05-31 | Phase H: `FiregridHost` ergonomics + production wiring closure. New options: `codec: "acp"` (sugar that composes `ProductionCodecAdapterLive` + `LocalProcessSandboxProvider` + `IdGenerator.defaultIdGenerator` + `ContextResolverFromControlPlaneTableLive` + `RuntimeEnvResolverPolicy.denyAll`); `hostId?` (derived from namespace by default). `buildCurrentHostSessionLayer` introduced in `host-identity.ts` — constructs valid `CurrentHostSession` rows with brand-validated `hostId` + derived stream prefix. `HostContextsCreateChannelLive` now actually persists rows to `RuntimeControlPlaneTable.contexts` (was a stub returning the input contextId). Channel bindings split: `UnifiedChannelBindingsLive` (stub, builds without `SignalTable`/`WorkflowEngine`) and `UnifiedSignalingChannelBindingsLive` (production override that wires `HostPrompt`/`SessionPrompt`/`HostSessionsStart`/`HostPermissionRespond` to real `sendSignal` calls). `FiregridHost` composes both — last-Live-wins per Tag means production gets the signaling versions automatically. Smoke test `test/unified-firegrid-host-compose.test.ts` verifies the factory builds with `codec: "acp"` and exposes every public Tag. |
