# Firegrid Architecture Map

This is a one-page "where does X live" reference for agents. It is
deliberately code-grounded and current-state-only — no aspirational
architecture, no future-tense. Pair it with `AGENTS.md`'s "The CLI Is
The Harness" rule.

If you find yourself grepping for the same answer across several
files, add it here.

## Where does X live?

| I want to… | Touch this |
|---|---|
| spawn an agent under the runtime workflow | `executeRun` in `src/run.ts` |
| start the unified host + MCP server | `hostAndMcpLayer` in `src/run.ts` |
| compose the runtime host (durable streams + control plane + sandbox provider) | `FiregridLocalHostLive` in `packages/runtime/src/runtime-host/index.ts` |
| compose the localhost MCP server | `FiregridMcpServerLayer` in `packages/runtime/src/agent-tools/mcp-host.ts` |
| drive an ACP agent end-to-end as `@effect/ai` `LanguageModel.Service` | `AcpAgentAdapter` in `packages/runtime/src/agent-adapters/acp/` |
| drive an ACP agent as a Firegrid `AgentSession` (legacy event shape) | `AcpCodec` in `packages/runtime/src/agent-codecs/acp/` |
| spawn a local child process and get an `AgentByteStream` | `LocalProcessSandboxProvider.openBytePipe` in `packages/runtime/src/providers/sandboxes/local-process.ts` |
| wire an MCP server into a spawned ACP agent's session | `AcpAgentAdapterOptions.session.mcpServers` (the option exists on the adapter; the CLI does **not** thread it through yet — see "Known CLI gaps" below) |
| validate `RuntimeContext` host binding for a request | `requireLocalContext` / `findRuntimeContext` in `packages/protocol/src/launch/host-context-authority.ts` |

## Codec vs Adapter

There are two parallel "talk ACP to a child process" paths today:

- **`AcpCodec`** (`packages/runtime/src/agent-codecs/acp/`) is the
  **legacy path**. It produces Firegrid-shaped `AgentOutputEvent`s
  (Ready / TextChunk / ToolUse / PermissionRequest / TurnComplete /
  Terminated). Currently used by tests and as a reference for the
  ACP wire mapping. Frozen for new features; new ACP work should
  not extend it.

- **`AcpAgentAdapter`** (`packages/runtime/src/agent-adapters/acp/`)
  is the **target end-state**. It exposes `@effect/ai`
  `LanguageModel.Service` (`streamText` / `generateText`) plus a
  small capability summary. This is the surface intended for
  runtime-host integration and future agent consumers.

Pure helpers (`acpStopReasonToFinishReason`,
`acpUserPromptPartToContentBlock`) are shared between the two
through `packages/runtime/src/agent-codecs/acp/mapping.ts`.

**The runtime workflow uses neither end-to-end ACP path today.**
`runRuntimeContext` (`packages/runtime/src/runtime-host/index.ts`)
spawns the child via `LocalProcessSandboxProvider` and streams its
stdout/stderr as raw byte chunks. It does not perform ACP
`initialize` / `newSession` / `prompt` handshakes from the Firegrid
side. The adapter and codec are reached from outside the runtime
workflow (tests, future CLI lowering).

## CLI subcommand intent

`src/run.ts` exposes two subcommands. They split responsibilities by
design; combinations not listed here are gaps, not bugs in your
reading:

| Subcommand | Starts host? | Starts MCP server? | Spawns agent? | Threads `mcpServers` to agent? |
|---|---|---|---|---|
| `firegrid -- run -- <agent>` | yes (`FiregridLocalHostLive`) | **no** | yes (`startRuntime` → `RuntimeContextWorkflow` → `LocalProcessSandboxProvider`) | **no** |
| `firegrid -- start` | yes | yes (emits `firegrid.start.ready` JSON with `mcpUrl`) | **no** — `Layer.tap` only seeds the context; the agent argv accepted after `--` is recorded into the intent but not launched | n/a |

## Known CLI gaps

These are surfaces the CLI does **not** own yet. If a smoke needs
one of these, extend `src/run.ts` (and the launch schema if
needed); do not reach around the CLI in a scenario.

- **`run` does not start MCP.** The host composed by `run` is
  `FiregridLocalHostLive` only; `FiregridMcpServerLayer` is not in
  the composition. A smoke that needs Firegrid MCP available
  during a `run` is currently impossible.
- **`run` does not thread `mcpServers` to the spawned agent.** The
  runtime workflow path (`startRuntime` → `runRuntimeContext`) uses
  `LocalProcessSandboxProvider.stream` and treats the agent as a
  byte-emitting process. It does not invoke `AcpAgentAdapter`. The
  `session.mcpServers` option added in #220 lives on the adapter,
  not on the codec the runtime workflow currently uses — and the
  runtime workflow doesn't drive the codec end-to-end either (see
  Codec vs Adapter).
- **`start` does not actually launch its agent argv.** The argv
  after `--` is captured into the `RuntimeContext.runtime` intent
  for someone else to `startRuntime` against; `start` itself just
  prints the ready record and idles.
- **No `--agent <kind>` flag yet.** There is no CLI signal that
  routes an ACP agent through the adapter (vs. the byte-stream
  spawn path). A schema-backed `--agent codex-acp` or equivalent
  is the smallest known-good shape for a CLI-driven Codex smoke;
  it does not exist today.

The acceptance shape we are working toward looks like:

```
pnpm firegrid -- run \
  --prompt "Call the Firegrid sleep tool with durationMs 1" \
  --agent codex-acp \
  -- npx -y @zed-industries/codex-acp@0.14.0
```

…where `src/run.ts` owns context creation, MCP attachment, lowering
MCP config into the agent's `session.mcpServers`, and waiting for
the run. A scenario wraps the CLI command; it does not reach past
the CLI boundary.

## MCP server transport

`FiregridMcpServerLayer` mounts `@effect/ai/McpServer.layerHttp`
behind `@effect/platform-node/NodeHttpServer` on loopback. The
upstream `McpServer.layerHttp` composes
`McpServer.layer + RpcServer.layerProtocolHttp + RpcSerialization.layerJsonRpc()`.
The default Effect-RPC JSON-RPC serializer always wraps responses
in a JSON-RPC batch array — `[{"jsonrpc":...}]` — even for a single
(non-batch) request. The lenient `@modelcontextprotocol/sdk`
`StreamableHTTPClientTransport` accepts that shape; strict clients
(`rmcp` / `@zed-industries/codex-acp`) reject the leading `[`
because their untagged `JsonRpcMessage` enum has no batch variant.
Transport-compat work for strict clients is tracked under the
`firegrid-effect-ai-native-agents.MCP_TRANSPORT_COMPAT` ACID.

## Adding to this doc

When you discover a recurring "where does X live" question, add a
row to the table or a short subsection. Two rules:

1. Stay code-grounded — file paths only, no speculation about
   future architecture.
2. If you add a known-gap entry, the gap should be real today
   (verified by reading the source), not "this might be missing,
   I'm not sure."
