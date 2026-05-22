# Runtime Shrink Loop — coordinator playbook

**Audience:** Gary (coordinator). **Goal:** shrink `packages/runtime` + `packages/host-sdk` to a size a person can hold, *without guessing* what's load-bearing. The instrument (`scripts/runtime-flow-map.py`) hands you targets and pass/fail numbers; you dispatch lanes and gate on the numbers.

**Companion:** `docs/architecture/runtime-dynamics-map.md` (the findings this loop acts on). Read §0 (value≠volume) and §3 (condensation) there before running this.

---

## The two numbers you are driving

| Metric | Meaning | Today | Target | Checkpoint rule |
|---|---|---|---|---|
| **`N` = condensation node count** | irreducible logical units (the "manageable size" number). Graph-exact: SCCs are unambiguous, "did N change" is decidable. | **38** | team-set, e.g. **≤ 20** | must not rise |
| **`C` = validated contract count** | number of seams the **author has classified** — `firegrid.seam.kind` set **and** `firegrid.contract.id` that resolves to a real ACID/SDD/decision-doc path | **0** | every hot seam classified | must not fall (ratchets up) |

`N` is a clean graph-theory number; treat it as authoritative. **`C` is deliberately defined as an author-classified count, not a proxy-driven percentage**, to dodge three ways a coverage-% would lie:
- **No "hot" threshold in the gate.** A traffic threshold creates a step-function — a seam ticking above/below it flips the denominator and `C` jitters for reasons unrelated to the work. So `C` has no denominator: it's a monotonic count of *validated* annotations. (A coverage *percentage* against the proxy-estimated hot-seam set is fine as an **informational** read in the report, but it is **not gated**.)
- **`contract.id` must resolve.** `firegrid.contract.id = "TODO"` does not count. CI resolves every id to an existing ACID/SDD/decision-doc path (a registry or path-exists check); unresolved ids fail the gate. Otherwise `C` climbs without a single invariant declared.
- **The proxy is never the enforcer.** The `--contracts` NEEDS-CONTRACT/COLLAPSE classification is a *worklist*, not a pass/fail. The gate fails only on (a) `N` rising or (b) `C` falling — never on "a proxy thinks this seam needs a contract." Authors adjudicate; the proxy only points.

You are **not deleting fat** (relay-contraction removes 1 node). You are **collapsing the irreducible-unit count** (`N`↓) by co-locating SCCs / reshaping `bridge_debt`, and **growing validated invariants** (`C`↑). Converges when `N ≤ target` and every hot seam is classified.

---

## Phase 0 — stand up the gate (one-time; do this first)

The loop is open until these exist. Commission them as beads before iterating:

1. **`corpus`** — a committed, versioned scenario set so `N`/`C` are comparable across PRs. Start from the 3 traces in the map; add **control-plane lifecycle** (cancel/close/resume) and **multi-context** (parent+child) — the §8 coverage gaps. Live-LLM scenarios are env-gated/manual; structural metrics (`N`, SCCs) are stable regardless of leaf timing.
2. **`baseline`** — `runtime-shape-baseline.json` = `{N, C, broken_sccs[]}` (no hot-seam list, no traffic threshold — see Gate contract). Same ratchet pattern as `semgrep-error-baseline.json`.
3. **`checkpoint`** — ✅ **BUILT**: `runtime-flow-map.py --check-baseline=<file>` / `--write-baseline=<file>` (see Gate contract below; tested deterministic). **Not wired to CI** — Gary runs it by hand at the checkpoints in the next section. One small prep bead:
   - **`corpus`** (above): keep a *fixed* set of small representative traces you re-use across checkpoints, so `N`/`C` are comparable run-to-run. **Do not use the raw live traces** — the elicitation trace is ~146MB. Topology (`N`, SCCs) is volume-independent, so a short capture that exercises the same paths gives the same `N`; stash a stable corpus (e.g. under `docs/architecture/corpus/` or a known `.simulate/runs/` set you don't delete).

Keep `runtime-shape-baseline.json` next to it as the comparison anchor; re-ratchet it with `--write-baseline` only after an accepted change (§6).

---

## Checkpoints — when Gary runs the check (manual, not CI)

Run `--check-baseline` against the **fixed corpus** at these moments. It's a decision aid, not an auto-gate — you read the verdict and decide.

| Checkpoint | Command | What you're confirming |
|---|---|---|
| **Loop start** | `--write-baseline` | snapshot the anchor (`N=38, C=0` today) |
| **Structural bead reports back** (§5 VERIFY) | `--check-baseline` | the target SCC is gone (merged/broken) **and** `N` didn't rise except by a sanctioned break **and** tests green → accept |
| **Annotation batch lands** | `--check-baseline` | `C` rose, **0 unresolved `contract.id`** (no `"TODO"`) |
| **Before closing tf-vfq9 / deleting `ToolCallWorkflow`** | `--check-baseline` + overlay | the tf-jpcg seam is **no longer invisible coupling** — i.e. it was reshaped, not bridged (the test case, see guardrails) |
| **Periodic heartbeat** (e.g. weekly) | `--check-baseline` | catch drift — `N` creeping up or a new unresolved contract from other lanes' work |

After an **accepted** change, run `--write-baseline` to re-ratchet the anchor, then continue.

## Two tracks (do NOT serialize them)

The targets have wildly different cycle times: the four-way SCC co-location is multi-week; the 120 NEEDS-CONTRACT seams are independent annotation passes. If you run one bead at a time across both, the loop runs at the speed of the slowest target and **`C` sits at 0 for months** while the structural work grinds. Split into two tracks that feed each other but share no critical path:

- **Structural track** (serial, slow, drives `N`↓): one bead at a time — SCC co-location / `bridge_debt` reshape. This is where the irreducible-unit count actually drops.
- **Annotation track** (parallel, fast, drives `C`↑): many lanes, each annotating a batch of NEEDS-CONTRACT seams with a validated `contract.id`. Independent of the structural track's pace.

**The tracks feed each other through failed collapses (the best contract-discovery you have).** When the structural track attempts a collapse and **a test breaks, that test is the executable specification of the invariant the seam was silently enforcing.** Don't just "annotate it" — emit a `contract.id` annotation citing the breaking test as evidence: *"this seam enforces the invariant that `<test>` validates."* That is more reliable than reading code or the proxies, and it means **`C` climbs as a byproduct of structural work** rather than only from sit-down schema sessions. Route every failed collapse into the annotation track as a discovered contract.

## The structural-track loop (one iteration = one bead)

```
CAPTURE → MEASURE → SELECT → DISPATCH → VERIFY → RATCHET → repeat
```

### 1. CAPTURE
Run the corpus, collect `trace.jsonl` per scenario (the `.simulate/runs/**/trace.jsonl` files).

### 2. MEASURE
```bash
npx depcruise --config .dependency-cruiser.cjs --output-type json packages/*/src > /tmp/dc.json
uv run --with networkx --with scipy python3 scripts/runtime-flow-map.py \
  <trace…> --depcruise=/tmp/dc.json --contracts --skeleton
```
Record `N` (condensation node count), `C` (contract-coverage %), the **SCC list**, and the **NEEDS-CONTRACT / COLLAPSE worklist**.

### 3. SELECT one target (highest leverage first — pick exactly one per bead)
1. **Biggest un-co-located SCC** → make the SCC **gone**. *Target #1 today:* the four-way `engine ⇄ runtime-context ⇄ runtime_context.workflow ⇄ runtime-control` SCC. Two valid outcomes, both succeed:
   - **merge** the cycle into one module (drops `N` by 3), or
   - **cleanly break** the cycle with a typed one-directional boundary (the body→engine call stops being reciprocal). A clean break can *raise* `N` (the cycle splits into separate condensation nodes) — **this is success, not regression.** Credit "the named SCC no longer appears as a multi-node SCC," never "N went down."
   Reshape toward the SDD's workflow-owned shape; see `SDD_TARGET_TINY_FIREGRID_ARCHITECTURE_REFERENCE.md` and the [[project_hostkernelworkflow_control_plane_direction]] direction.
2. **Highest-traffic uncontracted seam** → annotate `firegrid.contract.id` (raises `C`) **or** collapse if it's a relay.
3. **A `bridge_debt` seam blocking an SDD target** (e.g. tf-jpcg's "external await into the workflow") → **reshape to the table-owned seam, do not bridge.** See guardrails.

### 4. DISPATCH (bead template — copy/paste)
```
br create --silent "<verb the target>"   # e.g. "co-locate engine+body SCC behind workflow-owned tool seam"
# task-enter line for the lane:
task-enter.sh <bead> <slug> --class codex
```
Bead body must carry the **instrument-derived acceptance criterion**:

> **Target:** <SCC to make-gone | seams to annotate/collapse | bridge_debt seam to reshape>
> **Acceptance (instrument-checked), by target type:**
> - *SCC:* the named SCC **no longer appears as a multi-node SCC** in `--skeleton` (merged into one node, or cycle cleanly broken) — `N` may move either way.
> - *annotation:* `C` rises by the batch size; **every new `contract.id` resolves** to a real ACID/SDD/decision-doc path.
> - *bridge_debt:* the named seam no longer appears as invisible coupling in the `--depcruise` overlay.
> - *all:* `turbo typecheck test lint` green, and `N` did not rise *except* by a credited clean SCC-break.
> **Cutover rule:** this is replacement work in runtime/host-sdk → close ONLY as a direct cutover, or as a declared bridge with an owner + a blocking deletion bead. No half-ships. (canon: [[feedback_transactional_cutover_rule]])

### 5. VERIFY
Lane reports back. Gate on **both**: tests green **and** the metric moved the right way.
- **Self-correction (important):** if a planned **collapse breaks a test**, the seam was load-bearing — it is *not* a collapse candidate, it's a NEEDS-CONTRACT seam. Redirect the lane to **annotate it with the invariant it turned out to enforce** instead of removing it. (This is the observation-streams correction, mechanized — see map §5.)

### 6. RATCHET
Update `runtime-shape-baseline.json` with the new `N`/`C`. CI now rejects any PR that raises `N` or adds a hot seam with no `contract.id`. Move to the next iteration.

---

## Guardrails (the tf-jpcg failure mode — do not repeat)

- **Never harden a `bridge_debt` seam.** A seam that carries flow but names no `contract.id` and crosses no real boundary is *operationally* load-bearing only because two eras are still connected. Route it to **reshape toward the SDD table-owned seam**, never "add another await/deferred bridge into the workflow." The instrument flags these; the map §7 worked the tf-jpcg example.

  > **tf-jpcg is the test case for whether this playbook bites.** Its proposed "external await into `RuntimeContextWorkflow`" (audit Option A, single-flight seam + follow-up) classifies as `bridge_debt`. Under this playbook it does **not** land as a bridge — it gets reshaped toward the SDD target *before* `ToolCallWorkflow` is deleted (tf-vfq9 stays blocked on the reshape, not on the bridge). **If we ship tf-jpcg as a bridge "just this once because the audit says it's fine," this playbook does not apply and the framework loses force.** Either the rule holds here or it holds nowhere.
- **Volume is not value.** `runtime-context.ts` carries 27k spans at 3% self-time — a coordination shell, not a worker. High traffic ≠ "preserve." Use `pagerank × self-time` (map §1), not raw counts.
- **Co-locate, don't couple-preserve.** An SCC means the file boundary is *already* wrong. The fix is co-location, not a new API across the boundary.
- **Proxies triage; authors adjudicate.** `seam.kind`/`contract.id` are 0% today, so NEEDS-CONTRACT vs COLLAPSE is a *derivable proxy*. The lane's author must confirm by naming the invariant (or proving its absence) — the instrument cannot.
- **Don't trust a single corpus.** `N` and the SCCs are union properties, not yet per-scenario verified (map §8). A reshape that improves the union but a scenario disagrees ⇒ re-measure per-scenario before ratcheting.

---

## Gate contract (BUILT — `scripts/runtime-flow-map.py`)

```bash
# generate/refresh the baseline (after an accepted ratchet):
uv run --with networkx --with scipy python3 scripts/runtime-flow-map.py \
  <committed corpus traces> --depcruise=dc.json --write-baseline=runtime-shape-baseline.json
# run at a checkpoint (exit 0 = pass, 1 = fail with offending items listed):
uv run --with networkx --with scipy python3 scripts/runtime-flow-map.py \
  <fixed corpus traces> --depcruise=dc.json --check-baseline=runtime-shape-baseline.json
```

Not wired to CI — Gary runs it at the checkpoints above and reads the verdict. **Determinism:** run against the **same fixed corpus** each time (not fresh live captures) + current source — same inputs ⇒ same `N`/`C`. `N` is graph-exact (condensation node count); contract resolution is a deterministic ACID/path lookup.

Baseline file: `{ "N": 38, "C": 0, "broken_sccs": [] }` (no hot-seam list, no traffic threshold — those were the soft edges).

Gate fails (exit non-zero) on exactly three conditions, all hard:
- **`N` rose** above `baseline.N` — *unless* the rise is fully explained by SCCs named in `baseline.broken_sccs` (a credited clean break). List the offending new condensation nodes.
- **`C` fell** below `baseline.C` (an annotation was removed/invalidated).
- **An unresolved `contract.id`** — any `firegrid.contract.id` in the corpus that does not resolve to an existing ACID/SDD/decision-doc path (rejects `"TODO"`).

It does **not** fail on the proxy worklist. NEEDS-CONTRACT/COLLAPSE counts print as **informational** (the worklist for the annotation track); they never gate. `--write-baseline` regenerates the file after an accepted ratchet.

---

## Termination

Stop when **`N ≤ target`** (irreducible units a person can hold) **and every hot seam is classified** (`C` has stopped rising because the NEEDS-CONTRACT worklist is empty). At that point the condensation graph *is* the architecture and it is documented by construction — every surviving node/edge points to the ACID/SDD it enforces. The map (`runtime-dynamics-map.md`) is regenerated as the living record each ratchet.

---

## Command appendix

```bash
# measure (the report you read N and C off)
npx depcruise --config .dependency-cruiser.cjs --output-type json packages/*/src > /tmp/dc.json
uv run --with networkx --with scipy python3 scripts/runtime-flow-map.py \
  <trace1> <trace2> … --depcruise=/tmp/dc.json --contracts --skeleton --top=20

# focus a single module under reshape
… --focus=control-request-dispatcher

# regenerate the team artifact after a ratchet
… --dot=docs/architecture/runtime-flow.dot && dot -Tsvg docs/architecture/runtime-flow.dot -o docs/architecture/runtime-flow.svg
… <one-trace> --timeline=docs/architecture/runtime-timeline.svg   # single trace only
```
