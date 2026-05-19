# RFC Profile (Firegrid): MCP Tool Exposure - lined-up spec

Status: lined-up spec skeleton plus tf-sd8 trace evidence for G-MCP-2.
This is the P8 anchor for the Firegrid RFC profile
(`docs/rfc/firegrid-profile-authoring-brief.md`, Page 8). It exists so the
"agents can call Firegrid's tools" claim is captured where a reviewer can
falsify it, not asserted in conversation.

Claim-status convention: `VERIFIED` cites a falsifying artifact;
`CLAIM-PENDING-EVIDENCE(G-N)` is intended-but-unverified with a gap id.

## Step 1 - Trust model: host-owns-catalog

`VERIFIED` (code, not test - structural):
- Tool implementations run in the Firegrid host process:
  `Layer.provide(FiregridAgentToolkitLayer)` in
  `packages/host-sdk/src/host/mcp-host.ts`.
- Host is the MCP server, agent is the MCP client:
  `McpServer.registerToolkit(FiregridAgentToolkit)` in `mcp-host.ts`;
  Effect AI owns `tools/list` / `tools/call`.
- Therefore the host decides which tools exist. The agent can only see and call
  what the `Toolkit.make` allowlist contains.

## Step 2 - Transport: MCP JSON-RPC over loopback HTTP

`VERIFIED` (code):
- MCP runs over JSON-RPC HTTP on a loopback `NodeHttpServer`, at the
  host-bound contextId-scoped `runtimeContextMcpPath` URL, late-bound via
  `FiregridRuntimeContextMcpBaseUrl`.
- Divergence to track - G-MCP-1: Firegrid replaces the default Effect
  JSON-RPC serializer with `firegridMcpJsonRpcSerialization`, unwrapping the
  one-element `[response]` array so strict single-message MCP clients receive
  `{...}`. `CLAIM-PENDING-EVIDENCE(G-MCP-1)`: no test asserts the bytes a real
  strict MCP client receives for a single non-batch `tools/call`.

## Step 3 - Discovery: `tools/list` projects the 8-tool allowlist

`VERIFIED` (code): `packages/host-sdk/src/agent-tools/bindings/tools.ts`
`FiregridAgentToolkit = Toolkit.make(...)` allowlists exactly 8:
`sleep, wait_for, session_new, session_prompt, session_cancel, session_close,
schedule_me, execute`.

- `SpawnTool` / `SpawnAllTool` are defined but excluded from `Toolkit.make`,
  so `spawn` / `spawn_all` are genuinely undiscoverable. Delegation is via
  `session_new` / `session_prompt` (in-catalog), consistent with finding
  tf-mn2.
- The tools file keeps one source of truth: codecs publish this set, MCP
  `tools/list` projects this set, and `toolUseToEffect` switches on the same
  `@firegrid/protocol/agent-tools` schemas.

## G-MCP-2 - Discovery silent-mismatch

`VERIFIED-FAILING` (trace artifacts):
`tooling/analysis/mcp-tool-exposure-trace.md` and
`tooling/analysis/mcp-tool-exposure-trace.json` capture a real Codex ACP smoke
run with Effect-native spans and a `Supervisor.track` snapshot. For the exporter
model, see `docs/runbooks/firegrid-effect-tracing.md`.

The trace localizes the failure:
- `firegrid.mcp.register_toolkit` records the host toolkit with 8 tools:
  `execute,schedule_me,session_cancel,session_close,session_new,session_prompt,sleep,wait_for`.
- `firegrid.mcp.publish_runtime_context_base` records the host MCP base
  publication.
- `firegrid.host.codec.resolve_effective_mcp_servers` records a context-scoped
  injected runtime-context MCP URL named `firegrid-runtime-context`.
- `firegrid.agent_event_pipeline.acp.new_session` records one ACP MCP server
  named `firegrid-runtime-context`.
- The agent reaches Ready but emits no Firegrid `ToolUse`; its text says the
  `firegrid.sleep` tool is not available in the active tool list.

Conclusion: G-MCP-2 is downstream of Firegrid host catalog construction and
codec MCP URL injection. The current evidence points at or after ACP
agent-side MCP discovery/tool exposure, not at an empty host catalog or missing
codec injection.

Remaining unknown: whether the ACP agent never calls `tools/list`, calls the
wrong URL/transport, silently drops the returned catalog, or exposes the tools
under names the prompt/config does not reference. The next probe should add
method-level MCP HTTP/JSON-RPC tracing around `initialize`, `tools/list`, and
`tools/call`.

## G-MCP-3..N - Per-tool end-to-end verification

For each of the 8 tools: a non-fraudulent test with a real agent process, the
Step-2 transport (including the G-MCP-1 unwrap serializer), real `tools/list`
discovery, and an assertion on observable Firegrid durable state. `execute` is
a known no-live-host gap (tf-mn2 sub-3). Each tool gets a `VERIFIED` artifact
pointer or a named `CLAIM-PENDING-EVIDENCE` gap.

## Relationship to the rest

- This file is the P8 anchor; Track D executes G-MCP-2 and the Step-4 per-tool
  artifacts against it.
- Sibling pattern: like `firegrid-client-runtime-input-intents.md`, this is a
  Firegrid-specific contract doc; it can later be folded into a neutral RFC
  profile sibling.
- A toy capability that exercises a tool flips its `CLAIM-PENDING-EVIDENCE`
  here to `VERIFIED` citing the toy test.
