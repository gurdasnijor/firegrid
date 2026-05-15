# SDD: Zed ACP Stdio External-Agent Boundary

**Status:** Draft for review
**Scope:** Docs/spec only; no runtime-host, CLI, ACP adapter, MCP, or journaling implementation.
**Related specs:** `firegrid-zed-acp-stdio-external-agent`, `firegrid-local-mcp-run`, `firegrid-effect-ai-native-agents`, `firegrid-host-context-authority`
**Related code:** `src/run.ts`, `packages/runtime/src/agent-codecs/acp`, `packages/runtime/src/agent-adapters`

## Problem

Zed external agents are long-running ACP processes. They are not a one-shot
prompt interface.

Firegrid now has two nearby but different local entrypoint shapes:

- `firegrid run -- <agent command...>` is synchronous. It creates a
  `RuntimeContext`, optionally appends an initial prompt, calls `startRuntime`,
  waits for exit, and propagates the child exit code.
- `firegrid start -- [agent command...]` is long-lived. It creates a host-bound
  `RuntimeContext`, starts local host resources plus the route-scoped MCP
  server, prints a versioned `firegrid.start.ready` record, then keeps the
  Effect scope alive.

That supported `start` shape is the right compatibility frame for future
long-running Zed/ACP work: a command can keep host resources and a
`RuntimeContext` alive while an external client interacts with a process. The
ACP stdio transport, however, is not the MCP HTTP route and cannot reuse the
same stdout contract. ACP owns stdin/stdout for JSON-RPC frames; diagnostics and
Firegrid ready/control records must not corrupt that stream.

## External Ground Truth

Zed documents external agents as separate processes that communicate with Zed
through the Agent Client Protocol, including CLI-based agents. Zed custom agents
are configured under `agent_servers`, and Zed can pass configured environment
values to those processes.

ACP documents stdio as the required transport for agents. The TypeScript SDK's
agent side uses `AgentSideConnection` over a bidirectional stream, typically
created with `ndJsonStream` for stdio.

This SDD deliberately inverts Firegrid's current ACP role. Zed launches
Firegrid as the ACP agent-side/server process over stdio, while the existing
Firegrid `AcpCodec` is Firegrid-as-client to an ACP subprocess. The codec's
mapping tests are useful evidence for prompt/session/update semantics, but its
`ClientSideConnection` implementation is not the implementation shape for Zed.
The Zed boundary must use ACP agent-side connection semantics.

References:

- <https://zed.dev/docs/ai/external-agents>
- <https://zed.dev/acp>
- <https://agentclientprotocol.com/protocol/session-setup>
- <https://agentclientprotocol.com/libraries/typescript>
- <https://agentclientprotocol.github.io/typescript-sdk/classes/AgentSideConnection.html>

## Decision

Define a future Firegrid ACP stdio external-agent process boundary under the
supported long-lived CLI family:

```sh
pnpm firegrid -- start -- [agent command...]
```

Today that family seeds a host-bound context and prints a local-MCP ready
record. A later implementation can add ACP stdio mode within the same
long-lived `start` family, but the exact flag/subcommand spelling is
intentionally not locked by this SDD because surface:104 owns entrypoint
unification. The invariant is more important than the flag name:

- `start` remains the long-lived host bootstrap family.
- `run` remains synchronous and should not become the Zed external-agent path.
- ACP stdio mode must not print the `firegrid.start.ready` record on stdout,
  because stdout is the ACP transport.
- Any readiness/control metadata for ACP stdio must use stderr, a side channel,
  inherited configuration, or a parent process protocol that does not share ACP
  stdout.

This gives Zed a process that can be launched as an ACP external agent while
preserving Firegrid's host/runtime context authority.

## Architecture

### Command And Process Boundary

`firegrid start` already has the important lifetime semantics: acquire Durable
Streams, compose `FiregridLocalHostLive`, seed a `RuntimeContext`, and keep the
scope alive. The ACP stdio external-agent mode should reuse those lifetime
semantics.

The ACP stdio process boundary differs from today's local MCP start mode:

| Concern | Local MCP start | Zed ACP stdio start |
| --- | --- | --- |
| Client transport | HTTP MCP route | ACP JSON-RPC over stdio |
| Stdout | Ready record JSON is allowed | ACP frames only |
| Stderr | Diagnostics | Diagnostics and optional human-readable readiness |
| Primary external client | MCP Inspector or MCP client | Zed or another ACP client |
| Agent lifetime | Host stays alive for MCP calls | ACP process stays alive for session prompts |
| Tool/control surface | Firegrid MCP tools | ACP session, prompt, permission, cancel |

The local MCP route can still run in the same host when explicitly requested by
host tooling, but it is not the Zed transport and should not be required for
ACP stdio.

### Stdout/Stderr Protocol Discipline

For an ACP stdio process, stdout is protocol-owned for the full lifetime of the
process. Firegrid must not write:

- `firegrid.start.ready` records,
- log lines,
- Durable Streams URLs,
- context ids for humans,
- MCP URLs,
- progress messages,
- non-ACP JSON,

to stdout after ACP mode starts.

All non-protocol diagnostics go to stderr. If an implementation needs a machine
readable ready signal, it must use a non-stdout channel. Candidate approaches
for a later implementation include:

- stderr JSON lines with a distinct prefix for local harnesses,
- an inherited file descriptor,
- a temp file path passed by the parent process,
- a parent supervisor that already knows the context id because it created it.

The validation smoke must parse stdout through the ACP SDK, not by string
matching Firegrid-specific records.

### RuntimeContext And Session Authority

The Firegrid authority key remains `RuntimeContext.contextId`.

ACP `sessionId` is necessary protocol state, but it is adapter/session-local. It
does not replace `RuntimeContext.contextId`, and it does not carry Durable
Streams host authority. Likewise, ACP `messageId` and `userMessageId` are not
Firegrid routing authority. The Effect AI-native adapter SDD already establishes
`CurrentAgentTurn` as the Firegrid turn-correlation context for ACP adapter
work.

The launch sequence should therefore be:

1. `firegrid start` acquires host resources.
2. Firegrid creates or resolves a host-bound `RuntimeContext` through existing
   host authority primitives.
3. The ACP stdio adapter binds that `RuntimeContext` into Effect context.
4. ACP `initialize` and `newSession` establish protocol state over stdio.
5. ACP `prompt` calls are handled as long-running turns under
   `CurrentAgentTurn`.
6. Output, tool calls, permission requests, cancellation, and termination are
   mapped through the ACP adapter layer.

This SDD does not decide durable journaling of ACP output. That remains a
separate runtime-host journaling decision.

### Environment And Secrets

Zed's `agent_servers` configuration naturally supplies environment variables to
external agent processes. Firegrid must keep the existing RuntimeContext env
binding invariant:

- durable rows contain binding refs such as `{ name, ref: "env:NAME" }`;
- secret values are resolved at the host/provider boundary;
- secret values are not written into durable RuntimeContext rows or Firegrid
  ready/control output.

This makes the ACP stdio path compatible with the env-bindings proposal without
making Zed-specific env handling a separate authority mechanism.

### Relationship To AgentCodec And AgentAdapter

The existing `AcpCodec` proves protocol mapping knowledge:

- initialize/session setup,
- prompt content mapping from Effect AI prompt parts,
- text deltas from ACP `agent_message_chunk`,
- tool calls from ACP `tool_call`,
- status observations from `tool_call_update`,
- permission requests/responses,
- cancel and terminate behavior.

It does not prove the connection role needed by Zed. `AcpCodec` opens a
`ClientSideConnection` so Firegrid can drive an ACP subprocess. In the Zed
external-agent path, Zed is the ACP client and Firegrid is the launched ACP
agent-side/server process. The implementation therefore needs an
`AgentSideConnection`-shaped boundary over stdio, with Firegrid handling ACP
`initialize`, `newSession`, `prompt`, permission, cancel, and close requests.

The future long-running ACP stdio agent should reuse this mapping knowledge, but
the product direction is the Effect AI-native `AgentAdapter` surface:

- `AgentAdapter.languageModel` remains the base model view.
- ACP protocol observations and permissions live on additive capability tags.
- `CurrentAgentTurn` carries Firegrid turn correlation.
- ACP prompt/session ids remain protocol state, not Firegrid authority.

`SandboxProvider` may still be used to acquire a local process or byte pipe, but
the ACP adapter is not a fake one-shot sandbox execution path.

## What Is Shared With MCP

Shared:

- Durable Streams endpoint selection.
- `FiregridLocalHostLive` / host-scope composition.
- `RuntimeContext` creation and host binding.
- Env binding resolution invariants.
- Runtime context authority checks.

Not shared:

- MCP HTTP server as ACP transport.
- MCP JSON-RPC methods or tool catalog.
- `firegrid.start.ready` stdout record.
- MCP URL/path selection.
- `mcp-local` or any renamed concept that hides the protocol difference.

## Expected Outcomes

When implemented in a later slice:

- Zed can launch Firegrid as a configured external ACP agent process.
- The process stays alive across multiple ACP prompts in the same ACP session.
- ACP stdout remains parseable by Zed and by the ACP TypeScript SDK.
- Firegrid binds the ACP session to a host-owned `RuntimeContext` without
  caller-known stream URLs.
- Permission/cancel/session update behavior follows ACP rather than a custom
  Firegrid protocol.
- Local MCP bootstrap remains available for MCP Inspector and local tool tests,
  but is not a dependency of the Zed ACP transport.

## Validation Plan

The implementation slice should include a spawned-process smoke test:

1. Start the Firegrid ACP stdio command as a child process.
2. Connect using the real ACP TypeScript SDK over the child's stdin/stdout.
3. Call `initialize` and `newSession`.
4. Send a prompt and observe at least one `sessionUpdate`.
5. Exercise cancellation or normal close and assert clean shutdown.
6. Assert stdout contained only ACP frames by letting the SDK parse all stdout
   protocol traffic.
7. Assert diagnostics, if any, went to stderr.
8. Assert the process bound to a Firegrid `RuntimeContext` without test-local
   stream URL construction.

Additional validation should cover env binding behavior with fake env values
and no durable secret-value persistence.

## Non-Goals

- No implementation in this docs/spec slice.
- No CLI entrypoint edits while entrypoint unification is owned elsewhere.
- No MCP HTTP server as the Zed ACP transport.
- No `mcp-local` abstraction.
- No one-shot prompt semantics for Zed external agents.
- No custom ACP protocol or JSON-RPC methods.
- No runtime-host workflow integration.
- No ACP adapter implementation.
- No durable journaling schema changes.
- No host directory, context placement table, or caller-supplied stream URLs.

## Open Questions

1. What exact CLI spelling should surface:104 reserve for ACP stdio mode under
   the `start` family?
2. Should ACP stdio mode suppress the `firegrid.start.ready` record entirely or
   move a machine-readable equivalent to stderr/side-channel for tests?
3. Does the first implementation bind one ACP process to one RuntimeContext, or
   allow multiple ACP sessions under the same host process with separate
   RuntimeContexts?
4. Which subset of ACP permission flows should be required in the first smoke:
   explicit deny/cancel only, or selected allow as well?
