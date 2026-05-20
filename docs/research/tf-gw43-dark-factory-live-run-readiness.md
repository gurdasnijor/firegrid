# tf-gw43 Dark-Factory Live Run Readiness

Status: readiness audit only. No dark-factory live run was started, and no
LLM/provider cycles were spent.

Sources read:

- `docs/vision/factory-vision.md`
- `packages/tiny-firegrid/src/simulations/dark-factory/host.ts`
- `packages/tiny-firegrid/src/simulations/dark-factory/driver.ts`
- `packages/tiny-firegrid/src/simulations/dark-factory/index.ts`
- `packages/host-sdk/src/host/channel.ts`
- `packages/host-sdk/src/host/mcp-channel-metadata.ts`
- `packages/host-sdk/src/agent-tools/execution/tool-use-to-effect.ts`
- `packages/host-sdk/src/agent-tools/execution/toolkit-layer.ts`
- `packages/host-sdk/src/host/agent-tool-host-live.ts`
- `packages/runtime/src/agent-event-pipeline/subscribers/runtime-tool-use-executor.ts`
- `packages/runtime/src/workflow-engine/workflows/{runtime-context,tool-call,wait-for}.ts`
- `packages/runtime/src/streams/runtime-observation-streams.ts`

## Current Substrate Snapshot

The current main branch is past the `tf-0r95` channel migration. Dark-factory
now owns its app-specific channel Tags in `host.ts` and registers:

| Target | Direction | Backing |
| --- | --- | --- |
| `factory.events` | ingress | `DarkFactoryFactTable.facts.rows()` |
| `event.plan.ready` | bidirectional | `DarkFactoryFactTable.planReadyEvents.rows()` plus append |
| `dm.operator` | ingress | filtered `operatorMessages.rows()` |
| `notification.operator` | egress | append to `operatorNotifications` |
| `approval.operator` | call | local callable channel |

`FiregridRuntimeHostLive` receives those registrations through its `channels`
option and dark-factory also provides `ChannelInventoryLive`. Runtime-context
MCP metadata enriches `wait_for` with the registered channel inventory under
`x-firegrid-channels`.

The current agent tool surface includes MCP/toolkit handlers for `sleep`,
`wait_for`, `wait_for_any`, `send`, `call`, `session_new`, `session_prompt`,
`session_cancel`, `session_close`, `schedule_me`, and `execute`.
`sleep` lowers through the runtime-owned `RuntimeAgentToolExecution` service and
`DurableClock.sleep`.

Important distinction: `WaitForWorkflow` exists in runtime, but the current
`wait_for` arm still uses the channel's typed stream directly with an
`Effect.timeoutTo` timeout. The comment in `tool-use-to-effect.ts` says the
production handoff to `WaitForWorkflow.execute` is still blocked on `tf-xw0w`.
So channel-backed waiting is available for a smoke, but it is not yet the final
runtime-owned wait workflow path.

## Capabilities §7 Readiness Matrix

| # | Factory-vision capability | Readiness for dark-factory now | Gating / notes |
| --- | --- | --- | --- |
| 1 | Accept external events as durable, verified facts | Partially works now | The sim seeds a synthetic `factory.trigger.accepted` row into `DarkFactoryFactTable.facts`, and `factory.events` exposes that row as a typed ingress channel. The verified webhook substrate exists elsewhere, but dark-factory is not currently exercising an external provider webhook path. |
| 2 | Hold participant identity durably across time | Works for a bounded smoke now | `darkFactoryDriver` creates or loads one runtime context by external key, enables runtime-context MCP, prompts it, and starts it through public client calls. The host owns `RuntimeContextWorkflow` start/attach and lifecycle handling. |
| 3 | Map one external intent to one participant | Works for one singleton sim participant; needs run-key refinement for repeated live runs | The driver uses `externalKey: { source: "tiny-firegrid.dark-factory", id: "dark-factory" }`. That proves create/load identity, but repeated ticket-like live runs should key by run or external entity instead of a singleton id. |
| 4 | Let participants delegate to other participants | Partially works now; full §6 delegation still needs a proof run | `session_new` and `session_prompt` lower through `AgentToolHost` into child `RuntimeContextWorkflow` creation and host-owned ingress. `spawn_all` is still unsupported by the live host service. The §6 implementer/reviewer loop should use `session_new`/`session_prompt` first, not assume bulk fan-out. |
| 5 | Let participants wait for things | Channel-backed wait can be smoked now; final readiness is gated on the runtime-owned wait workflow cutover | `wait_for` and `wait_for_any` resolve `ChannelInventory` entries and can read typed channel streams. They do not yet hand off to `WaitForWorkflow.execute`; timeout uses the current tool-call workflow activity. Full §6 should wait for the final Lane B / `tf-xw0w` wait arm if the goal is to prove the public substrate, not just the channel facade. |
| 6 | Let participants take actions in the world and remember what they did | Sleep works now; real world actions are not full-run ready | `sleep` is runtime-owned and durable. `send` can append to egress/bidirectional channels, and `execute` can call a sandbox provider if present. The current dark-factory run does not yet bind real Linear/GitHub/Slack side effects. Also, registered `approval.operator` currently returns `{ matched: false, timedOut: true }`, so the visible approval channel does not exercise the permission request/response path. |
| 7 | Let everyone see what is happening | Works for runtime output observation; needs a bounded live-run observer plan | Runtime-owned observation streams expose per-context output, runtime runs, and caller facts through `RuntimeObservationStreams`. The driver currently loops forever on `session.wait.forAgentOutput({ timeoutMs: 15_000 })`, so the next live attempt needs an explicit stop condition and artifact capture plan. |

## Smallest Live-Run Slice

The smallest useful live-run slice should avoid the full §6 factory loop and
prove only the public substrate pieces that are already unblocked:

1. Compose the existing dark-factory host.
2. Create or load a fresh runtime context using a run-scoped external key, not
   the current singleton `id: "dark-factory"`.
3. Start the runtime context through `firegrid.sessions.start` so
   `RuntimeContextWorkflow` provision/start/lifecycle paths are exercised.
4. Ask the agent to inspect available MCP tools and call `sleep` once with a
   short duration.
5. Require one terminal text line such as `DARK_FACTORY_SLEEP_SMOKE_DONE`.
6. Capture evidence from public or host-authored surfaces:
   - runtime context row exists for the run-scoped key;
   - runtime run started for the context;
   - MCP `wait_for` tool metadata includes the dark-factory channel inventory;
   - the `sleep` tool call returns `{ slept: true }`;
   - agent output contains the terminal marker.

This validates the plumbing that is safe today: `ChannelInventory` projection,
runtime-context MCP exposure, `ToolCallWorkflow`, runtime-owned `sleep`, and
`RuntimeContextWorkflow` start/provision. It does not prove factory
choreography.

If coordinator wants to avoid any live LLM cycle before the full shape is
ready, this slice should be implemented as a deterministic MCP/tooling smoke
instead: call the runtime-context MCP endpoint or toolkit layer directly against
a composed context and verify `tools/list` metadata plus `sleep`. That would
still test public Firegrid tool routing without involving Claude ACP behavior.

## Blockers For Full §6 Live Run

Full §6 requires more than the current dark-factory sim can honestly prove:

1. Final wait arm: `wait_for` should run through the runtime-owned
   `WaitForWorkflow` handoff, not the current direct stream scaffold, before it
   becomes the backbone of trigger, approval, review, CI, and merge waits.
2. Approval channel: `approval.operator` is registered and visible, but its
   binding always times out. Because registered call channels take precedence
   over the `approval.*` fallback, an agent calling the advertised channel will
   not drive the existing permission request/response adapter.
3. External trigger path: dark-factory currently seeds a synthetic trigger row.
   A real factory run needs a bounded choice between synthetic tiny-firegrid
   trigger and verified webhook ingress.
4. Real side-effect adapters: the §6 story mentions Linear/GitHub/Slack-like
   work. The current sim only has local durable tables, sandbox execution if
   composed, and runtime-context MCP tools.
5. Repeated-run identity: the driver should not reuse the singleton
   `tiny-firegrid.dark-factory/dark-factory` external key for multiple ticket
   runs.
6. Driver stop condition: `driver.ts` loops forever waiting for agent output.
   A live run needs a bounded terminal predicate, timeout, and artifact path.
7. Delegation shape: `session_new` and `session_prompt` are wired; `spawn_all`
   is not. The first §6 proof should delegate serially or explicitly avoid
   fan-out.

## Recommendation

Do not attempt the full factory-vision §6 live run until the final Lane B
`wait_for` arm lands on the runtime-owned `WaitForWorkflow` path and the
`approval.operator` binding is changed to use the real approval adapter or is
removed from the advertised inventory until it can.

A smaller sleep-only echo run is reasonable now if the goal is to validate
substrate plumbing rather than choreography. Keep it named as a smoke, not a
factory proof: it should exercise runtime context start, MCP/toolkit exposure,
ChannelInventory metadata, `ToolCallWorkflow`, `RuntimeAgentToolExecution.sleep`,
and observation capture. It should not ask the agent to wait for factory events,
send plan events, call approval, delegate implementation, review PRs, or merge.

