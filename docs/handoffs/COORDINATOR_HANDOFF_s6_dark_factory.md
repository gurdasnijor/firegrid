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
work. Its own comment (lines ~148–165) **states claude-agent-acp's internal
merge/precedence behavior as fact** ("strips `alwaysLoad`", "the
`{...userProvided, ...acpDerived}` merge overrides any colliding `_meta`
entry") — but that was inferred from the protocol surface, **never verified
against claude-agent-acp source** (`src/acp-agent.ts` ~L1488, the model-turn /
tools / tool_choice construction). The codec annotates only what *we send*
(`firegrid.acp.mcp_server_count/_names`); it captures **nothing** about what
claude-agent-acp forwarded to the model.

**Three concrete ways this transformation alone produces the exact symptom
("discovers tools, plans in prose, never invokes") — none of them an ACP
limitation:**
- **Tool-name mismatch.** If the `-alwaysload` alias is the path whose tools
  reach the model, the model is offered `mcp__<name>-alwaysload__wait_for`
  while the §6 prompt **and the #401 proof harness** reference `wait_for`. The
  agent narrates the right call; the advertised tool has a different name → it
  cannot invoke what it was told to. Self-inflicted prose-vs-invoke.
- **Deferred-server-wins.** Same URL under two names → claude-agent-acp may
  keep the non-`alwaysLoad` primary (still ToolSearch-deferred) and drop the
  alias. We assumed the alias wins; never measured.
- **Inert `_meta`.** If claude-agent-acp doesn't honor
  `_meta.disableBuiltInTools` / `claudeCode.options.mcpServers` in this shape,
  the A1 payload is a no-op and **every "terminal" run was the default
  deferred behavior** — we concluded "ACP can't" from runs where our fix did
  nothing and never instrumented that it did nothing.

**Consequence for the handoff:** the §6-run gap is **not** established as an
ACP-architecture limitation. The leading hypothesis is now: *our own codec
transformation is malforming what the model is offered.* The first real work
is to **eliminate this confound**, not to build around it.

### What the next agent must do (in order)
1. **Strip the codec to the minimum.** Advertise the Firegrid MCP server
   **once, plainly, under its real name** (just `lowerMcpServerDeclaration`).
   Delete the `<name>-alwaysload` alias + the `_meta`/`disableBuiltInTools`
   speculation (`claudeAgentAcpAlwaysLoadMeta` and its `_meta` spread).
2. **Read the actual claude-agent-acp source** at `src/acp-agent.ts` ~L1488
   (vendor it under `repos/` so it's inspectable/traceable): does it forward
   MCP tools into the model request? under what condition? what `tool_choice`?
   what system prompt? Replace every "claude-agent-acp does X" *comment* with
   a source citation or delete the claim.
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

---

## 7. `packages/tiny-firegrid/` is structurally a mess — clean it to this contract

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

The current `TinyFiregridSimulation` is wrong. It types assertions as
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
interface TinyFiregridSimulation {
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
  owned "is tiny-firegrid still the clean trace-generator it was meant to be."
- **Confident conclusions asserted on unverified inference — three times.**
  (1) the §6 "victory" over-declaration; (2) "no ACP path forces tool-choice,
  terminal" reasoned from the protocol surface, not source; (3) the codec's
  claude-agent-acp merge behavior **stated as fact in code comments** (§0a)
  while never reading claude-agent-acp source. Same shape each time:
  inference promoted to decision-grade because the visible metric (merged
  PRs / "demoable") rewarded closing, not verifying.

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
