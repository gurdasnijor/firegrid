# OLA session handoff — 2026-05-22

For the next **OLA** session (the research / synthesis / review lane that sits alongside **Gary**, the build coordinator who dispatches CC worker lanes). This records how this session went, what worked, the mistakes not to repeat, and the patterns worth continuing. Read it before picking up — especially §3 (mistakes) and §4 (operating mechanics).

---

## 1. What this session did (two arcs)

**Arc A — live ACP validation loop.** Drove a real agent through the ACP stdio edge, hardened the `acp-tool-elicitation` sim driver (per-turn outcome classification + fail-fast after 2 consecutive failures), and root-caused a cross-agent finding: **codex-acp surfaces only a subset of the Firegrid MCP toolset** because the Codex engine snapshots `tools/list` once and ignores `tools/list_changed`, while Firegrid publishes tools progressively (11× `list_changed`). Doc: `docs/investigations/2026-05-22-codex-acp-mcp-tool-exposure.md`. Memory: `project_codex_acp_defers_mcp_tools`.

**Arc B — runtime re-architecture (the bulk).** Built an OTel "contrast scan" instrument (`scripts/runtime-flow-map.py`, networkx) + a contract-coverage practice + the shrink-loop coordinator playbook, then ran a first-principles investigation that **dissolved the "two blocking decisions" framing** and **proved cross-author input ordering is an artifact, not a requirement**. Landed as a research bundle on `main` (`docs/research/2026-05-22-rearch-Q1..Q4`, `…runtime-rearch-synthesis.md`, `docs/architecture/2026-05-22-runtime-rearch-closeout.md` + the human handoff). The one open question (axis-2 engine durability across crash/restart) is now a single tiny-firegrid sim (**S1 `input-suspend-crash-recovery`**) that Gary is running via CC3.

**Where it stands:** git clean and synced to `origin/main`; the re-arch thread is Gary's now; the only live question is S1's result (verdict grid is in the closeout + my last message to the user).

---

## 2. What worked — patterns to continue

- **Falsification over construction.** The single highest-leverage move all session was *refusing to satisfy a requirement and instead asking whether it was real*. The multi-day ordering stall dissolved not by building an ordering authority but by deriving from the consumer code (`transitionInputEvent`/`transitionOutputEvent`) that the body is order-invariant. **When you see an invariant "at risk," ask "under what conditions did it actually hold, and is it even required?" before asking "how do we preserve it."**
- **Empirical instruments beat opinion.** "Nobody understands the runtime dynamics" → the contrast scan produced *measured* facts (the `runtime-context.ts` coordination-shell: 27k spans / 3% self-time; the engine⇄body SCC; invisible coupling depcruiser can't see). And tiny-firegrid sims are the falsification machine: **any architectural hypothesis → a sim → empirical verdict, fast.** Prefer this to more prose.
- **Decompose conflated problems.** "Two blocking decisions" → four independent axes that share no critical path. Naming the independence is what unblocked progress (`N` reduction comes from axes 3+4, not the stuck axis 1).
- **Label the epistemic tier.** Always distinguish **settled (code/conformance) vs inferred vs design-decision**. The user explicitly rewarded this and pushed back when I blurred it. "Source-verified" earns decision-grade; inference does not.
- **Parallel fan-out with strict briefs.** The 4 CC research lanes worked because each had: a tight scope, a hard output contract (primary sources at file:line, **no recommendations**, flag unknowns), and "report one line back to OLA." Dispatch via `cmux-dispatch.sh <lane> - < brief.txt` (stdin file — never inline args with backticks/`$()`; zsh substitutes them).
- **Self-correction in the artifact, not just chat.** When a claim was disproven (the offset "regression"; CC4's stale-checkout misread), I corrected the *doc*, not just the conversation. Keep the durable record honest.
- **Match action scope to question scope.** The session ended well because we narrowed: one open question → one sim → one lane. Resist parallelizing once the question is singular.

## 3. Mistakes — do not repeat

- **⚠️ STALE-CHECKOUT HAZARD — bit twice. The #1 operational lesson.** This OLA checkout ran ~17 commits behind `origin/main` for most of the session. That caused a *phantom finding*: I (and CC4, reading the same shared tree) misread "my stale HEAD lacks `Inserted.offset`" as "an in-flight edit is *removing* `Inserted.offset`" — when #658 had *added* it on origin. **Before analyzing any code state, sync to `origin/main` or read via `git show origin/main:<path>`. Never assert "X is being changed/removed/added" from a working tree without confirming it's current.** Especially in this shared multi-agent checkout where the coordinator pushes constantly.
- **Path-dependent reasoning kept creeping back.** I twice started analyzing "does mechanism X preserve invariant Y" with Y treated as axiomatic (per-author FIFO; the `inputId` PK scheme). The user had to redirect both times. **In a re-architecture, every existing pattern is an artifact under question. Derive whether the invariant is required before checking whether a change preserves it.**
- **Scope creep / over-expansion.** I drifted toward dispatching more research briefs and building more after the question had collapsed to one. (Gary made the same slip — 4 lanes → 1.) **When the question narrows, narrow the action.**
- **Recommendation-drift in research.** When asked for *research/observations only*, I (and CC2) leaked toward "the correct shape is…" / options. **Keep research and decision separate. Observations + trade-offs + open questions; no "options A/B/C", no "recommended path" — unless explicitly asked to decide.**
- **Premature framing.** The "two blocking decisions" doc pre-committed to two framings and deliberated *inside* them — which is why successive reviews kept finding bigger holes. It got retired. **Question the framing before deliberating inside it.** The user's "discard it, start over from first principles, this is research not a decision" redirect was the correction.
- **Git churn in a shared checkout.** Accumulated a divergent local commit (the HC-0 falsification amend) that conflicted with origin, and a `git checkout origin/main -- docs` polluted the index. **Keep local synced; don't accumulate divergent local commits; let the coordinator own `main` pushes or sync-then-push cleanly; prefer `git show origin/main:` for reads.**

## 4. Operating mechanics for the next OLA

- **Roles:** OLA = research/synthesis/review (this lane, `surface:295` this session). Gary = build coordinator (`surface:255`), dispatches CC lanes + owns beads + pushes `main`. CC1–CC4 = worker sessions (`workspace:2`, surfaces 311–314) that **share OLA's primary checkout** — their output lands as *untracked* files in your tree.
- **Dispatch:** `bash scripts/cmux-dispatch.sh <lane|bead> - < /tmp/brief.txt` (it resolves stable labels → current surface, sends, and verifies submission). Use stdin-from-file for multi-line; never inline backticks/`$()`. Lanes report back to OLA via the same script.
- **Sweep:** `bash scripts/lane-sweep.sh --json` to see lane labels, running state, and recent context — use it to route a task to the lane whose warm context fits.
- **Beads** are the status authority (`br`); the coordinator owns mutations.
- **Instruments built this session (all on `main`):**
  - `scripts/runtime-flow-map.py` — run via `uv run --with networkx --with scipy python3 …`. Modes: `--contracts` (contract-coverage), `--skeleton` (condensation/centrality/k-core), `--coverage`, `--depcruise=`, `--dot=`, `--timeline=`, `--check-baseline=`/`--write-baseline=`.
  - `scripts/acp-trace-health.py` — the 3-axis ACP trace report.
  - tiny-firegrid sims (`packages/tiny-firegrid/src/simulations/`) — the empirical answer machine; `pnpm --filter @firegrid/tiny-firegrid simulate:run -- <sim>`.
- **The shrink-loop playbook** (`docs/architecture/runtime-shrink-loop.md`) is Gary's; the metric is `N` (condensation node count) ↓ and `C` (validated contract count) ↑; the checkpoint gate is `--check-baseline` (manual, not CI by request).

## 5. The meta-lesson

The session's value was **epistemic discipline, not output volume.** A lot of what felt like progress was documents (cheap); the actual unblock of a multi-day stall was *one first-principles question answered from the consumer code* — "is cross-author ordering even required?" → no. The recurring failure mode was treating the current system as a set of axioms; the recurring win was treating it as a set of *hypotheses to falsify*. For a codebase in active re-architecture, **the highest-leverage move is often falsifying a requirement, not satisfying it** — and tiny-firegrid makes that cheap. Carry that forward.

## 6. Pointers
- Re-arch landing: `docs/architecture/2026-05-22-runtime-rearch-closeout.md` (start here) → synthesis → `rearch-Q1..Q4`.
- The runtime dynamics map + the shrink-loop playbook + the shape-falsification doc (all `docs/architecture/`).
- ACP arc: `docs/investigations/2026-05-22-codex-acp-mcp-tool-exposure.md`.
- Open thread: S1 (`input-suspend-crash-recovery`) on Gary/CC3 — verdict grid in the closeout §3.
