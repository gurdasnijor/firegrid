# FINDING — codec→SDK source-verified baseline

Bead: `tf-3ek` · P1 · type: docs · context: §9g instrumentation lane prep · status: source-verified, decision-grade for the SDK-boundary causes

This is a **stake-in-the-ground baseline** for the codec→Claude Agent SDK
instrumentation work referenced in §9g of
[`docs/handoffs/COORDINATOR_HANDOFF_s6_dark_factory.md`](../handoffs/COORDINATOR_HANDOFF_s6_dark_factory.md).
It captures what the 60-second-grep heuristic establishes about the
`tools/list ×N, tools/call=0` symptom *without* new instrumentation, so the
instrumentation lane starts with a narrower search space.

Sources are the **exact pinned versions** from the npx cache:
- `@agentclientprotocol/claude-agent-acp@0.36.1`
- `@anthropic-ai/claude-agent-sdk@0.3.143` (transitive dep of the above)

## TL;DR

Of the five candidate causes for `tools/call=0` enumerated in
[`COORDINATOR_HANDOFF_s6_dark_factory.md` §1](../handoffs/COORDINATOR_HANDOFF_s6_dark_factory.md):

| Cause | Verdict | Mechanism |
|---|---|---|
| **#1** claude-agent-acp loaded MCP but didn't forward tools to the model | **RULED OUT (structural)** | `acp-agent.js:1438` merges our `_meta.claudeCode.options.mcpServers` payload with `request.mcpServers`; both reach the SDK. `sdk.d.ts:957` confirms `alwaysLoad:true` does what the codec assumes — tools always in the prompt, never deferred behind tool search. |
| **#2** `tool_choice` defaulted to `auto` → model chose prose | **CONFIRMED as a real SDK gap** | `rg 'tool_choice\|toolChoice' sdk.d.ts` = **0 hits**. The SDK does not expose `tool_choice` in its public typed surface. tf-549's conclusion re-confirmed against this exact pin. |
| **#3** tool schema/name mismatch | **NOT INVESTIGATED here** — needs the instrumentation lane's wire capture |
| **#4** claude-agent-acp's system-prompt steering toward prose/explore | **STRUCTURALLY LOCKED** | `acp-agent.js:1371-1387`: default = `{type:"preset", preset:"claude_code"}`. Custom `_meta.systemPrompt` allows forwarding `append`/`excludeDynamicSections` only; `type:"preset"` and `preset:"claude_code"` are force-set on the merged object. No override path through ACP `_meta`. |
| **#5** tool-result round-trip break / streaming parse race | **PARTIALLY EVIDENCED — different mechanism than handoff framing** | The 2026-05-19 live run (see below) captured `observedToolInputs:['…wait_for:{}']` — the planner *did* call `wait_for`, but the assertion harness raced streaming JSON tool_use blocks and observed empty args. That is a **measurement gap in tiny-firegrid's harness**, not "model didn't invoke tools." |

**Net (ACP-mediated path): cause #4 is off-the-table by source; #2 is real-and-fixed-at-SDK-API-level (no public knob); #3 requires wire capture; #5 reconciles partly to a harness streaming-parse race rather than a model behavior. Cause #1 is "ruled out for the path we use today" — the native `.mcp.json` / stdio MCP path is a different mechanism through it and is being tested by spike tf-s8y.**

## What the codec actually sends (source: `packages/runtime/src/agent-event-pipeline/codecs/acp/index.ts:148-194`)

```jsonc
// ACP NewSessionRequest fields (standard)
{
  "mcpServers": [{ "name": "firegrid", "type": "http", "url": "...", "headers": [...] }],
  "_meta": {
    // additive payload — claude-agent-acp reads it; other ACP agents ignore it
    "disableBuiltInTools": true,
    "claudeCode": {
      "options": {
        "mcpServers": {
          // NON-colliding alias — bypasses the acpDerived merge override
          "firegrid-alwaysload": {
            "type": "http",
            "url": "...",
            "alwaysLoad": true
          }
        }
      }
    }
  }
}
```

The non-colliding `-alwaysload` alias is the key correctness move: at
`acp-agent.js:1438` the spread `{ ...userProvidedOptions?.mcpServers, ...mcpServers }`
makes `acpDerived` win on name-collision (acpDerived comes second). By using a
different key (`firegrid-alwaysload`), our `_meta` entry survives the merge —
both servers reach the SDK. **Verified by reading acp-agent.js:1346-1438.**

The merged `mcpServers` then flows into the Claude Agent SDK options at
line 1438:

```js
mcpServers: { ...(userProvidedOptions?.mcpServers || {}), ...mcpServers },
```

Both server registrations point to the same Firegrid runtime-context URL.
The SDK loads tools from both — the `-alwaysload`-prefixed copy bypasses
tool-search (per `sdk.d.ts:957`), the non-prefixed copy is the standard
ACP-derived path.

## What the SDK exposes (source: `@anthropic-ai/claude-agent-sdk@0.3.143/sdk.d.ts`)

Verified knobs that exist:
- `mcpServers?: Record<string, McpServerConfig>` (`sdk.d.ts:1498`)
- `McpHttpServerConfig.alwaysLoad?: boolean` with the documented semantics (`sdk.d.ts:951-961`)
- `allowedTools`, `disallowedTools`, `toolAliases`
- `permissionMode` (`default`/`acceptEdits`/`bypassPermissions`/`plan`/`dontAsk`/`auto`)
- `tools` — either an array of built-in tool names or `{type:"preset", preset:"claude_code"}`

Verified absent:
- `tool_choice`, `toolChoice`, `forcedTool`, `mustUseTool`, `required` — `rg` across `sdk.d.ts` returns **0 hits**. The SDK does not provide a Messages-API-style `tool_choice` forcing knob.

## Where the §9g instrumentation lane should focus

Given the above, the instrumentation work should:

1. **NOT spend effort on causes #1 or #4** — they're settled by source. The
   wire/span capture is unlikely to produce new information about them.

2. **Focus the codec→SDK boundary spans on cause #3 (tool schema/name
   mismatch).** Capture the exact tool definitions claude-agent-acp builds
   from the merged `mcpServers` dict and forwards into the SDK's
   `query(...)` call. Specifically: tool `name`, `description`, JSON schema
   shape, and any `_meta` annotations. Compare against the Firegrid MCP
   server's actual advertisement.

3. **Capture the subprocess wire to characterize cause #5 the right way.**
   The 2026-05-19 investigation showed the planner *did* call `wait_for`
   with empty observed args. The instrumentation should capture:
   - The raw streaming tool_use blocks (deltas) emitted by the model
   - The `session/update` messages claude-agent-acp pushes back over ACP
   - How tiny-firegrid's harness aggregates streaming blocks into final
     `observedToolInputs`

   The expected outcome is *not* "the model didn't call tools" but rather
   "the model called tools and the harness raced the stream." That
   re-frames the §6 gap from a substrate/codec/SDK issue into a
   measurement issue at the assertion harness — a more tractable fix.

4. **Distinguish "what the SDK passes to the Anthropic API" from "what
   ACP+SDK expose to us."** The SDK wraps the model loop. Even if the
   Anthropic API supports `tool_choice:required`, this SDK does not
   forward our intent there. The wire capture at the SDK↔Anthropic-API
   layer (if reachable; the SDK is closed-loop) is the only place that
   question resolves empirically.

## The non-ACP planner control is still legitimate (per §1 of the handoff)

A direct Messages-API loop with `tool_choice:"required"` over the same
Firegrid MCP catalog confirms/refutes cause #2 cleanly — it isolates one
variable. **But it is not "the path to finish":** the SDK gap (no public
`tool_choice`) is real, the workaround means stepping outside the SDK
entirely. Any green demo built on this path is the orchestration-shortcut
the handoff warns against.

The honest deliverable remains: a source-verified FINDING. This file is
one stake; the instrumentation lane's FINDING will be another.

## Cross-references

- `tf-s8y` (P0 SPIKE) — drives §6 via native `.mcp.json` / stdio MCP
  registration to test the alternative path through cause #1. Either
  outcome narrows scope: green ⇒ cause #1 localized to ACP `_meta`
  plumbing; red ⇒ MCP-path eliminated as variable, §9g scope narrows.
- `tf-549` — TERMINAL FINDING that established "no ACP path exposes
  forced tool-choice" — re-confirmed against pin 0.36.1 / SDK 0.3.143.
- `tf-p9s` — A1 finding on the `alwaysLoad` strategy; confirmed structurally
  correct here against the SDK contract.
- `tf-0ro` — ToolSearch stall finding; the `disableBuiltInTools: true` +
  `alwaysLoad: true` combo is the codec's response to it.
- `tf-hmo` — codec premise structural-correctness check (referenced in
  memory `project_s6_codec_sdk_boundary_verified`).
- `docs/investigations/2026-05-19-s6-dark-factory-live-run.md` — the live
  run that surfaced the `observedToolInputs:['…wait_for:{}']` measurement
  gap.

## What this file is NOT

- Not a replacement for the §9g codec→SDK instrumentation. The wire
  capture is independently load-bearing for cause #3 and #5 resolution.
- Not a substrate critique — the substrate (`wait_for ×1470`,
  `wait_router ×968`, `deferred.result ×3050` per the 2026-05-19 run) is
  proven.
- Not a "demo is green" claim. The §6 demo's `tools/call` accounting is
  still gapped; this file narrows where to look.
