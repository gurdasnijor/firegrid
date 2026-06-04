# tf-vqv5 — layer-2 channel collapse: FINDING + partial collapse (2026-06-04)

## TL;DR

Collapsing the host-plane channel **Tags** into free functions is only possible
for the **`WorkflowEngine`-backed** ones. The **DurableTable-backed** one
(`HostSessionsCreateOrLoad`) **cannot** collapse — a load-bearing lint gate
(`local/sg-runtime-no-table-*`) forbids passing `RuntimeControlPlaneTable` to
consumers. The Tag's provider Live IS the sanctioned encapsulation seam. This
reshapes the task's "delete the channel Tags + make bin thin" premise.

**Shipped this PR:** collapsed `session.cancel` / `session.close` /
`host.sessions.start` (the `WorkflowEngine`-backed / vestigial Tags) — net −166
LoC, full preflight green. (commit on branch `codex/tf-vqv5-thin-bin`.)

## THE FINDING (the "ONE gap" the task said to STOP and report)

Slice 2 attempted to collapse `HostSessionsCreateOrLoadChannel` → an exported
`createOrLoadRuntimeContext({control, hostSession, request})` function, rewiring
seedGateway / tool-dispatch / stdio-edge / bin to call it. It typechecked and
lint:dead/lint:deps passed, but **ESLint failed with 6 errors**:

```
local/sg-runtime-no-table-service-yield-outside-providers   (bin/run, stdio-edge, mcp-ingress seedGateway)
local/sg-runtime-no-table-type-parameters-outside-authorities (stdio-edge ctor, tool-dispatch helper)
@typescript-eslint/no-unsafe-return                         (stdio-edge layer)
```

These guard **substrate encapsulation**: `RuntimeControlPlaneTable` (a
runtime-owned `DurableTable`) must only be yielded/accepted inside provider
internals or host composition — NOT handed to edges / the MCP dispatch arm / bin.
`createOrLoadRuntimeContext` necessarily takes `control: RuntimeControlPlaneTable["Type"]`,
so every caller "accepts a runtime-owned DurableTable service" → blocked.

**The `HostSessionsCreateOrLoadChannel` Tag's Live (`HostSessionsCreateOrLoadChannelLive`,
`runtime/src/channels/host-control.ts`) is precisely the sanctioned encapsulation:**
a `Layer.effect` that resolves the table INSIDE the provider and exposes only a
`.binding.call(request) → {sessionId, contextId}` capability. The Tag is NOT
collapsible cruft — it is the encapsulation boundary the gate enforces. Per the
guardrails ("NEVER weaken anti-forge/enforcement gates"; "STOP and report ONE
gap; don't hand-wire around it"), slice 2 was **reverted**.

### Consequence for the task framing

- `host.sessions.start`, `session.cancel`, `session.close` → **collapsed** (they
  call `emitSessionTerminalSignal` over `WorkflowEngine`; no table). DONE.
- `session.prompt` (`SessionPromptChannel`) → **KEEP** — the op-registry keystone
  sim overrides it (`GeneratedSessionPromptChannelLive`, validated architecture);
  it's also `WorkflowEngine`-backed so it *could* collapse, but the keystone needs
  the Tag as its injection seam. Confirmed survives.
- `host.permissions.respond` → **collapsible** (uses `WorkflowEngine` +
  `DurableDeferred`, no table) — see remaining work.
- `host.sessions.create_or_load` → **CANNOT collapse** (table-backed). The Tag
  stays. This is the −300/−450 shortfall's root cause: the biggest binding is the
  one the gate pins in place.
- **bin thin** → bin/run must resolve `HostSessionsCreateOrLoad` (Tag, can't
  collapse) + `SessionPrompt` (keystone Tag). It cannot become "arg-parse +
  firegridHost()" by collapsing Tags. The only path to a truly thin bin is to
  rewrite bin/run to DRIVE via `@firegrid/client-sdk/mcp` over a durable-streams
  ingress (like the sims), not resolve internal Tags — a transport change to a
  user-facing CLI with an `acp-cli-smoke` `firegrid run` test. Risky; separate.

## SHIPPED (this PR)

`session.cancel` / `session.close`: tool-dispatch calls `emitSessionTerminalSignal`
directly (resolving `WorkflowEngine` via the existing `requireHostChannel` helper).
`host.sessions.start`: vestigial ack (the prompt drives `startOrAttach`) — bin/run
dropped it. Deleted: the 3 protocol Tags/Targets/schemas, their SignalingLives +
`signalSessionTerminal`/`terminalPayloadJson`, test stubs. Net −166. Full preflight
green; `mcp-tool-dispatch-sleep` + `control-plane-cancel-close` sim prove it.

## REMAINING WORK (ordered, gate-aware)

1. **Collapse `host.permissions.respond`** (gate-safe — `WorkflowEngine`, no table).
   Export `respondPermissionDecision({engine, request})` from `channel-bindings.ts`
   (extract the `DurableDeferred.succeed` body of `HostPermissionRespondChannelSignalingLive`).
   Rewire: `stdio-edge.answerPermissionRequest`, `bin/run.renderObservation`, and
   the projection runtime (`task-projection.ts:822/838/881` `makeRuntimeTaskAndObservationProjectionRuntime`
   takes `permissionRespond` — change it to take the function + an engine; check
   `mcp-host.ts:275-280` has `WorkflowEngine` in scope to supply it). Delete the
   Tag + Live. Medium effort (threads the 880-line task-projection file).

2. **bin thin** — PO decision required: keep bin/run resolving the surviving Tags
   (createOrLoad + prompt), OR rewrite it to drive via `@firegrid/client-sdk/mcp`
   (durable-streams gateway, mirror `control-plane-cancel-close` driver). The
   latter is the only "thin bin" that satisfies "why bin/" but changes the CLI's
   transport — keep the `acp-cli-smoke` `firegrid run` test green.

3. **Do NOT** try to collapse `HostSessionsCreateOrLoad` or `SessionPrompt` —
   gate-pinned / keystone-pinned respectively.

## GUARDRAIL OUTCOME

The task's "net −300/−450" assumed all layer-2 Tags collapse. Source + the lint
gate show only the `WorkflowEngine`-backed/vestigial ones do; the table-backed
createOrLoad and the keystone prompt Tag are load-bearing. Honest delta: cancel/
close/start (−166) + permission (a further ~−80 when done) ≈ −250, with createOrLoad
+ prompt Tags intentionally retained.
