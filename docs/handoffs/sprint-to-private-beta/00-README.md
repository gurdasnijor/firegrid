# Sprint to Private Beta — handoff packet

Date: 2026-05-20
Repo state assessed: `origin/main` at `7ecaa9102`

This folder is the bootstrap packet for the next coordinator + 3-lane team
finishing the canonical-doc convergence and driving Firegrid to private beta.

## Read order

1. **Root `README.md`** (refreshed on PR #529, branch `codex/tf-4eye-...`) —
   first thing the next coordinator sees when they cd in.
   Reflects the current architecture (protocol → bindings → runtime; channels
   as agent surface; host-sdk as binding/composition, not substrate owner;
   durable-tools deletion + import-direction invariants), updated package
   roles, current commands, worktree workflow, and private-beta remaining work.
   Points to `docs/cannon/` as the compact canonical source of truth.
2. **`00-README.md`** — this file (you're here)
3. **`docs/cannon/README.md`** (post-#529 landing) — gary's canonical mirror/index
   establishing the source-of-truth surface (architecture, SDDs, research, RFCs,
   PRDs, vision, handoffs). When #529 (`tf-4eye`) lands, this is the primary
   onboarding-discoverability surface for next-team reading. Until then, follow
   the original paths in references below; cannon/ adds discoverability without
   moving the originals.
3. **`01-COORDINATOR_HANDOFF_canonical_convergence.md`** — operational handoff
   from the overnight wave coordinator (34 PRs, ~93% convergence). Captures
   the full PR table, verified invariants, lane disposition, references, and
   lessons-learned. Read end-to-end.
4. **`02-GARY_ARCHITECTURE_ASSESSMENT.md`** — gary's architectural scorecard
   + decisions. **Decision-grade companion** to the coordinator handoff:
   names the 8-file carveout list as the finish-line scoreboard, enumerates
   private-beta acceptable/unacceptable gaps, frames the 3-phase sequencing to
   beta. **Note (Gurdas correction):** this doc's original P0 framing of
   `session_new_all` is SUPERSEDED — see updated `docs/cannon/` docs (post-#529)
   which demote batch delegation to **P2 optional ergonomics**. Repeated
   `session_new` calls are sufficient unless evidence proves a batch primitive
   is needed.
5. **`03-GARY_NEXT_SESSION_HANDOFF.md`** — gary's tactical next-session
   playbook. "If asked what now, answer this." Dispatch shape recommendation,
   useful commands, watchpoints. Shorter than the assessment; reads as the
   action layer above it.

Then also read:
- `docs/handoffs/COORDINATOR_HANDOFF_s6_dark_factory.md` — the prior-arc
  handoff that captured the META-PROCESS RULE + operational tooling discipline
  that made this wave's convergence possible. Re-read §0 (META), §3 (tooling),
  §4 (discipline), §8 (post-mortem), §9 (closing-turn lessons).
- `docs/architecture/host-sdk-runtime-boundary.md` — the canonical target
  (mirrored at `docs/cannon/architecture/` post-#529).
- `docs/architecture/host-sdk-runtime-boundary-open-questions-framing.md` —
  gary's Q1–Q4 framing answers (mirrored at `docs/cannon/architecture/` post-#529).
- `docs/cannon/architecture/current-convergence-assessment-2026-05-20.md`
  (post-#529 landing) — gary's freshly-authored sequencing-source assessment;
  the older `docs/research/canonical-convergence-assessment-2026-05-20.md` is
  the historical 65% baseline.
- `docs/cannon/architecture/sdd-alignment-sanity-check-2026-05-20.md`
  (post-#529 landing) — gary's verdict on which SDDs remain canonical for
  direction/invariants vs which paths/pseudocode/progress markers are now
  historical. Agent Body Plan + One Substrate stay canonical for direction;
  current convergence doc supersedes them as the sequencing source.

## What this packet is for

Firegrid is **~90-93% converged** on the canonical host-sdk/runtime boundary.
The remaining work is **gap closure around known seams**, not architectural
discovery. This packet primes the next 3-lane team to:

1. **Ratchet the 8-file carveout list** in `.dependency-cruiser.cjs` →
   `currentHostSdkSubstrateDebt` down to zero (or one-named-shim-with-no-behavior).
   **This is the actual P0** — the finish-line scoreboard.
2. **Wire the first external trigger** (Linear verified webhook) + first real
   side-effect adapter (GitHub OR Linear, not both)
3. `session_new_all` is **P2 optional ergonomics, NOT a private-beta blocker**
   (per Gurdas correction post-#529 cannon update). Use repeated `session_new`
   calls; only build a batch primitive if evidence shows it's needed.

## Finish-line scoreboard

```bash
git show origin/main:.dependency-cruiser.cjs | grep -A 12 currentHostSdkSubstrateDebt
```

When that array is at zero or has only named compatibility shims with no
runtime behavior, the canonical firewall is clean enough for private beta.

## Source-of-truth maps

- **Canonical architecture:** `docs/architecture/host-sdk-runtime-boundary.md`
- **Open-question decisions:** `docs/architecture/host-sdk-runtime-boundary-open-questions-framing.md`
- **Factory-vision:** `docs/vision/factory-vision.md`
- **Convergence assessment baseline:** `docs/research/canonical-convergence-assessment-2026-05-20.md`
  (gary's 65% baseline; superseded by §02 here for current state but useful as a
  point-in-time landmark)

## Companion artifacts (research/docs landed in the wave)

- `docs/research/tf-krts-schema-projection-inventory.FINDING.md` (original 12-mismatch inventory; 5 consumed)
- `docs/research/tf-2y01-import-guardrails-baseline.md` (carveout doc; current count 8). Mirrored at `docs/cannon/research/` post-#529.
- `docs/research/tf-ygz3-shim-retirement-iteration-4.FINDING.md` (honest no-ratchet finding distinguishing pure-shim vs substrate). Mirrored at `docs/cannon/research/` post-#529.
- `docs/research/tf-6d4y-deletion-blocker-investigation.FINDING.md` (pre-deletion verification before #519)
- `docs/research/tf-lwqm-spawn-all-wiring.PROPOSAL.md` (`session_new_all` proposal source — gary's verdict reads this). Promoted to RFC tier at `docs/cannon/rfcs/tf-lwqm-session-new-all-delegation.PROPOSAL.md` post-#529.
- `docs/research/tf-gw43-dark-factory-live-run-readiness.md` (§6 7-blocker audit; 5 cleared)
- `docs/research/tf-rjta-sleep-smoke-results.md` (first factory-vision deterministic smoke artifact)
- `docs/research/workflow-body-single-suspension-rule.md` (Gurdas-authored authoring rule; mirrored at `docs/cannon/research/` post-#529)

## Memory artifact

`memory/project_overnight_canonical_convergence_2026-05-20.md` (in the
coordinator's persistent memory) — captures the per-PR table, verified
invariants, and process notes for cross-session reference.
