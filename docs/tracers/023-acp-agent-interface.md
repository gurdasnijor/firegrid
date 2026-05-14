# 023: Protocol-Aware Agent Interface (Real ACP SDK)

Status: Implemented. Vertical proof of the Firegrid substrate boundary
against real Agent Client Protocol (ACP) semantics from the upstream
`@agentclientprotocol/sdk` TypeScript SDK.

Implements: `scenarios/firegrid/src/tracer-023-acp-agent-interface.test.ts`
with adapter + fixtures in `scenarios/firegrid/src/fixtures/`.

## Why

The next-wave tracer plan (`docs/tracers/019-workflow-driven-runtime-next-wave.md`
Tracer F + Tracer I) asks two questions that have to be answered together once
a protocol-aware agent is in the picture:

1. Can Firegrid expose capabilities to a protocol-aware agent without
   treating the runtime as an opaque stdin/stdout box?
2. Can it do so without adding ACP/MCP vocabulary to Firegrid-native row
   families, services, or types?

Earlier tracers (012, 016, 017) proved the durable ingress path against
plain stdin/stdout child processes. Tracer 023 swaps the child process for
a real ACP agent — implementing the SDK's `Agent` interface and speaking
real ndjson JSON-RPC — so the boundary is validated against actual ACP
semantics: `initialize`, `session/new`, `session/prompt`, `session/update`,
and `requestPermission`.

## Architectural contract under test

```txt
client (scenario test)
  |
  | appendRuntimeIngress(kind="message")           --> RuntimeIngressTable (durable)
  |
  | runAcpTurn(...) [scenario-owned ACP adapter]
  |     |
  |     | reads sequenced prompt row from RuntimeIngressTable BEFORE any ACP side effect
  |     |
  |     | spawns ACP example agent (real SDK)
  |     |   AgentSideConnection + ndJsonStream over child stdin/stdout
  |     |
  |     | ClientSideConnection (real SDK) wraps adapter's Client impl
  |     |     requestPermission: durable evidence + deterministic policy
  |     |     sessionUpdate: durable evidence
  |     |
  |     | connection.initialize / newSession / prompt
  |     |   each ACP request/response/notification --> AcpObservationTable (caller-owned)
  |
  | scenario asserts:
  |   - prompt was durable BEFORE ACP session/prompt
  |   - every ACP message is a durable row correlated with runtimeContextId
  |   - frozen tool catalog stripped to {name, description, inputSchema}
  |   - no Firegrid-native ACP row families, services, or vocabulary
```

The adapter lives in `scenarios/firegrid/src/fixtures/`, *not* in
`@firegrid/*` — agent-runtime wire-protocol conversion is a downstream
concern per `firegrid-scheduling-tool-bindings.AGENT_OBSERVATION_RECIPE.4`
and `PACKAGE_PLACEMENT.4`.

## What the tracer proves

`scenarios/firegrid/src/tracer-023-acp-agent-interface.test.ts` asserts:

- A `RuntimeIngressTable.inputs` row with `kind: "message"` and
  `status: "sequenced"` exists for the runtime context BEFORE the adapter
  issues `connection.prompt(...)`. The adapter explicitly reads that row
  and refuses to run if it is missing.
  (`firegrid-agent-ingress.INGRESS.1`, `firegrid-agent-ingress.INGRESS.6`,
  `firegrid-platform-invariants.AUTHORITY.4`)

- The same durable input id surfaces in the adapter's
  `session/prompt` client-to-agent observation row, correlating the ACP
  prompt with the Firegrid durable fact.
  (`firegrid-agent-ingress.INGRESS.2`, `firegrid-agent-ingress.HOST.3`)

- Every ACP message (`initialize`, `session/new`, `session/prompt`,
  `session/update`, `session/request_permission`) is recorded as a
  caller-owned `AcpObservationTable` row with `direction`, `kind`,
  `method`, `sessionId?`, and a JSON-serialized payload. The agent's
  `session/update` notifications include both `agent_message_chunk`,
  `tool_call`, and `tool_call_update` from the real SDK example.
  (`client-event-plane-registration.ACP_AGENT_PROFILE.1`,
  `firegrid-scheduling-tool-bindings.AGENT_OBSERVATION_RECIPE.4`)

- The frozen tool catalog exposed by the adapter contains exactly the
  triple `{ name, description, inputSchema }`. Untrusted source
  descriptors that carry `transport`, `credentials`, or `hostId` fields
  are stripped at the adapter boundary; durable observation rows are
  scanned to confirm those secret-shaped values never appear anywhere
  downstream.
  (`firegrid-scheduling-tool-bindings.NEUTRAL_TOOL_BINDING_SHAPE.1`,
  `firegrid-scheduling-tool-bindings.NEUTRAL_TOOL_BINDING_SHAPE.4`,
  `firegrid-scheduling-tool-bindings.DURABLE_DESCRIPTOR_PUBLICATION.4`)

- `RuntimeIngressTable` contains exactly one row for the prompt — no
  duplicate ingestion through an ACP-shaped side channel.
  (`firegrid-agent-ingress.BOUNDARY.1`, `firegrid-agent-ingress.BOUNDARY.4`)

- The ACP `PromptResponse.stopReason` is `end_turn` and is recorded as a
  durable agent-to-client observation row.

## Coverage map

The tracer is proved by a single scenario file:

- `scenarios/firegrid/src/tracer-023-acp-agent-interface.test.ts`
  - covers all ACIDs listed in the file's leading docblock
- `scenarios/firegrid/src/fixtures/acp-example-agent.mjs`
  - minimally-modified copy of the upstream
    `@agentclientprotocol/sdk` example agent (sleep budget reduced for
    fast tests; deterministic marker injected via `TRACER_AGENT_MARKER`)
- `scenarios/firegrid/src/fixtures/acp-adapter.ts`
  - scenario-owned ACP adapter (`runAcpTurn`)
- `scenarios/firegrid/src/fixtures/acp-observation-table.ts`
  - caller-owned `AcpObservationTable` (per
    `firegrid-platform-invariants.PRODUCTION_SURFACE.6`)

The adapter consumes existing Firegrid production surfaces — no new
Firegrid public package code is added by this tracer. The boundary is
proved by the agent NOT seeing Firegrid internals and Firegrid NOT
learning ACP vocabulary.

## Architectural constraints honored (and worth not forgetting)

- ACP is an adapter/profile ABOVE the execution plane, not a
  `SandboxProvider`. The adapter is responsible for byte-level duplex
  framing because `LocalProcessSandboxProvider.stream(...)` line-splits
  stdout/stderr (good for jsonl journaling, lossy for JSON-RPC framing).
- No top-level `@firegrid/acp` package, no Firegrid-native
  `session`/`prompt`/`tool_call` row families, no Firegrid-side ACP/MCP
  wire-protocol conversion (per
  `firegrid-scheduling-tool-bindings.AGENT_OBSERVATION_RECIPE.4`,
  `PACKAGE_PLACEMENT.4`, `NON_SCOPE.1`, `NON_SCOPE.6`).
- Tool descriptors visible to the agent stay at the
  `{ name, description, inputSchema }` triple. Credentials, callback
  tokens, host ids, durable streams URLs, and transport refs never appear
  in the durable adapter-observation rows.
- Prompt intent is durable in `RuntimeIngressTable.inputs` before any
  ACP side effect.

## Deliberate non-goals

- **MCP-mounted tool catalog**. Today's ACP wire surface injects tool
  catalogs via `NewSessionRequest.mcpServers`. The tracer sets
  `mcpServers: []` and records the frozen catalog inside the `_meta` of
  the `session/new` request as scenario-owned evidence. Standing up an
  in-process MCP server adjacent to Firegrid is the next step (see
  follow-ups below).
- **Real Claude Code / Codex / Zed configuration**. The agent fixture
  is the SDK example, not a vendor agent. The neutral descriptor model
  proved here can later be lowered to MCP/ACP/vendor config without
  changing Firegrid.
- **Follow-up prompts to a running ACP session**. Tracer I in the
  next-wave plan covers continuous ingress; this tracer is single-turn.
- **Local-process env containment hardening**. Out of scope for this
  tracer per current coordinator direction.

## Follow-ups (acceptance criteria left explicit)

The vertical proof is single-turn and single-tool-catalog-mount-point.
The remaining acceptance criteria for the full Tracer F bar live here so
they survive between sessions:

1. **MCP-mount neutral catalog**. Stand up an in-process MCP server
   adjacent to the adapter; advertise two neutral tools
   (`firegrid_context`, `firegrid_record_marker`) as MCP tools; configure
   the agent via `NewSessionRequest.mcpServers`; assert the agent
   actually invokes them and that the MCP wire frames each tool
   descriptor as exactly `{ name, description, inputSchema }`. Assert
   tool invocation request/result evidence are durable
   `RuntimeIngressTable` `kind: "tool_result"` / caller-owned EventPlane
   rows.
2. **Same-name tool collision policy**. With two MCP servers each
   advertising a tool of the same name, assert the adapter's
   replay-stable policy (first-valid-attach-wins or fail-before-exposure
   per `firegrid-scheduling-tool-bindings.DURABLE_DESCRIPTOR_PUBLICATION.4`).
3. **Follow-up prompt ingress to a running ACP session** (Tracer I).
   Append a second `RuntimeIngressTable.inputs` row after the agent has
   already received the initial prompt; assert the adapter delivers it
   through the same ACP session and records the resulting
   `session/update`s as durable rows.
4. **Cancellation parity**. Assert `connection.cancel(...)` correlates
   with a durable adapter-observation row and that the agent's
   `PromptResponse.stopReason` becomes `cancelled`.
5. **SandboxProvider byte-pipe path**. Either (a) extend
   `LocalProcessSandboxProvider.stream(...)` to expose a raw byte-pipe
   variant so ACP can be launched through Firegrid's runtime path
   without bypassing the SandboxProvider abstraction, or (b) document
   that ACP adapters legitimately spawn directly because byte-level
   duplex framing is incompatible with the line-split journaling shape.
6. **Reattach profile**. Wire a `RuntimeContext` row + control-plane
   start event so that an ACP-shaped agent has a declared restart
   reattach profile (no reattach / replacement / supervised reattach) per
   `firegrid-workflow-driven-runtime.PHASE_1_CONTEXT_WORKFLOW.3`.

These follow-ups can be split across one or more PRs as Tracer F
extensions; the current tracer is the vertical proof that the boundary
holds.

## Validation

```bash
pnpm --filter @firegrid/scenario-firegrid test -- tracer-023
pnpm run check:specs
pnpm run check:docs
```
