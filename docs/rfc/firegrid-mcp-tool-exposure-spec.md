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

`VERIFIED` (trace + source verified, 2026-05-19):
the Codex ACP tiny-firegrid simulation writes gitignored local evidence under
`packages/tiny-firegrid/.simulate/runs/<run-id>/`. For the exporter model, see
`docs/runbooks/firegrid-effect-tracing.md`.

Classification result:
- Pre-fix run
  `2026-05-19T10-04-19-042Z__codex-acp-tool-call-pipeline` proved a
  Firegrid-side route exposure bug: the host registered 8 tools and injected
  `firegrid-runtime-context`, Codex ACP called the injected URL, and an
  independent JSON-RPC client against that same URL also received HTTP 404
  before any `McpServer.initialize` span. A short control URL
  `/mcp/runtime-context/test` initialized successfully with
  `capabilities.tools`, which localized the failure to the route parameter
  length of Firegrid-generated context ids rather than catalog construction or
  serialization.
- Firegrid fix: `FiregridMcpServerLayer` now raises the Effect HTTP router
  `maxParamLength` for the MCP listener
  (`packages/host-sdk/src/host/mcp-host.ts:55`,
  `packages/host-sdk/src/host/mcp-host.ts:269`). This satisfies
  `firegrid-local-mcp-run.MCP_ROUTE.1-1`.
- Post-fix run
  `2026-05-19T10-13-30-441Z__codex-acp-tool-call-pipeline` classified the
  remaining Codex ACP behavior as **(a) agent never calls `tools/list`**:
  Codex ACP attempted OAuth discovery, then emitted `McpServer.initialize` and
  two successful `firegrid.mcp.http POST /runtime-context/:contextId` spans at
  10:13:41Z, with no agent-originated `McpServer.tools/list` or
  `McpServer.tools/call`.
- The same run's independent known-good `@modelcontextprotocol/sdk`
  `Client` + `StreamableHTTPClientTransport` probe against the same captured
  long context URL emitted `McpServer.initialize` and `McpServer.tools/list` at
  10:14:19Z. The initialize response advertised `capabilities.tools`, and
  `listTools()` returned all 8 tools:
  `sleep, wait_for, session_new, session_prompt, session_cancel,
  session_close, schedule_me, execute`.

Verdict:
- The first failure was **Firegrid-side** and fixed by making the route accept
  Firegrid-generated context-id path parameters.
- After that fix, G-MCP-2 is **agent-side for codex-acp@0.14.0**: the agent
  connects to the correct URL and receives a valid initialize response, but
  does not enumerate the tool catalog. This refutes (b), (c), and (d) for the
  post-fix Firegrid surface: the URL/transport works for a known-good client,
  the returned catalog contains the expected tool names, and Codex ACP never
  requests the catalog it could drop or remap.

Source grounding:
- `@effect/rpc` creates request spans after resolving the request tag and
  before the handler result is returned
  (`repos/effect/packages/rpc/src/RpcServer.ts:229`,
  `repos/effect/packages/rpc/src/RpcServer.ts:293`), so absence of
  `McpServer.tools/list` before the independent probe is real host evidence.
- Effect AI advertises `capabilities.tools` when server tools exist and handles
  `tools/list` from the same server state
  (`repos/effect/packages/ai/ai/src/McpServer.ts:1263`,
  `repos/effect/packages/ai/ai/src/McpServer.ts:1270`,
  `repos/effect/packages/ai/ai/src/McpServer.ts:1315`).
- The router-param limit mechanism is source-verified by Effect's own
  `setRouterConfig` test
  (`repos/effect/packages/platform-node/test/HttpServer.test.ts:725`,
  `repos/effect/packages/platform-node/test/HttpServer.test.ts:737`).

The supporting trace surface also covers Firegrid's durable boundaries:
runtime-control-plane authorities, host reconciliation, runtime context engine
registry, workflow engine execution/resume/deferred/clock operations,
per-context runtime output, durable wait store/router operations, and the
shared DurableTable action facade with table/collection/durable-type metadata.
That coverage is intended to answer consistency questions directly: whether a
row was written, whether a subscriber observed it, whether a wait matched it,
and whether the workflow resumed from the corresponding durable deferred.

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
