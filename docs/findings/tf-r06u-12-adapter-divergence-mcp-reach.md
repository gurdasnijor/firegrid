# tf-r06u.12 — ACP adapter divergence + choreography MCP-reach (config vs code)

Date: 2026-06-01
Owner: tf-r06u.12 (agent2 / lane-b)
Bead: tf-r06u.12 (gates tf-r06u.14 S-REFACTOR, tf-r06u.15 T-REGISTRY)
Evidence: `packages/runtime/test/sources/codecs/acp/acp-live-adapters.test.ts` (env-gated `FIREGRID_ACP_LIVE=1`, 4 tests, all green 2026-06-01)
Grounded against: `sim/unified-kernel-validation` (#765 head). Adapters: `codex-acp@0.0.44`, `claude-agent-acp@0.36.1`.

## Verdict — SMALL ROCK: fleet onboarding is CONFIG, not per-dialect code; the one un-run dependency (does the choreography surface REACH each adapter LLM via MCP?) is now run and GREEN for both adapters.

Two independently-built foreign ACP adapters each (a) complete a full turn through Firegrid's **unmodified** production codec `AcpSessionLive` + the real `LocalProcessSandboxProvider`, and (b) **discover and actually call** a Firegrid-surfaced `schedule_me` MCP tool routed through the real codec MCP path. The §4 codec-ternary→registry investment is justified and low-risk; the entire per-dialect cost is one registry field (`newSessionMeta`) plus a tool-name-normalization rule. **Category 1/2 boundary: this is not a gap — it is a measurement that clears the registry contract to freeze.**

## What was run (evidence, not assertion)

`acp-live-adapters.test.ts` drives the **private codec/sandbox seam** — the exact two Layers `ProductionCodecAdapterLive.buildSessionForContext` composes (`packages/runtime/src/unified/codec-adapter.ts:264-317`): `SandboxProvider.create`/`openBytePipe` (real subprocess) → `AcpSessionLive(byteStream, …)` (real codec) → consume the mapped `AgentOutputEvent` stream. No `@firegrid/client-sdk`, no `FiregridHost` — hence it lives in the owning package's `test/`, per `firelab/docs/methodology.md` ("if the scenario needs codec/sandbox primitives, it is exercising a private seam … write the test in the owning package's test/ folder").

| test | claude-agent-acp@0.36.1 | codex-acp@0.0.44 |
|---|---|---|
| completes a turn through `AcpSessionLive` (`Ready`/`TextChunk`/`TurnComplete`) | ✅ | ✅ |
| reaches + calls Firegrid-surfaced `schedule_me` MCP tool (tools/list + tools/call + exact args) | ✅ | ✅ |

Both reduce to the same `AgentOutputEvent` vocabulary; the choreography tool was invoked with the exact args (`{when:9999999999999, prompt:"check the build"}`).

## Divergence, codec ⟂ adapter (six dimensions)

The wire-frame shapes below were observed during harness development (a probe over the same SDK `ClientSideConnection`+`ndJsonStream` the codec uses, `acp/index.ts:609-610`); the live tests are the durable evidence.

| # | Dimension | claude-agent-acp | codex-acp | Verdict |
|---|---|---|---|---|
| 1 | initialize / `_meta` | rich `agentCapabilities` (`loadSession`, fork/resume/list/delete/close, `_meta.claudeCode.promptQueueing`), `agentInfo`, `authMethods:[]` | leaner caps (`auth{logout}`, `loadSession`, `resume`/`list`), no `agentInfo`, `authMethods:[api-key,chat-gpt]` | **CONFIG** — agent→client only; codec sends `clientCapabilities:{}` and ignores it |
| 2 | capability negotiation | — | — | **CONFIG/none** — one shared empty `clientCapabilities` |
| 3 | tool-use mode | provider-executed | provider-executed | **CONFIG/none** — codec's `observation_only` (`acp/index.ts:850`) correct for both |
| 4 | permission req/resp | standard ACP; modes `auto/default/acceptEdits/plan/dontAsk/bypassPermissions` | standard ACP; modes `read-only/agent/agent-full-access` | **CONFIG** — wire shape identical; mode taxonomies differ (registry `modeMap`). Not exercised live (gate used `permissionPolicy:"allow"`) |
| 5 | session/update shapes | `available_commands_update` (slash), `usage_update{inputTokens…}`, `agent_message_chunk` | `available_commands_update` (skills/`$`), `usage_update{used,size}`, `agent_message_chunk` | **CONFIG/none** — divergent payloads fold into the codec's `Match.orElse → Status` passthrough (`acp/index.ts:416`) |
| 6 | cancellation | fire-and-forget `session/cancel` | fire-and-forget `session/cancel` | **CONFIG/none** — identical (codec `sendCancel`, `acp/index.ts:783`) |

## The one code→config item, confirmed by a + and a − case

`session/new` carries a hardcoded **claude-specific** `_meta` (`disableBuiltInTools` + `*-alwaysload` MCP aliases + `claudeCode.options.settingSources`; `acp/index.ts:200-234,644`). The MCP-reach gate proved its purpose and its dialect-specificity by contrast:

- **claude needs the coax** — the Claude Agent SDK defers MCP tools behind a ToolSearch indirection; without the `alwaysLoad` alias the agent never reaches `schedule_me`. The codec already supplies it; the tool was reached. ✅
- **codex needs nothing** — it surfaced the HTTP MCP tool natively via standard `session/new.mcpServers` and called it. ✅

So `newSessionMeta` is genuinely the single divergent per-dialect field: `claude → coax blob`, `codex → undefined`. Divergence is concentrated in one registry field = **measurement gap, not architecture gap.**

**One additional CONFIG nuance (gate finding):** the codec's observed `ToolUse.name` differs — claude emits bare `schedule_me`; codex namespaces it `mcp.firegrid.schedule_me`. Any name-based correlation of a ToolUse back to a known choreography tool needs a per-dialect `mcpToolNamePrefix` normalization rule (registry, or normalize in `canonicalAcpToolName`).

## Proposed `AdapterRegistryEntry` (input to tf-r06u.14 / .15)

```
AdapterRegistryEntry {
  command:           ReadonlyArray<string>   // claude resolved from devDep; codex external (env/installed path)
  credentialEnv?:    string                  // ANTHROPIC_API_KEY / OPENAI_API_KEY (both ambient; no authenticate() call needed)
  newSessionMeta?:   (decls) => Record<…>    // claude → claudeAgentAcpMeta (alwaysLoad coax); codex → undefined  ← the one CODE→CONFIG move
  mcpToolNamePrefix?: string                 // claude → "" (bare); codex → "mcp.<server>." — ToolUse.name correlation
  modeMap?:          Record<FiregridMode,string>  // only if Firegrid drives modes
}
```

## Open falsifiers (all SHARED flows, not per-dialect forks)

1. **Interactive `authenticate()`** — both adapters used ambient env-var creds; neither required an ACP `authenticate` round-trip. An OAuth-required adapter would hit the unimplemented authenticate path (`stdio-edge.ts:257` rejects) — one shared flow.
2. **Client-side tool execution** — both adapters are provider-executed; `observation_only` never contradicted. A client-tool agent engages the codec's `writeTextFile`/`readTextFile`/`createTerminal` handlers — one shared path.
3. **Live forward-permission rendezvous** — the reach gate used `permissionPolicy:"allow"`; the durable `PermissionRequest`→`PermissionResponse` rendezvous over a real adapter tool-permission prompt is not yet exercised end-to-end.

## Corrections to prior memory

- `project_codex_acp_defers_mcp_tools` (2026-05-22: "codex-acp defers MCP → only `sleep` surfaced of 11") does **not** hold for `codex-acp@0.0.44` over an HTTP MCP server — it discovered and invoked the HTTP MCP tool directly. Do not carry it forward as a codex MCP-reach blocker.

## Out-of-scope incidental

`firelab/.../production-flow-acp-live-scenario.ts` resolves `@agentclientprotocol/claude-agent-acp/dist/acp-agent.js` as its real-binary spawn target; that file is a library module (exports `runAcp`/`claudeCliPath`), and the package `bin` is `dist/index.js`. Spawning `acp-agent.js` exits 0 with no ACP I/O — that gated toggle has never driven the binary. One-line fix (`dist/index.js`); filed separately, not in this PR.

## Reproduction

```bash
cd packages/runtime
# claude resolved from devDep; codex external — point at an isolated install:
#   (in a dir OUTSIDE the pnpm workspace)  npm i @agentclientprotocol/codex-acp
FIREGRID_ACP_LIVE=1 \
FIREGRID_CODEX_ACP_BIN=/abs/path/to/@agentclientprotocol/codex-acp/dist/index.js \
  npx vitest run test/sources/codecs/acp/acp-live-adapters.test.ts
# (needs ANTHROPIC_API_KEY and/or OPENAI_API_KEY; each adapter skips if its bin+cred is absent)
```

## Deferred follow-up (motivates the §4 rebuild)

A true firelab PUBLIC-surface MCP-reach sim — driver on `@firegrid/client-sdk`, `host(env)` composing a `FiregridHost` that surfaces the choreography toolkit via MCP — is **blocked on the host-owned MCP-surfacing rebuild** (the deleted `mcp-host`). It is deferred and is itself a motivation for the §4 separation/registry work. Filed as a blocked bead.
