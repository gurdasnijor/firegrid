# Coordinator Handoff — Canonical Convergence (post overnight wave 2026-05-20)

> Read this top to bottom before doing anything. The architecture refactor is
> ~93% converged after a 34-PR overnight wave; the team is being scaled down to
> 3 lanes to take it across the finish line. This doc primes you for that.
>
> **Companion doc you must also read:** `docs/handoffs/COORDINATOR_HANDOFF_s6_dark_factory.md`.
> That doc captured the meta-process rule and the post-mortem lessons that made
> *this* wave succeed. The lessons it preserves still govern — re-read its §0
> META-PROCESS RULE, §3 operational tooling, §4 working discipline, §8
> post-mortem, and §9 closing-turn learnings. They are not duplicated below.

---

## ★ META — what was different about this wave (carry this forward)

The prior §6 arc failed because **confident conclusions were asserted on
unverified inference** (5 instances enumerated in the old handoff §8). This
overnight wave succeeded because we *applied the corrective principles
operationally*, not just documented them. Specifically:

- **60-second-grep before any decision-grade claim** (memory:
  `feedback_60_sec_grep_before_instrumentation`). Caught the per-instance-Tag
  misread on Lane 3 reshape *after* the wrong steer went out — and corrected
  before the lane wasted a cycle.
- **Audit-first dispatch produces the best decision-grade artifacts**
  (Lane 6's tf-gw43 → tf-rjta → tf-vq32 → tf-lwqm sequence). PROPOSAL slices
  consumed Gurdas decision input cheaply; impl slices followed.
- **"Don't parallelize against an unvalidated decomposition"**
  (memory: `feedback_dont_parallelize_unvalidated_decomposition`). Held the
  fan-out until the canonical doc landed, then went 6-wide cleanly.
- **Effect-diag baseline ratchet (#508) was the load-bearing unblock** — until
  it landed, every canonical-wave PR was "fully green except pre-existing red"
  which confused both review and humans. Once baselined, every subsequent PR
  was truly all-green and merge confidence skyrocketed.
- **Heads-up-then-merge-order pattern** for predictable conflict surfaces
  (e.g. `tool-use-to-effect.ts` was modified by Lane 2/3/6 in overlapping
  slices — coordinator pre-announced order, lanes rebased cleanly).

---

## 0. STATUS — where main is right now

**main HEAD:** `7ecaa9102` (latest of 34-PR wave)

**Convergence:** ~93% against `docs/architecture/host-sdk-runtime-boundary.md`
(the canonical framing landed at #495). The remaining ~7% is the bulleted list
in §3 below — every item is Gurdas-decision-grade, not mechanical.

### Verified invariants on main

```
✓ rg "@firegrid/host-sdk" packages/runtime/src/                  → ZERO
✓ ls packages/runtime/src/durable-tools/                          → does not exist
✓ packages/runtime/src/workflow-engine/workflows/ contains all 7 defs
✓ dep-cruiser hard-error rules: runtime-no-host-sdk + client-sdk-no-runtime + 4 substrate scans
✓ Effect-diag baseline ratchet active (caught + held against 1 real regression at #526)
✓ pnpm run verify GREEN
```

### What landed in the wave (34 PRs)

Boundary framing & convergence assessment:
- **#495** — canonical doc `docs/architecture/host-sdk-runtime-boundary.md` (Gurdas merged)
- **#496** — tf-6d4y deletion-blocker investigation FINDING (precursor)
- **#501** — gary tf-gc7c Open Questions Q1–Q4 framing (host-runtime split? metadata→protocol? webhook fact→protocol? FiregridRuntimeHostLive rename?)
- **#512** — gary tf-k4uo convergence assessment (65% baseline + roadmap)

Schema-projection moves (Lane 1, 5 slices):
- **#500** — tf-krts FINDING inventory (12 mismatches)
- **#506** — tf-wzrr agent-output observations → protocol
- **#511** — tf-yka4 observation source names → @firegrid/protocol/observations
- **#515** — tf-8mkr verified-webhook fact key/schema → @firegrid/protocol/verified-webhook
- **#522** — tf-lq80 projection annotation helpers → @firegrid/protocol/projection
- **#525** — tf-asvu operation-entry wrapper removal (binding from protocol schemas directly)

Agent-tool execution carve (Lane 2, 4 slices):
- **#497** — tf-7knr carve PROPOSAL doc
- **#504** — tf-pnhq RuntimeAgentToolExecution.sleep arm + service Tag in runtime
- **#514** — tf-dnl0 .waitFor arm wires WaitForWorkflow.execute via RuntimeObservationStreams
- **#518** — tf-e5dy .waitForAny + .send + .call arms (5/5 wired)

Channel inventory (Lane 3, 1 slice):
- **#502** — tf-kddg ChannelRegistry deleted; per-channel `Context.Tag` + `ChannelInventoryLive` + `findChannel` + generic make{Ingress,Egress,Bidirectional,Callable}Channel factories

Workflow consolidation + durable-tools deletion (Lane 4, 4 slices):
- **#499** — tf-rvt5 RuntimeContextProvisionWorkflow + RuntimeStartWorkflow + RuntimeLifecycleWorkflow → runtime
- **#503** — tf-tlwi WaitForWorkflow created in runtime (no source existed to move; created with RuntimeObservationStreams inversion seam)
- **#507** — tf-nu71 RuntimeContextWorkflow + ToolCallWorkflow + RuntimeIngressTransform → runtime
- **#519** — tf-n5wh durable-tools package FULL DELETION (-4952 lines, 42 files)

Import guardrails + ratcheting (Lane 5, 7 slices):
- **#498** — tf-2y01 warning-mode dep-cruiser rules + baseline
- **#508** — tf-ofbm Effect-diag baseline ratchet (`.effect-diagnostics-baseline.json` + ratchet logic in `scripts/tooling.mjs`)
- **#509** — tf-wtgc --error flip; 4 rules at hard-error; runtime-no-host-sdk + client-sdk-no-runtime HARD ZERO; host-sdk substrate carveouts at 12
- **#517** — tf-6ezj ratchet-recheck FINDING (gated on Lane B/C)
- **#520** — tf-1glx ratchet 12→11 (host-owned-durable-tools.ts gone)
- **#524** — tf-emxk ratchet 11→9 (workflow-run + ingress-transform shims retired)
- **#526** — tf-rb9e ratchet 9→8 (workflow-helper shim retired) — *caught Effect-diag regression; Data.TaggedError fix in same PR*
- **#528** — tf-ygz3 honest no-ratchet FINDING (closes the per-file shim track)

Dark-factory channel migration (Lane 6, 1 slice):
- **#505** — tf-0r95 FactoryEventsChannel + PlanReadyEventChannel + DmOperatorIngressChannel + NotificationOperatorEgressChannel + ApprovalOperatorChannel moved from host-sdk into `packages/firelab/src/simulations/dark-factory/host.ts`; session-tier Tags kept in host-sdk

Factory-vision §6 (Lane 6, 5 slices):
- **#510** — tf-gw43 §6 live-run readiness AUDIT (7 specific blockers identified)
- **#513** — tf-e1g8 approval.operator routing fix (approval.* dispatched before registered callable channel; drives permission adapter)
- **#516** — tf-rjta 🏆 deterministic sleep-only substrate smoke (no LLM cycles)
- **#521** — tf-vq32 driver.ts §6 fixes (bounded marker watch + max-iteration cap + JSON artifact write-out + run-scoped external key)
- **#523** — tf-lwqm spawn_all PROPOSAL (recommends new `session_new_all` over legacy spawn_all)
- **#527** — tf-2em0 deterministic sleep + waitFor end-to-end smoke (extends #516)

---

## 0a. GARY'S ARCHITECTURAL ASSESSMENT (post-wave, decision-grade) — read this

Gary independently assessed `7ecaa9102` and produced a decision-grade scorecard
at `02-GARY_ARCHITECTURE_ASSESSMENT.md` (sibling in this folder) + a tactical
playbook at `03-GARY_NEXT_SESSION_HANDOFF.md`. The assessment refines what this
doc said and commits to several previously-open decisions.

**Companion: gary's `docs/cannon/` curation (PR #529 open as of handoff close,
branch `codex/tf-4eye-canonical-docs-cannon-curation`).** Establishes a
canonical mirror/index at `docs/cannon/{architecture,sdds,research,rfcs,prds,
vision,handoffs}/` distinguishing current source-of-truth from historical.
Originals untouched; cannon/ adds discoverability. Three key fresh-authored
docs in that PR:
- `docs/cannon/architecture/current-convergence-assessment-2026-05-20.md` —
  gary's freshly-authored sequencing-source assessment (supersedes the older
  65% baseline at `docs/research/canonical-convergence-assessment-2026-05-20.md`
  as the active roadmap)
- `docs/cannon/architecture/sdd-alignment-sanity-check-2026-05-20.md` —
  gary's verdict: Agent Body Plan + One Substrate SDDs remain canonical for
  direction/invariants; their exact paths/pseudocode/progress markers are
  historical. **The current convergence doc is the sequencing source**, not the
  SDDs themselves.
- `docs/cannon/rfcs/tf-lwqm-session-new-all-delegation.PROPOSAL.md` — the
  spawn_all → session_new_all proposal, promoted to RFC tier.

> **⚠ PRIORITY CORRECTION (Gurdas, post-#529 cannon update):**
> `session_new_all` is **NOT P0**. It is **P2 optional ergonomics, NOT a
> private-beta blocker**. Repeated `session_new` calls are sufficient unless
> evidence proves a batch primitive is needed. Gary updated
> `docs/cannon/README.md` + the two architecture docs above to reflect this.
> **The actual P0 is the 8-file carveout list reduction** (Item D below).
> When you read gary's `02-` assessment in this folder, treat its
> session_new_all "P0" framing as superseded; the cannon/ docs and this §0a
> are the current truth.

**The points below are gary's, folded in for the next coordinator:**

### The current convergence is **~90–93%**, not the 65% from `tf-k4uo`.
Gary's number reflects the post-#512 landings (#519 durable-tools deletion,
#502 ChannelInventory, #499/#503/#507 workflow consolidation, #504/#518
RuntimeAgentToolExecution arms, #509/#520/#524/#526/#528 carveout ratchet,
schema-projection wave, dark-factory smokes). The remaining work is **not
architectural discovery — it is gap closure around known seams.**

### The 8-file carveout list IS the finish-line scoreboard.
Future coordinators should inspect `.dependency-cruiser.cjs` (variable
`currentHostSdkSubstrateDebt`) **first**. As of `7ecaa9102`:

```
packages/host-sdk/src/agent-tools/execution/tool-use-to-effect.ts
packages/host-sdk/src/agent-tools/execution/toolkit-layer.ts
packages/host-sdk/src/host/control-request-reconciler.ts
packages/host-sdk/src/host/internal/runtime-context-helpers.ts
packages/host-sdk/src/host/runtime-context-workflow-core.ts
packages/host-sdk/src/host/runtime-context-workflow-runtime.ts
packages/host-sdk/src/host/runtime-input-deferred.ts
packages/host-sdk/src/host/session-log-channel.ts
```

### `session_new_all` decision: introduce **NEW** if/when needed — but it's **P2 not P0**.
**Per Gurdas correction (post-#529 cannon update):** batch delegation is P2
optional ergonomics, NOT a private-beta blocker. Use **repeated `session_new`
calls** by default; only build the batch primitive once evidence shows it's
needed. The "introduce NEW vs bend spawn_all" framing remains correct IF the
work is ever taken — see `docs/cannon/rfcs/tf-lwqm-session-new-all-delegation.PROPOSAL.md`
for the design — but treat the dispatch as deferred unless an explicit signal
arrives.

### PR #519 (durable-tools FULL DELETION) is the architectural turning point.
**Hard rule:** do not let future work reintroduce durable-tools or wait-router
compatibility surfaces. If a slice tries to, that's a regression signal —
catch at review.

### Lane D's no-ratchet finding (#528) is healthy, not failure.
It tells us the next ratchet step requires **consumer migration or real
substrate moves**, not grep-only cleanup. The 8 remaining carveouts split:
- pure re-export shims with consumers → consumer migration phase
- real substrate files → relocation phase (template: Lane 4 workflow-defs)

### Private-beta acceptable vs unacceptable gaps (gary's bar):

**Acceptable** (ship with these if needed):
- one external integration instead of all planned integrations
- `session_new_all` deferred entirely — repeated `session_new` is fine for beta
- protocol projection backlog for surfaces not exposed to beta users
- engine-native primitives (`streamWait`/`streamWaitAny`) deferred IF performance is comfortably below LLM latency budget

**Unacceptable** (block beta until clean):
- runtime imports host-sdk
- client-sdk imports runtime
- durable-tools resurrection or wait-router compatibility shims
- host-sdk common operation execution growing new behavior
- agent-facing channels exposing workflow handles, execution ids, stream URLs, table names, or engine services

### Three-track finish (gary's recommended dispatch shape):

1. **Architect/implementation lane** → ~~`session_new_all` impl~~ DEFERRED to
   P2 per Gurdas correction. This lane's freed capacity should go to
   accelerating Item D (carveout reduction) or Item B (Linear trigger).
2. **Runtime boundary lane** → pick two of the 8 carveout files; move/retire
   them; update `.dependency-cruiser.cjs` in the SAME PR (atomic).
3. **Integration lane** → draft Linear verified-webhook trigger path + first
   narrow adapter plan; implement only after route/channel placement is
   confirmed by you/coordinator.

Keep one lane free for merge/rebase/guardrail repair. **Progress will be
constrained more by merge discipline than by lack of architectural clarity.**

### Avoid another broad SDD wave.
The wave produced one canonical doc + one Open Questions framing + one
convergence assessment — that's enough framing for now. Dispatch **small
implementation slices tied to specific files, invariants, and acceptance
greps**, not new SDDs.

### Engine-native primitives (`streamWait`/`streamWaitAny`) stay P2 with concrete trigger.
Open this track only if measured system latency approaches a meaningful
fraction of LLM/provider network latency, OR if another workflow-body
composition leak appears. Until then, **do not block private beta on
engine-native work**.

---

## 1. Remaining work — what 3 lanes need to finish

These 5 items are the remaining ~7-10% per gary's assessment. The order below
maps to gary's P0/P0/P0/P1/P1 priorities + the three-track dispatch shape.

### A. `session_new_all` primitive — DEMOTED to P2 (per Gurdas correction)

**Status:** ~~P0 high-priority~~ → **P2 optional ergonomics, NOT a private-beta
blocker.** Per Gurdas correction (post-#529 cannon update): repeated
`session_new` calls are sufficient for §6 capability #4 (delegation to multiple
participants) unless evidence proves a batch primitive is needed.

**If/when ever taken:** the design verdict (introduce NEW `session_new_all`
operation, don't bend legacy `spawn_all`) remains correct. See:
- `docs/cannon/rfcs/tf-lwqm-session-new-all-delegation.PROPOSAL.md` (RFC tier
  post-#529; original at `docs/research/tf-lwqm-spawn-all-wiring.PROPOSAL.md`)
- `docs/cannon/architecture/current-convergence-assessment-2026-05-20.md`
  (post-#529) for the P2 framing

**Coordinator action:** **do not dispatch this proactively.** Wait for an
explicit signal (Gurdas direction OR empirical evidence from beta usage that
repeated `session_new` is insufficient).

### B. External trigger path — P0 or P1 depending on private-beta scope (gary: Linear first)

**Why it matters:** §6 capability #1 (durable verified facts from external
systems). Currently dark-factory seeds a synthetic `factory.trigger.accepted`
row. The substrate exists (`packages/runtime/src/verified-webhook-ingest/` —
the README is excellent and pre-dates this wave; schema is now projected
through `@firegrid/protocol/verified-webhook` per #515).

**Gary's verdict (priority):** P0 if private beta means "real external event
starts the factory"; P1 if private beta is fine with operator/test-harness
trigger.

**Decision committed (gary):** **Linear first** — matches the factory-vision
narrative.

**Placement (gary, per canonical doc):**
- Route installation → app or host-sdk integration layer
- Signature verification + durable fact writes → runtime (`verified-webhook-ingest/`)
- Channel binding adapters → host-sdk or app integration

**Read first:** `packages/runtime/src/verified-webhook-ingest/README.md` (the
canonical product-vs-substrate boundary doc).

### C. Real side-effect adapters (Linear / GitHub / Slack)

**Why it matters:** §6 capability #6 (actions in the world). The §6 narrative
in `docs/vision/factory-vision.md` is explicit: open PR, post comment, run
command, call tool. Currently dark-factory has only local durable tables.

**Gary's verdict (sequencing):** GitHub OR Linear first, **not both**. Pick
the one that unlocks the first private-beta story; keep the first adapter
intentionally narrow with the right retry / credential / observation model.
Subsequent adapters follow only after the first is correct.

**Placement (gary, per canonical doc):**
- Request/response schemas when shared → protocol
- Execution adapters touching providers/credentials/retries/durable side-effects → runtime
- host-sdk/app composition installs Live Layers + channel bindings

### D. Last 8 import-guardrail carveouts — P0 (the finish-line scoreboard)

**Why it matters:** Per gary, this is the **single most useful objective
scoreboard**. When the list hits zero (or contains only named compat shims
with no behavior), the architectural invariants are clean enough to ship
private beta.

**The 8 carved-out files (`.dependency-cruiser.cjs` → `currentHostSdkSubstrateDebt`):**

| # | File | Treatment |
|---|---|---|
| 1 | `packages/host-sdk/src/agent-tools/execution/tool-use-to-effect.ts` | Execution relocation (continues Lane B carve pattern) |
| 2 | `packages/host-sdk/src/agent-tools/execution/toolkit-layer.ts` | Execution relocation |
| 3 | `packages/host-sdk/src/host/control-request-reconciler.ts` | Runtime shell relocation |
| 4 | `packages/host-sdk/src/host/internal/runtime-context-helpers.ts` | Runtime shell relocation |
| 5 | `packages/host-sdk/src/host/runtime-context-workflow-core.ts` | Pure re-export shim; consumer migration phase |
| 6 | `packages/host-sdk/src/host/runtime-context-workflow-runtime.ts` | Runtime shell relocation |
| 7 | `packages/host-sdk/src/host/runtime-input-deferred.ts` | Runtime shell relocation |
| 8 | `packages/host-sdk/src/host/session-log-channel.ts` | Channel binding review (may stay as compat shim per gary's "named shim, no behavior" allowance) |

**Gary's split (4-step process):**
1. **Consumer migration / shim retirement** — move consumers off re-export
   shims like #5 (`runtime-context-workflow-core.ts`).
2. **Execution relocation** — finish moving agent-tool execution mechanics
   (#1, #2) from host-sdk into runtime-owned services.
3. **Runtime shell relocation** — move engine-lifecycle, input-deferred,
   control-request mechanics (#3, #4, #6, #7) below the binding line.
   host-sdk retains Layer composition.
4. **Immediate guardrail ratchet** — after each merge, remove the matching
   carveout entry AND run `pnpm run lint:deps`. Atomic.

**Acceptable end-state:** zero or ONE well-named compatibility shim with NO
runtime behavior. **Not acceptable:** host-sdk owning live workflow bodies,
durable substrate mechanics, or common operation execution.

**Read first:** `docs/research/tf-2y01-import-guardrails-baseline.md`,
`docs/research/tf-ygz3-shim-retirement-iteration-4.FINDING.md`,
`02-GARY_ARCHITECTURE_ASSESSMENT.md` § P0 (sibling in this folder).

### E. Lane 1 schema-projection inventory re-baseline — P1

**Why it matters:** The original tf-krts FINDING inventory has been
substantially consumed by the wave (5 of 12 moved; many obsoleted by
intervening landings). Without a re-baseline, you can't dispatch further
schema-projection moves with confidence.

**Gary's bar:** private beta can ship with minor protocol projection gaps if
the app/agent surface doesn't expose them. It cannot ship with a shape that
**client-sdk and host-sdk both define separately**.

**Sized for:** ~1 slice — re-audit current main vs canonical doc § Package
Roles + § Placement Of Specific Surfaces; produce an updated inventory
FINDING. Defer to P1 unless an in-flight slice surfaces a hard need.

---

## 2. Recommended 3-lane disposition (per gary's three-track dispatch shape)

| Lane | Track | Scope | Why |
|---|---|---|---|
| **Runtime boundary lane A** (e.g. cca1) | Track 1 (P0) | Item D carveouts — execution-tier (files #1, #2: `tool-use-to-effect.ts`, `toolkit-layer.ts`). Move/retire + atomic carveout-list update + lint:deps in same PR | Lane 2 (#497/#504/#514/#518) carve pattern applies directly |
| **Runtime boundary lane B** (e.g. oca1) | Track 2 (P0) | Item D carveouts — runtime-shell tier (files #3, #4, #5, #6, #7). Move/retire per file, atomic carveout-list update | Lane 4 (#499/#503/#507/#519) workflow-defs move pattern applies directly |
| **Integration lane** (e.g. cca2) | Track 3 (P0/P1) | Item B Linear verified-webhook trigger path + Item C first narrow adapter (GitHub OR Linear, not both) | Both items B+C cluster on the external-systems boundary; same lane keeps context |

**Reserve / merge discipline:** **There is no spare lane** — the two
boundary lanes overlap risk on `tool-use-to-effect.ts` if not staged.
Coordinate via heads-up-then-merge-order (proven pattern this wave). Per gary:
*"At this point, progress will be constrained more by merge discipline than
by lack of architectural clarity."*

**gary** stays available as architect-reserve for further framing or audits
(first-adapter design review; cannon/ doc maintenance).

**Item A `session_new_all`** is DEFERRED (P2 per Gurdas) — do not dispatch
proactively. **Item E schema-projection re-baseline** is P1; fold into a
boundary lane between carveout moves OR dispatch only if a hard need
surfaces.

---

## 3. References

### 3a. Technical — the canonical doc & related artifacts

**Single source of truth:**
- `docs/architecture/host-sdk-runtime-boundary.md` — boundary framing
  (landed at #495). Read § Decision, § Package Roles, § Placement Of Specific
  Surfaces, § Risk Surfaces. Quote it in dispatches.
- `docs/architecture/host-sdk-runtime-boundary-open-questions-framing.md` —
  gary's Q1–Q4 answers (landed at #501). Each answer names downstream lanes
  unblocked.
- `docs/research/canonical-convergence-assessment-2026-05-20.md` — gary's
  65% baseline (landed at #512). Roadmap that aged well.
- **`02-GARY_ARCHITECTURE_ASSESSMENT.md`** (sibling in this folder) — gary's
  post-wave assessment (~90-93% verdict; the 8-file carveout scoreboard;
  session_new_all design verdict — **note: priority demoted to P2 by Gurdas
  correction post-#529; treat its "P0" framing as superseded**;
  private-beta acceptable/unacceptable gaps; three-track dispatch shape;
  sequencing to private beta in 3 phases). **The decision-grade companion to
  this handoff** (with the session_new_all priority caveat).
- **`03-GARY_NEXT_SESSION_HANDOFF.md`** (sibling in this folder) — gary's
  tactical next-session playbook: "if asked what now, answer this." Dispatch
  shape recommendation, useful commands, watchpoints. Shorter; reads as the
  action layer above the assessment.

**Factory-vision:**
- `docs/vision/factory-vision.md` — §6 narrative + §7 seven capabilities.
  Re-read; it's the north star.
- `docs/research/tf-gw43-dark-factory-live-run-readiness.md` — Lane 6 audit
  identifying the 7 §6 blockers. 5 cleared, 3 remaining (which are items
  A/B/C above).

**Substrate verification artifacts:**
- `docs/research/tf-krts-schema-projection-inventory.FINDING.md` — original
  12-mismatch inventory (5 consumed; needs re-baseline per Item E).
- `docs/research/tf-2y01-import-guardrails-baseline.md` — carveout doc
  (current count 8).
- `docs/research/tf-ygz3-shim-retirement-iteration-4.FINDING.md` — Lane 5
  honest-close finding distinguishing pure-shim-with-consumers from
  substrate-files.
- `docs/research/tf-6d4y-deletion-blocker-investigation.FINDING.md` —
  pre-deletion verification (#496 → #519 cleared).
- `docs/research/tf-lwqm-spawn-all-wiring.PROPOSAL.md` — the load-bearing
  proposal for Item A.
- `docs/research/tf-rjta-sleep-smoke-results.md` — first factory-vision
  artifact's results.

**Key code surfaces:**
```
packages/runtime/src/workflow-engine/workflows/    ← all 7 workflow defs
packages/runtime/src/agent-event-pipeline/tool-execution/runtime-agent-tool-execution.ts
packages/runtime/src/streams/runtime-observation-streams.ts   ← inversion seam
packages/runtime/src/verified-webhook-ingest/      ← Item B substrate
packages/host-sdk/src/host/channel.ts              ← ChannelInventory API
packages/firelab/src/simulations/dark-factory/host.ts  ← Item B/C composition target
packages/firelab/src/simulations/dark-factory/driver.ts ← post-#521 bounded loop
packages/firelab/test/sleep-only-substrate-smoke.test.ts ← deterministic smoke pattern (extend for Items A/B/C)
.dependency-cruiser.cjs                            ← Item D guardrails + carveouts
.effect-diagnostics-baseline.json                  ← #508 ratchet
docs/sdds/                                         ← Gurdas-authored SDDs only; do not author new ones
```

### 3b. Communication — cmux, beads, dispatch protocol

(See COORDINATOR_HANDOFF_s6_dark_factory.md §3 for fuller treatment. Key
ones repeated here.)

**Lanes & messaging:**
```bash
bash scripts/cmux-dispatch.sh <lane-label> '<message>'         # by label
bash scripts/cmux-dispatch.sh <bead-id>    '<message>'         # resolves via assignee
bash scripts/cmux-dispatch.sh <lane>     - <<'EOF'             # heredoc for multi-line
…body…
EOF
```
- **NEVER** use backticks or `$(...)` in cmux-dispatch messages — zsh
  substitutes them. Use heredoc (`-`) form for anything containing them.
  (memory: `feedback_cmux_send_no_backticks`)
- **NEVER** `cmux send` directly — always go through cmux-dispatch.sh
  (memory: `feedback_always_use_cmux_dispatch_script`)
- A dispatch without a bead-id reference is dead-on-arrival
  (memory: `feedback_dispatch_must_carry_a_bead_handle`)
- Always bake in "task-exit = push + DRAFT PR; only MERGE is gated" — lanes
  misread "no self-merge" as "don't push" (memory:
  `feedback_dispatch_say_taskexit_push_pr_explicitly`)

**Lane state:**
```bash
bash scripts/lane-sweep.sh --lines 12             # human-readable per-lane tail
bash scripts/lane-sweep.sh --json --workspace workspace:2  # machine-parseable
bash scripts/lane-sweep.sh 246 --lines 25         # single lane deep tail
```
- `running=true` = literal "esc to interrupt" indicator
- `mergeable=UNKNOWN` is eventually-consistent (often after force-push) — re-poll, don't interpret
- Per-bead `pr=#N draft=… ci=…` shows verbatim CI status; never bare `bv` (memory: `feedback_beads_status_cutover`)

**Beads:**
```bash
br create --silent --title "…" --priority p1 --labels "host-sdk-runtime-boundary,…" --description "…"  # prints bead id only
br update <bead> --assignee <lane-label>           # assignment (task-enter.sh does this automatically)
br comments add <bead> --author coordinator --message "…"
br list --json --status in_progress | jq …
```
- `.beads/issues.jsonl` is the SoT; **never hand-commit it** — beads-sync cron owns the push (memory: `feedback_beads_sync_owner_is_cron`)
- Don't bare `bv` (TUI blocks); use `br` for mutations, `bv --robot-triage` / `--robot-insights` for reads if needed

**Worktree lifecycle:**
```bash
br create --silent --title "…"                     # → tf-XXXX
bash scripts/task-enter.sh tf-XXXX <slug>          # fresh worktree off origin/main
#   --resume                                       # attaches existing branch (preserves commits)
cd ../firegrid-worktrees/tf-XXXX-<slug>
pnpm install
br update tf-XXXX --assignee <lane>
# …work…
bash scripts/task-exit.sh tf-XXXX                  # commit + push + open/refresh DRAFT PR
bash scripts/task-reap.sh                          # clean merged worktrees (never dirty)
```
- Worktrees live at `/Users/gnijor/gurdasnijor/firegrid-worktrees/<branch>/`
- Lanes work in worktrees; coordinator never edits feature code in the primary checkout
  (memory: `feedback_use_worktree_for_branch_work`)

### 3c. Tooling — scripts inventory

```
scripts/cmux-dispatch.sh           ← THE dispatch path (heredoc-stdin for backticks)
scripts/lane-sweep.sh              ← lane state read (--json for parseable)
scripts/cmux-broadcast.sh          ← message all lanes at once
scripts/task-enter.sh              ← lane worktree creation (always with bead id)
scripts/task-exit.sh               ← lane commit/push/PR + self-heal CI trigger
scripts/dispatch-gap.sh            ← finds lanes idle without active bead
scripts/state-watch.sh             ← cron-driven state-change watcher
scripts/preflight.mjs              ← repo-level sanity check before action
scripts/tooling.mjs                ← effect:diagnostics + check:docs/specs/* + arch:deps:*
scripts/effect-quality-metrics-*.mjs  ← quality ratchet
scripts/knip-check-baseline.mjs    ← dead-code ratchet (knip)
scripts/jscpd-check-baseline.mjs   ← duplicate-code ratchet (jscpd)
scripts/semgrep-check-baseline.mjs ← semgrep ratchet
scripts/runtime-public-surface-check.mjs  ← runtime exports validator
scripts/effect-native-production-cutover-check.mjs ← canonical Effect pattern enforcement
scripts/test-layout-check.mjs      ← test file placement enforcement
```

**The full CI gate set** (so you don't claim green from a subset; memory:
`feedback_run_full_ci_gate_set`):
```
pnpm run lint              # eslint + effect-native + runtime-public-surface + test-layout
pnpm run lint:dead         # knip ratchet
pnpm run lint:dup          # jscpd ratchet
pnpm run lint:deps         # dep-cruiser (now in --error mode)
pnpm run lint:effect-quality  # Effect quality ratchet
pnpm run lint:ast-grep     # ast-grep hrtime arithmetic check
pnpm run lint:semgrep      # semgrep ratchet
pnpm run lint:semgrep:test # semgrep tests
pnpm run typecheck         # turbo run typecheck
pnpm run test              # turbo run test
pnpm run effect:diagnostics  # baseline-ratchet via scripts/tooling.mjs
pnpm run check:docs        # markdown/doc consistency
pnpm run check:specs       # feature spec consistency
```

Single command: `pnpm run verify` runs the production set
(typecheck + lint + lint:dead + lint:dup + lint:deps + lint:effect-quality + lint:ast-grep + lint:semgrep:test + lint:semgrep + test).
`pnpm run effect:diagnostics` is now part of `lint` per #508.

### 3d. Tech — design principles & non-negotiables

**Canonical doc rules (CI-enforced):**
- `@firegrid/runtime` MUST NOT import `@firegrid/host-sdk` (HARD ZERO)
- `@firegrid/client-sdk` MUST NOT import `@firegrid/runtime` (HARD ZERO)
- Host-sdk → runtime-substrate violations have explicit carveouts ratcheting down
- Inversion pattern when runtime needs host capability: runtime-owned
  `Context.Tag` + host-sdk-provided Live Layer. Templates: `RuntimeToolUseExecutor`,
  `RuntimeAgentToolExecution`, `RuntimeObservationStreams`.

**SDDs are Gurdas-authored** (memory: `feedback_inference_is_not_verified_groundtruth`).
Lanes producing SDDs is a hard signal-of-confusion. Lane 4 did this once in
#499 and was correctly steered to drop it (Option A). Coordinator: catch SDD
authoring at PR review.

**No assumptions in the absence of data** (memory:
`feedback_no_assumptions_instrument_the_data_gap` + §0 of the §6 handoff). When
you don't know: instrument the boundary, run the sim, gather data, *then*
conclude. The 60-second-grep heuristic operationalises this.

**No CI-determinism on choreography probes** (memory:
`feedback_no_ci_determinism_on_choreography_probes`). The deterministic
substrate smoke (#516 / #527) is the right shape — it tests substrate
plumbing, not the choreography. A real §6 live run needs a real LLM agent +
env-gated `.smoke` + hard halt rule.

**Don't leak substrate to agent surface** (memory:
`feedback_dont_leak_substrate_to_agent_surface`). Typed handles
(channel/sandbox/agent tokens) are host-resolved. Verb signatures are
direction-enforced.

**Apps/ red is not a blocker** (memory: `feedback_apps_not_canonical`).
Canonical = `packages/*`. `apps/flamecast`, `apps/factory` CI red doesn't gate.

**60-second grep before any decision-grade claim** (memory:
`feedback_60_sec_grep_before_instrumentation` and `feedback_60sec_grep_beats_instrumentation_arc`).
Before accepting any closing-out artifact (yours, a lane's, gary's): *"what
single grep or file-read would refute this?"* If <60s, do it.

**Verify ground-truth, not memory** (memory:
`feedback_refetch_before_analytical_packet` + the §6 handoff §4 working
discipline). Re-fetch branch HEAD before finalizing an analytical packet. Run
verification from a clean worktree at the real HEAD. `git fetch` alone does
NOT move the primary working tree.

---

## 4. Resume checklist (for the next session)

1. **Read** `docs/handoffs/COORDINATOR_HANDOFF_s6_dark_factory.md` §0 (META),
   §3 (tooling), §4 (discipline), §8 (post-mortem), §9 (closing-turn lessons).
2. **Read** this doc end-to-end, ESPECIALLY §0a (gary's assessment).
3. **Read** `02-GARY_ARCHITECTURE_ASSESSMENT.md` (sibling) in full — it
   names the 8-file carveout scoreboard as the finish line, enumerates
   private-beta acceptable/unacceptable gaps, and frames the three-track
   dispatch. **Caveat:** its `session_new_all` "P0" framing is SUPERSEDED by
   Gurdas's correction post-#529; treat batch delegation as P2/deferred. The
   updated cannon/ docs (`docs/cannon/architecture/current-convergence-assessment-2026-05-20.md`,
   `docs/cannon/architecture/sdd-alignment-sanity-check-2026-05-20.md`,
   `docs/cannon/README.md`) reflect the correction. Also read
   `03-GARY_NEXT_SESSION_HANDOFF.md` (tactical playbook) — apply the same
   caveat to its session_new_all references.
4. **Read** `docs/architecture/host-sdk-runtime-boundary.md` (the canonical
   target) and `docs/architecture/host-sdk-runtime-boundary-open-questions-framing.md`
   (Q1–Q4 decisions).
5. **Inspect** `.dependency-cruiser.cjs` → `currentHostSdkSubstrateDebt` array.
   This is gary's "single most useful objective scoreboard." Count the
   entries; that's your finish-line metric.
6. **Read** `docs/research/canonical-convergence-assessment-2026-05-20.md` for
   the gary-framing roadmap (note: it predates the post-65% landings; gary's
   newer assessment in step 3 supersedes its "remaining" framing).
7. **Read** `docs/research/tf-gw43-dark-factory-live-run-readiness.md` (the
   §6 7-blocker audit). Skip the spawn_all PROPOSAL unless you're picking up
   the deferred P2 work.
8. **`bash scripts/lane-sweep.sh --json`** — verify the 3 lanes you intend to
   dispatch are actually running and what their last status was.
9. **`git fetch origin main && git log origin/main -5 --oneline`** — verify
   you have current main; the wave landed 34 PRs and you want HEAD `7ecaa9102`
   or descendant.
10. **`gh pr list --state open --search "tf- in:title"`** — confirm only
    out-of-scope items remain (#444, #446, #452, #462). Anything else means
    new work hit since you last looked.
11. **Dispatch the 3 lanes** per §2 disposition. Lane assignments shifted to
    reflect Gurdas's correction: TWO boundary lanes on Item D carveouts (the
    actual P0) split by tier; ONE integration lane on Items B+C. Do NOT
    proactively dispatch Item A `session_new_all` — it's P2/deferred.

---

## 5. Cron + memory state at handoff

- Overnight 10-min cron `294efe84` was **cancelled** at this session close
  (Gurdas direction). No automated ticks running.
- Memory artifact for the wave: `memory/project_overnight_canonical_convergence_2026-05-20.md`
  (and indexed in `MEMORY.md`). It captures the per-PR table, verified invariants,
  and process notes — durable across sessions.
- Existing worktrees: many lane worktrees still exist at
  `/Users/gnijor/gurdasnijor/firegrid-worktrees/tf-*` from this wave's slices.
  They're harmless but `bash scripts/task-reap.sh` will clean any whose
  branches are merged.

---

## 6. Closing-turn lessons from THIS wave (preserve)

The §6 handoff captured 9a–9g lessons; this wave added a few. Carry these
forward:

### 6a. Audit-first dispatch is the highest-value shape for §6-style work

When the territory is unfamiliar and the decision matters, dispatching a lane
for an AUDIT slice (no impl, just analysis + PROPOSAL doc) consumed minutes of
LLM time but produced decision-grade artifacts that saved hours of wrong-shape
impl. Lane 6's tf-gw43 readiness audit → tf-lwqm spawn_all PROPOSAL was the
canonical example: each artifact landed as a docs PR, gave Gurdas/coordinator
the input to choose the right next slice, then concrete impl followed cleanly.

**When to use:** any time a lane is about to start something that touches an
unfamiliar boundary or has multiple plausible shapes (e.g., session_new_all
vs evolved spawn_all). Pay the audit slice; never sink an impl slice you don't
know is shaped right.

### 6b. Baseline ratchets unblock the entire wave

The wave was bogged down on "fully green except pre-existing red" for the
first ~10 PRs because main had effect-diag noise that every PR inherited. Lane
5's tf-ofbm baseline ratchet (#508) flipped the gate to "current state is
baseline; new noise above baseline is a fail." Suddenly every subsequent PR
was crisply all-green and merge confidence soared. This caught a real
regression at #526 (Effect.fail(new Error(...)) → Data.TaggedError fix)
without delay.

**Generalisation:** when a CI gate is failing on pre-existing noise, baseline
it FIRST (with the gate logic that ratchets DOWN over time, not UP). Trying to
land architectural work through a noisy gate confuses both review and
attribution.

### 6c. Heads-up-then-merge-order resolves file-conflict surface cleanly

Three lanes touched `tool-use-to-effect.ts` (Lane 2 sleep arm, Lane 3
ChannelInventory consumption, Lane 6 approval.operator fix). Coordinator
pre-announced merge order via cmux-dispatch heads-ups; lanes rebased cleanly.
Zero merge conflicts hit Gurdas.

**Pattern:** when N lanes will modify the same file in overlapping slices,
coordinator sends a heads-up to the lane(s) NOT pushing first, naming the
expected conflict surface + resolution shape ("keep both: Lane X owns
[surface], Lane Y owns [surface]; rebase post-merge"). Lanes do the rebase
themselves; you just announce.

### 6d. Lane 6's "audit + fix + audit + fix" rhythm is the gold standard

Lane 6 produced more decision-grade value than any other lane in the wave:
tf-0r95 channel migration → tf-gw43 §6 readiness audit → tf-e1g8 approval
fix → tf-rjta sleep-smoke → tf-vq32 driver fixes → tf-lwqm spawn_all proposal
→ tf-2em0 sleep+waitFor smoke. Each artifact built on the prior. They alone
delivered 5 of the 7 §6 blockers' resolution.

**Pattern:** when one lane has the deepest context for an area, give them
multiple consecutive slices rather than spreading the area across lanes. The
context-stickiness compounds.

### 6e. "Don't manufacture work in the lull" is real discipline

After ~25 PRs, the remaining work hit Gurdas-decision boundaries. Coordinator
correctly held idle lanes through 11 consecutive hold ticks rather than
dispatching marginal slices. The cost of dispatching the wrong slice
(churning a lane, then having to re-dispatch when Gurdas's actual direction
arrives) exceeds the cost of idle time.

**Pattern:** if you're tempted to dispatch a slice "to keep momentum," ask
whether the slice is mechanical (decomposition validated by canonical doc) or
decision-grade (needs Gurdas input). If decision-grade, hold.

---

## 7. The single best thing to do next

**Dispatch Item D first.** The 8-file carveout list is the actual finish-line
scoreboard per gary, and per Gurdas's correction `session_new_all` is no
longer the load-bearing piece it was framed as.

Concrete sequencing:
1. Read `docs/research/tf-2y01-import-guardrails-baseline.md` and
   `docs/research/tf-ygz3-shim-retirement-iteration-4.FINDING.md` to
   understand the 8 files and their per-file disposition.
2. Inspect `.dependency-cruiser.cjs` → `currentHostSdkSubstrateDebt` to
   confirm the list at current HEAD.
3. Create beads for the two boundary lanes (split execution-tier files vs
   runtime-shell-tier files per §2):
   - `br create --silent --title "Item D: retire host-sdk substrate carveouts
     — execution tier (tool-use-to-effect.ts + toolkit-layer.ts)" --priority
     p0 --labels "host-sdk-runtime-boundary,canonical-lane-D-finish"`
   - `br create --silent --title "Item D: retire host-sdk substrate carveouts
     — runtime-shell tier (control-request-reconciler + workflow-runtime + etc.)"
     --priority p0 --labels "host-sdk-runtime-boundary,canonical-lane-D-finish"`
4. Dispatch with the Lane 2/Lane 4 carve patterns as templates (PROPOSAL
   #497, slices #504/#514/#518 for execution; #499/#503/#507 for runtime
   workflow-defs; #519 for full-delete reference).
5. **Atomic-PR discipline:** each PR moves/retires the substrate AND removes
   the carveout entry from `.dependency-cruiser.cjs` AND runs `pnpm run
   lint:deps`. No carveout-without-move OR move-without-carveout-removal.

In parallel, the integration lane dispatches **Item B Linear verified-webhook
trigger** (Item C first adapter follows).

**Watch the scoreboard:** `.dependency-cruiser.cjs` →
`currentHostSdkSubstrateDebt` array length. Each carveout removed = real
canonical progress. Zero (or one-named-shim with no behavior) = ready for
private beta gate per gary's bar.

---

🙏 Thanks for the trust to drive this overnight. The wave wouldn't have
landed without the operational discipline the §6 handoff put in writing —
this doc tries to preserve those lessons + the new ones for whoever picks up
next. Best of luck across the finish line.
