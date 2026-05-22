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
| `../../../runtime-shape-baseline.json` | `{N, C, broken_sccs}` anchor (ratchet target) |
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

## Scenario set (current baseline `N=31`, `C=0`)

| Scenario | Kind | Covers |
|---|---|---|
| `codex-acp-tool-calls` | live-llm (`OPENAI_API_KEY`) | tool-call path |
| `wait-pre-attach-roundtrip` | live-llm (`ANTHROPIC_API_KEY`) | wait_for / pre-attach roundtrip |
| `delegation-proof-cap4` | **deterministic** | multi-context parent+child, control-plane recorder, session_new/resume |

- **Live scenarios are env-gated:** the recipe skips them when their key is
  unset and prints a SKIP line. With no keys, only the deterministic subset runs
  (`delegation-proof-cap4`, stable `N=23`) — useful for keyless CI drift checks,
  but it is **not** the full `N=31` gate.
- **`acp-tool-elicitation` is a manual probe, not in the gate** (its own
  `host.ts` says so; ~146MB raw trace). Run it by hand for prompt/output
  coverage; never add it to the gate.

## Coverage slots

- ✅ multi-context parent+child — `delegation-proof-cap4`
- ✅ control-plane lifecycle (session_new + resume) — `delegation-proof-cap4`
- ⬜ **control-plane lifecycle (cancel + close)** — OPEN. No corpus scenario yet
  exercises `session_cancel` / `session_close`; the `control-request-dispatcher`
  edges stay under-sampled (`runtime-dynamics-map.md` §8). Fill with a
  deterministic cancel/close/resume scenario, then re-run `baseline`.
