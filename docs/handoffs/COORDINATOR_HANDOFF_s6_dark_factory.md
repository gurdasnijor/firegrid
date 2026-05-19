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

## 1. The path to actually finish it

The terminal findings closed *ACP-layer* forcing. They explicitly left **one
open path**, never pursued: a **non-ACP planner**.

### Primary task: a non-ACP planner with forced tool-choice

Build a planner that talks to the model API directly (Anthropic and/or OpenAI
messages API) with **`tool_choice:{type:"any"}` / `"required"`**, where the
tools are the **Firegrid runtime-context choreography tools** (the same MCP
toolset, bound directly as model tools rather than via an ACP runtime). The
model is then *forced* to emit a tool call each turn; the planner loop feeds
tool results back and continues until §6 terminal.

Key design constraints (do not violate — see §4 philosophy):
- The planner still **owns all sequencing**. No app-authored DAG/phase-chain.
  You are only changing the *transport that forces invocation*, not who decides.
- It must drive the **public Firegrid surface** (the runtime-context tools /
  client SDK), not reach into substrate internals — reach-pasts are FINDINGS.
- It must run against the merged dark-factory substrate + `darkFactory.facts`
  CallerFact trigger and be observed by the **#401 sectionSixProof harness**
  (do not weaken the harness; the codec already surfaces canonical tool names
  via #419).
- Honest or bust: if the non-ACP planner *also* fails to advance §6, that is a
  precise new FINDING (HARD HALT, not papered) — but it is the most likely
  path to a real live §6 because `tool_choice:required` is exactly the lever
  the ACP layer could not reach.

Secondary / alternative avenues if the primary stalls:
- Evaluate `claude-code` (the CLI agent, not `claude-agent-acp`) or another
  agent harness that aggressively forces tool use, wired to the Firegrid MCP
  server. This is agent-runtime selection, not substrate work.
- The reusable constraint levers (`tf-9q4`/#420), the
  `DARK_FACTORY_PLANNER_AGENT` switch (#414), and the ACP-force-tool shim
  (`src/bin/acp-force-tool-shim.mjs`, #424) are all in `main` — build on them.

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
5. Spec the **non-ACP planner** (§1): direct model API loop,
   `tool_choice:required`, Firegrid runtime-context tools as model tools,
   planner-owns-sequencing preserved, observed by the #401 harness. Write it as
   an SDD with the load-bearing question at §0 (house style) if non-trivial;
   otherwise dispatch directly.
6. `br create` the bead, `cmux-dispatch.sh` the lane with the full lifecycle
   wording (§3c), bead id, and the choreography constraints (§4).
7. Iterate: review against the anti-smoketest bar, merge honest greens,
   surface true blockers to the PO. **Done = a live §6 run with the #401
   harness reporting required steps `proven:true`, honestly.**

You are the PO's delegate. Drive it to a *running* factory — not a doc that
explains why it doesn't run.
