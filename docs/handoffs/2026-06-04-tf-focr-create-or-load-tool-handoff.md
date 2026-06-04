# tf-focr — `session_create_or_load` MCP tool + comp-sim-idempotent restore: HANDOFF (2026-06-04)

The host-plane channel collapse (tf-s9uj) is DONE, green, and merged-ready (PR
#913, branch `codex/tf-s9uj-host-plane-collapse`). This handoff is the **fold-in
that was deliberately split out** to keep that PR a clean transactional cut: a
new caller-external-key create-or-load MCP tool + the restored comp-sim-idempotent
sim. Fully mapped below — execution is mechanical (~12 files, ~30 min).

## WHY this is separate

The collapse rewires existing ops to direct bindings (pure refactor, −226 LoC).
This fold-in is a **surface ADDITION** that touches the projection registry +
exact-set test assertions (operation-id-uniqueness, client projection, two
tool-count tests). Different review surface; kept apart on purpose.

## THE GAP (verified)

`client-sdk/src/mcp.ts` `sessions.createOrLoad` is **mis-wired**: it takes
`SessionNewToolInput` and calls `callTool("session_new", …)` (mcp.ts:547-563).
`session_new` derives the externalKey HOST-side
(`firegrid.mcp.session_new:${parentContextId}:${toolUseId}`, tool-dispatch.ts
`runSessionNew`), so two "same intent" calls get DIFFERENT contexts — NOT
idempotent on the caller's `[source,id]`. comp-sim-idempotent needs caller-keyed
idempotency, so it cannot run on the current surface.

## THE FIX (reuse the existing schema — avoids an operationId collision)

`SessionCreateOrLoadInputSchema` (session-facade/schema.ts:54) already exists:
`{ externalKey:{source,id}, runtime, createdBy?, parentContextId? }`, operationId
`session.createOrLoad`, clientName `sessions.createOrLoad`. And
`HostSessionsCreateOrLoadRequestSchema === SessionCreateOrLoadInputSchema`, so the
arm passes input STRAIGHT to `.binding.call`. Output =
`SessionHandleReferenceSchema` (`{sessionId, contextId}`, schema.ts:102). REUSE
both — the operation-id-uniqueness gate is keyed on schema IDENTITY and
explicitly allows one operation projecting to multiple surfaces via the SAME
schema (operation-id-uniqueness.test.ts header).

### Ordered edits

1. **protocol/session-facade/schema.ts:64** — add `toolName: "session_create_or_load"`
   to `SessionCreateOrLoadInputSchema`'s `firegridProjection({ operationId:
   "session.createOrLoad", clientName: "sessions.createOrLoad" })`. (This is the
   ONLY protocol-schema change; output needs no projection — `projectTool` reads
   metadata off the INPUT only.)
2. **protocol/agent-tools/schema.ts:793** — add to `FiregridAgentToolOperations`:
   `sessionCreateOrLoad: { input: SessionCreateOrLoadInputSchema, output: SessionHandleReferenceSchema }`
   (import both from `../session-facade/schema.ts`). This is the registry the
   projection/uniqueness tests enumerate.
3. **runtime/unified/mcp-host/toolkit.ts** — add a 12th entry to `AGENT_TOOL_GROUPS`
   (164), `ProjectedAgentTools` tuple (213-225 → add index 11), `AgentToolNames`
   (180-192 → add "session_create_or_load"), and the destructure (235-247 → add
   `SessionCreateOrLoadTool`). Import `SessionCreateOrLoadInputSchema` +
   `SessionHandleReferenceSchema` (they are NOT under `AgentToolSchemas`; import
   from `@firegrid/protocol/session-facade` or re-export them from agent-tools).
4. **runtime/unified/mcp-host/toolkit-layer.ts:87** — add a handler in
   `makeToolkitHandlers`: `session_create_or_load: (params) =>
   handleTool<SessionHandleReference>(captured, "session_create_or_load", params)`.
5. **runtime/unified/mcp-host/tool-dispatch.ts** — add `runSessionCreateOrLoad`
   arm + a `dispatchArm` case "session_create_or_load". The arm:
   `requireHostChannel(HostSessionsCreateOrLoadChannel, toolUseId, "session_create_or_load")`
   then `.binding.call(input).pipe(Effect.mapError(mapChannelError(...)))` and
   return the `{sessionId, contextId}` handle. (Mirror the create-or-load call
   already in `runSessionNew` — same channel, same shape.)
6. **client-sdk/src/mcp.ts** — re-point `sessions.createOrLoad` (127-131 type +
   547-563 impl): take `SessionCreateOrLoadInput` (externalKey/runtime/createdBy),
   `callTool("session_create_or_load", request)`, decode the `{sessionId,
   contextId}` handle. Drop the `SessionNewToolInput`→`session_new` mapping.
7. **Restore the sim** — `git show 63791b544:packages/tiny-firegrid/src/simulations/comp-sim-idempotent/{driver,host,index}.ts`.
   - `host.ts`: migrate to `firegridHost({ spec, adapter, backend, ingress })`
     (the #910 pattern — see any sim under simulations/*/host.ts, e.g.
     control-plane-cancel-close). durableStreams ingress with a gateway external
     key.
   - `driver.ts`: replace `@firegrid/client-sdk/firegrid` + `Firegrid` /
     `firegrid.sessions.createOrLoad` with the mcp.ts client
     (`@firegrid/client-sdk/mcp`, the FiregridMcpClient) `sessions.createOrLoad`.
     Keep the noopRuntime + the redeliver/replay/distinct assertions-as-trace.
   - Register it in the sim index/registry if sims are enumerated.
8. **Tests** (exact-set assertions — update counts):
   - `runtime/test/bin/acp-cli-smoke.test.ts`: `tool_count` 11→12,
     `EXPECTED_FULL_TOOL_NAMES` add `"session_create_or_load"` (alphabetical).
   - `runtime/test/mcp-host/mcp-host-http-acceptance.test.ts`: same count/name set.
   - `client-sdk/test/firegrid.projection.test.ts`: the `session.createOrLoad`
     expectation (lines ~27/98) now ALSO carries `toolName:
     "session_create_or_load"` — update the expected projection.
   - `protocol/test/projection/operation-id-uniqueness.test.ts`: should stay green
     (schema reuse), but run it — it imports `FiregridAgentToolOperations`.
9. **docs/findings/tf-ll90-8-4-held-sims.md** — flip comp-sim-idempotent from HELD
   to RESTORED (note the new tool). verified-webhook-wait stays HELD (separate
   dynamic-plane gap).

## PROVE

Run the restored sim: `pnpm --filter @firegrid/tiny-firegrid run simulate:run
comp-sim-idempotent`. Expect `DriverCompleted`; the trace's summary span
(`firegrid.sim.idempotent_one_intent`) shows first==redeliver==all replays (one
participant) and distinct_entity/other_source as DISTINCT contextIds. Then full
`pnpm preflight`.

## GATE WATCH

- operationId-uniqueness: green ONLY because you REUSE `SessionCreateOrLoadInputSchema`.
  Do NOT mint a new input schema with operationId `session.createOrLoad`.
- The acp-cli-smoke runs a REAL agent; a 12th tool only changes the count/name
  assertions, not agent behavior (it calls what it needs).
