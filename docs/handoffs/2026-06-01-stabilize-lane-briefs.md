# Stabilize-unified — fire-ready lane briefs (4 lanes)

Companion to `docs/handoffs/2026-06-01-stabilize-unified-handoff.md`. These are the
session-start dispatch bodies for the next coordinator's three agent lanes. Each is
self-contained: a fresh lane reads only its brief + the handoff.

**How to fire** (label must match the cmux surface; brief from stdin so no `$()`/backtick
substitution — see `scripts/cmux-dispatch.sh`):
```bash
bash scripts/cmux-dispatch.sh LANE-1 - < <(sed -n '/^### LANE 1/,/^```$/p' this-file)   # or just paste the block below
```
Simplest: copy the fenced block for each lane and pipe it:
`pbpaste | bash scripts/cmux-dispatch.sh LANE-1 -`

**Board (see handoff §map):** Lane 1 owns `unified/` FIRST (trunk-green production fixes); Lane 2
(kernel lifecycle, sims-first) and Lane 3 (harness/enforcement + real-agent + proofs) start in
tiny-firegrid (non-colliding); Lane 4 (enforcement-surface audit) is read-only/non-colliding.
Lane 2 enters `unified/` only after Lane 1 merges green. **Never two lanes in `unified/` at once.**
Governing rule: **gather data (run a sim) before concluding** (handoff §0). **HARD GATE:** "make
CI green" (Lane 1 / `tf-ll90.1`) is blocked-by the sim-enforcement (Lane 3 / `tf-ll90.15`) — a
green trunk over a forgeable sim harness is a false green. Lane 4's audit feeds Lane 1: which red
gates are real-to-SATISFY vs stale-to-RETIRE.

---

### LANE 1 — Trunk-green
```
You are LANE 1 (Trunk-green) on the unified-kernel STABILIZE effort (epic tf-ll90). Mission:
get the integration trunk (sim/unified-kernel-validation) to a genuinely green CI.

READ FIRST: docs/handoffs/2026-06-01-stabilize-unified-handoff.md — §0 (THE META-RULE: gather
data before concluding; never assert a fix works — run the gate and read the output), §3-5,
and project_tf_r06u5_trunk_greenup.md (the precise mechanical remainder).

TASK 1 = tf-ll90.1 (green-up, P0). Path-A REAL fixes only (NO semgrep baseline, NO eslint
disable): the provideMerge restructure (effect:diag + lint:dup), lint:dead/effect-quality,
eslint process-env, and the 1 failing test protocol/test/channels/session-permission.test.ts:21
(offset ParseError).
TASK 2 = tf-ll90.2 (read-side relocation, P1): move the host-control channel bindings from
unified/channel-bindings.ts back to channels/ (the semgrep-excluded binding dir; authorities/
is deleted). Wires the stubbed snapshot/lifecycle reads AND clears the :390/:399
table-discipline semgrep. (no-unclassified-workflow-make clears later via §4/tf-ll90.8 — leave it.)

ACCEPTANCE (data, not assertion): `gh pr checks 772` shows all 5 gates green after .1; for .2,
run semgrep and confirm the table-discipline findings are gone (cite the run).

HARD GATE: your green-up is NOT "done"/green until Lane 3's sim-enforcement (tf-ll90.15) +
sim-rebuild (tf-ll90.11) land — tf-ll90.1 is blocked-by tf-ll90.15. "CI green" includes the
sim-honesty gate; a green trunk over a forgeable sim harness is a FALSE green. So fix the
production gates in parallel, but the trunk is declared green only when Lane 3's enforcement
passes too. Coordinate the merge with Lane 3.

DISCIPLINE: one bead = one worktree off origin/sim/unified-kernel-validation (never primary
checkout, never main). You OWN unified/ FIRST — Lanes 2 & 3 stay out of unified/ until you merge
green. Before building any wrapper/binding, check docs/recipes/README.md. Confirm your plan
(gate-fix order + the .2 relocation shape) with the coordinator BEFORE building.
```

---

### LANE 2 — Kernel lifecycle (sims-first)
```
You are LANE 2 (Kernel lifecycle) on the unified-kernel STABILIZE effort (epic tf-ll90).
Mission: make the durable session lifecycle real — cancel/close, crash-recovery + kernel
write+arm, terminal-completion (fix the process leak), schedule_me delivery. SIMS-FIRST.

READ FIRST: docs/handoffs/2026-06-01-stabilize-unified-handoff.md §0 (THE META-RULE) +
packages/tiny-firegrid/docs/methodology.md + docs/runbooks/firegrid-effect-tracing.md (sims
are RUN via simulate:run; evidence = the captured OTLP trace, NOT vitest) +
docs/cannon/architecture/kernel-owned-write-arm.md (CANNON) + docs/recipes/_lift-candidates.md
(the lifecycle sims to rebuild) + docs/recipes/README.md (check before building any
wrapper/channel). docs/proposals/SDD_FIREGRID_DURABLE_TOOLS.md gives schedule_me/wait_for
SHAPES + the "no new coordination primitives" bar — CAVEAT: pre-unified; mine the shapes, NOT
its RuntimeIngressTable/DurableDeferred mechanisms (superseded by the unified signal primitive).
PR #776 is a reference plan only — its de-risk is INVALID (built on non-airgapped spikes).

TASK 1 = the AIRGAPPED RUN SIM for cancel/close (rebuilding control-plane-cancel-close; under
tf-ll90.4 + .11). Per the meta-rule, build the sim to GATHER DATA FIRST: a registry-entry sim
(makeHost(env) host Layer; driver(env) importing ONLY @firegrid/client-sdk; summarize), run by
simulate:run, driving session_cancel → resume-after-cancel → session_close over the PUBLIC
client surface, capturing the trace. Run it; read the trace (simulate:show / DuckDB) to see what
the unified kernel does today (audit says: nothing — no consumer); write a prose finding citing
spans. THEN (after Lane 1 greens the trunk) build the unified/ production consumer to make the
sim show cancel→terminal.

ACCEPTANCE: a RUN sim producing .simulate/runs/<id>/ trace evidence over the public client seam +
a prose finding citing specific spans; (later) the production that makes it pass. NO vitest, NO
test/probe.ts, NO in-script verdict.

DISCIPLINE: tiny-firegrid ONLY at start (non-colliding). Production enters unified/ ONLY after
Lane 1 merges green (never 2 lanes in unified/). The lifecycle properties share ONE durable
terminal-emit surface (tf-ll90.3) — design it once, don't duplicate. Confirm your plan + the
cancel/close sim shape with the coordinator BEFORE building.
```

---

### LANE 3 — Harness + real-agent + proofs
```
You are LANE 3 (Proofs) on the unified-kernel STABILIZE effort (epic tf-ll90). Mission: fix the
sim harness, prove a REAL agent works on the unified kernel, and rebuild the deleted CORE proofs
as airgapped RUN sims. (The kernel currently has NO trace-evidenced coverage — only vitest probes
against internals, and only fake-codec, never a real agent.)

READ FIRST: docs/handoffs/2026-06-01-stabilize-unified-handoff.md §0 (THE META-RULE) +
packages/tiny-firegrid/docs/methodology.md + docs/runbooks/firegrid-effect-tracing.md +
docs/recipes/_lift-candidates.md (the rebuild catalog) + docs/recipes/agent-to-agent-observation.md
+ docs/recipes/runtime-permission-resume.md (composable patterns to REUSE, not rebuild — observe→
respond→resume on existing channels, "Do Not Reimplement").

TASK 1 = tf-ll90.15 (sim-enforcement CI GATE) — ★ CRITICAL PATH: this HARD-GATES the green-up
(tf-ll90.1 is blocked-by it). "CI green" is FALSE until sims cannot forge evidence, and EVERY
current sim forges it (driver.ts value-imports ./host.ts for a substrate handle; unified-kernel-
validation sprawls to ~18 files + fakes; others use runtime.ts/probe.test.ts + vitest verdicts).
Build the enforcement AS A CI GATE (red on any violation), per the full spec on the bead:
  - SHAPE LOCK: a sim is EXACTLY {index.ts, driver.ts, host.ts} (extend scripts/tiny-firegrid-
    layout-check.mjs) — no substrate.ts/scenarios.ts/fake-codec.ts/runtime.ts/probe.ts sprawl.
  - ENTRY LOCK: index.ts must `export default defineSimulation({host, driver})`; runSimulation is
    the only runner; brand defineSimulation's return so a hand-rolled literal is a type error.
  - IMPORT LOCKS (eslint, per file): driver.ts = ONLY @firegrid/client-sdk + effect, FORBID ALL
    relative imports (closes the ./host.ts cheat); host.ts = substrate only, no client-sdk;
    index.ts = only ../../types.ts + ./driver.ts + ./host.ts.
  - Remove vitest + the "test":"vitest run" script; add a verdict-shape ban ({claimStatus}/
    findings:[]); align dep-cruiser R3↔R2 (+@effect/workflow, @durable-streams/*); drop ALL grandfathers.
The gate goes RED on the current sims (correct — they all cheat); making it GREEN = rebuilding
them to the shape (TASK 3 / tf-ll90.11, shared with Lane 2's lifecycle sims). This unblocks the
green-up and makes "sims are evidence" trustworthy — do it FIRST.
TASK 2 = tf-ll90.14 (real-agent proof, P0): an env-gated live RUN sim driving a real Claude/codex
agent through the public client surface, FiregridOtelLive in the host, capturing the
client→host→workflow→codec→sandbox→MCP trace (runbook §"Full e2e"). This is the definition of
done for stabilization.
TASK 3 (queue): rebuild the codec/ACP, wait/pre-attach, output-replay, and input proofs from
tf-ll90.11's CORE list — as RUN sims (use _lift-candidates.md).

ACCEPTANCE: vitest gone + test tree converted; a real-agent RUN sim with a captured trace proving
the path; every artifact is a RUN sim + trace + prose finding. NO vitest anywhere.

DISCIPLINE: tiny-firegrid ONLY (non-colliding). Coordinate sim-dir ownership with Lane 2 (they own
the cancel/write-arm/terminal/schedule lifecycle sims; you own harness + real-agent + codec + wait
+ output). Confirm your plan (esp. the test-tree conversion list — which convert vs remove) with
the coordinator BEFORE building.
```

---

### LANE 4 — Enforcement-surface audit (read-only)
```
You are LANE 4 (Enforcement audit) on the unified-kernel STABILIZE effort (epic tf-ll90.16).
Mission: determine which of the repo's ENFORCEMENT actually gates the TARGET (unified) arch vs a
SUPERSEDED (pre-unified / shape-c / runtime-shrink / legacy-tree) one — and tell Lane 1 which
green-up gates to SATISFY vs RETIRE. READ-ONLY; produce a prose finding. Non-colliding.

READ FIRST: docs/handoffs/2026-06-01-stabilize-unified-handoff.md §0 (THE META-RULE: don't satisfy
a requirement that shouldn't exist — falsify it first) + the TARGET arch: docs/architecture/
unified-subscriber-kernel.md + 2026-05-31-unified-architecture-mental-model.md + docs/sdds/
SDD_FIREGRID_GATEWAY_SEPARATION_OF_CONCERNS.md + docs/analysis/2026-06-01-765-deletion-audit.md.

AUDIT the full enforcement-config surface — for EACH item: what invariant it enforces, then
ALIGNED (real unified-arch invariant → keep) / STALE (enforces a pre-unified/shape-c/runtime-shrink/
legacy-tree constraint #765 superseded → RETIRE) / REALIGN (useful, needs updating to unified),
with EVIDENCE (read the rule/script/baseline + what it gates; note if it's vacuously-green on
deleted dirs or actively blocking the §4 reshape):
1. scripts/ — the ~20 WIRED enforcement scripts (clean-room-hard-root-guard, effect-native-
   production-cutover-check, legacy-runtime-roots-scoreboard, runtime-target-legacy-type-only-check,
   runtime-public-surface-check, host-sdk-runtime-import-baseline, test-layout-check, tiny-firegrid-
   layout-check, trace-seam-coverage, tiny-config-prod-coverage, jscpd/knip/semgrep/effect-quality
   baselines, preflight, tooling.mjs) + git-hooks/{pre-commit,pre-push}. (~19 orphan coordination/
   cron tools — cmux-dispatch, lane-sweep, task-enter, beads-sync, state-watch — are operational,
   note-but-deprioritize.)
2. .dependency-cruiser.cjs — ALL rules; ESP the ~17 runtime-folder-tier + *-no-legacy-tree-import +
   runtime-shape-c-* rules (the pre-unified tiering the collapse retired). Flag the tiny-firegrid
   R2/R3 airgap rules as ALIGNED-but-needs-strengthening (→ tf-ll90.15, don't duplicate).
3. .effect-diagnostics-baseline.json — the 82-entry floor: stale debt the green-up should FIX,
   deleted/superseded code, or legit? Same for the semgrep/jscpd/knip baselines.
4. eslint.config.js + .semgrep.yml — same lens.

★ CRITICAL OUTPUT for tf-ll90.1: a SATISFY-vs-RETIRE table for the green-up's 4 red gates
(effect-diag/lint/semgrep/tests) — which red is a real unified invariant to satisfy vs stale
enforcement to retire. Lane 1 must NOT grind a dead gate green.

ACCEPTANCE: a prose finding (docs/findings/ or docs/analysis/) classifying every enforcement item
+ the satisfy-vs-retire call. Ground every "STALE" verdict in the source + the target-arch docs —
don't assert stale without reading it (the meta-rule applies to YOU too). Confirm the audit plan +
which docs you're treating as the target-arch authority with the coordinator BEFORE starting.
```
