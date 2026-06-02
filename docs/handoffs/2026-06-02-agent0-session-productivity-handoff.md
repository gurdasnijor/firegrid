# Agent0 Session Productivity Handoff

Date: 2026-06-02
Branch: `codex/tf-0awo.34.1-audit-a-composition`
Primary output: PR #838, `docs/analysis/2026-06-02-alignment-audit-A-composition.md`

## What Worked

- Worktree discipline worked. Keeping all real edits in
  `../firegrid-worktrees/tf-0awo.34.1-audit-a-composition` avoided disturbing the
  already-dirty primary checkout.
- Source-first audit worked. The useful pattern was: locate the SDD, read the
  exact cited sections with `nl -ba`, then verify live call sites with `rg`
  before writing a finding. This prevented false gaps around read views, logs,
  signal delivery, and engine-native primitives.
- `multi_tool_use.parallel` was high-leverage for read-only evidence gathering.
  Running SDD reads, code searches, and bead searches in parallel cut a lot of
  wall-clock time.
- `pnpm preflight` was the right final gate even for docs-only work. It caught
  nothing here, but it also proved the doc did not trip docs/spec checks and
  gave the PR a clean local baseline.
- `task-exit.sh` did the right thing: reran preflight, pushed, opened the draft
  PR, and verified a CI run existed.

## What Did Not Work

- I initially used `apply_patch` without accounting for its process working
  directory. The patch landed in the primary checkout, not the worktree. I
  corrected it immediately, but this is the sharpest tooling footgun from the
  session.
- `br show <id> --json` returned arrays, not single objects. Piping directly to
  `jq '{id,...}'` failed. The reliable form was:
  `jq 'if type=="array" then .[0] else . end | {...}'`.
- Broad `rg` across `docs` and `packages` produced very large, truncated output.
  The better pattern is to run a broad discovery search once, then follow with
  narrowly-scoped `nl -ba file | sed -n` reads for line-citable evidence.
- `cmux-dispatch.sh coordinator` failed because the lane label was
  case-sensitive in this workspace: the actual label was `Coordinator`.
  Retrying with the exact label from the error output worked.

## Friction Points

- The requested SDD path
  `docs/sdds/Firegrid Composition-Type-Driven-Greenfield-SDD.md` is absent on
  main. That is audit friction because agents must infer the intended section-12
  target from findings, beads, and live code. The audit doc now records this as
  a stale pointer.
- Some old cannon SDDs are now both useful and misleading. They preserve the
  architectural reasoning, but their file-level work plans reference deleted
  paths. Agents need to classify these as `superseded` only after checking beads
  and current source.
- Primary checkout dirtiness can make status output noisy. Always run status in
  the worktree before edits and ignore unrelated primary changes unless the task
  explicitly asks to operate there.
- Bead state is rich but noisy. Targeted `br show` plus `rg` against
  `.beads/issues.jsonl` was faster than dumping all beads into the model.

## Recommendations For Individual Agents

- Before any manual patch, confirm the edit target with `pwd`, `git rev-parse
  --abbrev-ref HEAD`, and an absolute file path if using `apply_patch`.
- Treat every SDD citation as a hypothesis until source proves it. Existing
  symbols are not enough; check who imports them, who provides their layers, and
  whether they are actually wired into the public path.
- Prefer small evidence packets: `nl -ba file | sed -n 'start,endp'` gives
  stable line numbers and avoids model overload.
- When using beads JSON, normalize the shape first because CLI output can be an
  array for `show`.
- For docs-only work, run at least `pnpm preflight` when the task requires it;
  otherwise run `pnpm run check:specs && pnpm run check:docs`.

## Recommendations For Team Productivity

- Keep stale SDD pointers as first-class cleanup beads. Missing or renamed
  architecture docs cost real coordination time during audits.
- Add a short "current source anchor" section to long-lived SDDs after major
  cutovers. A line like "current implementation is
  `packages/runtime/src/unified/host.ts`" would eliminate a lot of rediscovery.
- Make lane labels normalized or aliasable for `cmux-dispatch.sh`
  (`coordinator` -> `Coordinator`) to remove a predictable handoff failure.
- Consider a wrapper for `br show --json` that always emits a single object for
  single-ID reads. It would save every agent from rediscovering the array shape.
- Make the `apply_patch` working-directory hazard explicit in the agent
  instructions, or prefer requiring absolute paths when operating from a
  sibling worktree.
- For concurrent audits, split output into "aligned evidence", "tracked gaps",
  and "untracked gaps" up front. That structure is easier for the coordinator to
  convert into beads and reduces duplicate gap filings.

## Session-Specific Follow-Ups Worth Preserving

- The section-12 runtime factory is aligned in code, but the named greenfield SDD
  pointer is stale.
- The main untracked product gap surfaced by this audit is unified MCP executor
  lowering for `send`, `execute`, and `call`.
- The client read-path durable-table leak is real but already tracked by
  `tf-0awo.6` / `tf-ll90.8.3`.
- Engine-native primitives are tracked as a contingency, not an active untracked
  blocker.
