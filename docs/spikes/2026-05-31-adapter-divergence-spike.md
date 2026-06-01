# Spike: ACP adapter divergence (RFC Phase 0)

- **Date:** 2026-05-31
- **Author:** adapter-divergence spike session (parallel to #765 green-up / D1)
- **Branch / worktree:** `sidecar/pr765-adapter-divergence-spike` @ `firegrid-worktrees/pr765-adapter-spike`, off `origin/sim/unified-kernel-validation` (`fabf9bb46`, the #765 head)
- **Gates:** RFC `docs/rfcs/2026-05-31-firegrid-durable-acp-acpx-alignment.md` §6 / §11-Phase-0 / open-Q5; handoff Tier-3 #7.
- **Mission:** *measure* config-vs-code divergence across two real foreign ACP adapters, not build a demo. The verdict gates the §4 codec-ternary→registry investment.

## TL;DR — verdict

**SMALL ROCK. Fleet onboarding is config, not per-dialect code — and the one un-run dependency is now run and GREEN.** Both `codex-acp@0.0.44` and `claude-agent-acp@0.36.1` ran a full durable-shaped turn end-to-end through Firegrid's **existing, unmodified** production codec (`AcpSessionLive`) over the **real** `LocalProcessSandboxProvider` — prompt → streamed output → `TurnComplete`. The central §6 claim is **proven**: *an acpx adapter is just an ACP subprocess Firegrid already speaks to.* Across all six divergence dimensions, the only thing currently implemented as per-dialect **code** is a hardcoded claude-specific `session/new` `_meta` blob — and the spike proved codex **ignores it and runs fine**, i.e. even that is an absorbable no-op that belongs in a registry row, not a codec fork. **The architect-elevated GATE (does Firegrid's §5.5 choreography surface actually *reach* each adapter's LLM via MCP?) PASSED for both adapters** — each discovered and called a real Firegrid-surfaced `schedule_me` MCP tool. The §4 registry investment is justified, low-risk, and cleared to proceed; no per-dialect codec variant is required.

## What was actually run (no fakes)

Two layers of evidence, both against the real npm-published adapter binaries with real API credentials (`ANTHROPIC_API_KEY` / `OPENAI_API_KEY` from the host env, injected into the subprocess via `SandboxCommand.envVars` — the same channel `envBindings` resolve onto):

1. **Wire probe** (`/tmp/acp-probe.mjs`): the adapter driven through the **exact SDK transport the codec uses** — `acp.ndJsonStream(stdin, stdout)` + `acp.ClientSideConnection` (`packages/runtime/src/sources/codecs/acp/index.ts:609-610`) — tee-ing every JSON-RPC frame in both directions. Captures the raw `initialize` / `session/new` / `session/update` / `session/prompt` / `session/cancel` shapes.
2. **Real-codec harness** (`packages/tiny-firegrid/src/prototypes/adapter-divergence-spike.ts`, this branch): the adapter driven through the **actual production codec** `AcpSessionLive(byteStream, …)` + `LocalProcessSandboxProvider` — mirroring `ProductionCodecAdapterLive.buildSessionForContext` (`codec-adapter.ts:264-317`) — consuming the codec's mapped `AgentOutputEvent` stream. This makes the proof airtight at the codec layer, not merely "the same SDK."

**Result (real-codec harness, identical for both adapters):**

| adapter | codec.kind | toolUseMode | output event sequence | terminal |
|---|---|---|---|---|
| `claude-agent-acp@0.36.1` | `acp` | `observation_only` | `Ready → Status×2 → TextChunk×2 ("PONG") → Status → TurnComplete` | `finishReason=stop` ✅ |
| `codex-acp@0.0.44` | `acp` | `observation_only` | `Ready → Status → TextChunk×2 ("PONG") → Status → TurnComplete` | `finishReason=stop` ✅ |

Both reduced to the **same Firegrid `AgentOutputEvent` vocabulary**. The codec required zero changes between adapters. Critically, the codec sends its hardcoded claude `_meta` (`{claudeCode:{options:{settingSources:["project"]}}}`) on `session/new` to **both** — codex received it, ignored the unknown key, and completed the turn. That is the divergence-absorption thesis demonstrated, not asserted.

## Divergence table (codex-acp vs claude-agent-acp)

Verdict legend: **CONFIG** = absorbable as a registry row / shared client declaration; **CODE** = needs per-dialect codec logic. Confidence noted where a dimension wasn't exercised by a live tool/permission turn.

| # | Dimension | claude-agent-acp | codex-acp | Codec handling today | Verdict |
|---|---|---|---|---|---|
| 1 | **initialize handshake / `_meta`** | protocolVersion 1; rich `agentCapabilities` (`loadSession`, `promptCapabilities{image,embeddedContext}`, `mcpCapabilities{http,sse}`, `sessionCapabilities{additionalDirectories,close,delete,fork,list,resume}`, `_meta.claudeCode.promptQueueing`); `agentInfo{name,title,version}`; `authMethods: []` | protocolVersion 1; leaner `agentCapabilities` (`auth{logout}`, `loadSession`, `promptCapabilities{image}`, `sessionCapabilities{resume,list}`, `mcpCapabilities{http, sse:false}`); **no** `agentInfo`; `authMethods:[api-key(provider=openai), chat-gpt]` | Firegrid sends `clientCapabilities:{}` and does **not** read the response capabilities/authMethods. Both accept. | **CONFIG** — divergence is entirely in the *agent→client* direction and Firegrid currently ignores it. Surfacing caps (e.g. to gate `loadSession`/`resume`) = read a field, registry-tagged, not per-dialect code. |
| 2 | **capability negotiation** | (as above) | (as above) | Firegrid advertises empty `clientCapabilities`; neither adapter demanded client fs/terminal for a no-tool turn. | **CONFIG/none** — one shared `clientCapabilities` object; no per-adapter branch. |
| 3 | **tool-use mode** (`provider_executed` vs `observation_only`) | provider-executed (runs its own tools behind its own modes) | provider-executed (runs its own tools) | Codec hardcodes `toolUseMode:"observation_only"` and maps `tool_call`/`tool_call_update` → `ToolUse{providerExecuted:true}` for both (`acp/index.ts:377-415,850`). | **CONFIG/none for both observed adapters** — both are provider-executed, so the constant is correct. *Open (not exercised):* a future client-tool-executing agent would engage the codec's `writeTextFile`/`readTextFile`/`createTerminal` client handlers — but that is **one shared code path**, not per-dialect. Medium confidence: no tool turn was driven. |
| 4 | **permission request/response shape** | `requestPermission` is standard ACP; permission *modes* exposed via `session/new.modes` = `auto/default/acceptEdits/plan/dontAsk/bypassPermissions` | standard ACP `requestPermission`; modes = `read-only/agent/agent-full-access` | Codec maps options by `kind` (`allow_once`/`allow_always`/`reject_once`/`reject_always`) → typed `PermissionDecision`, uniform (`acp/index.ts:295-317,547`). | **CONFIG** — request/response *wire shape* is identical standard ACP (high confidence, static). The two **mode taxonomies differ** but ride the standard `modes`/`configOptions` fields → a mode-name mapping is a registry row, not codec code. Permission round-trip not triggered live (trivial prompt) → medium confidence on response, high on request. |
| 5 | **session/update event shapes** | emits `available_commands_update` (slash commands), `usage_update{inputTokens,outputTokens,…}`, `agent_message_chunk{content.type=text}` | emits `available_commands_update` (skills/`$`-prefixed), `usage_update{used,size}`, `agent_message_chunk{content.type=text}` | `agent_message_chunk(text)` → `TextChunk`; `tool_call`/`tool_call_update` handled explicitly; **everything else → opaque `Status` passthrough** via `Match.orElse` (`acp/index.ts:362-416`). | **CONFIG/none** — every divergent payload (different `usage_update` fields, wildly different `available_commands`) folds into the generic `Status` event with **zero per-dialect code**. The `orElse→status` fallback is the structural absorber. |
| 6 | **cancellation** | `session/cancel` accepted as a fire-and-forget notification | `session/cancel` accepted as a fire-and-forget notification | Codec `sendCancel` → `connection.cancel({sessionId})` (`acp/index.ts:783-789`), uniform. | **CONFIG/none** at the client-codec layer — identical for both. (The RFC §7 keystone — *cancelled terminal state* — is about Firegrid's own **agent face**, not this downstream client cancel; out of scope here.) |

### The one real code-shaped item today, and why it's still CONFIG

`session/new` always carries `_meta: claudeAgentAcpMeta(declarations)` — a **claude-specific** blob (`claudeCode.options.settingSources`, `disableBuiltInTools`, `*-alwaysload` MCP aliases; `acp/index.ts:200-234,644`). This exists because the Claude Agent SDK defers MCP tools behind a `ToolSearch` indirection (tf-b6n/A1) and needs coaxing. It is:

- **Hardcoded into the shared codec** — a §4-conflation #2 symptom (dialect quirk in the common path).
- **Provably harmless to other dialects** — codex received it this run and ignored the unknown key, completing the turn. (Matches the RFC's "non-claude ACP agents ignore it" comment, now empirically confirmed.)

So the correct home is a **per-dialect registry row supplying a `newSession._meta` builder** (claude → this blob; codex → none), not a codec fork. This is the single concrete thing the §4 registry must own beyond `command`.

## Cost that scales with N (the long tail)

The only per-adapter cost observed is **dialect quirk metadata**, all of which fits a registry row:

```
AdapterRegistryEntry {
  command:        ReadonlyArray<string>        // codex → [node, codex-acp/dist/index.js]; claude → [node, claude-agent-acp/dist/index.js]
  credentialEnv?: string                       // codex → OPENAI_API_KEY; claude → ANTHROPIC_API_KEY (ambient; no authenticate() call needed)
  newSessionMeta?: (decls) => Record<…>        // claude → claudeAgentAcpMeta (alwaysLoad coax); codex → undefined  ← the one CODE→CONFIG move; gate-confirmed by + and − case
  mcpToolNamePrefix?: string                   // claude → "" (bare); codex → "mcp.<server>." — normalize ToolUse.name correlation (gate finding)
  modeMap?: Record<FiregridMode, string>       // claude → {…}; codex → {readOnly:"read-only", …}  (only if Firegrid drives modes)
}
```

Everything else (turn lifecycle, streaming, status passthrough, cancel) is **dialect-invariant** and already lives in the shared codec.

## Verdict → what it gates

**Do §4 (codec ternary → registry); it is a small rock with a large payoff.** Specifically:

- Replace `codec-adapter.ts:299` ternary (`agentProtocol==="raw" ? StdioJsonl : Acp`) with a protocol→codec registry, and add an **adapter registry** keyed by adapter name supplying `command` + the table above.
- Onboarding a new ACP adapter = **add a registry row** (command + optional `_meta`/mode map). No codec PR. This is the §6 "ingestion is configuration" thesis, now empirically supported by two independent, differently-built adapters.

### Honest residual risks (where a future adapter *could* force code — flag, don't block)

1. **Explicit `authenticate()` flow.** Both adapters accepted ambient env-var credentials; neither required Firegrid to call ACP `authenticate`. codex *advertises* `authMethods:[api-key, chat-gpt]`. An adapter that **requires** an interactive/OAuth `authenticate` round-trip would hit the currently-unimplemented authenticate path (RFC §4 #3 / `stdio-edge.ts:257` rejects). That is **one shared flow** to build, not per-dialect — but it is real and unbuilt. Bounded CODE item.
2. **Client-side tool execution.** Both adapters are provider-executed; the `toolUseMode:"observation_only"` constant was never contradicted. A client-tool agent would engage the codec's `writeTextFile`/`readTextFile`/`createTerminal` handlers (already present) and possibly require `toolUseMode` to vary — making mode a **registry field**, still not a fork. Medium confidence; not exercised.
3. **Permission round-trip live.** Dimension 4's response shape was verified statically + by handshake, not by a live tool-gated turn. Recommend a follow-up spike that drives a tool-using prompt through each adapter to exercise `requestPermission` end-to-end before committing the mode-map design.

None of these are per-dialect codec variants. The "bigger rock" scenario (a per-dialect codec fork) did **not** materialize for the turn lifecycle.

## Proposed RFC §6 deltas (put here; not editing the RFC — other session may be touching it)

1. **§6 "The realization" — upgrade from claim to result.** Add: *"Empirically confirmed (spike 2026-05-31): `codex-acp@0.0.44` and `claude-agent-acp@0.36.1` both ran a full turn through the unmodified `AcpSessionLive` codec + `LocalProcessSandboxProvider`, reducing to the same `AgentOutputEvent` vocabulary. Onboarding cost is a registry row."*
2. **§6 "Where the long-tail cost actually lives" — make it concrete.** The dialect-quirk cost is captured by the `AdapterRegistryEntry` shape above; the *only* code→config migration the spike found is moving the hardcoded claude `session/new._meta` (`acp/index.ts:200-234,644`) into a per-dialect `newSessionMeta` builder. The GATE confirmed this by contrast: claude needs the `alwaysLoad` coax to surface MCP choreography tools, codex needs nothing — so the field's *value* diverges (claude blob vs none) but the field is singular. Add a `mcpToolNamePrefix` normalization note (codex namespaces MCP `ToolUse` names `mcp.<server>.<tool>`; claude is bare).
3. **§6 (new sub-point) — credential model.** Both adapters authenticated from an **ambient env var** injected via `SandboxCommand.envVars`; no ACP `authenticate` call was needed. Add `credentialEnv` to the registry row and note explicit-`authenticate` adapters as a separate (shared, unbuilt) flow — ties to open-Q on the agent face (§4 #3).
4. **Open-Q5 (one dispatch key or two) — data point.** `agentProtocol` (acp/raw) and adapter-name are **orthogonal**: every ACP adapter shares one codec; the adapter row varies only `command` + quirks. Supports **two registries** (protocol→codec, name→adapter-row), not one key.
5. **§10 falsifiers — discharge three.** "ACP dialect drift" and "`provider_executed` vs `observation_only`" falsifiers are *discharged*: drift was absorbed by the `Status` fallback for the turn lifecycle; both adapters are `observation_only`-correct. The **§5.5 choreography-reach falsifier** (does the MCP-surfaced tool actually reach the LLM?) is **discharged by the gate** — both adapters discovered + called a real Firegrid `schedule_me` MCP tool. Note the two residual-risk items (interactive `authenticate`, client-side tool execution) and the live forward-permission rendezvous (gate used `permissionPolicy:"allow"`) as the still-open falsifiers.
6. **§5.5 / Q10 — add the reach data point.** The choreography surface is empirically reachable over the fleet today: claude via the codec's existing `alwaysLoad` coax, codex natively. This de-risks the §5.5 "agent participates with the substrate" axis for ACP adapters — the remaining §5.5 gaps (`event(name)` peer-pheromone, `session.self.*` interoception) are *substrate-side surfacing*, not adapter-reach.

## Intersection with RFC §5.5 (choreography-first) — the dialect quirk *is* the choreography-reach quirk

The parallel session added RFC §5.5 (the agent participates *with* the substrate via `sleep`/`wait_for`/`spawn`/`schedule_me`/`execute`). For a **downstream acpx adapter** (client face, `observation_only`), those Firegrid choreography tools reach the adapter's LLM **only through MCP servers declared on `session/new`** — the adapter executes its own tool calls, so Firegrid surfaces its catalog as MCP. This spike used `mcpServers:[]`, so it did **not** exercise that path — but it explains *why the one code-shaped divergence exists*:

- The hardcoded claude `_meta` (`disableBuiltInTools` + `*-alwaysload` aliases) is **precisely a choreography-reach workaround**: the Claude Agent SDK defers MCP tools behind a `ToolSearch` indirection, so without the `alwaysLoad` coax the agent never reaches Firegrid's `wait_for`/`spawn` tools (tf-b6n/A1, `acp/index.ts:194-199`).
- codex-acp **also defers MCP tools** (prior finding `project_codex_acp_defers_mcp_tools`: only `sleep` surfaced of 11) — but via a *different* mechanism, so the claude coax does not apply to it.

**Implication (now MEASURED — see gate below):** the most important divergence dimension for the §5.5 axis — *does Firegrid's choreography surface actually reach this adapter's LLM* — was the one un-run dependency of the small-rock verdict. The architect (RFC-owner session) elevated this to a **GATE** before the §4 `newSessionMeta`/MCP-surfacing contract is frozen. **Run and PASSED for both adapters** — see next section.

## GATE — MCP-surfacing reach (RUN 2026-05-31, architect-elevated)

**Method:** a real HTTP MCP server (`@modelcontextprotocol/sdk` StreamableHTTP) exposes a `schedule_me` tool with the **real protocol schema** (`{when:int≥0, prompt:string}`, `protocol/src/agent-tools/schema.ts:552`). It is surfaced through the **real codec MCP path** — `AcpSessionLive(bytes, { mcpServers:[{name:"firegrid", server:{type:"url",url}}], permissionPolicy:"allow" })` → `lowerMcpServerDeclaration` + (claude) `claudeAgentAcpMeta` alwaysLoad coax. Each adapter is prompted to call `schedule_me`; the server records `tools/list`/`tools/call`, and the codec's `ToolUse` observations are captured. Harness: `packages/tiny-firegrid/src/prototypes/mcp-reach-gate.ts`.

| adapter | tools/list seen | `schedule_me` called on server | args correct | codec `ToolUse` name | verdict |
|---|---|---|---|---|---|
| `claude-agent-acp@0.36.1` | ✅ | ✅ | ✅ `{when:9999999999999, prompt:"check the build"}` | `schedule_me` | **REACHED** |
| `codex-acp@0.0.44` | ✅ | ✅ | ✅ `{when:9999999999999, prompt:"check the build"}` | `mcp.firegrid.schedule_me` | **REACHED** |

**The §5.5 choreography surface reaches BOTH adapters' LLMs as a callable tool.** Two findings that tighten the registry design:

1. **The coax IS the one divergent field — confirmed by contrast.** claude needs the codec's `alwaysLoad` `_meta` (Claude SDK defers MCP behind ToolSearch); **codex needed nothing** — it surfaced the HTTP MCP tool natively via standard `session/new.mcpServers`. So `newSessionMeta` is genuinely the single per-dialect field: `claude → {disableBuiltInTools, claudeCode.options.mcpServers[*-alwaysload]}`, `codex → none`. This is the divergence concentrated in **one registry field**, now empirically demonstrated by a positive *and* a negative case — measurement gap, not architecture gap.
2. **One additional CONFIG-shaped nuance: MCP tool-name convention.** The codec's observed `ToolUse.name` diverges — claude emits the bare `schedule_me`; codex namespaces it `mcp.<server>.<tool>` (`mcp.firegrid.schedule_me`). Any Firegrid code that *correlates a ToolUse back to a known choreography tool by name* must normalize this per dialect (a registry name-prefix rule, or normalize in `canonicalAcpToolName`). Absorbable as CONFIG; flag so it isn't discovered late.

**Stale-finding correction:** memory `project_codex_acp_defers_mcp_tools` (2026-05-22: "codex-acp defers MCP → only `sleep` surfaced of 11") does **not** hold for `codex-acp@0.0.44` over an HTTP MCP server — it discovered and invoked the HTTP MCP tool directly. The earlier finding was a different version/transport; do not carry it forward as a codex MCP-reach blocker.

**Gate verdict: the small-rock thesis is discharged of its un-run dependency.** The divergence remains concentrated in the `newSessionMeta` field (+ a minor tool-name-normalization rule). The §4 registry investment is cleared to proceed.

## Reproduction

```bash
# wire probe (raw frames, both directions)
node /tmp/acp-probe.mjs claude-agent-acp     # needs ANTHROPIC_API_KEY
node /tmp/acp-probe.mjs codex-acp            # needs OPENAI_API_KEY

# real-codec turn harness (drives AcpSessionLive + LocalProcessSandboxProvider)
cd packages/tiny-firegrid
FIREGRID_SPIKE_ADAPTER=claude-agent-acp npx tsx src/prototypes/adapter-divergence-spike.ts
FIREGRID_SPIKE_ADAPTER=codex-acp        npx tsx src/prototypes/adapter-divergence-spike.ts

# MCP-surfacing-reach GATE (real HTTP MCP server + real codec MCP path)
FIREGRID_SPIKE_ADAPTER=claude-agent-acp npx tsx src/prototypes/mcp-reach-gate.ts
FIREGRID_SPIKE_ADAPTER=codex-acp        npx tsx src/prototypes/mcp-reach-gate.ts
```

`codex-acp@0.0.44` is installed in an isolated dir (`/tmp/acp-adapters`) because `npm install` rejects the monorepo `workspace:*` protocol; `claude-agent-acp@0.36.1` is already a `@firegrid/runtime` devDependency.

## Incidental finding (out of scope, worth a bead)

`production-flow-acp-live-scenario.ts` (the gated `FIREGRID_UKV_RUN_ACP_LIVE` scenario) resolves `@agentclientprotocol/claude-agent-acp/dist/acp-agent.js` as its real-binary spawn target. That file is a **library module** (exports `runAcp`/`claudeCliPath`); the package `bin` is `dist/index.js`. Spawning `acp-agent.js` exits 0 immediately with no ACP I/O — so the "real claude-agent-acp" toggle in that scenario has never actually driven the binary. The fix is a one-line path change to `dist/index.js` (verified working by this spike's harness). Not fixed here (out of scope; would touch shared sim code).
