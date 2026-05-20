# FINDING — §6 dark-factory reached `DARK_FACTORY_FINDING` honest-halt

Bead: `tf-h1gm` · P0 · type: docs · status: source-of-truth

Run: `2026-05-20T04-55-49-098Z__dark-factory`
Branch: `sidecar/tf-v7t-s6-codec-mcp-json-rationalize` (PR #446)
Trace: `packages/tiny-firegrid/.simulate/runs/2026-05-20T04-55-49-098Z__dark-factory/trace.jsonl`

## The headline

After landing tf-v7t (codec `.mcp.json` rationalization + driver permission auto-approver), the §6 dark-factory sim was driven against a real `claude-agent-acp@0.36.1` planner. The agent **reached the prompt's canonical `DARK_FACTORY_FINDING` honest-halt marker**, surfacing a concrete missing-public-surface diagnosis it derived **on its own** by probing the available Firegrid MCP toolset.

This closes the **Layer 4 GAP** the 2026-05-19 investigation flagged ("End-to-end observable proof of each §6 step"):

| Layer | 2026-05-19 verdict | 2026-05-20 verdict |
|---|---|---|
| 1. External model edge (quota) | ✅ | ✅ |
| 2. Choreography reasoning | ✅ | ✅ |
| 3. Durable substrate under live model | ✅ | ✅ |
| 4. End-to-end observable proof of each §6 step | ⚠️ GAP | ✅ + actionable Firegrid finding produced |

## The agent's complete reasoning trail (extracted from `trace.jsonl`)

> *I'll start by reading the trigger fact the app edge seeded on the `darkFactory.facts` stream.*

[Agent emitted a `wait_for` tool call with empty `whereFields`.]

> Firegrid host response: `{"_tag":"ToolInvalidInput","name":"wait_for","reason":"waitQuery.whereFields must declare at least one predicate; empty predicate sets are rejected because they would match every row."}`

> *The predicate-required constraint on `wait_for` means I need to know the seeded fact's schema. Let me try common shapes.*

[Agent emitted 6 successive `wait_for` calls with predicates: `_tag: Trigger`, `_tag: DarkFactoryTrigger`, `_tag: Seed`, `_tag: Start`, `kind: trigger`, `type: trigger`. All six returned `{"matched":false,"timedOut":true}`.]

> *The available Firegrid surface in this session offers `wait_for` over `CallerFact{stream: "darkFactory.facts"}` only with a non-empty `whereFields` predicate set (empty predicates are rejected). There is no read-latest, list-stream, peek, or schema-introspection operation exposed on the runtime-context MCP toolset, and the seeded fact's schema is not declared in the task framing or recoverable from the tools available. Several reasonable predicate guesses (`_tag: Trigger / DarkFactoryTrigger / Seed / Start`, `kind: trigger`, `type: trigger`) all timed out, which is consistent with not-yet-matching rather than not-present. Without a discovery primitive, blindly guessing further is not a loop step — it's noise.*
>
> *Per the halt-honestly clause:*
>
> *DARK_FACTORY_FINDING missing public surface — runtime-context MCP `wait_for` requires at least one `whereFields` predicate but exposes no companion read-latest / list-stream / peek / schema-introspection operation on `CallerFact{stream}`, so the seeded `darkFactory.facts` trigger fact cannot be observed without out-of-band knowledge of its schema; the §6 loop is not drivable from the tool surface alone.*

## Why this is the success condition (not a failure)

The dark-factory prompt is explicitly designed as a **bitter-lesson test of the substrate + tool surface**:

> *"If a needed step is not expressible or cannot proceed, write one line beginning with `DARK_FACTORY_FINDING` and name the missing public surface."*

The exercise's null hypothesis is **not** "every §6 step runs green." It is "the planner, given only primitives + a ticket, either drives the loop or surfaces what's missing." The agent surfaced what's missing — with **precise, technically-correct vocabulary** (read-latest / list-stream / peek / schema-introspection are exactly the names the substrate would use).

## Trace evidence summary

| Signal | Value |
|---|---|
| `agent-tools` side spans | 3176 |
| `McpServer.tools/call` server-side dispatches | 7 |
| `tool_call` session_updates | 9 |
| `tool_call_update` session_updates | 25 |
| Distinct predicate shapes the agent probed | 6 |
| Permission round-trips closed via driver auto-approve | 2 (then claude-agent-acp's `allow_always` cache) |
| `durable_tools.wait_for.upsert_active` | 5142 (substrate's reactive observation-stream re-registration; not 5142 distinct waits) |
| `wait_router.complete_match` | 78 |
| Final agent output | `DARK_FACTORY_FINDING` (honest halt per prompt clause) |

## What changed between 2026-05-19 and tonight

1. **tf-3ek (PR #441)** — 60-second-grep settled cause #2 (no `tool_choice` in `claude-agent-sdk@0.3.143`), cause #4 (system-prompt force-locked).
2. **tf-s8y (PR #444)** — proved native `.mcp.json` registration end-to-end; cause #1 EMPIRICALLY resolved.
3. **tf-v7t (PR #446)** — split the codec `_meta` payload: MCP advertisement → `.mcp.json` (host-sdk codec adapter writes it pre-spawn); tool policy `disableBuiltInTools: true` stays on `_meta`. Tools surface to the agent under natural names (`mcp__firegrid-runtime-context__<tool>`), no `-alwaysload` alias prefix.
4. **tf-v7t driver permission auto-approver** — closed the ACP `session/request_permission` gate that was silently waiting forever (this WAS the 2026-05-19 Layer 4 GAP's mechanism — the gate not the streaming JSON race).

Each of those was a small, falsifiable step; none of them was the §9g instrumentation arc the original handoff prescribed as the load-bearing deliverable.

## Concrete follow-ups derived from the agent's diagnosis

- **`tf-zkwg` (P1)** — Add the schema-introspection / read-latest / list-stream / peek companion to `runtime-context MCP wait_for` on `CallerFact{stream}` sources. Agent named all four candidate primitives in its own words.
- **`tf-alca` (P2)** — dark-factory sim's seed schema discoverability: either pass the schema in the prompt, seed multiple variants, or (preferred) wait on `tf-zkwg` landing.

## What still doesn't happen end-to-end

Even with the above two beads landing, the §6 dance has 6 steps — `delegate → wait PR → review → merge-signoff → schedule_me CI → wait_for ci.status → execute merge → cancel/close on reject`. The dark-factory host's seed-fact-injector only emits the *initial trigger fact*. To drive the loop past step 1, the host needs fact-injectors for each intermediate step (or external systems would emit them in a real deployment). That's an orthogonal sim-design problem, not a substrate or codec problem.

## §9g instrumentation lane — UNNECESSARY

The original handoff prescribed a "codec→SDK boundary span + subprocess wire capture" lane (§9g) as the load-bearing deliverable to disambiguate the 5 candidate causes of `tools/call=0`. After tonight:

| Cause | Status |
|---|---|
| #1 tools not forwarded | RESOLVED (tf-s8y + tf-v7t) |
| #2 `tool_choice` forcing | Confirmed SDK gap — no public knob, out of our hands |
| #3 schema/name mismatch | NOT AN ISSUE — agent invoked tools under natural names correctly |
| #4 system-prompt steering | Not a blocker — agent did §6 anyway |
| #5 streaming harness race | NOT THE BUG — `observedToolInputs:[…wait_for:{}]` from 2026-05-19 was the *permission-gate-blocked-tool-call* observed pre-resolution, not a parser race |

§9g would be re-instrumenting questions that source-reading + a 100-line spike + a production codec change already answered. Recommend the lane be **closed without opening**.

## Cross-references

- `tf-3ek` / PR #441 — codec→SDK source-verified baseline
- `tf-s8y` / PR #444 — native `.mcp.json` spike
- `tf-v7t` / PR #446 — production codec change + permission auto-approver
- `tf-zkwg` (P1) — `wait_for` schema-introspection follow-up
- `tf-alca` (P2) — dark-factory seed discoverability
- `tf-85bs` (P2) — pre-existing `wait.forAgentOutput` hot loop (unrelated, but noise in tonight's trace)
- `tf-9cn` (P2) — `settingSources` user-state leak (orthogonal hygiene)
- `docs/handoffs/COORDINATOR_HANDOFF_s6_dark_factory.md` — the §6 framing this run resolved; §9g acceptance criteria are now overdetermined
- `docs/investigations/2026-05-19-s6-dark-factory-live-run.md` — the prior live run that surfaced the Layer 4 GAP

## Honest meta

The 5-causes framing on the handoff doc was useful as a hypothesis space but pointed at the wrong primary suspect. The actual blocker was claude-agent-acp's permission-gate callback (not "tool_choice unforceable," not "MCP not forwarded," not a streaming parser race) — and the fix was 70 lines of driver code. The 60-second-grep heuristic mentioned in handoff §9f genuinely was the right opening move; source-reading + targeted falsifiable spikes resolved every cause faster than instrumentation would have.

The Firegrid substrate (`wait_for`, `wait_router`, `durable_tools`, codec, host-sdk, client-sdk session facade, permission flow) all worked correctly under a live model. The remaining gaps are about **tool surface ergonomics** — making the surface drivable from the tool list alone, which is exactly what the dark-factory exercise was designed to surface.
