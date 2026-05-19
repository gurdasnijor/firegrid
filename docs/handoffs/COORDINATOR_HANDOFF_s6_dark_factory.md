# Coordinator Handoff — §6 Dark-Factory (NOT DONE)

> Read this top to bottom before doing anything. The previous coordinator
> over-declared victory; the autonomous factory **does not run yet**. Your job
> is to finish it. The substrate is done; the agent-invocation path is not.

---

## 0. STATUS: NOT DONE — the honest failure

**The north star (factory-vision §6) has never executed live.** Every live
dark-factory run produced `s6FullLoopProven=false`, **0/6 required steps**. A
real planner agent has *never once* driven the ticket→clarify→plan→
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

### Why it fails (precise, source-verified)

Given exactly the Firegrid choreography toolset + a tool-first prompt, **both**
`@agentclientprotocol/claude-agent-acp` and `codex-acp`:
1. discover the toolset (`McpServer.initialize`, `tools/list ×16`), and
2. **narrate the exact correct §6 plan in prose**, then
3. emit **zero `tools/call`** and stop (`sawTurnComplete=false`, no error).

Localization (each a merged FINDING, nothing papered):
- `tf-7dq`/#395 — ruled out quota (HTTP 200 verified separately).
- `tf-pcg`/#414 — ruled out exploration-distraction (constraining the toolset
  removed Read/Search/rg wandering but did not produce tool calls).
- `tf-9q4`/#420 — **cross-runtime**: both runtimes, fully constrained, narrate
  but do not invoke.
- `tf-549`/#422 — **native angle terminal**: no ACP runtime nor the ACP
  protocol exposes a forced-tool-choice / must-call knob for the planner turn
  (source-verified from SDK/launcher/protocol).
- `tf-xyo`/#424 — **shim angle terminal**: a transparent ACP-layer shim can
  refuse prose-only completion and re-drive the turn, but **cannot make the
  model *choose* a tool** — `tool_choice:required` lives in the
  agent-internal model request, unreachable from the ACP protocol layer.

**Root cause:** the failure is agent-side "plans-in-prose vs invokes-the-tool",
and *forced tool invocation is unreachable through the ACP protocol layer*.
This is an ACP-architecture / third-party limitation, **not a Firegrid
defect**. The substrate is sound.

### Why "accept the demo" was not "done"

The previous coordinator asked the PO to choose, and the PO picked "accept the
substrate-complete demo." That makes the *artifact* defensible, but it does
**not** make the factory run. The PO has since said: *do not declare victory;
finish it.* So:

> **The factory is finished only when a real planner agent drives §6
> end-to-end and the #401 harness reports the required steps `proven:true`
> (honestly, not by loosening the matcher).**

---

## 1. The path to actually finish it — INSTRUMENT, do not route around

> **Correction (the previous draft of this section was wrong in spirit).**
> The earlier version said "build a non-ACP planner to get a live §6." That is
> the orchestration-shortcut mindset this entire exercise exists to reject.
> The goal is **not** a green demo — it is to *drive out the real issue and
> capture the data to address it*. The "ACP cannot force tool-choice"
> conclusion was reached by **reading the ACP protocol surface (inference)**,
> not by instrumenting the actual decision point. That is the unfinished work.

### The real unfinished task: instrument the claude-agent-acp model-request boundary

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

Once a planner advances steps: run `pnpm --filter @firegrid/tiny-firegrid
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
`packages/tiny-firegrid/docs/findings/tf-*.md`.

The sim lives at
`packages/tiny-firegrid/src/simulations/dark-factory-pipeline.ts`. Run a sim:
`pnpm --filter @firegrid/tiny-firegrid simulate:run -- <id>`; inspect with
`simulate:show` / `simulate:proof` / `simulate:duckdb`. Trace artifacts land
under `packages/tiny-firegrid/.simulate/runs/<id>/` (gitignored).

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
(blocking TUI). Join key for tiny-firegrid: label `tfind:NNN` historically;
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
5. **Instrument the real decision point** (§1) — do NOT route around it. Read
   the actual `claude-agent-acp` source (`src/acp-agent.ts` ~L1488, the
   model-turn/tools/tool_choice construction); vendor it so it is inspectable.
   Add OTEL/tracing that captures the *model request claude-agent-acp builds*
   (tool list, tool_choice, system prompt) + the model response, on the **real
   production path** (`simulate:run -- dark-factory-pipeline`, not the
   fake-connection codec test). Distinguish causes #1–#5 (§1) **with data**.
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
