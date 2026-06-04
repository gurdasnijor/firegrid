# MCP Executor Lowering Options

Date: 2026-06-02
Bead: `tf-0awo.36`
Lane: analysis

## Scope

This is a source-verified options note for the unified MCP executor mismatch:
the MCP toolkit can expose tools whose names are not handled by
`dispatchArm`, causing the default typed failure
`tool "<name>" is not yet ported onto the unified executor`
([`tool-dispatch.ts:678-685`](../../packages/runtime/src/unified/mcp-host/tool-dispatch.ts#L678)).

The current dispatcher handles only:

- `sleep`, `wait_until`, `wait_for`, `wait_any`
  ([`tool-dispatch.ts:589-623`](../../packages/runtime/src/unified/mcp-host/tool-dispatch.ts#L589)).
- `send`, `call`, lowered through `RuntimeChannelRouter.dispatch`
  ([`tool-dispatch.ts:178-189`](../../packages/runtime/src/unified/mcp-host/tool-dispatch.ts#L178),
  [`tool-dispatch.ts:326-357`](../../packages/runtime/src/unified/mcp-host/tool-dispatch.ts#L326),
  [`tool-dispatch.ts:624-641`](../../packages/runtime/src/unified/mcp-host/tool-dispatch.ts#L624)).
- `session_new`, `session_prompt`, `session_cancel`, `session_close`
  ([`tool-dispatch.ts:642-677`](../../packages/runtime/src/unified/mcp-host/tool-dispatch.ts#L642)).

The session tools are the local template for "lower onto the real host/channel
route": `hostPlaneDispatch` resolves `HostPlaneChannelRouter` and calls
`router.dispatch({ target, verb, payload })`
([`tool-dispatch.ts:359-374`](../../packages/runtime/src/unified/mcp-host/tool-dispatch.ts#L359)).
`session_new` then creates/loads a child session, sends the initial prompt, and
starts the child via host-plane channel targets
([`tool-dispatch.ts:441-509`](../../packages/runtime/src/unified/mcp-host/tool-dispatch.ts#L441)).
That lowering was added by commit `9c063a4fe` (`tf-0awo.32 port MCP session tools`),
which changed `tool-dispatch.ts`, added `channels/host-plane-router.ts`, and
updated the capstone host composition.

## Router Facts

`RuntimeChannelRouter` and `HostPlaneChannelRouter` are both services over the
same route/dispatch shape
([`router.ts:61-89`](../../packages/runtime/src/channels/router.ts#L61)).
`makeRuntimeChannelRouter(...).dispatch` finds the route, checks supported
verbs, decodes against the route input schema, invokes the route, and maps
failures into channel dispatch errors
([`router.ts:153-184`](../../packages/runtime/src/channels/router.ts#L153)).

Generic channel routes already know how to run `send`, `call`, and `wait_for`:
egress appends payloads, bidirectional `send` appends while non-`send` waits,
call channels invoke `binding.call`, and ingress waits for the next row
([`router.ts:224-249`](../../packages/runtime/src/channels/router.ts#L224)).

The capstone host already provides an app `RuntimeChannelRouter` to
`ToolDispatchLive` and separately provides `HostPlaneSessionControlRouterLive`
for session tools
([`factory-capstone/host.ts:227-239`](../../packages/firelab/src/simulations/factory-capstone/host.ts#L227)).
The CLI composition provides `ToolDispatchLive` with the host-plane session
router but not an app `RuntimeChannelRouter`
([`_compose.ts:152-163`](../../packages/runtime/src/bin/_compose.ts#L152)).

## Tool Options

### `send`

Current state:

- Advertised in the full MCP toolkit schema group at
  [`toolkit.ts:136-139`](../../packages/runtime/src/unified/mcp-host/toolkit.ts#L136).
- Named in the toolkit type list at
  [`toolkit.ts:180-192`](../../packages/runtime/src/unified/mcp-host/toolkit.ts#L180),
  exported as `SendTool` at
  [`toolkit.ts:231-243`](../../packages/runtime/src/unified/mcp-host/toolkit.ts#L231),
  and included in the primitive profile at
  [`toolkit.ts:265-270`](../../packages/runtime/src/unified/mcp-host/toolkit.ts#L265).
- Handler routes `send` through `ToolDispatch.call`
  ([`toolkit-layer.ts:84-99`](../../packages/runtime/src/unified/mcp-host/toolkit-layer.ts#L84)).
- Implemented in PR #847 follow-up: `runSend` calls
  `RuntimeChannelRouter.dispatch({ target: input.channel, verb: "send",
  payload: input.payload })` through the shared `dispatchWithOptionalRouter`
  guard, then returns `{ sent: true, channel }`
  ([`tool-dispatch.ts:178-189`](../../packages/runtime/src/unified/mcp-host/tool-dispatch.ts#L178),
  [`tool-dispatch.ts:326-343`](../../packages/runtime/src/unified/mcp-host/tool-dispatch.ts#L326),
  [`tool-dispatch.ts:624-632`](../../packages/runtime/src/unified/mcp-host/tool-dispatch.ts#L624)).
- Protocol input is `{ channel, payload }`; output is `{ sent: true, channel }`
  ([`schema.ts:265-292`](../../packages/protocol/src/agent-tools/schema.ts#L265)).

Implemented lowering:

```ts
const runSend = (
  toolUseId: string,
  input: AgentToolSchemas.SendToolInput,
): Effect.Effect<AgentToolSchemas.SendToolOutput, ToolError> =>
  dispatchWithOptionalRouter(
    Effect.serviceOption(RuntimeChannelRouter),
    "channel tools require RuntimeChannelRouter",
    toolUseId,
    "send",
    input.channel,
    "send",
    input.payload,
  ).pipe(
    Effect.as({ sent: true, channel: input.channel }),
  )

// dispatchArm:
case "send":
  return decodeJson(AgentToolSchemas.SendToolInputSchema)(inputJson).pipe(
    Effect.mapError(cause => cause instanceof ParseResult.ParseError
      ? toolInvalidInputFromParseError(toolUseId, "send", cause)
      : toolExecutionFailed(toolUseId, "send", cause)),
    Effect.flatMap(input => runSend(toolUseId, input)),
    Effect.map(output => JSON.stringify(output)),
  )
```

This mirrors the session lowering shape, but targets `RuntimeChannelRouter`
instead of `HostPlaneChannelRouter`. The route decoder and verb support checks
remain router-owned.

Remove-advertisement option:

- Full profile: remove `SendToolInputSchema`/`SendToolOutputSchema` from
  `AGENT_TOOL_GROUPS`, remove `"send"` from `AgentToolNames`, remove the
  corresponding projected tuple slot, remove `SendTool` from the exported
  destructuring, and remove `send` from `FiregridAgentToolkitLayer`
  ([`toolkit.ts:119-243`](../../packages/runtime/src/unified/mcp-host/toolkit.ts#L119),
  [`toolkit-layer.ts:84-109`](../../packages/runtime/src/unified/mcp-host/toolkit-layer.ts#L84)).
- Primitive profile: remove `SendTool` from
  `FiregridPrimitiveProfileToolkit` and remove `send` from
  `FiregridPrimitiveProfileToolkitLayer`
  ([`toolkit.ts:265-270`](../../packages/runtime/src/unified/mcp-host/toolkit.ts#L265),
  [`toolkit-layer.ts:122-130`](../../packages/runtime/src/unified/mcp-host/toolkit-layer.ts#L122)).
- Spec impact: primitive profile currently requires `send`
  ([`agentic-patterns-primitive-profile.feature.yaml:13-18`](../../features/firegrid/agentic-patterns-primitive-profile.feature.yaml#L13)).

Call classification:

- Done as clean engineering: `send` lowers through `RuntimeChannelRouter`.
- PO-owned only if the product wants to remove channel-authoring from the
  primitive profile despite the current primitive-profile spec.

### `call`

Current state:

- Advertised in the full MCP toolkit schema group at
  [`toolkit.ts:160-163`](../../packages/runtime/src/unified/mcp-host/toolkit.ts#L160).
- Named in the toolkit type list at
  [`toolkit.ts:180-192`](../../packages/runtime/src/unified/mcp-host/toolkit.ts#L180),
  exported as `CallTool` at
  [`toolkit.ts:231-243`](../../packages/runtime/src/unified/mcp-host/toolkit.ts#L231),
  and included in the primitive profile at
  [`toolkit.ts:265-270`](../../packages/runtime/src/unified/mcp-host/toolkit.ts#L265).
- Handler routes `call` through `ToolDispatch.call`
  ([`toolkit-layer.ts:84-99`](../../packages/runtime/src/unified/mcp-host/toolkit-layer.ts#L84)).
- Implemented in PR #847 follow-up: `runCall` calls
  `RuntimeChannelRouter.dispatch({ target: input.channel, verb: "call",
  payload: input.request })` through the shared `dispatchWithOptionalRouter`
  guard and returns the call-channel response payload
  ([`tool-dispatch.ts:178-189`](../../packages/runtime/src/unified/mcp-host/tool-dispatch.ts#L178),
  [`tool-dispatch.ts:345-357`](../../packages/runtime/src/unified/mcp-host/tool-dispatch.ts#L345),
  [`tool-dispatch.ts:633-641`](../../packages/runtime/src/unified/mcp-host/tool-dispatch.ts#L633)).
- Protocol input is `{ channel, request }`; output is unknown call-channel
  response payload
  ([`schema.ts:839-866`](../../packages/protocol/src/agent-tools/schema.ts#L839)).

Implemented lowering:

```ts
const runCall = (
  toolUseId: string,
  input: AgentToolSchemas.CallToolInput,
): Effect.Effect<AgentToolSchemas.CallToolOutput, ToolError> =>
  dispatchWithOptionalRouter(
    Effect.serviceOption(RuntimeChannelRouter),
    "channel tools require RuntimeChannelRouter",
    toolUseId,
    "call",
    input.channel,
    "call",
    input.request,
  )

// dispatchArm:
case "call":
  return decodeJson(AgentToolSchemas.CallToolInputSchema)(inputJson).pipe(
    Effect.mapError(cause => cause instanceof ParseResult.ParseError
      ? toolInvalidInputFromParseError(toolUseId, "call", cause)
      : toolExecutionFailed(toolUseId, "call", cause)),
    Effect.flatMap(input => runCall(toolUseId, input)),
    Effect.map(output => JSON.stringify(output)),
  )
```

This is the same router path as `send`, using `verb: "call"`. It should return
the route result rather than wrapping it because `CallToolOutputSchema` is
`Schema.Unknown`.

Remove-advertisement option:

- Full profile: remove `CallToolInputSchema`/`CallToolOutputSchema` from
  `AGENT_TOOL_GROUPS`, remove `"call"` from `AgentToolNames`, remove the
  projected tuple slot, remove `CallTool` from the exported destructuring, and
  remove `call` from `FiregridAgentToolkitLayer`.
- Primitive profile: remove `CallTool` from
  `FiregridPrimitiveProfileToolkit` and remove `call` from
  `FiregridPrimitiveProfileToolkitLayer`.
- Spec impact: primitive profile currently requires `call`
  ([`agentic-patterns-primitive-profile.feature.yaml:13-18`](../../features/firegrid/agentic-patterns-primitive-profile.feature.yaml#L13)).

Call classification:

- Done as clean engineering: `call` lowers through `RuntimeChannelRouter`.
- PO-owned only if the product wants the primitive profile to stop exposing
  channel calls.

### `execute`

Current state:

- Advertised in the full MCP toolkit schema group at
  [`toolkit.ts:156-159`](../../packages/runtime/src/unified/mcp-host/toolkit.ts#L156).
- Named in the toolkit type list at
  [`toolkit.ts:180-192`](../../packages/runtime/src/unified/mcp-host/toolkit.ts#L180)
  and exported as `ExecuteTool` at
  [`toolkit.ts:231-243`](../../packages/runtime/src/unified/mcp-host/toolkit.ts#L231).
- Handler routes `execute` through `ToolDispatch.call`
  ([`toolkit-layer.ts:107-108`](../../packages/runtime/src/unified/mcp-host/toolkit-layer.ts#L107)).
- Not in the primitive profile
  ([`toolkit.ts:265-270`](../../packages/runtime/src/unified/mcp-host/toolkit.ts#L265)).
- No `case "execute"` exists in `dispatchArm`; it reaches the default failure
  ([`tool-dispatch.ts:576-686`](../../packages/runtime/src/unified/mcp-host/tool-dispatch.ts#L576)).
- Protocol shape accepts either session-bound capability fields
  (`sessionId`, `capability`) or legacy `sandbox`, plus `input`
  ([`schema.ts:673-722`](../../packages/protocol/src/agent-tools/schema.ts#L673)).
- `tf-x1jx` closed with provider actions as MCP tools by default and durable
  callable-channel promotion only under claim/receipt/retry/waitable-evidence
  pressure. That is bead source, not code source.
- The capstone finding says the child reached an ACP permission request for
  `mcp__firegrid-runtime-context__execute`; the run did not dynamically prove
  the execute fallthrough because child execute was not approved before the
  sim output cap ended
  ([`tf-0awo.30-factory-capstone-sim.md:54-80`](../findings/tf-0awo.30-factory-capstone-sim.md#L54)).

Lowering option:

There is no currently source-visible equivalent of `RuntimeChannelRouter` for
`ExecuteToolInputSchema` in `mcp-host`. A real lowering needs a host-owned
capability executor, or an explicit decision to translate `execute` into a
durable action/receipt channel. A minimal shape would be:

```ts
export class SessionCapabilityExecutor extends Context.Tag(
  "@firegrid/runtime/SessionCapabilityExecutor",
)<SessionCapabilityExecutor, {
  readonly execute: (input: AgentToolSchemas.ExecuteToolInput) =>
    Effect.Effect<unknown, unknown>
}>() {}

const runExecute = (
  toolUseId: string,
  input: AgentToolSchemas.ExecuteToolInput,
): Effect.Effect<AgentToolSchemas.ExecuteToolOutput, ToolError> =>
  Effect.serviceOption(SessionCapabilityExecutor).pipe(
    Effect.flatMap(Option.match({
      onNone: () => Effect.fail(toolExecutionFailed(
        toolUseId,
        "execute",
        "execute requires SessionCapabilityExecutor",
      )),
      onSome: executor => executor.execute(input).pipe(
        Effect.mapError(cause => toolExecutionFailed(toolUseId, "execute", cause)),
      ),
    })),
  )
```

That sketch is intentionally not enough to implement, because the executor
contract is the product decision: session-bound capability execution vs legacy
sandbox bridge vs durable action receipt.

Remove-advertisement option:

- Remove `ExecuteToolInputSchema`/`ExecuteToolOutputSchema` from
  `AGENT_TOOL_GROUPS`, remove `"execute"` from `AgentToolNames`, remove the
  projected tuple slot, remove `ExecuteTool` from the exported destructuring,
  and remove `execute` from `FiregridAgentToolkitLayer`.
- This does not affect the primitive profile because it is already excluded
  there.
- Spec impact: the older workflow-driven-runtime spec still names `execute`
  in the canonical tool surface
  ([`firegrid-workflow-driven-runtime.feature.yaml:68-96`](../../features/firegrid/firegrid-workflow-driven-runtime.feature.yaml#L68)),
  while the newer factory-aligned spec says execute accepts session-bound
  capability invocation
  ([`firegrid-factory-aligned-agent-tools.feature.yaml:26-30`](../../features/firegrid/firegrid-factory-aligned-agent-tools.feature.yaml#L26)).

Call classification:

- PO-owned: port-vs-remove for `execute`.
- Reason: `execute` is tied to the cap-6 design boundary from `tf-x1jx`:
  keep provider actions as external MCP tools by default, or promote a
  provider/action path only when durable receipt semantics are required. The
  implementation lane should not decide that by silently wiring a legacy
  sandbox bridge or deleting the public tool.

### `spawn`

Current state:

- `spawn` is not advertised by the current `mcp-host` toolkit in this
  worktree. `AGENT_TOOL_GROUPS` has no `SpawnToolInputSchema` group, the
  `AgentToolNames` tuple does not contain `"spawn"`, and the exported
  destructuring has no `SpawnTool`
  ([`toolkit.ts:119-164`](../../packages/runtime/src/unified/mcp-host/toolkit.ts#L119),
  [`toolkit.ts:180-243`](../../packages/runtime/src/unified/mcp-host/toolkit.ts#L180)).
- No `spawn` handler exists in `toolkit-layer.ts`
  ([`toolkit-layer.ts:84-109`](../../packages/runtime/src/unified/mcp-host/toolkit-layer.ts#L84)).
- The protocol schema still defines `spawn` / `spawn_all` as await-terminal
  contracts: `SpawnToolInputSchema` description says "await its terminal
  state", and output is `{ childContextId, terminalState }`
  ([`schema.ts:369-407`](../../packages/protocol/src/agent-tools/schema.ts#L369)).
  `FiregridAgentToolOperations` also includes `spawn` and `spawnAll`
  ([`schema.ts:868-875`](../../packages/protocol/src/agent-tools/schema.ts#L868)).
- The older workflow-driven-runtime spec still lists `spawn`, `spawn_all`, and
  `execute` as canonical toolkit tools
  ([`firegrid-workflow-driven-runtime.feature.yaml:68-96`](../../features/firegrid/firegrid-workflow-driven-runtime.feature.yaml#L68)).
- The newer factory-aligned spec says public agent-tool exposure uses
  `session_new`, `session_prompt`, `session_cancel`, and `session_close`, while
  `spawn` and `spawn_all` remain host-internal lowering seams
  ([`firegrid-factory-aligned-agent-tools.feature.yaml:15-24`](../../features/firegrid/firegrid-factory-aligned-agent-tools.feature.yaml#L15)).
- A direct `ToolDispatch.call({ toolName: "spawn", ... })` would still hit the
  `dispatchArm` default because there is no `case "spawn"`
  ([`tool-dispatch.ts:576-686`](../../packages/runtime/src/unified/mcp-host/tool-dispatch.ts#L576)).
  Current MCP clients should not receive `spawn` from this toolkit because it
  is not registered.

Lowering option:

The session-tool template could create a child context and return a session
handle today, as `session_new` already does through
`HostSessionsCreateOrLoadChannelTarget`, `SessionPromptChannelTarget`, and
`HostSessionsStartChannelTarget`
([`tool-dispatch.ts:441-509`](../../packages/runtime/src/unified/mcp-host/tool-dispatch.ts#L441)).
But that would not satisfy the current `SpawnToolOutputSchema`, which demands a
terminal state
([`schema.ts:398-407`](../../packages/protocol/src/agent-tools/schema.ts#L398)).

A handle-shaped spawn sketch would look like:

```ts
// Only after protocol contract is reshaped.
const runSpawn = (
  contextId: string,
  toolUseId: string,
  input: AgentToolSchemas.SpawnToolInput,
) =>
  runSessionNew(contextId, toolUseId, {
    agentKind: input.agentKind,
    prompt: input.prompt,
    metadata: input.options?.metadata,
  }).pipe(
    Effect.map(output => ({
      childContextId: output.session.contextId,
      started: true,
      session: output.session,
    })),
  )
```

An await-terminal implementation would need a domain-signal/wait model after
child start, not just the current create+prompt+start route.

Remove-advertisement option:

- No `mcp-host` toolkit removal is needed in this worktree because `spawn` is
  not currently in the registered toolkit.
- If a future branch re-added it, remove it from the same surfaces as other
  tools: schema group, name tuple, exported destructuring, full/primitive
  toolkit values, and toolkit-layer handlers.
- Spec cleanup remains separate: reconcile the stale canonical-tool statement
  in `firegrid-workflow-driven-runtime.feature.yaml` with the newer
  factory-aligned public surface.

Call classification:

- PO-owned: spawn contract shape.
- Reason: `tf-r06u.48` explicitly parks the decision between reshaping `spawn`
  into a bounded handle-returning op or keeping the legacy await-terminal
  contract until the needed domain-signal suspension is built. `tf-r06u.9`
  comments say agent-facing spawn rides `.48`, while `.9` proceeds on the
  non-blocked session output/wait axis.

## Acceptance Check

The implementation acceptance should be:

1. No tool advertised by the selected MCP toolkit profile reaches
   `tool "<name>" is not yet ported onto the unified executor`, except the
   still-advertised full-profile `execute` tool pending the PO-owned cap-6
   decision.
2. The primitive profile remains internally consistent: both advertised channel
   tools, `send` and `call`, now lower through `RuntimeChannelRouter`.
3. The full profile either lowers `execute` through a PO-approved capability
   path or removes it from `FiregridAgentToolkit`.
4. `spawn` is not treated as an accidental P0 code bug in current `mcp-host`
   because it is not currently advertised there; changing that requires the
   `tf-r06u.48` PO contract call.
5. The capstone advances past the child's `execute` permission request only
   after the child permission gate is intentionally handled and the PO-owned
   `execute` port-vs-remove decision is resolved.

## Recommended Non-Decision Sequence

1. Done: implement `send` and `call` lowerings through `RuntimeChannelRouter`.
2. Done: add focused MCP dispatch tests with one egress/send route and one
   callable route.
3. Leave `execute` as a PO-owned decision: either remove it from full toolkit
   until the capability executor is real, or add the real executor contract and
   tests as the cap-6 implementation.
4. Leave `spawn` to `tf-r06u.48`; do not re-add it to MCP exposure before the
   output contract is reshaped or the await-terminal route exists.
