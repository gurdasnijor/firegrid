# Agent Instructions

## Vendored Reference Repositories

This repository vendors selected upstream sources under `repos/` as read-only
reference material via `git subtree --squash`. They are not part of the build
graph and must not be imported from product code.

Currently vendored:

- `repos/effect/` — Effect-TS source repo (`Effect-TS/effect`, `main`,
  squash-imported). See `repos/effect/AGENTS.md` and the package sources for
  authoritative examples of idiomatic Effect APIs and patterns.

### Rules

Use vendored repositories as read-only reference material when working with
related libraries. Prefer examples and patterns from the vendored source code
over generated guesses or web search results. Do not edit files under `repos/`
unless explicitly asked. Do not import from `repos/` — application code should
continue importing from normal package dependencies (`effect`, `@effect/*`,
etc.) resolved through `node_modules`.

Before writing or modifying Effect code, read `@repos/effect/AGENTS.md` (the
upstream Effect contributor guide). It encodes the code-style, naming, and
"look at existing code to learn established patterns" expectations that the
maintainers apply to the library itself, and those are the strongest available
signal for what idiomatic Effect looks like. If/when this repository moves to
a vendored Effect v4 subtree, also read `@repos/effect/LLMS.md`.

When you need to confirm an Effect API signature, behavior, or idiom, read the
relevant file under `repos/effect/packages/effect/src/` (or the appropriate
sibling package) before relying on training knowledge or web search.

### Optional: agent-patterns/

You may distill recurring patterns you discover while reading `repos/effect`
into focused notes under `agent-patterns/` (e.g. `agent-patterns/effect-schema.md`
with constructors/combinators, encoding/decoding examples, transformation
patterns, error-handling patterns). Do this on demand, when a pattern keeps
recurring across product code — not speculatively. Keep each note short and
link back to the canonical file in `repos/effect/`.

### Updating the vendored Effect source

```bash
git subtree pull \
  --prefix=repos/effect \
  https://github.com/Effect-TS/effect.git \
  main \
  --squash
```

Run this as a standalone PR — never bundle a `repos/effect` refresh with
product changes.

### Why these files are excluded from tooling

- ESLint ignores `repos/**` so vendored source does not pollute lint output and
  cannot drift our rule set.
- `no-restricted-imports` blocks `repos/**` paths so a stray import from
  product code fails the build.
- VS Code excludes `repos/**` from search, file watching, and TypeScript /
  JavaScript auto-import suggestions so the upstream symbols never appear as
  import candidates while you write product code.

## Worktrees and Lockfiles

Each git worktree is its own pnpm workspace root because `pnpm-workspace.yaml`
sits at the worktree root and `pnpm-lock.yaml` is checked in. That means:

- `pnpm add` / `pnpm remove` from inside a worktree mutates **that worktree's**
  `pnpm-lock.yaml`, not the main checkout's. The two trees can resolve
  different transitive versions until you push and the lockfiles diverge in
  history.
- If a typecheck or test that passes on `main` starts failing inside a
  worktree, first confirm the worktree lockfile matches main:
  `md5 pnpm-lock.yaml <main-checkout-or-other-worktree>/pnpm-lock.yaml`.
- To revert a stray lockfile mutation: `git restore pnpm-lock.yaml` then
  `pnpm install --frozen-lockfile`.

If the harness places you in a fresh worktree (`.claude/worktrees/<name>/`),
the branch is auto-named `worktree-<name>`. Rename it before pushing if you
want a more descriptive branch (`git branch -m worktree-foo opus/foo-pr1`).

## Task lifecycle (worktree-enforced — use the wrappers)

Lane work NEVER happens in the primary checkout. A lane squatting the
primary on its branch stranded decision state and produced recurring
concurrent-beads-sync races; the convention got forgotten, so it is now
enforced structurally. Worktrees are siblings in `../firegrid-worktrees/`
(NOT in-root — keeps the second tree out of pnpm-workspace / jscpd / knip /
effect-quality / depcruise scanners; sibling = zero carve-outs).

```bash
bash scripts/task-enter.sh <bead-id> <slug> [--class codex|sidecar]
  # → fresh worktree off origin/main at firegrid-worktrees/<bead>-<slug>,
  #   branch <class>/<bead>-<slug>, bead → in_progress. Deterministic on the
  #   bead id (lanes get renamed; beads don't).
  # RESUME an existing branch (e.g. PR #326 — preserves its commits, does
  #   NOT fork off main):  task-enter.sh <bead> <slug> --resume
  #   Without --resume, an existing branch is REFUSED (never silently
  #   orphans committed work).

cd ../firegrid-worktrees/<bead>-<slug>      # work + commit ONLY here

bash scripts/task-exit.sh <bead-id> [--decision <PR/SDD url>]
  # → local beads flush, commit, PUSH (fails LOUD if push fails — no
  #   silent stranded work), open/refresh PR, optional signoff:pending.
  #   Does NOT push .beads/issues.jsonl (that races) and does NOT remove
  #   the worktree (PR still in review).
  #
  #   POST-REBASE PUSH RULE: a lane MUST rebase onto origin/main before
  #   merge, which rewrites history so local & origin/<branch> diverge and
  #   a plain push fails non-fast-forward. task-exit.sh handles this
  #   automatically: if every origin/<branch> commit has a patch-equivalent
  #   in local HEAD (a clean rebase of your OWN branch, no remote-only
  #   commits) it recovers with `--force-with-lease` (race-safe; NEVER
  #   plain `--force`). If origin/<branch> has commits NOT represented
  #   locally it is a DIVERGENCE: task-exit HARD-STOPS, refuses to force,
  #   and surfaces it (do not blind-force — another lane may share the
  #   branch; investigate `git log HEAD..origin/<branch>`). Either way the
  #   failure is loud + non-zero — it can no longer be silently missed
  #   (this was the recurring stranded-work fallout class).

bash scripts/task-reap.sh [<branch>]        # after merge, from primary
  # → removes ONLY clean+merged worktrees, deletes the branch, prunes,
  #   and surfaces any bead still open for a merged branch. NEVER discards
  #   dirty/unmerged work — it reports and keeps it.

#  beads-sync is OWNED by the beads-sync cron (.beads/.beads-owner=cron).
#  scripts/beads-sync.sh REFUSES unless run by that cron — the coordinator
#  and lanes are structurally blocked from pushing the SoT (separation of
#  duties). Install: scripts/install-beads-sync-cron.sh (operator, once).
#  It self-locks (self-healing .git lock), ground-truth-verifies the push,
#  and is a sub-second no-op when nothing changed. Deliberate br-owner op:
#  FG_BEADS_OWNER=1 (audited). Lanes/coordinator NEVER run beads-sync.
```

### Deterministic dispatch (coordinator → lanes)

Never hardcode `--surface surface:NNN` — surface numbers renumber
(coordinator was :153 → :199; oca1 is not durably :155). Dispatch by the
**stable lane label or the bead id**; the wrapper resolves the current
ref, sends, and **verifies the agent is running, retrying the Enter** — a
multi-line paste does NOT submit on a trailing `\n` (it queues as a
`[Pasted text]` chip), the #1 "message never ran" failure.

```bash
bash scripts/cmux-dispatch.sh <lane|bead-id> "<message…>"
  # oca1 / cca2 / coordinator, OR tf-80d (→ its assignee). Resolves
  # label→current ref, sends, confirms running, fails LOUD if queued.
bash scripts/cmux-broadcast.sh "<message…>"
  # fan-out to every oca/cca worker lane (excl. coordinator + self),
  # per-lane verified; non-zero exit if ANY lane unconfirmed.
```

**Guardrail:** `scripts/git-hooks/` + `scripts/install-git-hooks.sh` set
`core.hooksPath` so a commit/push from the primary checkout while it is NOT
on `main` is **blocked** (symlink-immune primary detection; no-op in every
worktree). Deliberate br-owner/admin op: `FIREGRID_ALLOW_PRIMARY=1` (logged).
The br-owner runs `install-git-hooks.sh` once in the primary to activate it.

## Effect / `@effect/*` Version Pins

`packages/runtime/src/workflow-engine/internal/engine-runtime.ts` is written
against the API shapes of the currently-pinned `effect` (root) and
`@effect/workflow` (runtime package). Minor version bumps have introduced
typing regressions in the past — notably:

- `effect` 3.18 → 3.21 changed inference around `Option.getOrUndefined` and
  related helpers in ways that broke the workflow-engine adapter.
- Adding `@effect/vitest` to a workspace package pulls in its own `effect`
  range, which can elevate the resolved `effect` version repo-wide.

Treat `effect`, `@effect/workflow`, `@effect/experimental`, `@effect/platform`,
`@effect/rpc`, and `@effect/vitest` as version-coupled. Do not loosen ranges
casually. Bumps land as **standalone PRs** that update the lockfile and any
adapter code together, never bundled with product changes.

## Preflight Before Pushing

CI runs `lint`, `lint:dead`, `lint:dup`, `lint:deps`, `lint:effect-quality`,
`lint:host-sdk-imports`, `typecheck`, and the full test suite. The
root `package.json` chains all of these as `pnpm run verify`. Run it before
pushing if you've touched code; CI feedback is slow and the Effect-quality
metric in particular is easy to miss locally:

```bash
pnpm run verify
```

If you've only touched docs/specs:

```bash
pnpm run check:specs && pnpm run check:docs
```

The Effect-quality metric ratchet (`lint:effect-quality`) refuses regressions
in counts like `forOfInPackageSourceCount`, `processEnvOutsideBinCount`, and
`anyNoContextCastCount`. See `docs/contributing/effect-quality-metrics.md` for
the full list, what each metric counts, and how to fix common regressions.

## Coordinator Cadence via cmux

Coordinator handoffs and review feedback for Firegrid agent work flow through
a cmux surface in the team's workspace. To send the coordinator an update:

```bash
cmux list-pane-surfaces                # find the coordinator surface
cmux send --surface surface:<n> 'message text'
cmux send-key --surface surface:<n> Return
```

Use this for spec PR opens, implementation PR opens, CI status, and review
responses. Don't broadcast every commit — coordinator updates are
review-shaped, not progress-shaped. See `docs/contributing/acai-walkthrough.md`
for the end-to-end review cadence Firegrid PRs follow.

### Pulling lane status (don't wait for engineers to message back)

Engineers do not reliably push status via `cmux send`. The coordinator should
*pull* instead: `scripts/lane-sweep.sh` fans `cmux read-screen` across every
other worklane.

```bash
bash scripts/lane-sweep.sh                 # all lanes except the current tab
bash scripts/lane-sweep.sh --lines 25      # deeper tail
bash scripts/lane-sweep.sh --json          # structured, agent-parseable
bash scripts/lane-sweep.sh 155 161         # only specific surfaces
```

It runs **relative to the current tab**: the pane the coordinator invokes it
from is auto-excluded (via `cmux identify`), so it shows only the *other*
lanes. The cmux **workspace is pinned once** (resolved from the caller's
`.caller.workspace_ref`); if the invoking shell's ambient context may not be
the worker workspace (nested tool subprocess, selected-workspace drift), pass
`--workspace <ref>` (or set `LANE_SWEEP_WS`) — otherwise enumeration can
intermittently list the wrong workspace and show no lanes. It is heuristic-free
by design — `--json` emits
`{lanes:[{surface,label,running,status,beads,prs,tail[]}]}` where `running` is
a literal read of the TUI's own `esc to interrupt` indicator and `status`
quotes the agent's own activity line verbatim; neither is a classification
that could be confidently wrong. `prs` resolves each assignee-tagged
in_progress bead's `pr-<n>` labels via one `gh pr view` and shows
`{number,draft,state,mergeable,ci}` **verbatim** — `mergeable`
(`mergeStateStatus`) is eventually-consistent and often `UNKNOWN`; treat
`UNKNOWN` as re-check, never as a verdict. PR enrichment is best-effort (a
`gh` failure/rate-limit does not abort the sweep) and absent when `gh` is
unavailable or the bead has no `pr-<n>`. This folds the per-PR `gh` polling
into the one sweep. It is **complementary to** the `signoff:pending` drain
query — PRs not yet beaded (framing PRs queued for signoff) appear there, not
here. Run it on a cadence rather than waiting for a `cmux send` that may never
come.

**Dispatch-gap gate (every cycle, after lane-sweep):** run
`bash scripts/dispatch-gap.sh`. Exit 3 = idle worker lane(s) coexist with
unassigned ready work — **assign before reporting status**. A status that
claims lanes are "correctly idle/parked" while this exits 3 is invalid by
construction; the only valid idle-on-purpose is an audited
`DISPATCH_GAP_PARKED="lane:reason …"` override. Full contract:
`docs/contributing/beads-operating-guide.md` → Dispatch gap.

**Push detection (`scripts/state-watch.sh`):** the pull tools above only
help when run. `state-watch.sh --once` is the edge-triggered detector —
diffs structured state vs a per-machine snapshot and emits only deltas
(`signoff_new`/`closed`/`unblocked`/`lane_idle`/`gap_open`), exit 3 on
change. Run by an *external* cron (deterministic — no LLM) with
`--notify <coord-surface>` to ping the coordinator the moment a lane
goes idle or a decision is needed, instead of waiting for its next
sweep. Full model: `docs/contributing/beads-operating-guide.md` →
Push detection.

**Lane labels are the short tab names** (`coordinator`, `oca1`, `oca2`,
`cca1`, `cca2`). These double as the beads join key.

#### Engineer protocol: tag your WIP bead with your lane

So `lane-sweep --json` can show which bead each lane owns, every engineer
**must set `assignee` to its own lane label** when it starts work:

```bash
# resolve own lane label, then claim the bead with it
LANE=$(cmux list-pane-surfaces | awk -v s="$(cmux identify | grep -m1 surface_ref | grep -oE 'surface:[0-9]+')" \
  '$0 ~ s {sub(/^[* ] *surface:[0-9]+ +/,""); sub(/ +\[selected\]$/,""); print; exit}')
br update <id> --status in_progress --assignee "$LANE"
# when a PR exists for this bead, also tag it so `prs` populates:
br update <id> --add-label pr-<n>
```

The join is whitespace/case-tolerant, so exact spacing doesn't matter, but the
label must be the lane's tab name. Without `--assignee` the sweep still shows
`running`/`status`/`tail` (no engineer cooperation needed) — `beads`/`prs`
just stay empty for that lane. Without `pr-<n>` the bead shows but its PR
state does not.



## Beads (br) — Dependency-Aware Issue Tracking

Beads provides a lightweight, dependency-aware issue database and CLI (`br` - beads_rust) for selecting "ready work," setting priorities, and tracking status. It complements MCP Agent Mail's messaging and file reservations.

**Important:** `br` is non-invasive—it NEVER runs git commands automatically. You must manually commit changes after `br sync --flush-only`.

### Firegrid workspace specifics (read this first)

The generic guidance below is upstream beads_rust boilerplate. For this repo,
these project facts override it:

- **Workspace & prefix:** repo-root `.beads/`, resolved via `BEADS_DIR` in
  `~/.zshenv` (single source of truth — not `.zshrc`; non-interactive script
  shells must resolve the same workspace). Issue prefix is **`tf`** (IDs look
  like `tf-q44`), *not* `br-`/`bd-`. Wherever the boilerplate says `br-###`,
  read `tf-###`.
- **Git-tracked state:** `br init` wrote `.beads/.gitignore` so the SQLite db,
  WAL, and lock/daemon files are ignored and only **`.beads/issues.jsonl`**
  (this `br` version names it `issues.jsonl`, not `beads.jsonl`),
  `config.yaml`, and `metadata.json` are committed. The JSONL is the source of
  truth; after `br sync --flush-only` run `git add .beads && git commit`.
- **tiny-firegrid authority cutover:** Beads is the **sole** authority for
  tiny-firegrid finding and configuration status. The old Markdown ledgers
  (`packages/tiny-firegrid/FINDINGS.md`, `CONFIGS.md`, `HANDOFF.md`) were
  **deleted** once the cutover was signed off (#354/#356) — do not recreate
  them. Each `TFIND-*` finding is a `br` issue; each configuration is an epic
  (`issue_type=epic`, `config:<slug>` label). Status changes happen via `br`.
- **Join key:** `br create` cannot set explicit IDs, so the original
  `TFIND-NNN` identity is carried as the **`tfind:NNN` label** (zero-padded,
  3 digits). Cross-reference from SDDs/commits/PRs via
  `br list --all --label tfind:049`. Other structural labels: `pr-<n>`
  (GitHub PR link), `cat-N` (triage rubric category), `status:*` (mirrors the
  disposition for filtering), `config:<slug>` / `surfaced-by:<slug>` /
  `consumed-by:<slug>` (finding↔config-epic edges), `keystone` / `factory-*`
  (routing tags).
- **Querying:** `br list` hides closed issues by default. Use
  `br list --all --limit 0` for full coverage (≈64 issues = 52 findings + 12
  config epics).
- **Label constraints:** ≤50 chars, charset `[A-Za-z0-9:_-]` only.
  Comma-joined label lists work **only** on `br create -l "a,b,c"`;
  `br label add` and `br update --add-label` take exactly one label per call.
- **Import script is historical:** `scripts/beads-import-findings.sh` was the
  one-time migration. Its inputs (`FINDINGS.md`/`CONFIGS.md`) were deleted in
  #354, so it is **no longer re-runnable** and is kept only as a provenance
  record. Never re-run it; mutate state with `br` directly. The live
  `.beads/issues.jsonl` is the only source of truth.
- **Status:** set via `br` (`br update --status …` / `br close …`). Ground
  status against merged/open PR state (`pr-<n>` labels link the bead to its
  GitHub PR), not against any Markdown.

**Operating guide:** for *how* to query the graph reliably (the
`br … --json` schema-divergence trap), how to sequence the next phase by
blocking factor (`bv --robot-insights` `topk_set`/`coverage_set`), the
**signoff queue** (draining decisions: the `signoff:pending` convention +
`scripts/signoff-queue.sh`), and verified `jq` recipes against
`issues.jsonl`, see
[docs/contributing/beads-operating-guide.md](docs/contributing/beads-operating-guide.md).
Point coordinators there.

**Signoff protocol (every lane) — structured, no prose to parse:** when you
queue a decision for a human:

```bash
br update <id> --add-label signoff:pending --add-label pr-<NNN> \
  --external-ref https://github.com/gurdasnijor/firegrid/pull/<NNN>
br dep add <gated-id> <id>     # the bead must `blocks` whatever it gates
```

The decisioner drains via `bash scripts/signoff-queue.sh` (read-only, ranked
keystone-first; `show <id>` for full context) and decides with the **single
structured transition** `br close <id> --reason "DECIDED: <verdict>"` — which
records the verdict *and* auto-unblocks every dependent via the graph (no
label-removal step that fails to propagate). Deliberation (options/reasoning)
stays in the PR/SDD at `external_ref` — read-material, never parsed for state.
The coordinator stays read-only: it routes, it does not mutate `br`. Full
model: `docs/contributing/decisions.md`.

### Bead-graph hygiene policy (added 2026-05-09 by `beads_rust-30ci`)

**Don't close beads with `Forced close due to cycle` or similar hedge text in the `close_reason`.** If a dependency cycle is in the way, resolve it first via:

- `br dep remove <issue> <depends-on>` — drop a single edge.
- `br update <issue> --parent ''` — clear a parent-child edge.
- Refactor the bead graph itself (split / merge / restructure).

Closing a bead under an unresolved cycle hides architectural debt and produces an audit-suspect close trail.

The doctor check `audit.suspect_close_reasons` (sibling bead `beads_rust-m3mi`) flags this pattern. The only legitimate close-under-cycle is when accompanied by the `audit-historical-cycle-close-<YYYY>-<MM>-<DD>` label, applied via:

```bash
br update <id> --add-label audit-historical-cycle-close-<DATE>
```

The label tells the doctor check + future audits that the closure has been triaged. Past triage decisions live in `docs/audit_forced_cycle_close_<DATE>.md`.

### Conventions

- **Single source of truth:** Beads for task status/priority/dependencies; Agent Mail for conversation and audit
- **Shared identifiers:** Use Beads issue ID (e.g., `br-123`) as Mail `thread_id` and prefix subjects with `[br-123]`
- **Reservations:** When starting a task, call `file_reservation_paths()` with the issue ID in `reason`

### Typical Agent Flow

1. **Pick ready work (Beads):**
   ```bash
   br ready --json  # Choose highest priority, no blockers
   ```

2. **Reserve edit surface (Mail):**
   ```
   file_reservation_paths(project_key, agent_name, ["src/**"], ttl_seconds=3600, exclusive=true, reason="br-123")
   ```

3. **Announce start (Mail):**
   ```
   send_message(..., thread_id="br-123", subject="[br-123] Start: <title>", ack_required=true)
   ```

4. **Work and update:** Reply in-thread with progress

5. **Complete and release:**
   ```bash
   br close 123 --reason "Completed"
   br sync --flush-only  # Export to JSONL (no git operations)
   ```
   ```
   release_file_reservations(project_key, agent_name, paths=["src/**"])
   ```
   Final Mail reply: `[br-123] Completed` with summary

### Degraded Coordination When Agent Mail Is Unavailable

Agent Mail reservations are the normal collision-avoidance mechanism. If Agent
Mail is red or unreachable, keep moving but make the weaker coordination state
visible in `br` before touching code:

1. **Claim with an explicit actor:**
   ```bash
   br update <id> --status in_progress --assignee "$AGENT_NAME" --json
   ```

2. **Record intended file scope in the issue thread:**
   ```bash
   br comments add <id> --author "$AGENT_NAME" \
     --message "degraded-coordination: Agent Mail unavailable; files: src/foo.rs, docs/bar.md" \
     --json
   ```

3. **Check for collisions before editing:** inspect `git status --short`,
   `br list --status in_progress --json`, and recent comments on the bead. If
   another active agent names the same files, pick different work or narrow the
   scope before editing.

4. **Keep the fallback advisory:** this is not a lock. Use the smallest possible
   file set, avoid broad globs, and update the comment if the edit surface
   expands.

5. **Finish normally:** close the bead, run `br sync --flush-only`, commit the
   code and `.beads/` changes together, and mention in the close reason that the
   work used degraded coordination. There is no Mail reservation to release.

### Stale Claims and Reclaiming Abandoned Work

`br ready` excludes `in_progress` beads, so a crashed or abandoned session can
hide work indefinitely. Do not treat every old claim as free work. Reclaim only
after you have evidence from the bead metadata and coordination trail.

Use this rule of thumb:

- Agent swarm claim: stale candidate after two hours without an `updated_at`
  change, unless the human operator explicitly says the pane/session is dead.
- Human or unclear claim: stale candidate after one business day.
- Any claim with live Agent Mail reservations, recent comments, or visible dirty
  work in the same files is not abandoned.

Before reclaiming, inspect:

```bash
br show <id> --json
br comments list <id> --json
br list --status in_progress --json
git status --short
```

If Agent Mail is healthy, also inspect the issue thread and active file
reservations. Use `updated_at`, `assignee`, any session/pane/agent identity in
comments, and named file scopes as evidence. If the previous owner may still be
working, choose another ready bead or ask the human operator.

When reclaiming, leave an audit comment first, then claim:

```bash
br comments add <id> --author "$AGENT_NAME" \
  --message "reclaim: previous in_progress claim appears abandoned; evidence: updated_at=<timestamp>, assignee=<name>, no active reservation or pane" \
  --json
br update <id> --claim --json
```

If Agent Mail is unavailable, add or include the degraded-coordination intended
file scope before editing. The newest assignee owns the claim, but if the old
owner returns, coordinate in the bead thread instead of overwriting their work.

### Mapping Cheat Sheet

In this repo the issue prefix is `tf`, so `###` below means a full id like
`tf-q44` (and for tiny-firegrid work also carry the `tfind:NNN` label):

| Concept | Value |
|---------|-------|
| Mail `thread_id` | `tf-###` |
| Mail subject | `[tf-###] ...` |
| File reservation `reason` | `tf-###` |
| Commit messages | Include `tf-###` (and `TFIND-NNN` when relevant) for traceability |

---

## bv — Graph-Aware Triage Engine

bv is a graph-aware triage engine for Beads projects (here: `.beads/issues.jsonl`). It computes PageRank, betweenness, critical path, cycles, HITS, eigenvector, and k-core metrics deterministically.

**Scope boundary:** bv handles *what to work on* (triage, priority, planning). For agent-to-agent coordination (messaging, work claiming, file reservations), use MCP Agent Mail. If Agent Mail is unavailable, use the degraded `br` comment protocol above until Mail is healthy again.

**CRITICAL: Use ONLY `--robot-*` flags. Bare `bv` launches an interactive TUI that blocks your session.**

### The Workflow: Start With Triage

**`bv --robot-triage` is your single entry point.** It returns:
- `quick_ref`: at-a-glance counts + top 3 picks
- `recommendations`: ranked actionable items with scores, reasons, unblock info
- `quick_wins`: low-effort high-impact items
- `blockers_to_clear`: items that unblock the most downstream work
- `project_health`: status/type/priority distributions, graph metrics
- `commands`: copy-paste shell commands for next steps

```bash
bv --robot-triage        # THE MEGA-COMMAND: start here
bv --robot-next          # Minimal: just the single top pick + claim command
```

### Command Reference

**Planning:**
| Command | Returns |
|---------|---------|
| `--robot-plan` | Parallel execution tracks with `unblocks` lists |
| `--robot-priority` | Priority misalignment detection with confidence |

**Graph Analysis:**
| Command | Returns |
|---------|---------|
| `--robot-insights` | Full metrics: PageRank, betweenness, HITS, eigenvector, critical path, cycles, k-core, articulation points, slack |
| `--robot-label-health` | Per-label health: `health_level`, `velocity_score`, `staleness`, `blocked_count` |
| `--robot-label-flow` | Cross-label dependency: `flow_matrix`, `dependencies`, `bottleneck_labels` |
| `--robot-label-attention [--attention-limit=N]` | Attention-ranked labels |

**History & Change Tracking:**
| Command | Returns |
|---------|---------|
| `--robot-history` | Bead-to-commit correlations |
| `--robot-diff --diff-since <ref>` | Changes since ref: new/closed/modified issues, cycles |

**Other:**
| Command | Returns |
|---------|---------|
| `--robot-burndown <sprint>` | Sprint burndown, scope changes, at-risk items |
| `--robot-forecast <id\|all>` | ETA predictions with dependency-aware scheduling |
| `--robot-alerts` | Stale issues, blocking cascades, priority mismatches |
| `--robot-suggest` | Hygiene: duplicates, missing deps, label suggestions |
| `--robot-graph [--graph-format=json\|dot\|mermaid]` | Dependency graph export |
| `--export-graph <file.html>` | Interactive HTML visualization |

### Scoping & Filtering

```bash
bv --robot-plan --label backend              # Scope to label's subgraph
bv --robot-insights --as-of HEAD~30          # Historical point-in-time
bv --recipe actionable --robot-plan          # Pre-filter: ready to work
bv --recipe high-impact --robot-triage       # Pre-filter: top PageRank
bv --robot-triage --robot-triage-by-track    # Group by parallel work streams
bv --robot-triage --robot-triage-by-label    # Group by domain
```

### Understanding Robot Output

**All robot JSON includes:**
- `data_hash` — Fingerprint of source beads.jsonl
- `status` — Per-metric state: `computed|approx|timeout|skipped` + elapsed ms
- `as_of` / `as_of_commit` — Present when using `--as-of`

**Two-phase analysis:**
- **Phase 1 (instant):** degree, topo sort, density
- **Phase 2 (async, 500ms timeout):** PageRank, betweenness, HITS, eigenvector, cycles

### jq Quick Reference

```bash
bv --robot-triage | jq '.quick_ref'                        # At-a-glance summary
bv --robot-triage | jq '.recommendations[0]'               # Top recommendation
bv --robot-plan | jq '.plan.summary.highest_impact'        # Best unblock target
bv --robot-insights | jq '.status'                         # Check metric readiness
bv --robot-insights | jq '.Cycles'                         # Circular deps (must fix!)
```

<!-- bv-agent-instructions-v2 -->

---

## Beads Workflow Integration

This project uses [beads_rust](https://github.com/Dicklesworthstone/beads_rust) (`br`) for issue tracking and [beads_viewer](https://github.com/Dicklesworthstone/beads_viewer) (`bv`) for graph-aware triage. Issues are stored in `.beads/` and tracked in git.

### Using bv as an AI sidecar

bv is a graph-aware triage engine for Beads projects (here: `.beads/issues.jsonl`). Instead of parsing JSONL or hallucinating graph traversal, use robot flags for deterministic, dependency-aware outputs with precomputed metrics (PageRank, betweenness, critical path, cycles, HITS, eigenvector, k-core).

**Scope boundary:** bv handles *what to work on* (triage, priority, planning). `br` handles creating, modifying, and closing beads.

**CRITICAL: Use ONLY --robot-* flags. Bare bv launches an interactive TUI that blocks your session.**

#### The Workflow: Start With Triage

**`bv --robot-triage` is your single entry point.** It returns everything you need in one call:
- `quick_ref`: at-a-glance counts + top 3 picks
- `recommendations`: ranked actionable items with scores, reasons, unblock info
- `quick_wins`: low-effort high-impact items
- `blockers_to_clear`: items that unblock the most downstream work
- `project_health`: status/type/priority distributions, graph metrics
- `commands`: copy-paste shell commands for next steps

```bash
bv --robot-triage        # THE MEGA-COMMAND: start here
bv --robot-next          # Minimal: just the single top pick + claim command

# Token-optimized output (TOON) for lower LLM context usage:
bv --robot-triage --format toon
```

#### Other bv Commands

| Command | Returns |
|---------|---------|
| `--robot-plan` | Parallel execution tracks with unblocks lists |
| `--robot-priority` | Priority misalignment detection with confidence |
| `--robot-insights` | Full metrics: PageRank, betweenness, HITS, eigenvector, critical path, cycles, k-core |
| `--robot-alerts` | Stale issues, blocking cascades, priority mismatches |
| `--robot-suggest` | Hygiene: duplicates, missing deps, label suggestions, cycle breaks |
| `--robot-diff --diff-since <ref>` | Changes since ref: new/closed/modified issues |
| `--robot-graph [--graph-format=json\|dot\|mermaid]` | Dependency graph export |

#### Scoping & Filtering

```bash
bv --robot-plan --label backend              # Scope to label's subgraph
bv --robot-insights --as-of HEAD~30          # Historical point-in-time
bv --recipe actionable --robot-plan          # Pre-filter: ready to work (no blockers)
bv --recipe high-impact --robot-triage       # Pre-filter: top PageRank scores
```

### br Commands for Issue Management

```bash
br ready              # Show issues ready to work (no blockers)
br list --status=open # All open issues
br show <id>          # Full issue details with dependencies
br create --title="..." --type=task --priority=2
br update <id> --status=in_progress
br close <id> --reason="Completed"
br close <id1> <id2>  # Close multiple issues at once
br sync --flush-only  # Export DB to JSONL
```

### Workflow Pattern

1. **Triage**: Run `bv --robot-triage` to find the highest-impact actionable work
2. **Claim**: Use `br update <id> --status=in_progress`
3. **Work**: Implement the task
4. **Complete**: Use `br close <id>`
5. **Sync**: Always run `br sync --flush-only` at session end

### Key Concepts

- **Dependencies**: Issues can block other issues. `br ready` shows only unblocked work.
- **Priority**: P0=critical, P1=high, P2=medium, P3=low, P4=backlog (use numbers 0-4, not words)
- **Types**: task, bug, feature, epic, chore, docs, question
- **Blocking**: `br dep add <issue> <depends-on>` to add dependencies

### Session Protocol

```bash
git status              # Check what changed
git add <files>         # Stage code changes
br sync --flush-only    # Export beads changes to JSONL
git commit -m "..."     # Commit everything
git push                # Push to remote
```

<!-- end-bv-agent-instructions -->
