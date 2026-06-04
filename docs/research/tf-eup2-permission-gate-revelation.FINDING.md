# FINDING — permission gate revelation

Bead: `tf-eup2` · companion to `tf-3ek` · status: source-verified doc update

## TL;DR

The 2026-05-19 "Layer 4 GAP" was the missing driver-side permission policy
loop. Once PR #444 / `tf-s8y` and PR #446 / `tf-v7t` made Firegrid MCP tools
visible under the working `.mcp.json` path, `claude-agent-acp@0.36.1` did what
its source says it will do: gate each MCP tool invocation behind ACP
`session/request_permission`. Firegrid correctly surfaced that as a
`PermissionRequest`; dark-factory simply had no driver loop answering it.

This is now recorded in
[`docs/handoffs/COORDINATOR_HANDOFF_s6_dark_factory.md` §0c](../handoffs/COORDINATOR_HANDOFF_s6_dark_factory.md).

## 60-second grep

The refuting grep is:

```bash
rg -n "canUseTool|requestPermission|allow_always" \
  /Users/gnijor/.npm/_npx/*/node_modules/@agentclientprotocol/claude-agent-acp/dist/acp-agent.js
```

Source-verified hits from the pinned runtime used by dark-factory:

- `/Users/gnijor/.npm/_npx/286fc3b7ffd18687/node_modules/@agentclientprotocol/claude-agent-acp/dist/acp-agent.js:1008`
  defines `canUseTool(sessionId)`.
- `acp-agent.js:1094-1118` calls `this.client.requestPermission(...)` for a
  normal tool invocation and only returns `behavior: "allow"` when the selected
  outcome is `allow` or `allow_always`.
- `acp-agent.js:1393` passes `canUseTool: this.canUseTool(sessionId)` into the
  Claude Agent SDK query options.

Firegrid's side of the same boundary:

- `packages/runtime/src/agent-event-pipeline/codecs/acp/index.ts:480-493`
  implements ACP `requestPermission`: mint a permission request id, emit a
  `PermissionRequest` observation, then await the driver's permission decision
  before returning to `claude-agent-acp`.

## PR #446 fix shape

PR #446 (`tf-v7t`, open PR head
`36fbc8d2eaf52e49c76a85d7a8804387af8ce9dc`) adds the missing dark-factory
driver policy loop on its branch:

- `packages/firelab/src/simulations/dark-factory/driver.ts:40-58`
  documents the finding: every MCP tool invocation is wrapped by
  `canUseTool`; Firegrid forwards it; the driver must respond.
- `driver.ts:59-94` implements `forkAutoApprovePermissions`, repeatedly
  waiting with `session.wait.forPermissionRequest`, threading `afterSequence`,
  and calling `session.permissions.respond({ decision: { _tag: "Allow" } })`.
- `driver.ts:137-140` starts the auto-approver before `session.start()`, so
  the first MCP tool call has a live policy handler waiting.

For the dark-factory proof harness, "auto approve" is not a product permission
policy. It is the closed-sim policy authority saying: allow the Firegrid MCP
tools so the §6 workflow can be measured. Real product permission UX remains a
separate surface.

## Consequence

The original five-cause matrix in `tf-3ek` was missing a sixth cause:

| Cause | Status |
|---|---|
| Permission gate: `claude-agent-acp` asks the client before each MCP tool call, and the driver never answered | RESOLVED by PR #446's forked permission handler |

That explains the observed "planner went quiet" behavior after tool visibility
was fixed: the agent was not refusing to use Firegrid tools; it was waiting on
the policy authority.
