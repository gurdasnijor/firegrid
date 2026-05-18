# tiny-firegrid Session Handoff

Last updated: 2026-05-18.

This document is the seed context for the next tiny-firegrid session. It is a
working handoff, not an architectural source of truth. Prefer the linked docs
when they disagree.

## Start Here

Read these first:

- `AGENTS.md` at the repository root.
- `repos/effect/AGENTS.md` before editing Effect-heavy code.
- `packages/tiny-firegrid/README.md` for the package purpose.
- `packages/tiny-firegrid/CONFIGS.md` for the configuration index.
- `packages/tiny-firegrid/FINDINGS.md` for the authoritative TFIND ledger.
- `packages/tiny-firegrid/FINDINGS_TRIAGE_RUBRIC.md` if present locally. The
  ledger references it; in this checkout it is currently untracked, so confirm
  with the coordinator before committing or deleting it.

## Current Workspace State

Main checkout: `/Users/gnijor/gurdasnijor/firegrid`.

At handoff time:

- `main` and `origin/main` point at `83ff0ada5`
  (`docs(tiny-firegrid): add configuration index (#340)`).
- Local untracked files exist and were intentionally not touched:
  `packages/tiny-firegrid/CONFIG_RUNNER_SDD.md`,
  `packages/tiny-firegrid/FINDINGS_TRIAGE_RUBRIC.md`, and `tmp/`.
- Do not delete those untracked files unless the user/coordinator explicitly
  asks. Treat `tmp/` as generated coverage output.

## Open PRs

### PR #338: output-journal pipeline

URL: https://github.com/gurdasnijor/firegrid/pull/338

Status at handoff:

- Open.
- Merge state: clean.
- CI: all green.
- Branch: `codex/tiny-firegrid-output-journal`.

What it adds:

- `packages/tiny-firegrid/src/configurations/output-journal-pipeline.ts`
- `packages/tiny-firegrid/test/output-journal-pipeline.test.ts`
- `packages/tiny-firegrid/src/index.ts` export.

What it proves:

- Per-context `RuntimeOutputTable` rows are the output journal used by the
  `AgentOutputAfter` path.
- The host ambient output table remains empty for this scenario.
- The correct output row sequence is `[0, 1, 2]`: two text chunks plus the
  production codec-owned terminal row.

CI failure that was fixed:

- The failing CI showed `[0, 1, 2, 3]`.
- Root cause was the test fixture emitting a `Terminated` envelope itself while
  the production stdio-jsonl codec already journals `Terminated` from process
  exit.
- The fix removed fixture-emitted terminal evidence. The assertion was not
  widened.

Coordinator was notified on `surface:153` with:

- #338 fixed and force-pushed at `426bb3255`.
- Full tiny-firegrid package test passed locally with `OPENAI_API_KEY` unset so
  the Codex ACP test followed its documented skip path.
- `pnpm --filter @firegrid/tiny-firegrid typecheck` passed.
- `pnpm run toy:coverage output-journal-pipeline` passed with end-to-end
  coverage `86.6%`.

Next step:

- If #338 is still open, ask coordinator to merge or merge if explicitly
  authorized and CI remains green.

### PR #326: DurableTable self-identity / TFIND-005

URL: https://github.com/gurdasnijor/firegrid/pull/326

Status at handoff:

- Open.
- CI currently red on Lint, Typecheck, and Effect diagnostics; Tests and
  Semgrep are green.
- Branch: `sidecar/workflow-layer-precision`.

Important state:

- `TFIND-005` is no longer "blocked" in the conceptual sense. Gurdas signed
  off on the curried `DurableTable` shape. #326 is the mechanical idiom
  migration / verify-then-flip work.
- The former TFIND-005 "fork (2)" is now `TFIND-044`, a separate
  architect-gated provider-shape issue.
- #339's tiny-firegrid cleanup commit was folded into #326 as a cherry-pick.

### PR #339: closed superseded

URL: https://github.com/gurdasnijor/firegrid/pull/339

Status:

- Closed as superseded.
- It was intentionally red standalone because it removed TFIND-005 suppressions
  before #326 landed the precision changes that make them unnecessary.
- #339 commit `6f2fcff` is already cherry-picked into #326 as `0de877b`.

### PR #340: merged

URL: https://github.com/gurdasnijor/firegrid/pull/340

Status:

- Merged at `83ff0ada5`.
- Moved `packages/tiny-firegrid/src/configurations/README.md` to
  `packages/tiny-firegrid/CONFIGS.md`.
- Added the configuration index table and maintenance protocol.

Post-merge note from coordinator:

- `CONFIGS.md` is mildly stale because `TFIND-005` is now signed off and
  `TFIND-044` exists.
- Fold that refresh into the next `CONFIGS.md`-touching PR; it is not urgent.

## tiny-firegrid Purpose

The package is an executable architectural model of Firegrid. The value is not
just passing tests. The value is that production-like configurations expose
whether public Firegrid seams are sufficient to express real system behavior.

Two categories matter:

- `production-consuming`: thin wrappers over real production layer factories
  such as `FiregridRuntimeHostLive`; tests drive through the client SDK where
  possible.
- `pedagogical`: hand-rolled in toy vocabulary to make one seam obvious; do
  not refactor these into production-consuming configs just for fidelity.

See `packages/tiny-firegrid/CONFIGS.md` for the full index.

## Findings Protocol

Coordinator surface: `surface:153`.

Current protocol:

- `packages/tiny-firegrid/FINDINGS.md` is the authoritative findings ledger.
- When asked to edit findings, confirm whether the coordinator owns the file
  for that workstream. During the #330/#338 period, the coordinator owned the
  canonical ledger and asked toy PRs not to carry `FINDINGS.md` hunks.
- Inline `// TFIND-xxx` annotations in code are allowed and expected where a
  test/config reaches past a production-like public boundary.
- If a new finding surfaces, send a concise handoff to `surface:153` with the
  TFIND title, evidence, and whether it blocks the current configuration.
- Do not dispatch fixes. Surface and continue unless the finding invalidates
  the current configuration's pre-conditions.

Triage rubric:

- Category 1/2: real production gap or boundary leak, usually sidecar work.
- Category 3: toy fixture awkwardness, toy should redirect the scenario.
- Category 4: toy/coverage artifact.
- Category 5: internal cleanup.

Important examples:

- `TFIND-036` was re-triaged category 3. Do not build a production "agent reads
  its own exit code" tool. Use an existing tool or `wait_for{RuntimeRun}` when
  genuinely host-plane.
- `TFIND-041` is resolved by decision B: session mode owns the `ToolUse`
  lifecycle. The event-level discriminant option is deferred, not chosen now.
- `TFIND-044` is the new provider-shape issue separated from `TFIND-005`.

## Configuration Queue

The queue from the user/coordinator, adjusted by later decisions:

1. `agent-adapter-driven-pipeline`
   - No longer gated on `TFIND-005`.
   - Use existing reach-past annotation patterns where precision still leaks.
   - Goal: exercise real `runtime/agent-adapters`, not a local script fixture.

2. `output-journal-pipeline`
   - Implemented in #338.
   - If #338 is merged before the next session starts, update `CONFIGS.md` from
     in-flight to landed and refresh the source links / line refs.

3. `multi-context-production-consuming-pipeline`
   - No longer gated on `TFIND-005`.
   - Host-side first; client-side separate-process shape consumes the #332
     client/host transaction.
   - Goal: real host dispatcher + real registry + multiple contexts.

4. `permission-flow-pipeline`
   - Gated on the permission-flow framing around `TFIND-015`.
   - `#332` is landed and `TFIND-041` is decided, but do not start if the
     permission authority/codec question is still architect-gated.

5. `agent-adapter-tool-execution-pipeline`
   - Capstone.
   - Depends on `agent-adapter-driven-pipeline` and the `TFIND-041` decided
     shape.

Protocol from the user:

- One configuration at a time.
- No parallel toy work.
- Production-consuming configs should be thin wrappers over production
  composition, with tests driven through client SDK where possible.
- Any action a real host/client SDK user would not perform should either be
  removed or annotated with a TFIND.

## Quality Gates

For configuration work:

- Test against production substrate when the config is production-consuming:
  real `DurableStreamTestServer`, real `FiregridRuntimeHostLive`.
- Run `pnpm run toy:coverage <config>` and record coverage in
  `tmp/toy-coverage/<config>/summary.md`.
- Update `CONFIGS.md` when config status, findings, reach-pasts, or coverage
  changes.
- Avoid `as unknown as` casts.
- Localized eslint disables are acceptable only with a specific TFIND comment.

Useful commands:

```bash
pnpm --dir packages/tiny-firegrid test
pnpm --filter @firegrid/tiny-firegrid typecheck
pnpm run toy:coverage <config>
pnpm run check:docs
```

For local runs, if the Codex ACP test hangs or should skip, run with:

```bash
env -u OPENAI_API_KEY pnpm --dir packages/tiny-firegrid test
```

CI will run the full quality gate. The user explicitly said not to spend time
rerunning everything CI already runs unless needed for diagnosis.

## Coverage Caveat

The coverage script currently produced unexpectedly low per-config numbers on
main for some production-consuming configs:

- `codex-acp-tool-call-pipeline`: `2.7% / 25.0%`
- `durable-streams-backed-pipeline`: `2.7% / 25.0%`
- `stdio-jsonl-tool-execution-pipeline`: `2.7% / 25.0%`

Earlier work reported higher durable-streams numbers. Treat coverage as a
measurement tool that may itself need debugging. Do not interpret low numbers
as architecture truth without checking the script's closure inputs and
dependency-cruiser behavior.

## Process Notes

- Always load the `acai` skill at the start of a coding turn.
- The repository has repeated warnings about too many unified exec processes.
  Before long test runs, check and kill stale `vitest` / package-test processes.
- Use `rg` / `rg --files` first for search.
- Use `apply_patch` for manual edits.
- Do not edit `repos/`.
- Do not include generated `tmp/` artifacts in PRs.
- Do not include unrelated local untracked docs unless explicitly asked.

Coordinator update command:

```bash
cmux send --surface surface:153 'message text'
cmux send-key --surface surface:153 Return
```

Use coordinator updates for review-shaped events: PR opened, finding surfaced,
CI diagnosis, merge-ready state. Do not broadcast every commit.

## Suggested Next Session Opening

1. `git status --short --branch`.
2. Check #338. If still open and green, ask/confirm merge path.
3. Refresh `CONFIGS.md` for `TFIND-005` signed-off state and `TFIND-044` if
   touching it anyway.
4. Start `agent-adapter-driven-pipeline` unless coordinator/user redirects.
5. Keep new findings out of `FINDINGS.md` unless the current protocol allows
   direct toy-agent edits; otherwise send them to `surface:153`.
