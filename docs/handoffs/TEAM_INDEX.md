# Next Wave Handoff Index

Date: 2026-05-06

This folder is the shared handoff packet for the next package-bridge and agent-runtime integration wave. New sessions should start here, then read the role-specific docs below.

## Start Here

1. `coordinator-handoff.md` - complete coordinator handoff, current baseline, cmux protocol, guardrails, and next-wave recommendations.
2. `ca1-firegrid-firepixel-handoff.md` - complete CA1 Firegrid and Firepixel implementation context.
3. `ca2-backup-context-handoff.md` - complete CA2 backup context and standby protocol.
4. `ca3-fireline-firepixel-bridge-handoff.md` - complete CA3 Fireline bridge, Firepixel doc/report, and closeout context.
5. `ola-lead-review-handoff.md` - complete OLA/Lead review bars, merge reserve protocol, and escalation guidance.
6. `oca-review-handoff.md` - complete OCA cross-repo review posture, known soft observations, and review checklist.

## Current Baseline

Use these merged baselines as the starting evidence for the next wave:

| Repo | Recent Lane Range | Final Merge |
| --- | --- | --- |
| Firegrid | PKG1-PKG2C, PRs #100-104 | `b46e9e2` |
| Firepixel | FPX2-FPX8, PRs #121-129 | `4ba3977` |
| Fireline | FLX1-FLX9, PRs #913-926 | `c56de5a` |

Live unrelated PRs at closeout:

- Firegrid: none.
- Firepixel: #119 and #108.
- Fireline: #912.

## Next Wave Theme

The next wave should focus on:

- Hardening Firegrid public surface boundaries.
- Validating integration patterns with additional agent runtimes.
- Starting with `https://github.com/smithery-ai/flamecast-agents` as a target runtime candidate.
- Preserving package-consumption discipline: packed artifacts, public APIs, no sibling paths, no fake terminal authoring, and no broad product semantics unless a spec and public seam exist.

## Team Doc Protocol

Each team member should add exactly one role-specific Markdown file in this folder, then ping back on their cmux surface with:

```text
HANDOFF COMPLETE: <file path>
```

Keep team docs read-only unless explicitly assigned implementation work. Do not open PRs for team handoff docs unless the coordinator asks.

## cmux Protocol Summary

- Send coordinator updates to `surface:33` with `[to-proxy-agent]`.
- Press Enter after every `cmux send` using:

```sh
cmux send-key --workspace workspace:2 --surface <surface> Enter
```

- Include lane name, repo, PR number, head SHA, CI status, merge state, worktree path, and cleanup status in handoff updates.
- Route reviews only after CI is green and merge state is CLEAN.
- Reviewers do not merge. Coordinator owns merge.
