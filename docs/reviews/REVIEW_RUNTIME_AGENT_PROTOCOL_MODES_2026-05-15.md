# Runtime Agent Protocol Modes Review

Date: 2026-05-15

Scope: PR #245, `docs/sdds/SDD_FIREGRID_RUNTIME_AGENT_EVENT_PIPELINE.md`
and `features/firegrid/firegrid-runtime-agent-event-pipeline.feature.yaml`.

## Summary

PR #245 should frame Firegrid `stdio-jsonl` as one member of a broader family of
agent wire modes, not as a Firegrid-invented branch opposite ACP. The current
runtime direction is sound: `stdio-jsonl` has a durable `ToolUse` to
`ToolResult` path, while ACP `sessionUpdate.tool_call` is an observation. The
SDD should adjust the taxonomy so future codecs can be described by negotiated
session capability rather than by static protocol class.

The useful taxonomy is:

- `observation_only`: tool-shaped events are durable observations for UI,
  tracing, metrics, and future observers. They are not router dispatch claims.
- `client_result_roundtrip`: the active session exposes an explicit path from
  normalized `ToolUse` output to host-produced `ToolResult` input.
- `control_channel_request_response`: the protocol has request/response methods
  with their own ids, responses, and capability negotiation. These are not
  subscriber-produced `ToolResult` ingress unless a separate SDD defines that
  bridge.

## Findings

### Codex has multiple wire modes in the same product family

`codex exec --json` is best treated as `observation_only` for #245. The
noninteractive docs say `--json` makes stdout a JSON Lines event stream with
events such as `thread.started`, `turn.started`, `turn.completed`, `item.*`, and
`error`. The same page documents stdin for prompt/context piping and
`codex exec -`, not for live tool-result injection.

Sources:

- OpenAI Codex noninteractive mode:
  <https://developers.openai.com/codex/noninteractive>
- Relevant sections: "Make output machine-readable" and "Advanced stdin
  piping".

Codex app-server is a separate `control_channel_request_response` surface. The
app-server docs describe JSON-RPC over stdio/websocket and dynamic tool calls
where app-server emits `item/tool/call` as a server request to the client, then
the client response payload is used to complete the dynamic tool call.

Sources:

- OpenAI Codex app-server:
  <https://developers.openai.com/codex/app-server>
- Relevant sections: initialization/capabilities, `dynamicTools`, and
  "Dynamic tool calls (experimental)".

Implication: the same ecosystem has both event stream mode and request/response
control-channel mode. `toolUseMode` should be derived per active codec session
from protocol kind, launch flags, and negotiated setup rather than treated as a
static codec-class property.

### Claude Code stream-json is externally real but underdocumented for tool results

Claude Code documents `--output-format stream-json` as newline-delimited JSON
for real-time streaming in print mode. That surface is `observation_only` for
#245 unless/until Firegrid targets a documented bidirectional CLI contract.

Claude Code also documents `--input-format stream-json` as a print-mode flag,
and the Claude Agent SDK documents streaming input as a persistent interaction
mode. However, the CLI docs do not currently define a stable stdin
`tool_result` shape for `claude -p --input-format stream-json`. The linked
Claude Code issue is not normative, but it supports the uncertainty: it reports
that `--input-format stream-json` is only listed in the flag table and does not
explain message formats, follow-up messages, bidirectional flow, or permission
responses.

Sources:

- Claude Code headless mode:
  <https://code.claude.com/docs/en/headless>
- Claude Code CLI reference:
  <https://code.claude.com/docs/en/cli-reference>
- Claude Agent SDK streaming input:
  <https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode>
- Claude Code issue #24594:
  <https://github.com/anthropics/claude-code/issues/24594>

Implication: cite Claude as evidence that stdio JSON event streams are a real
protocol family, but do not cite Claude CLI as a confirmed
`client_result_roundtrip` tool-result protocol.

### ACP tool calls are deliberate observation and delegation

ACP Tool Calls are `observation_only` for Firegrid's v1 router. The ACP docs say
tool calls and updates are sent through `session/update` so clients can show
progress and results. This is not a deficiency; it is ACP's directionality for
tool progress.

ACP also has `control_channel_request_response` capabilities. Permission uses
`session/request_permission`, where the agent sends a JSON-RPC request and the
client responds with a decision. ACP file system methods such as
`fs/read_text_file` and terminal methods such as `terminal/create` likewise
depend on client capability checks and direct JSON-RPC responses.

ACP tool execution can also be delegated through MCP servers supplied during
session setup or session load. In that path, MCP owns the tool request/result
exchange and ACP reports observations back to the client.

Sources:

- ACP Tool Calls:
  <https://agentclientprotocol.com/protocol/tool-calls>
- ACP Session Setup:
  <https://agentclientprotocol.com/protocol/session-setup>
- ACP File System:
  <https://agentclientprotocol.com/protocol/file-system>
- ACP Terminals:
  <https://agentclientprotocol.com/protocol/terminals>

Implication: #245 should keep ACP `sessionUpdate.tool_call` rows queryable and
durable, should keep permission as durable wait/resume, and should avoid routing
ACP tool-call observations through subscriber-produced `ToolResult` ingress.

### Firegrid stdio-jsonl is the v1 client-result route

The current Firegrid `stdio-jsonl` codec decodes stdout records with
`type: "tool_use"` into normalized `ToolUse` and encodes `ToolResult` input as a
stdin `type: "tool_result"` line. That is a concrete
`client_result_roundtrip` route and is appropriate for the v1 durable
subscriber dispatch path.

Source:

- `packages/runtime/src/agent-codecs/stdio-jsonl/index.ts`

The current Firegrid ACP codec maps `sessionUpdate: "tool_call"` to normalized
`ToolUse`, but its `ToolResult` send path fails with
`ACP ToolResult input is out-of-band for this codec slice`. It also passes
`mcpServers` to ACP session creation and supports permission request/response.

Source:

- `packages/runtime/src/agent-codecs/acp/index.ts`

Implication: the implementation evidence matches the intended SDD split. The
docs/spec language just needs to distinguish observation rows from dispatch
routes more carefully.

## Recommended SDD Wording

Replace the current two-value contract language with a per-session route:

```ts
readonly toolUseMode:
  | "client_result_roundtrip"
  | "observation_only"
  | "control_channel_request_response"
```

Recommended prose:

```md
`toolUseMode` is a per active codec session capability, not a static property of
a protocol family. The runtime derives it when the session opens from the codec
kind, launch flags, and negotiated setup/capabilities. The tool router only
claims durable `ToolUse` rows for sessions whose active route is
`client_result_roundtrip`.

`client_result_roundtrip` means the active session exposes an explicit path from
normalized `ToolUse` output to host-produced `ToolResult` input. Firegrid's
`stdio-jsonl` v1 codec is one instance: it decodes `tool_use` from stdout and
accepts `tool_result` on stdin.

`observation_only` means `ToolUse`/tool-call-shaped output is durable telemetry
for UI, tracing, metrics, or future observation subscribers. The tool router
must not claim these rows.

`control_channel_request_response` means the protocol has tool/client authority
methods with their own request ids, responses, and capability negotiation.
These may be durable in Firegrid, but they are not modeled as
subscriber-produced `ToolResult` ingress unless a separate SDD defines that
bridge.
```

Replace the ACP framing with:

```md
ACP `sessionUpdate.tool_call` and `tool_call_update` are progress/result
observations from the Agent to the Client. This is a deliberate ACP
directionality contract, not a missing Firegrid dispatch path. ACP tool
execution can flow through MCP servers supplied at session setup, through
agent-owned tools inside the launched process, or through explicit ACP Client
capability request/response methods such as permission, filesystem, and
terminal. Firegrid v1 journals ACP tool-call observations and supports
permission wait/resume; it must not reinterpret ACP tool-call observations as
client-executed tool requests.
```

## Recommended Feature ACID Edits

Patch-ready edits for
`features/firegrid/firegrid-runtime-agent-event-pipeline.feature.yaml`:

```yaml
STAGES:
  requirements:
    3-8: Active codec sessions expose a per-session toolUseMode derived from protocol kind, launch flags, and negotiated setup/capabilities; the tool router gates only client_result_roundtrip sessions.
    3-9: The SDD classifies agent wire modes as observation_only, client_result_roundtrip, and control_channel_request_response; control-channel request/response is not subscriber-produced ToolResult ingress.
```

```yaml
TOOL_DISPATCH:
  requirements:
    6: The v1 transactional cutover implements subscriber-based ToolUse to ToolResult round-trip for active stdio-jsonl sessions whose per-session toolUseMode is client_result_roundtrip.
    7: ACP sessionUpdate.tool_call and tool_call_update rows are durable observations, not dispatch candidates, and the tool router must not claim them.
    9: ACP MCP delegation and ACP Client capability methods are request/response control-channel paths; additional filesystem or terminal handlers require separate SDD/spec ACIDs for authority, journaling, idempotency, and sandbox policy.
```

```yaml
VALIDATION:
  requirements:
    2: The cutover proves stdio-jsonl codec runtime execution advertises client_result_roundtrip and still handles Prompt, ToolUse, ToolResult, and Terminated events.
    6: The cutover proves ACP tool_call and tool_call_update observations are journaled and not claimed by the tool router, while ACP PermissionRequest remains durably observable and resumable.
    7: The cutover proves control_channel_request_response modes are not routed through subscriber-produced ToolResult ingress.
```

## Landing Recommendation

Treat the wording and ACID cleanup as a pre-landing blocker for PR #245, but
not as an implementation blocker. The current architecture direction is right;
the risk is review interpretation. Without the cleanup, the SDD can be read as
"Firegrid-owned stdio-jsonl vs externally specified ACP", when the more durable
framing is "per-session codec capability across real agent wire-mode families."
