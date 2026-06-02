# Agent1 handoff — session learnings and concurrency notes

Date: 2026-06-02
Session scope: `tf-0awo.34.2` capability/Brookhaven alignment audit, PR #836

## What worked

- The one-bead/one-worktree wrapper flow did its job. `task-enter` gave a clean
  branch off current `origin/main`, and `task-exit` committed, reran preflight,
  pushed, opened the PR, and confirmed a CI run was present.
- Source-first audit work was productive. Reading the stale map, current proof
  findings, live runtime/client symbols, and bead records prevented several
  false gaps:
  - cap-1 was not missing after the old sim deletion; it was re-proven by
    `tf-0awo.31a`.
  - cap-4 was no longer the old partial; `tf-0awo.31.3` proved the ACP MCP path.
  - Brookhaven's apparent bridge set collapsed into the existing substrate plus
    a single scoped opaque-handle auth gap tracked under `tf-qne2`.
- The full `pnpm preflight` caught the only real formatting defect before the
  branch was pushed. The first run failed only on `check:docs` trailing
  whitespace, which was cheap to fix locally.
- `cmux-dispatch.sh` was useful once the correct lane label was used. It
  verified submission instead of relying on a paste into the wrong pane.

## What did not work

- The first coordinator dispatch failed because I used lowercase `coordinator`
  while the actual cmux lane label was `Coordinator`. The wrapper failed loudly,
  which is good, but labels are case-sensitive in practice.
- `git diff -- <new-file>` produced no useful content for an untracked file.
  For a new doc, `sed`/`rg` was the better sanity check until the file was
  staged or committed.
- Long Markdown table rows are hard to review in terminal output. They passed
  the repo docs checker, but they are not pleasant in diffs. For future audit
  docs, use tables for compact maps and prose/finding blocks for the high-value
  evidence.
- Some source docs remain intentionally stale after cutovers. Treat docs as
  evidence only after checking current code, proof findings, and beads. The
  old `tf-d6s9` capability map was useful as a comparison target, not as state.

## Tooling friction

- `pnpm preflight` is the right gate, but the first uncached run is long enough
  that agents should avoid waiting until the very end to discover docs-format
  failures. For docs-only work, run `pnpm run check:docs` before the full gate.
- `check:docs` flags trailing spaces but does not rewrite them. A small
  markdown formatter or pre-commit whitespace trim would remove this class of
  failure.
- `task-exit` reruns full preflight even after a manual green preflight. That is
  conservative and appropriate for protected PRs, but agents should account for
  the duplicate wall time.
- Bead JSON via `br show <id> --json` was the most reliable way to verify
  tracking state. Grepping `.beads/issues.jsonl` is useful for discovery, but
  not enough for final disposition.

## Recommendations for individual agent productivity

- Start every audit by listing the target docs, current proof docs, live source
  symbols, and relevant bead records. Do not classify a gap from docs alone.
- Prefer exact source citations in the doc while writing. It makes the final
  review cheaper and catches stale-memory mistakes early.
- Run quick gates before full gates:
  - docs-only: `pnpm run check:docs`
  - specs touched: `pnpm run check:specs && pnpm run check:docs`
  - before push: `pnpm preflight`
- Use `cmux identify` before dispatching status if there is any doubt about the
  current lane identity or coordinator label.
- Keep findings mechanically convertible. The requested format is good; avoid
  inventing references such as `tracked-by(F-07)` when a real bead or suggested
  bead is required.

## Recommendations for team concurrency

- Keep ownership narrow and visible. The most effective concurrent work in this
  session was possible because proof sims, schema/client work, and audit docs
  had distinct branches and PRs.
- After major cutovers, dispatch an explicit stale-doc cleanup pass. Stale
  planning maps create coordination drag because each later agent has to
  rediscover which references are obsolete.
- When a task depends on another agent's proof, point to the merged finding doc
  and PR number in the dispatch. That made this audit much faster than
  re-deriving the cap proofs from raw traces.
- For external-consumer work, preserve the boundary rule in the task statement:
  substrate stays generic; consumers compose. That single rule prevented
  Brookhaven-specific bridge work from being mistaken for platform work.
- Prefer wrapper-verified communication (`cmux-dispatch.sh`) over manual cmux
  commands for review-shaped updates. The label lookup/submission verification
  catches silent coordination failures.

## Next-session cautions

- `tf-r06u.36` is still a live terminal-relay gap. Do not treat observable
  `TurnComplete`/`Terminated` rows as proof that the session body terminates and
  deregisters.
- Cap-6 remains the load-bearing factory/Brookhaven gap. Provider actions are
  MCP-tools-first by design, but a waitable durable action receipt/publish
  terminal is still not proven.
- `tf-qne2` is the tracking epic for deferred Brookhaven/gateway work and
  explicitly rejects transcribed Brookhaven bridges. Future work should build a
  generic scoped opaque-handle auth surface or use existing session input
  surfaces, not a parallel intent stream or consumer-specific translator.

