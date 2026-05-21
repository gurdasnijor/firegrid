# tf-lwqm Spawn-All Wiring Proposal

## Summary

`spawn_all` is present in the protocol schema, Effect AI toolkit exposure, and
`toolUseToEffect` dispatch, but the live runtime host still rejects it at the
`AgentToolHost.spawnChildContexts` seam.

The missing code is not just a small fan-out loop. The currently shipped
`spawn_all` schema is the legacy "fan out child workflows and await every
terminal state" shape, while the §6 factory path now uses the session-plane
model: create durable child participants, return handles immediately, and let
the planner observe child progress through `wait_for` / runtime observations.

## Existing Surface

`session_new` is wired end-to-end today:

- Protocol input: `{ agentKind, prompt, options? }`.
- Host lowering: `toolUseToEffect` calls `AgentToolHost.spawnChildContext`.
- Live host implementation:
  - derives a deterministic child context id from `(parentContextId, toolUseId)`;
  - inserts a local `RuntimeContext`;
  - appends the initial prompt through the current host-owned prompt/input
    intent path;
  - starts the child `RuntimeContextWorkflow`;
  - returns a session-shaped handle with `sessionId === contextId`, `status:
    "running"`, and tool-result metadata.

`session_prompt` is also wired end-to-end:

- Protocol input: `{ sessionId, prompt, inputId?, metadata? }`.
- Host lowering: `toolUseToEffect` calls `AgentToolHost.appendSessionPrompt`.
- Live host implementation dispatches the prompt through the current host-owned
  prompt/input intent path after resolving the target runtime context through
  host authority.

Current correlation support is partial:

- `session_new` can return `parentSessionId` and caller-supplied
  `options.metadata` in the tool result.
- `session_new` does not durably persist `options.metadata` into the context row
  or initial runtime ingress payload.
- `session_prompt` accepts `metadata` at the protocol boundary, but the lowering
  currently ignores it.
- Durable correlation can still be carried today by prompt text, app-owned facts,
  runtime output, and explicit `inputId` values.

Relevant ACIDs:

- `firegrid-factory-aligned-agent-tools.SESSION.1`
- `firegrid-factory-aligned-agent-tools.SESSION.2`
- `firegrid-factory-aligned-agent-tools.SESSION.3`
- `firegrid-factory-aligned-agent-tools.SESSION.6`
- `firegrid-factory-aligned-agent-tools.SESSION.7`
- `firegrid-factory-aligned-agent-tools.PROMPT_DISPATCH.1`
- `firegrid-factory-aligned-agent-tools.PROMPT_DISPATCH.2`
- `firegrid-dark-factory-app.SESSION_TOOLS.1`
- `firegrid-dark-factory-app.SESSION_TOOLS.2`
- `firegrid-dark-factory-app.SESSION_TOOLS.4`

## Current Spawn-All Shape

The existing `spawn_all` protocol shape is already defined:

```ts
{
  tasks: Array<{
    key?: string
    agentKind: string
    prompt: string
    options?: SpawnOptions
  }>
}
```

The existing output shape is:

```ts
{
  children: Array<{
    key: string
    childContextId: string
    terminalState: WorkflowTerminalState
  }>
}
```

`toolUseToEffect` already decodes this shape and dispatches to
`AgentToolHost.spawnChildContexts`; unit tests prove that contract with a fake
host.

The live host does not implement the seam:

```ts
spawnChildContexts: ({ toolUseId }) => unsupportedAgentTool(toolUseId, "spawn_all")
```

## Decision Point

There are two viable interpretations, and they should not be mixed silently.

### Option A: Keep legacy `spawn_all`

`spawn_all` remains a host-side helper over `spawn`, with the existing
terminal-state output schema.

This means live implementation must create each child and then wait for every
child to reach a terminal state before returning. That is not a small helper
over today's `session_new`, because `session_new` intentionally returns while
the child is still running. Implementing this correctly needs a durable
terminal-observation path for each child and timeout/cancellation semantics for
the aggregate call.

This option aligns with
`firegrid-workflow-driven-runtime.PHASE_6_AGENT_TOOLS.12`, but conflicts with
the current factory-aligned session-plane direction for planner-facing
delegation.

### Option B: Reshape batch delegation to session-plane semantics

Batch delegation becomes a generalized convenience over repeated
`session_new`, returning session handles immediately instead of terminal states.

The output would be closer to:

```ts
{
  sessions: Array<{
    key: string
    session: SessionHandle
  }>
}
```

This matches `firegrid-factory-aligned-agent-tools.SESSION.2` and the §6
factory model: participants are durable identities, and completion is observed
later through runtime facts rather than by blocking inside creation.

This requires either:

- replacing the existing `spawn_all` schema/output, or
- adding a distinct session-plane operation such as `session_new_all`.

Because `firegrid-factory-aligned-agent-tools.SESSION.6` says public exposure
uses `session_new` / `session_prompt` while `spawn_all` remains a host-internal
lowering seam, the cleanest product-facing path is `session_new_all`, not
repurposing legacy `spawn_all`.

## Recommendation

Do not wire live `spawn_all` in this slice.

The smallest correct §6 path is to continue using repeated `session_new` calls
for delegation until a session-plane batch API is explicitly accepted. The
existing schema already supports caller-provided task keys and metadata, but the
durability of correlation metadata needs tightening before batch creation should
be treated as a factory primitive.

Recommended next slice:

1. Add `session_new_all` protocol schemas:
   - input: `{ tasks: Array<{ key?, agentKind, prompt, options? }> }`;
   - output: `{ sessions: Array<{ key, session: SessionHandle }> }`.
2. Add a toolkit entry and `toolUseToEffect` arm that maps each task through the
   same child-context creation path as `session_new`.
3. Implement `AgentToolHost.spawnChildSessions` or reuse
   `spawnChildContexts` only after renaming the interface away from terminal
   semantics.
4. Preserve deterministic child identity as
   `(parentContextId, toolUseId, keyOrIndex)`.
5. Persist caller-supplied correlation metadata durably, not only in the tool
   result.
6. Add a live host test alongside the existing `session_new` test proving two
   child context rows plus two initial prompt ingress rows are created without
   waiting for terminal states.

This is more than a few-file wire-up because it changes the public protocol
shape and resolves a spec tension. It should be a follow-up implementation
slice after coordinator confirmation.
