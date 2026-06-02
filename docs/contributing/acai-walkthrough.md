# acai Walkthrough: Spec → Handoff → Implementation → Review

The Firegrid contribution cadence is **spec-first**: behavior changes start
as edits to a `features/<product>/*.feature.yaml` file (and usually an SDD),
get coordinator review as a docs/spec-only PR, and only then become
implementation PRs that reference the now-merged ACIDs.

This page walks through one concrete example end-to-end — the durable-tools
`wait_for` feature (May 2026) — so a new agent can pick up the rhythm
quickly.

> Authoritative spec convention: `.agents/skills/acai/SKILL.md`. ACID format
> and rules are defined there; this page is the *workflow* around them.

## The cast

- **Implementation Agent (the contributor)** — drafts specs, opens PRs,
  responds to review. In the example below: OLA.
- **Coordinator** — the human/agent who reviews specs, accepts/rejects
  scope, and signs off on merges. Talks to the implementation agent through
  a `cmux` surface in the team's workspace.
- **`acai` server** — at `https://app.acai.sh`, syncs spec ACIDs and their
  per-implementation status. Reachable via `npx @acai.sh/cli`. Useful but
  not load-bearing for the PR cadence; the spec yaml file is the source of
  truth.

## The example: `wait_for` (durable-tools PR 1)

### Phase 0 — Planning report (no PR yet)

Before any code or spec changes, the implementation agent does a planning
report against the relevant SDD. For wait_for, this was a coordinator-prompted
review of the cleaned `SDD_FIREGRID_DURABLE_TOOLS.md` against the post-#168
codebase. Output: a written recommendation covering "should PR 1 be sleep,
wait_for, or schedule_me?" plus answers to specific coordinator questions.

This report is conversational; it doesn't land on disk. It's the
coordinator's basis for pinning decisions and authorizing the next phase.

### Phase 1 — Docs/spec PR

The implementation agent translates the pinned decisions into:

- A new feature spec: `features/firegrid/firegrid-durable-tools.feature.yaml`
  (51 ACIDs across components and constraints).
- Patches to the SDD: `docs/proposals/SDD_FIREGRID_DURABLE_TOOLS.md`
  (Tool Matrix, MVP Rollout, Subscription Router Design, etc.).
- An implementation handoff:
  `docs/handoffs/2026-05-13-durable-tools-wait-for-pr1-handoff.md` —
  translates the ACIDs into a concrete module layout, types, and test
  matrix.

The PR (in this example, [PR #169](https://github.com/gurdasnijor/firegrid/pull/169))
is **docs/spec-only**: no source or test changes. The PR description lays
out the why, the spec gates that follow, and the hard rejects encoded in
the spec.

**CI gates relevant at this stage:** the standard gates (ESLint, typecheck,
static-quality, tests) run as always; a docs/spec-only change is typically
unaffected by them. (The former `check:specs`/`check:docs` process gates were
retired — tf-dbxp.)

The coordinator reviews and either:
- Accepts the spec → merges it. The ACIDs are now law.
- Requests changes → the implementation agent pushes fixup commits
  ("docs+spec: patch wait_for spec per coordinator review", in this
  example). The bar for spec edits is the same as for code: no
  renumbering, append new ACIDs, mark deprecated rather than delete.

### Phase 2 — Implementation PR

Once the spec is merged, the implementation agent opens a separate PR with
the actual code (in this example,
[PR #171](https://github.com/gurdasnijor/firegrid/pull/171)):

- Source code references ACIDs in comments at load-bearing decision points
  (`// firegrid-durable-tools.WAIT_FOR.2`, `// firegrid-durable-tools.LIFECYCLE.2`).
- Test names cite the ACIDs they prove
  (`it("firegrid-durable-tools.WAIT_FOR.7 reconciles a match completion ...", ...)`).
- The PR description maps the test matrix back to ACID coverage and calls
  out documented caveats (workarounds, future-work follow-ups).

**The hard rejects from the spec are now load-bearing.** The implementation
must not introduce code that the spec's `BOUNDARIES.*` constraints forbid;
the linter and dead-code/dup/effect-quality ratchets back this up
mechanically where they can.

**CI gates relevant at this stage:**
- `pnpm run typecheck`
- `pnpm run test`
- `pnpm run lint` (max-warnings 0)
- `pnpm run lint:deps` (no new dep-cruiser violations)
- `pnpm run lint:dead` (knip, strict-0)
- `pnpm run lint:dup` (jscpd, strict-0)
- `pnpm run lint:effect-quality` (see
  [`docs/contributing/effect-quality-metrics.md`](./effect-quality-metrics.md))

Run them all locally as `pnpm run verify` before pushing.

### Phase 3 — Review

The coordinator reviews against the merged spec. The review template is
roughly:

1. **Hard rejects intact?** Spec-encoded prohibitions (no new package, no
   protocol imports of `@durable-streams/*`, no
   `DurableConsumer`/`Source`/`Checkpoint`/`Projection` revival, etc.) are
   non-negotiable.
2. **ACIDs covered?** Each ACID should have at least one test or one code
   comment referencing it. The PR's coverage inventory should match what's
   in the diff.
3. **Documented caveats reasonable?** Where the implementation deviates
   from the handoff (workarounds, eslint-disables, deferred follow-ups),
   the PR description must explain why.
4. **Correctness on the load-bearing semantics?** For wait_for: crash
   recovery, source-registration startup order, match/timeout race, etc.
   This is where review can spot bugs the spec didn't pin down precisely
   enough.

The implementation agent responds either with fixup commits or with a
spec-first amendment if the review surfaces a missing/over-strict ACID.
For wait_for, two ACIDs (`RUNTIME_BOUNDARY.4`, `EFFECT_IDIOMS.1`) were
softened with `-note` markers when review confirmed the original wording
didn't match what the implementation could deliver in PR 1.

### Phase 4 — Merge and follow-ups

After CI is green and review is satisfied, the coordinator merges (typically
squash-merge to keep `main` linear). Open follow-ups (workarounds documented
during review, etc.) live as:

- New ACIDs appended to the spec for future PRs.
- Entries in `KNOWN_ISSUES.md` for the relevant package.
- `-note` markers on existing ACIDs pointing at the follow-up.

Don't open follow-up PRs speculatively. Wait until the next product
pressure justifies the work.

## The cmux cadence

The coordinator and implementation agent communicate through a cmux surface
in the team's workspace. The cadence is review-shaped, not progress-shaped:

- **Spec PR opened** → message: PR URL, why this is PR 1, what hard rejects
  are encoded, what CI says.
- **Spec PR review feedback received** → message: fixup plan, ACID
  renumbering if any (rare; prefer appending), expected timing.
- **Implementation PR opened** → message: PR URL, ACID coverage summary,
  documented caveats, CI status, anything that deviated from the handoff.
- **Implementation PR review feedback** → message: the fixup plan for each
  finding, classified by severity (HIGH = correctness; MEDIUM = spec/docs;
  LOW = polish).
- **PR merged** → coordinator messages the implementation agent; the
  implementation agent confirms and cleans up worktrees.

What does **not** go through cmux:
- Every individual commit.
- "Working on it…" updates with no decision needed.
- Internal investigation traces.

The cmux command surface is documented in the top-level `AGENTS.md` under
"Coordinator Cadence via cmux".

## Common mistakes (and how to recognize them)

- **Implementation drift from spec.** A reviewer asks "where's the ACID
  for this behavior?" and the answer is "I just added it." → fix by
  reverting the code or amending the spec first.
- **Renumbering ACIDs.** `1, 2, 3` → `1, 3, 4` because someone wanted to
  remove `2`. → never. Mark `2` as `deprecated: true` and leave it.
- **Bundling a spec change with a runtime change.** The runtime PR
  reviewer can't tell if the spec change is correct without re-reviewing
  the spec. → split into two PRs.
- **Soft language in ACIDs.** "should, when possible, prefer, normally."
  → ACIDs are testable acceptance criteria. Rewrite as imperative
  outcome-oriented statements.
- **Hidden assumptions.** Code references a `forEach` style loop because
  "that's the convention" — but the convention isn't documented anywhere.
  → write it down in the appropriate place (`AGENTS.md`,
  `agent-patterns/`, package-level README, or the spec's
  `constraints.EFFECT_IDIOMS`).

## TL;DR

1. Coordinator and implementation agent agree on scope (planning report).
2. Implementation agent opens a **docs/spec-only PR** updating the feature
   yaml + SDD + handoff. Coordinator reviews and merges.
3. Implementation agent opens a **second PR** with code that satisfies the
   now-merged ACIDs. Each load-bearing decision references its ACID in
   comments/tests.
4. Coordinator reviews against the spec; correctness findings become
   fixup commits, ACID misalignments become spec-first amendments.
5. Merge. Follow-ups live as new ACIDs, `KNOWN_ISSUES.md` entries, or
   `-note` markers on existing ACIDs.

Two PRs per behavior change is the floor, not the ceiling. The cost is
worth it: spec PRs are cheap to review, implementation PRs are easier to
audit, and the spec stays usable as a contract.
