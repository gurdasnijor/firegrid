# Coordinator Handoff — §6 Dark-Factory (§6 LIVE)

> Read this top to bottom before doing anything. The previous coordinator
> over-declared victory; the autonomous factory **does not run yet**. Your job
> is to finish it. The substrate is done; the agent-invocation path is not.
>
> **2026-05-20 update:** superseded by §10 arc closure. The historical record
> below is intentionally preserved; where it says "not done" or frames §9g as
> load-bearing, read it as pre-closure context unless the newer sections say
> otherwise.

---

## ★ THE META-PROCESS RULE (governs everything below)

> **Do not make assumptions in the absence of data. When you don't know:
> (1) locate exactly where the data gap is, (2) instrument/trace that
> boundary, (3) run a simulation to GATHER that data, (4) only then
> conclude — from the data.**

Inference is a *hypothesis to be instrumented*, never a conclusion to act on.
"It probably works this way / it's an ACP limitation / accept the demo" are
all assumptions; each one in this arc was made where the instrumentation to
settle it was *available and not done*. This is the entire reason
`firelab` exists: generate trace data to drive an experiment. Every
failure here (the §6 over-declaration; "no ACP path forces tool-choice,
terminal"; the codec's claude-agent-acp merge behavior asserted as fact in
comments; "accept the substrate-complete demo") was the same violation:
**a data gap filled with an assumption instead of a trace.**

When you catch yourself (or a lane) writing "this is because…", "X can't…",
"it's terminal", or a code comment asserting third-party behavior — STOP.
Name the data gap. Instrument it. Run the sim. Then write the conclusion with
the artifact that proves it. A confident conclusion with no captured evidence
is the bug, not the finding.

---

## 0. STATUS: §6 LIVE — arc closed 2026-05-20

**Superseded by §10 arc closure — see 2026-05-20.** The factory ran live
against real `@agentclientprotocol/claude-agent-acp@0.36.1` planner traffic in
PR #446 (`tf-v7t`, PR head `36fbc8d2`). OA's live verification observed 3,176
`agent-tools` side spans, 7 server-side `McpServer.tools/call` executions, and
149 durable waits registered and matched (`wait_for.upsert_active` / `wait_for.match`).
The 4-minute run stopped because dark-factory only seeded the initial trigger
fact; subsequent step-fact seeders are tracked separately by `tf-t2a5`.

Historical pre-closure record follows:

**The north star (factory-vision §6) had never executed live.** Every live
dark-factory run produced `s6FullLoopProven=false`, **0/6 required steps**. A
real planner agent had *never once* driven the ticket→clarify→plan→
human-approval→delegate→review→revision→merge-signoff→durable-CI-watch→merge→
clean-unwind loop through Firegrid tools.

What *is* real and proven:
- The **Firegrid substrate** for every §6 capability (in isolation, source-verified).
- An **honest, falsifiable proof harness** that reports 0/6 truthfully and was never papered.
- The human-permission gate ran end-to-end with a real agent **once**, in a
  *narrow gated-op sim* (#423) — proof the substrate works when an agent
  actually invokes; the full §6 planner never does.

What is **NOT** done — the actual goal:
- A live §6 run where the planner issues real Firegrid `tools/call` and the
  loop advances. **This is the deliverable. It is unfinished.**

### The symptom (fact) vs the conclusion (UNPROVEN — see §0a)

**Symptom (observed fact, not disputed):** given the Firegrid toolset + a
tool-first prompt, **both** `@agentclientprotocol/claude-agent-acp` and
`codex-acp`: (1) discover the toolset (`tools/list ×16`), (2) narrate the
correct §6 plan in prose, (3) emit **zero `tools/call`** and stop.

The earlier findings (`tf-7dq`/#395 ruled out quota; `tf-pcg`/#414 ruled out
exploration-distraction; `tf-9q4`/#420 cross-runtime; `tf-549`/#422 + `tf-xyo`/
#424 framed as "native/shim terminal") concluded **"forced tool-invocation is
unreachable through the ACP protocol layer — an ACP-architecture limitation,
not Firegrid."**

> ⚠️ **That conclusion is NOT safe. Treat it as UNPROVEN.** It was reasoned
> from the ACP *protocol surface*, never verified against claude-agent-acp's
> *source*, and — critically — it sits on top of an unverified, heavy
> transformation in our **own** ACP codec that was never instrumented or
> eliminated as the confound. The codec is the **prime suspect**, not ACP.
> **Read §0a before acting on anything in this section.** "Substrate is sound"
> remains true (substrate proven in isolation, §2); "the gap is a terminal ACP
> limitation" does **not**.

### Why "accept the demo" was not "done"

The previous coordinator asked the PO to choose, and the PO picked "accept the
substrate-complete demo." That makes the *artifact* defensible, but it does
**not** make the factory run. The PO has since said: *do not declare victory;
finish it.* So:

> **The factory is finished only when a real planner agent drives §6
> end-to-end and the #401 harness reports the required steps `proven:true`
> (honestly, not by loosening the matcher).**

---

## 0a. THE PRIME SUSPECT — our own ACP codec transformation (read this)

File: `packages/runtime/src/agent-event-pipeline/codecs/acp/index.ts`.

In a **single `connection.newSession(...)`** the codec advertises the *same*
Firegrid MCP endpoint to claude-agent-acp **twice, under two different names,
via two different mechanisms**:

1. `mcpServers: (options.mcpServers ?? []).map(lowerMcpServerDeclaration)`
   (line ~485) — the server under its **real name**, **no `alwaysLoad`**.
2. `_meta: claudeAgentAcpAlwaysLoadMeta(...)` (lines ~166–194, ~491–494) —
   the **same URL aliased to `<name>-alwaysload`**, **with `alwaysLoad:true`**,
   plus `disableBuiltInTools:true`, under `_meta.claudeCode.options.mcpServers`.

This "A1 fix" (`tf-b6n`/#411, framed off `tf-p9s`/#408) is the demo-deadline
work. Its own comment (lines ~148–165) states claude-agent-acp's internal
merge/precedence/`alwaysLoad` behavior **as fact** — and that was never
checked against the package at all.

### UPDATE — source-verified against `@agentclientprotocol/claude-agent-acp@0.36.1` (the exact pinned version, npx cache)

I read `dist/acp-agent.js` of the pinned version. The codec's premises split:

**CONFIRMED correct (acp-agent.js):**
- The merge precedence the codec assumes — `acp-agent.js:1438`:
  `mcpServers: { ...(userProvidedOptions?.mcpServers || {}), ...mcpServers }`.
  ACP-derived spreads last, **wins on name collision**. So the codec's trick
  of using a non-colliding `<name>-alwaysload` key in `_meta.claudeCode.options`
  *does* survive the merge.
- `disableBuiltInTools: true` is honored — `acp-agent.js:1402–1406`:
  `tools = userProvidedOptions?.tools ?? (_meta?.disableBuiltInTools === true
  ? [] : { type: "preset", preset: "claude_code" })`. Empties built-ins as
  the codec claims.

**NOT IN THE PACKAGE AT ALL (the load-bearing premise):**
- **`alwaysLoad`** — zero occurrences across all of
  `claude-agent-acp@0.36.1/dist/`. claude-agent-acp does **not** read or act
  on it. It forwards the per-server config (whatever keys, including
  `alwaysLoad`) untouched into the Claude Agent SDK via the merged `options`
  passed to `session.query`.
- **`ToolSearch` / `tool_search` / tool-deferral** — zero occurrences.
  claude-agent-acp does not defer MCP tools behind any "ToolSearch."

**What that means:** the entire A1 model — *"claude-agent-acp defers MCP
tools behind ToolSearch; `alwaysLoad:true` un-defers them"* — is about
behavior **that does not exist in claude-agent-acp**. Both `alwaysLoad` and
tool-deferral are (at most) properties of the **deeper `@anthropic-ai`
Claude Agent SDK / `claude_code`** package, which **was never read**. The
"terminal ACP" conclusion is therefore an assertion about a package nobody
opened.

The two confirmed levers (merge + `disableBuiltInTools`) **do not address
tool deferral at all** — they just change what's in the `tools` array and
which mcpServers entry wins by name. So the A1 fix at the claude-agent-acp
layer is, with high confidence, **inert with respect to its stated goal**:
the `alwaysLoad` key it sets is forwarded down to the SDK, and whether *the
SDK* honors it is open. Every "terminal" run may have been default behavior
with an A1 payload that did nothing measurable — and we never instrumented
that it did nothing.

### What the next agent must do (in order — corrected)
1. **Strip the codec to the minimum.** Advertise the Firegrid MCP server
   **once, plainly, under its real name** (just `lowerMcpServerDeclaration`).
   Delete the `<name>-alwaysload` alias + the `_meta` spread + the
   `claudeAgentAcpAlwaysLoadMeta` helper. The merge-collision rationale they
   exist for is moot once you advertise once.
2. **Open the right package this time —
   `@anthropic-ai/claude-agent-sdk`** (or whichever `claude_code` package
   claude-agent-acp's `session.query` invokes — find it at
   `/Users/gnijor/.npm/_npx/902b360216d9b9cc/node_modules/` and trace from
   acp-agent.js:1438 onward). Specifically: `grep alwaysLoad` and
   `grep -i 'tool[_-]search\|deferred'`. Does the SDK honor `alwaysLoad` on
   an HTTP MCP server config? Where (if anywhere) does it defer MCP tools
   from the model turn? **This is the file nobody opened.** Until it's
   opened, every "ACP can't" / "terminal" claim is unfounded.
3. **Instrument the real boundary.** Add OTEL/tracing that captures the
   *resolved tool catalog + exact tool names + `tool_choice` + system prompt*
   claude-agent-acp sends the model, and the model response — on the **real
   production path** (`simulate:run -- dark-factory-pipeline`, NOT the
   fake-connection codec test, see §7). Distinguish the causes with **data**.
4. Only then is anything sayable about ACP capability. The honest deliverable
   is a **source-verified** finding explaining the 0/6 — most likely a
   fixable Firegrid-codec / MCP-advertisement-shape bug.

This is the **third instance of the same root failure** (see §8): a confident
conclusion asserted on top of unverified inference, with the instrumentation
that would settle it sitting in the very file being edited.

---

## 0c. THE PERMISSION-GATE REVELATION — the actual Layer-4 GAP

The 2026-05-19 "Layer 4 GAP" was not a missing Firegrid wait primitive and not
a terminal ACP inability to call tools. It was the policy boundary:
`claude-agent-acp@0.36.1` gates every MCP tool invocation through its
`canUseTool` callback and ACP `session/request_permission`.

Source-verified path:

- `@agentclientprotocol/claude-agent-acp@0.36.1/dist/acp-agent.js:1008-1118`
  defines `canUseTool(sessionId)` and calls `this.client.requestPermission(...)`
  for normal tool use.
- `acp-agent.js:1393` passes `canUseTool: this.canUseTool(sessionId)` into the
  Claude Agent SDK query options.
- Firegrid's ACP codec forwards that request as a `PermissionRequest`
  observation and waits for a driver decision
  (`packages/runtime/src/agent-event-pipeline/codecs/acp/index.ts:480-493`).

That makes the **driver** the policy authority. Dark-factory's driver had no
permission handler, so the planner did invoke the Firegrid MCP tool but then
waited indefinitely for permission. PR #446 (`tf-v7t`, open PR head
`36fbc8d2`) adds the missing loop: fork `session.wait.forPermissionRequest`,
thread `afterSequence`, and call `session.permissions.respond({ decision:
{ _tag: "Allow" } })` before the agent starts. In that closed-harness sim, the
permission policy is intentionally "allow Firegrid MCP tools" because the sim's
purpose is to prove the §6 workflow path, not human authorization UX.

This is the permission-gate revelation captured separately in
`docs/research/tf-eup2-permission-gate-revelation.FINDING.md`.

---

## 1. The path to actually finish it — INSTRUMENT, do not route around

> **Correction (the previous draft of this section was wrong in spirit).**
> The earlier version said "build a non-ACP planner to get a live §6." That is
> the orchestration-shortcut mindset this entire exercise exists to reject.
> The goal is **not** a green demo — it is to *drive out the real issue and
> capture the data to address it*. The "ACP cannot force tool-choice"
> conclusion was reached by **reading the ACP protocol surface (inference)**,
> not by instrumenting the actual decision point. That is the unfinished work.

### The real unfinished task: open the **Claude Agent SDK** (one layer deeper than the codec)

We observed only the **symptom at our side of the boundary**: the codec
(`packages/runtime/src/agent-event-pipeline/codecs/acp/index.ts`) instruments
*what we send* (`firegrid.acp.mcp_server_count`, `mcp_server_names`, the
`newSession({ mcpServers, _meta:{ disableBuiltInTools, claudeCode:{options:
{mcpServers}} } })` lowering — ~13 spans) and we saw `tools/call`=0 come back.
We instrumented **nothing about what claude-agent-acp does with it**, and the
codec test uses a *fake connection* that never drives the real model-turn path.

`tools/list ×16 but tools/call=0` is **under-determined**. It conflates ≥5
distinct causes we never instrumented apart:
1. claude-agent-acp loaded the MCP server but **did not forward its tools into
   the model request** (governed around `claude-agent-acp` `src/acp-agent.ts`
   ~L1488 — where the model turn / tools / `tool_choice` are constructed).
2. tools offered but `tool_choice` defaulted to `auto` → model chose prose.
3. tool schema/name mismatch → model doesn't treat them as callable.
4. claude-agent-acp's own injected system prompt steering toward prose/explore.
5. tool-result round-trip format break → agent abandons after one attempt.

We asserted #2 as "architectural / terminal" without measuring it. **Get the
data:**
- Read the actual `claude-agent-acp` source at/around `src/acp-agent.ts`
  ~L1488 (model-turn construction): does it include MCP tools in the Anthropic
  request? under what condition? what `tool_choice`? what system prompt? Vendor
  it if needed (`repos/`-style) so it is inspectable and traceable.
- Add OTEL/tracing **at the decision point**, not just our side: capture the
  exact model request claude-agent-acp builds (tool list, tool_choice, system
  prompt) and the model response. Drive the **real production code path**
  (a real `simulate:run -- dark-factory-pipeline`, not the fake-connection
  test) and capture this granular data into the trace artifact so the proof
  matrix's "0/6" is explained *with evidence*, not inference.
- Distinguish causes #1–#5 with that data. The outcome is a precise,
  source-verified FINDING (which may well be a Firegrid-codec or
  MCP-tool-advertisement-shape issue that *is* fixable — #1/#3 are not
  immutable ACP limits). Capturing and characterizing that **is the
  deliverable**, per the spirit of the exercise.

### The non-ACP planner is a CONTROL, not the goal

A direct model-API loop with `tool_choice:required` over the same Firegrid
tools is legitimate **only as a control experiment to isolate one variable**
(does the model invoke when tools are demonstrably in the request with forced
choice?) — it confirms/refutes cause #2 vs #1/#3/#4. It is **not** "the path
to finish" and must never be used to manufacture a green demo while leaving the
real ACP-path issue uncharacterized. If you build it, build it to *generate
the contrasting data*, then return to fixing/characterizing the real path.

Reusable assets in `main` to build on (not to route around with): the
constraint levers (`tf-9q4`/#420), `DARK_FACTORY_PLANNER_AGENT` switch (#414),
the ACP-force-tool shim (`src/bin/acp-force-tool-shim.mjs`, #424 — it proved a
*protocol-layer* shim can't force model tool-choice; that is itself a data
point, not a dead end for instrumentation).

Once a planner advances steps: run `pnpm --filter @firegrid/firelab
demo:s6` and the harness will objectively report which §6 steps are now
`proven:true`. That — not a doc — is "done".

---

## 2. Substrate inventory — DONE, do not redo

Every item below is merged to `main` and source-verified. Do not re-investigate
these; build on them.

| Capability (factory-vision §7) | Evidence | State |
|---|---|---|
| Caller-owned durable fact waits (`wait_for` CallerFact) | #383 | DONE |
| `execute` provider side-effects | #388 + real-agent pass #413 | DONE |
| Durable identity + restart survival | #381, #397 | DONE |
| Clean-unwind / Gap-3 (`session_cancel/close`) | #393→#396→#404→#417 (root cause: serial-reconciler starvation; fixed #417) | DONE |
| Observability (queryable rows; tool-arg/error propagation) | #400, #403 | DONE |
| Codec emits **canonical** MCP tool names (not ACP titles) | #419 | DONE |
| Idempotent one-intent→one-participant | #391 | DONE |
| Delegation parent↔child | #392 | DONE |
| Falsifiable §6 proof harness (`sectionSixProof`) | #401 | DONE — DO NOT weaken |
| `simulate:proof` readout | #402 | DONE |
| `pnpm demo:s6` one-command turnkey | #409 | DONE |
| §5 minimal-slice factory-ready capstone | #418 | DONE |
| Auto-discovery sim registry (killed the fan-out merge-conflict class) | #385 | DONE — add a sim = add a file; never hand-edit a registry array |
| `DARK_FACTORY_PLANNER_AGENT` switch (claude-acp default / codex-acp) | #414 | DONE |
| ACP force-tool shim (opt-in `DARK_FACTORY_FORCE_TOOL_SHIM=1`) | #424 | DONE (proven insufficient — kept as negative-evidence tooling) |

Investigation/finding docs: `docs/investigations/2026-05-19-s6-dark-factory-live-run.md`
(§7 "Definitive conclusion"), and `docs/research/tf-*.md` /
`packages/firelab/docs/findings/tf-*.md`.

The sim lives at
`packages/firelab/src/simulations/dark-factory-pipeline.ts`. Run a sim:
`pnpm --filter @firegrid/firelab simulate:run -- <id>`; inspect with
`simulate:show` / `simulate:proof` / `simulate:duckdb`. Trace artifacts land
under `packages/firelab/.simulate/runs/<id>/` (gitignored).

The Anthropic key is persisted at `~/.firegrid-anthropic-key` and exported in
`~/.zshenv` (all zsh incl. subprocesses). Verify quota with a direct
`curl https://api.anthropic.com/v1/messages` probe before blaming quota —
**verify ground-truth, never infer** (a quota false-alarm was caught this way).

---

## 3. Operational tooling & delegation protocol

You are a coordinator. You do **not** write feature code in the primary
checkout. You dispatch lanes, review their PRs against a hard bar, and merge.

### 3a. Lanes & messaging — `scripts/cmux-dispatch.sh`

Engineer lanes are cmux panes with stable labels: `oca1 oca2 oca3 cca1 cca2`
and `Tooling Agent`. Surface numbers renumber; **always address by label**.

```
bash scripts/cmux-dispatch.sh <lane-label> '<message>'
bash scripts/cmux-dispatch.sh <bead-id>   '<message>'   # resolves bead→assignee
```
- It sends the body, presses Enter, and **verifies the agent is running**
  (retries Enter ×5, fails LOUD if not). A "✓ dispatched & SUBMITTED" line
  means it took.
- **Single-quote the whole message. NEVER use backticks or `$(...)`** — zsh
  substitutes them and corrupts correctness-critical dispatches. Reference
  scripts/paths in plain prose.
- Default workspace is `workspace:2` (override `--workspace`).

### 3b. See lane state — `scripts/lane-sweep.sh`

```
bash scripts/lane-sweep.sh --json --workspace workspace:2 --lines 12
```
Heuristic-free: per lane it prints `running` (literal "esc to interrupt"
indicator), the agent's own status line, in-progress beads joined by assignee,
and PR/CI state for `pr-<n>`-labelled beads. `mergeable` is
eventually-consistent (often `UNKNOWN`) — never interpret it as a verdict;
check CI rollup explicitly. STATE-CHANGE pings (lane idle / signoff) are often
**stale-by-arrival** — verify with a sweep before re-dispatching; do not churn.

### 3c. Worktree lifecycle — `task-enter.sh` / `task-exit.sh`

Lanes (and you, for coordinator artifacts) work in **dedicated worktrees off
`origin/main`**, NEVER the shared primary checkout (other agents drive it;
`checkout -b` there does not stick).

Every dispatch MUST carry a coordinator-created bead id and the literal
task-enter line. A dispatch without a bead is dead-on-arrival.

```
br create "<title>" -t task -p P0..P4 -l <labels> --silent      # → prints bead id
bash scripts/task-enter.sh <bead> <slug> --class sidecar         # fresh worktree off origin/main
#   --resume  attaches an EXISTING branch (preserves commits; never forks off main)
BEADS_DIR=<repo>/.beads br update <bead> --assignee <lane> --add-label pr-<n>
# …lane works & commits IN THE WORKTREE…
bash scripts/task-exit.sh <bead>          # flush beads, commit, push, open/refresh DRAFT PR, self-heal CI trigger
#   --decision <url>  marks the bead signoff:pending for the structured decision loop
```
- `task-exit.sh` PUSHES + opens a **draft PR** (that draft PR *is* the gate)
  and force-with-lease-recovers a clean post-rebase push (never blind force;
  hard-stops on real divergence). It refuses to run in the primary.
- **Standing dispatch wording (bake into every dispatch):** *"When done:
  commit in the worktree, then `bash scripts/task-exit.sh <bead>` — it PUSHES
  + opens a DRAFT PR (that IS the gate). 'No self-merge' = do NOT run the
  merge; it does NOT mean don't push/PR. Do not stop at a local commit."*
  Lanes have repeatedly stranded work by misreading "no self-merge" as "don't
  push".
- `task-reap.sh [branch]` cleans merged worktrees (never discards
  dirty/unmerged — surfaces it).

### 3d. Beads (`br`) — status authority

`.beads/issues.jsonl` is the SoT for task status. The coordinator creates
beads (`br create … --silent`) and owns status mutations; **the cron owns
beads-sync** (durable push) — never hand-push `issues.jsonl`, never re-run the
import. Read with `bv --robot-triage` / `--robot-insights`; **never bare `bv`**
(blocking TUI). Join key for firelab: label `tfind:NNN` historically;
今 use the bead id directly.

**Structured decision loop** (how lanes escalate a call to you): a lane
finishes with `task-exit.sh --decision <pr-url>` → bead gets
`signoff:pending` + external_ref. You review; your verdict is
`br close <bead> --reason "DECIDED: …"` (auto-unblocks dependents). You are a
read-only router for the decision itself — bounce malformed ones; capture the
verdict in the bead/PR, not chat.

---

## 4. Working discipline (do not regress these)

- **Choreography, not orchestration** (factory-vision §2/§4 — the load-bearing
  philosophy). The factory is NOT a coded workflow/DAG. The planner (a real
  tool-use agent) is given a *small set of durable primitives* — `wait_for`,
  `session_new`, `session_prompt`, `schedule_me`, `execute`, `sleep`,
  `session_cancel`, `session_close` — and decides *what next* moment-to-moment
  from what it sees. Any app-authored phase chain is the anti-pattern. Firegrid
  ships primitives + substrate, never a `createFactory()` workflow. **The
  non-ACP planner you build must preserve this** — force *invocation*, never
  the *sequence*.
- **No CI-determinism on choreography probes.** A real §6 run needs a real
  tool-use LLM agent + env-gated `.smoke` + a hard halt rule. A deterministic
  stub forces the orchestration anti-pattern and produces false greens. Keyed
  sims must env-gate cleanly in keyless CI (#412) WITHOUT weakening the
  real-key assertion.
- **Findings are deliverables; never paper.** A red sim that honestly surfaces
  a gap (HARD HALT + precise FINDING) is a valid, valuable result. Do not
  loosen a matcher, stub a result, or bump a baseline to manufacture green.
- **Anti-smoketest review bar.** Before merging: does the assertion observe
  real durable state? Would it fail if the behavior were wrong? Are negative
  controls present? Is divergence surfaced as a finding, not papered? A
  substrate change bundled with an unresolved bug does **not** drain-merge —
  split it (the FINDING lands; the fix is separately gated) — see #393/#396.
- **Verify ground-truth; never escalate inference to decision-grade.** Label
  epistemic tier (assertion / inference / source-verified). Only
  source-verified earns a decision. Re-fetch branch HEAD before finalizing an
  analytical packet (it goes stale as lanes push). Run a verification from a
  CLEAN worktree at the real HEAD — `git fetch` alone does NOT move the
  primary working tree (this caused a wasted "demo run" on stale code).
- **Run the FULL CI gate** before claiming green: `lint` is
  lint + lint:dead + lint:dup + lint:deps + the Effect-quality metric ratchet
  + Semgrep + Typecheck + Tests. `pnpm run lint` alone is a subset.
- **Outward-facing actions need explicit authorization.** Filing an upstream
  third-party issue is a publish — the PO's call, not autonomous. Self-merge
  is the PO's gate; lanes never self-merge.
- **Drain > new builds.** When the PR queue is large, clearing the review/merge
  gate beats fanning new sims. The coordinator is often the bottleneck.

---

## 5. The team & current disposition

Six lanes, wound down at handoff. Re-dispatch as needed:
- `oca1 oca2 oca3` (Opus coding agents), `cca1 cca2` (GPT-5.x coding agents),
  `Tooling Agent`. All idle / stood-down. cmux `workspace:2`.

Reasonable fresh allocation: 1–2 lanes on the **non-ACP planner** (primary
path, §1), 1 on a `claude-code`/alt-harness spike, the rest reserve for
review-support and any FINDING follow-ups. Keep ~2 on build, rest on
fixing/verifying — the PO's standing preference.

---

## 6. Resume checklist (do this first, in order)

1. Read `docs/investigations/2026-05-19-s6-dark-factory-live-run.md` §7 and the
   `tf-549`/`tf-9q4`/`tf-xyo` findings — the precise failure boundary.
2. `bash scripts/lane-sweep.sh --json --workspace workspace:2` — see lanes.
3. `gh pr list --state open` — should be ~0; the substrate is all merged.
4. Confirm the substrate inventory (§2) is in `main` — do NOT redo it.
5. **Open the right package, then instrument** (§0a UPDATE + §1). claude-agent-acp
   has already been read — at v0.36.1 (`/Users/gnijor/.npm/_npx/902b360216d9b9cc/
   node_modules/@agentclientprotocol/claude-agent-acp/dist/acp-agent.js`)
   `alwaysLoad` and any "ToolSearch"/tool-deferral concept are **absent**. The
   `alwaysLoad` key is forwarded untouched into the **deeper Claude Agent SDK**
   (`@anthropic-ai/claude-agent-sdk` / `claude_code`, invoked via
   `session.query` in acp-agent.js:1438→onward) — **that** is the package
   nobody opened, and where the deferral mechanism (if any) lives. Open it,
   `grep alwaysLoad`, `grep -i 'tool[_-]search\\|deferred'`, trace where MCP
   tools enter the model request and what `tool_choice` is set. Add OTEL at
   that boundary on the real production path. Distinguish whether the
   symptom is (a) SDK-side tool-deferral, (b) `alwaysLoad` actually does
   nothing anywhere (A1 inert), (c) name mangling, (d) something else —
   **with captured data**, not inference.
6. `br create` the bead, `cmux-dispatch.sh` the lane with the full lifecycle
   wording (§3c), bead id, and the choreography constraints (§4). The
   deliverable is a **source-verified FINDING** explaining 0/6 with captured
   evidence — likely a fixable Firegrid-codec / MCP-advertisement-shape issue.
   The non-ACP planner is only a *control* to isolate one variable (§1).
7. Iterate: review against the anti-smoketest bar, merge honest greens,
   surface true blockers to the PO. **Done = the failure is characterized with
   captured instrumented data and the real issue addressed — a live §6 with
   the #401 harness `proven:true` honestly is the *consequence*, never the
   goal pursued by routing around the discovery.**

You are the PO's delegate. Drive it to a *running* factory — not a doc that
explains why it doesn't run.

---

## 7. `packages/firelab/` is structurally a mess — clean it to this contract

A separate agent is mid-cleanup of this. Current state and the **target** the
package must regrow to:

### 7a. Active breakage (the cleanup exposed it)

`src/configurations/` was deleted, but **3 registry-discovered sims still
`import` from it** (real imports, not comments):
- `src/simulations/codex-acp-tool-call-pipeline.ts:8`
- `src/simulations/wait-for-output-pipeline.ts:3,4`
- `src/simulations/multi-context-production-consuming-pipeline.ts:6`

`src/simulations/registry.ts` loads via `await Promise.all(files.map(import))`,
so **one failing import rejects the whole batch → every sim is bricked**, not
just those 3. (Design fragility: auto-discovery made "add a file" frictionless
but "one bad file bricks all". The folded loader must isolate per-file
failures — `Promise.allSettled` / per-file try-catch — skip+report a bad file,
run the rest.) Remediation per coupled sim: **inline** the needed
host-compose, or **delete** the sim if a self-contained sibling already covers
it (e.g. `output-journal-pipeline.ts` exists self-contained), or temporarily
**restore `configurations/`** as documented debt. Prefer delete-where-redundant.

### 7b. The contract `src/simulations/` MUST regrow to (do NOT re-accrete)

The current `FirelabSimulation` is wrong. It types assertions as
`summarize: (result) => Record<string, unknown>` + freeform `localize` — so a
sim's **expectations are undeclared imperative code**, different per sim, with
no schema; you reverse-engineer intent by reading each sim's `driver()` +
`summarize()` + its sibling `.FINDING.md`. That is the opposite of the stated
purpose ("an easy/clean way to generate OTEL trace data to drive an
experiment"). The trace artifacts (`.simulate/runs/<id>/` —
`run.json`/`trace.json`/`live-spans.jsonl`/`traces.otlp.jsonl`/`duckdb/`) are
the **one clean, uniform, gitignored output and the actual deliverable**;
everything layered around them is accretion.

Target contract — collapse to **four fields**:
```ts
interface FirelabSimulation {
  id; description;
  makeHost(env): Layer<FiregridHost>;
  driver(env): Effect<unknown, unknown, Firegrid>;   // exercises the path
}
```
- **Delete `summarize` and `localize`.** The **trace is the output.**
  Expectations are expressed as **declarative queries over the trace**
  (duckdb/jq over `trace.json`/`live-spans.jsonl`) — sim-agnostic,
  inspectable — or are the analyst's job. Never untyped per-sim boolean blobs.
- **Conclusions/findings live in `docs/`, never interleaved** in
  `src/simulations/`. Move every `*.FINDING.md` out.
- **No `registry.ts` module** — fold the dir-scan + `isSimulation` filter +
  the non-sim exclusion list (`types.ts`, `trace-*.ts`) into `simulate.ts`
  (per-file-isolated load). **No `proof` subcommand** in `simulate.ts`
  (§6-hardcoded demo renderer — `simulate show` already prints any run's
  summary). **No `demo:s6`** entrypoint/script. **No `bin/acp-force-tool-
  shim.mjs`** (closed #424 residue).
- Net `src/`: `bin/simulate.ts` (one runner: discover-load + `run` + the
  sim-agnostic inspection verbs `list`/`runs`/`show`/`tail`/`attach`/`query`/
  `duckdb`) + `simulations/` (one self-contained file per experiment +
  `types.ts` for the 4-field interface; trace infra may move to `src/trace/`)
  + a minimal `index.ts` with no `configurations/` re-exports.

The hard rule, stated so it cannot re-accrete: **the runner stays
sim-agnostic; demo/presentation is never inlined into discovery infra; a
sim's only job is "exercise a code path, emit OTEL"; the trace (or a trace
query) is how you learn what happened.**

---

## 8. Post-mortem — how the mess happened (do not repeat)

This was a **coordination failure**, the previous coordinator's. Root causes,
stated so the next session recognizes the pattern early:

- **Demo-deadline velocity was optimized over coherence.** "Get this demoable,
  few hours, set a timer" was translated into *produce presenter-facing
  artifacts fast* — and fast meant bolting `proof`/`demo:s6`/registry onto
  existing infra instead of designing a clean boundary. The shortcut **was**
  the orchestration / demo-for-demo's-sake anti-pattern this whole project
  exists to reject.
- **Per-PR review gated correctness, not architecture.** #401/#402/#409 etc.
  were each reviewed in isolation against an anti-smoketest/"is it honest +
  green" bar. The architectural question — *does a §6-specific renderer belong
  in the shared runner? does this assertion blob belong in the contract?* —
  was never asked. Each PR passed alone; the aggregate was incoherent. No one
  owned "is firelab still the clean trace-generator it was meant to be."
- **Confident conclusions asserted on unverified inference — at least five
  times.** (1) the §6 "victory" over-declaration; (2) "no ACP path forces
  tool-choice, terminal" reasoned from the protocol surface, not source;
  (3) the codec's claude-agent-acp merge behavior **stated as fact in code
  comments** (§0a) while never reading claude-agent-acp source; (4) **the
  TFIND-017 / "`DurableTable.rows()` is a live tail" / #406 fact-advancement
  story** — propagated from a lane report + a bead title + the sim's own
  comment, asserted as a "real substrate finding," then **refuted on actually
  reading the source** (see the box below). (5) **the entire `alwaysLoad` /
  "ToolSearch deferral" mechanism the codec and the "terminal ACP" conclusion
  were built on** — when claude-agent-acp@0.36.1 was finally read,
  `alwaysLoad` and "ToolSearch" do not exist in the package at all; the
  asserted mechanism lives (if anywhere) in the deeper Claude Agent SDK,
  which was **never opened** (§0a UPDATE). One `grep` would have killed the
  whole "terminal ACP" thread at the start. Same shape each time: inference
  promoted to decision-grade because the visible metric (merged PRs /
  "demoable") rewarded closing, not verifying.

- **Meta-lesson the original "actual issues" list demonstrated.** When a
  prior coordinator (me) re-listed the issues this arc surfaced — #1 §6
  never ran, #2 codec double-advertisement, #3 instrumentation gap,
  #4 `rows()` live-tail, #5 codec error.message drop, #6 firelab
  drift, plus resolved Gap-3 — and the PO challenged "what data backs
  this," **the list collapsed on re-check**: #1 was the symptom, not an
  issue; #3 was misframed (the boundary is in a package we didn't open,
  not in our codec); #4 was outright refuted; #5 was already fixed in
  `main` (tf-ds2/#403, surfaced as "open" by stale propagation); #6 is
  harness clutter not a substrate bug; #2's mechanism relocated to the
  unread deeper SDK; Gap-3's outcome is real but its mechanism shares an
  author with the refuted TFIND-017 and warrants skepticism. **In the
  whole arc, zero new, real, unresolved Firegrid problems were both
  characterized and unresolved at the end.** What it actually produced,
  verified, was the methodology failure itself.

> **⚠ KNOWN MISDIAGNOSIS — do NOT resurrect (source-cited refutation).**
> The claim "`DurableTable.rows()` is a live tail, so a fact written before a
> `wait_for` attaches is lost" is **false**. Source:
> `packages/effect-durable-operators/src/DurableTable.ts:143` — contract:
> *"Current non-deleted rows **plus** live non-deleted row changes"*; impl
> ~line 769 — `subscribeChanges(handler, { **includeInitialState: true** })`.
> `rows()` replays current rows then tails; pre-attach facts ARE delivered.
> Therefore **#406's "fact-advancement timing" change is a workaround built on
> a misdiagnosis**, and almost certainly moot (if the planner never issues
> `wait_for` — the real #2/#3 issue — fact *timing* is irrelevant; there is
> nothing to advance). One honest residual: a CallerFact `wait_for` resolves
> through the **host-supplied `CallerOwnedFactStreams.callerFact` resolver**
> (`packages/runtime/src/durable-tools/internal/runtime-wait-streams.ts`),
> which was **not** read — so "the §6 wait path loses pre-attach facts" is
> *uninstrumented/unknown*, NOT established. Do not treat TFIND-017, the
> `tf-eoi` bead, or merged #406 as evidence of a real `rows()` defect. If the
> CallerFact wait path is ever suspect, instrument that resolver — don't
> re-derive the refuted `rows()` story.

**Corrective principles (enforce these as coordinator):**
1. Label epistemic tier on every claim: *assertion / inference /
   source-verified*. Only source-verified earns a decision or a "terminal".
   Code comments asserting third-party internals are inference until cited.
2. Per-PR review must include *"does this belong here architecturally"*, not
   just "is it honest and green."
3. Demo/presentation is **never** inlined into discovery infra. The runner
   stays sim-agnostic. If a demo is genuinely needed it is a separate,
   clearly-labelled artifact outside the infra — and is not a deliverable of
   this exercise (the deliverable is captured trace data + characterized
   findings).
4. When the goal is "discover/characterize an issue", routing around it to
   produce a green is failure, not progress. Instrument the actual boundary;
   the trace is the evidence.
5. Periodically step back and ask "is the system still coherent for its
   stated purpose?" — throughput loops do not ask this; the coordinator must.

---

## 9. Closing-turn additional learnings (read; these are the ones that bit hardest)

### 9a. Polish was the danger signal

Every wrong conclusion this arc was *well-written*: the "terminal ACP"
write-up, the cross-runtime "common cause" finding (#420/#424), the original
ScenarioSpec proposal, and the previous coordinator's own "actual issues"
list. Citations, hierarchical structure, sober tone. The *honest* reports
were rougher and more useful — oca2's "I built Option A and it didn't fix
it" (#396), oca3's "shim engaged, tools/call still zero" (#424).

**Heuristic for the next coordinator:** treat polish in a closing-out
artifact as a **yellow flag, not a green one**. Especially if the artifact
asserts a "terminal" / "architectural" conclusion. The thing that *feels*
authoritative is exactly where to demand "what data backs this."

### 9b. Throughput mode is the trap, not a sub-symptom of it

"Queue 20 → 0" felt like progress and got optimized. When the substantive
work is *settle one open question with captured data*, merging PRs is
motion that crowds out the question. The STATE CHANGE cron's
*"act/route then re-sweep"* template was throughput-mode wearing
autonomous-loop clothes; killing the cron was right.

**Heuristic:** automation (or a metric) that rewards *reacting* is
automation working against the goal when the goal is *verifying*.
If you find yourself burning down a queue while the load-bearing question
is unsettled, the queue is not the work.

### 9c. Self-built metrics become theater

`s6FullLoopProven` / "0/6" felt authoritative because we shipped the
harness. But a metric we invented, instrumented, and then optimized against
is a closed loop — green or red, it can't tell you anything about the
actual world it claims to measure. The *trace* (and the unread source) were
the real evidence; the boolean was a mirror reflecting our own assumptions.

**Heuristic:** if a metric is satisfied by an artifact you also wrote,
the metric is not evidence. Treat it as a *prompt to look at the trace*,
not as an answer.

### 9d. Lane reports must land as hypotheses, not findings

A surprising number of "real findings" propagated through the coordinator
this session were lane diagnoses I (the prior coordinator) restated as
verified without independent source reads: cca1's TFIND-017 (refuted on
read), cca1's #417 serial-reconciler mechanism (outcome verified, mechanism
suspect), oca3's #406 fact-advancement timing story (built on the refuted
TFIND-017), oca1's "terminal ACP" framing (relocated to the unread Claude
Agent SDK). The repo has `packages/firelab/FINDINGS_TRIAGE_RUBRIC.md`
explicitly to triage findings *before* routing — and it was not applied
to any of these. That is a coordinator-hygiene failure separate from the
meta-rule.

**Heuristic:** every lane-produced "finding" enters as a *hypothesis with
attached evidence pointer*. Apply the rubric's triage question first; do
the 60-second source check; only then promote to a finding the next
session inherits as established.

### 9e. What survived is real (honest balance)

The arc's failure was concentrated in the **§6 interpretation layer** —
the "terminal ACP" story and the conclusions stacked on top of it. The
*substrate work* in `main` is real, source-grounded, and useful:

- Gap-3 progressive-localization chain (#393→#396→#404→#417) — fix
  produces a verifiably green session-lifecycle-unwind sim.
- Auto-discovery sim registry (#385) — structurally eliminated the
  fan-out merge-conflict class.
- Codec `error.message` enrichment (tf-ds2/#403) — real observability fix.
- Several §7 sims surfaced real properties (#379 stdio-jsonl, #383
  CallerFact, #388 execute substrate, #391 idempotent intent, #392
  delegation, #397 action-survives-restart, #399 wait-survives-restart).
- §5 minimal-slice capstone (#418).
- task-exit.sh post-rebase safe-path fix (#416).
- The bead ledger reconciliation (122 closed, 5 real items remain).

**Do not re-do this work.** The next coordinator should treat §2's
inventory + the §7 cleanup the other agent is doing as durable wins. The
*one* item that bears re-examination on grounds of mechanism (not outcome)
is Gap-3/#417 — see §9d's note that its diagnosis shares an author with
the refuted TFIND-017; the *fix works* (sim flips green) but the *story
of why* warrants source verification before being cited.

### 9f. The 60-second-grep heuristic (operationalising the meta-rule)

Before accepting any closing-out artifact — yours, a lane's, or another
agent's — ask:

> *"What single grep or file-read would refute this?"*

If the answer takes **under 60 seconds**, do it before merge / before
citing the artifact in a decision. The whole §6 thread would have died at:

```
grep -r 'alwaysLoad' /Users/gnijor/.npm/_npx/*/node_modules/@agentclientprotocol/claude-agent-acp/
```

— ~5 seconds, zero hits, "terminal ACP" theory dead on the spot. That
heuristic, applied consistently, is the meta-rule with teeth.

### 9g. RESOLVED — see §10 arc closure

§9g instrumentation lane was UNNECESSARY for §6 resolution; only cause #2
remains and is an SDK gap out of our control.

---

## 10. ARC CLOSURE — 2026-05-20

The §6 arc closed through a source→measurement→fix sequence, not through a
single final rewrite:

| PR | Bead | Status / ref | Role in the arc |
|---|---|---|---|
| #441 | `tf-3ek` | merged `3108ad502f866e533d44106b40a54cf815ad0aa0` | 60-second-grep baseline: source-verified the codec→SDK assumptions and narrowed the candidate-cause matrix. |
| #444 | `tf-s8y` | open spike, head `fd22e5b2ad854a13db8e8ed0e5377abcd16356a2` | Falsifiable `.mcp.json` spike: proved native project MCP registration produced real Firegrid tool calls. |
| #446 | `tf-v7t` | open production PR, head `36fbc8d2eaf52e49c76a85d7a8804387af8ce9dc` | Production codec split (`.mcp.json` for MCP, `_meta` for tool policy) plus the dark-factory permission auto-approve handler. |
| #447 | `tf-9ut` | merged `9f7d0cc95d2d2c8687c0910a0298861b2de13f70` | Empirical workflow-core-paths sim: separated candidate `complete_match` pressure from `wait.satisfied` completions and ruled out the stale orphan-parent baseline after #445. |
| #448 | `tf-85bs` | merged `bc75af27403191cfc00f3770933e671d990b0256` | Hot-loop fix: auto-threaded `afterSequence` in session handle waits so repeated waits do not re-read the first observation forever. |

Methodology summary: `tf-3ek` started with the cheap refutation pass
(60-second grep/source read). `tf-s8y` converted the strongest remaining
theory into a falsifiable spike. `tf-v7t` carried the spike result into the
production codec shape and added the missing permission policy loop. `tf-9ut`
then exercised related workflow-core wait paths empirically instead of
promoting a trace-shape inference to a decision. `tf-85bs` closed the
hot-loop discovered by those live runs. The remaining timeout in PR #446 is
not "§6 cannot drive tools"; it is the app-domain fact-seeding gap tracked by
`tf-t2a5`.
