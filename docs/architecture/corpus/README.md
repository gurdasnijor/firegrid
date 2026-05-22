# Runtime-shrink fixed corpus

The comparable scenario corpus for the runtime-shrink loop
(`docs/architecture/runtime-shrink-loop.md`, Phase 0). It makes `N`
(condensation node count) and `C` (validated-contract count) comparable across
PRs and checkpoints.

## "Fixed" means fixed inputs + recipe, NOT frozen traces

The corpus is a **fixed scenario set + run recipe + stable artifact path** —
**not** immutable old trace files.

- **`N` is volume-independent.** Topology (condensation nodes, SCCs) depends on
  *which module paths run*, not on how many spans. A short re-capture of the
  same scenarios reproduces the same `N`. So we never need the ~146MB raw live
  traces; short runs suffice.
- **`C` is read from span attributes.** A seam's contract is `firegrid.seam.kind`
  / `firegrid.contract.id` *on the span*. After source annotations land, the
  corpus must be **regenerated from the same scenarios** for `C` to rise.
  Freezing old traces would pin `C` at its capture-time value forever — so the
  regenerated traces under `.runs/` are **git-ignored and disposable**, and the
  committed artifacts are the *manifest + recipe + baseline*, not the traces.

## Files

| Path | Role |
|---|---|
| `manifest.json` | the fixed scenario set, coverage slots, env-gating, and the measured baseline |
| `../../../scripts/runtime-corpus.sh` | the run recipe + checkpoint command |
| `../../../runtime-shape-baseline.json` | full keyed-corpus `{N, C, broken_sccs}` anchor |
| `../../../runtime-shape-baseline.keyless.json` | keyless deterministic-subset anchor (used when no live traces are present) |
| `.runs/` | regenerated small traces + depcruise graph (git-ignored, disposable) |

## Commands

```bash
# checkpoint: regenerate + gate against the baseline (exit 0 = pass)
bash scripts/runtime-corpus.sh check

# regenerate the traces only (small captures -> docs/architecture/corpus/.runs/)
bash scripts/runtime-corpus.sh regen

# print the full N/C + SCC + contract worklist report (no gate)
bash scripts/runtime-corpus.sh measure

# re-ratchet the baseline after an ACCEPTED change (§6 of the playbook)
bash scripts/runtime-corpus.sh baseline

# reuse existing .runs traces without re-running scenarios:
CORPUS_NO_REGEN=1 bash scripts/runtime-corpus.sh check
```

## Scenario set (current baseline `N=33`, `C=23`)

> `C` rose from 0 to 23 once the seam-annotation PRs (#646/#647/#648) merged and
> the corpus was regenerated to observe their `firegrid.contract.id` spans (all
> resolve; `unresolved-contracts=0`). `C` is regenerated from source each run,
> never assumed. Because the keyless subset observes only the deterministic
> seams (`C=17`), the gate uses **two anchors** — see "Two baseline anchors".

| Scenario | Kind | Covers |
|---|---|---|
| `codex-acp-tool-calls` | live-llm (`OPENAI_API_KEY`) | tool-call path |
| `wait-pre-attach-roundtrip` | live-llm (`ANTHROPIC_API_KEY`) | wait_for / pre-attach roundtrip |
| `delegation-proof-cap4` | **deterministic** | multi-context parent+child, control-plane recorder, session_new/resume |
| `control-plane-cancel-close` | **deterministic** | control-plane lifecycle cancel + resume-after-cancel + close (dispatcher / RuntimeLifecycleWorkflow / runtime-control) |

- **Live scenarios are env-gated:** the recipe skips them when their key is
  unset and prints a SKIP line. With no keys, only the deterministic subset runs
  (`delegation-proof-cap4` + `control-plane-cancel-close`, stable `N=25`, `C=17`)
  — runnable in CI without keys; it is a subset of the full `N=33`/`C=23` gate.

### Two baseline anchors

The keyless subset observes only the deterministic seams, so its `C` (17) is
below the full corpus's `C` (23). A single anchor would make the keyless `check`
fail on "C fell". The recipe therefore keeps **two anchors** and selects one by
corpus mode (does any live-llm scenario have a trace present?):

| Mode | When | Anchor | Numbers |
|---|---|---|---|
| full (keyed) | ≥1 live trace present | `runtime-shape-baseline.json` | `N=33`, `C=23` |
| keyless | no live traces (keys absent / skipped) | `runtime-shape-baseline.keyless.json` | `N=25`, `C=17` |

`check` / `baseline` print the selected mode + anchor. `baseline` re-ratchets
whichever anchor matches the current mode, so the two evolve independently. The
full keyed anchor remains the authoritative gate; the keyless anchor is the
keyless-CI drift check. (Skipping a live scenario also deletes its stale trace
from `.runs/` so mode detection is accurate run-to-run.)
- **A live run that `TimedOut` still yields a topology-complete trace.** The
  recipe tolerates a live scenario's non-zero exit and collects its trace
  anyway (`N` is volume-independent); a missing live trace is non-fatal
  (env-gated), a missing deterministic trace fails the recipe.
- **`acp-tool-elicitation` is a manual probe, not in the gate** (its own
  `host.ts` says so; ~146MB raw trace). Run it by hand for prompt/output
  coverage; never add it to the gate.

## Coverage slots

- ✅ multi-context parent+child — `delegation-proof-cap4`
- ✅ control-plane lifecycle (session_new + resume) — `delegation-proof-cap4`
- ✅ control-plane lifecycle (cancel + close) — `control-plane-cancel-close`
  (deterministic; drives cancel + resume-after-cancel + close through the
  agent-tool surface, firing the previously under-sampled
  `control-request-dispatcher` / `runtime-control` path, `runtime-dynamics-map.md` §8).
