# Beads Operating Guide (coordinator-facing)

Practical guide for working the tiny-firegrid issue graph with `br`/`bv`.
This is the *operating* doc; `AGENTS.md` → "Beads (br)" → "Firegrid workspace
specifics" holds the workspace facts (prefix `tf`, `tfind:NNN` join label,
git-tracked `issues.jsonl`, the FINDINGS/CONFIGS authority cutover). Read that
block first; this one assumes it.

## TL;DR

- **Beads is the sole authority** for tiny-firegrid finding/config status.
  The old Markdown ledgers (`FINDINGS.md`/`CONFIGS.md`/`HANDOFF.md`) were
  deleted post-cutover (#354/#356) — do not recreate them.
- **Two reliable query surfaces only.** Never parse `br … --json` ad hoc.
- **To sequence the next phase**, ask `bv` for the max-unblock set — don't
  eyeball the graph.

## Cardinal rule: do not parse `br … --json` ad hoc

`br`'s JSON surfaces are **schema-divergent and lossy by default**. This has
already cost a coordinator a full debugging detour. Concretely:

| Command | Shape | `labels` field? | Closed issues? |
|---|---|---|---|
| `br list --json` | `{total,issues,limit,offset}` (wrapped, **paginated**, default limit 50) | ✅ included | ❌ **hidden** unless `--all` |
| `br ready --json` | bare **array**, ~9 thin keys | ❌ **absent** | n/a |
| `br blocked --json` | varies | partial | n/a |

Failure mode: a label/dependency filter run against `br ready --json` returns
`[]` for **every** record — silently, because the field was never in the
projection — and looks like "no results / shape differs." Suppressing stderr
(`2>/dev/null`) while doing this turns a loud parse error into a confident
wrong answer. Don't do either.

**Use exactly these two surfaces:**

1. **`bv --robot-*`** for triage / graph / sequencing. Stable, documented JSON.
   Note the nesting: triage data is under `.triage`, insights under
   `.advanced_insights`. Never run bare `bv` (it opens a blocking TUI) — always
   `--robot-*`.
2. **`.beads/issues.jsonl`** for any label/dependency/status rollup. It is
   one complete JSON object per line (all labels, all dependencies, status,
   actor, timestamps) and is the git-tracked source of truth. Stream it with
   `jq -c` (no `-s`) — never `python -c` through a shell (heredoc/quote
   mangling is its own recurring footgun).

For human-readable one-offs, the **table** forms (`br ready`, `br blocked`,
`br show <id>`) are reliable — it's only the *ad hoc JSON parsing* that bites.

## Sequencing the next phase by "blocking factor"

This is a native `bv` query. `br` only tells you *whether* something is
blocked; `bv` tells you *what unblocks the most*, in order.

```bash
bv --robot-insights | jq '.advanced_insights.topk_set'      # ordered max-unlock plan
bv --robot-insights | jq '.advanced_insights.coverage_set'  # minimal edge-covering set
bv --robot-plan     | jq '.plan.summary'                    # single highest-impact pick
bv --robot-triage   | jq '.triage.blockers_to_clear'        # friendlier framing
```

- **`topk_set`** — *"Best k issues to complete for max downstream unlock. Work
  these in order."* `marginal_gain` is greedy (recomputed after each pick), so
  re-run it after every merge; the order shifts as the graph changes.
- **`coverage_set`** — smallest set of issues touching *every* dependency edge.
  Use it as the next-phase working set for breadth.

Caveats (verify outputs, don't assume):

- **`bv --robot-plan`'s `tracks` is unimplemented in the current bv build** —
  it returns empty `?`/0-issue tracks and `parallel_gain` reports
  `state: "pending" (bv-129)`. Sequence off `topk_set`/`coverage_set`, not
  `--robot-plan` tracks.
- The graph is **shallow** (~29 edges over 64 issues; most findings are
  independent). Blocking-factor sequencing mainly governs the gating roots and
  the keystone chain; for the rest, fall back to priority/`br ready`.

## Verified `jq` recipes (against `.beads/issues.jsonl`)

All tested. Run from the repo root.

```bash
# Every config epic with status
jq -rc 'select(.labels[]?|startswith("config:"))
  | [.id,.status,(.labels[]|select(startswith("config:")))] | @tsv' .beads/issues.jsonl

# Resolve a TFIND number to its bead (the tfind:NNN join key, 3-digit padded)
jq -rc 'select(.labels[]? == "tfind:049") | [.id,.status,.title] | @tsv' .beads/issues.jsonl

# Open findings grouped by triage-rubric category
jq -rc 'select(.status=="open" and (.labels[]?|startswith("tfind:")))
  | (.labels[]|select(startswith("cat-")))' .beads/issues.jsonl | sort | uniq -c | sort -rn

# Who-blocks-whom (dependency edges; fields are issue_id / depends_on_id)
jq -rc 'select((.dependencies//[])|length>0)
  | .dependencies[] | "\(.depends_on_id) blocks \(.issue_id)"' .beads/issues.jsonl

# Full open/in_progress picture with status label + factory tag
jq -rc 'select(.status=="open" or .status=="in_progress")
  | {id,status,t:[.labels[]|select(startswith("tfind:")or startswith("config:"))],
     cat:[.labels[]|select(startswith("cat-"))]}' .beads/issues.jsonl
```

Mutations still go through `br` (`br update --status …`, `br close …`,
`br dep add …`), then `br sync --flush-only` and commit `.beads/issues.jsonl`.
Reading is via the two surfaces above. `scripts/beads-import-findings.sh` was
the one-time migration; its `FINDINGS.md`/`CONFIGS.md` inputs were deleted in
#354, so it is no longer re-runnable — never invoke it to "update" state.

## Signoff queue (the structured decision model)

A decision is **structured beads state, not prose to parse.** Earlier this was
a `DECISION:`/`READ:` block grepped out of the description with a
heading-bisecting SDD scraper — three parsing bugs in one sitting. Deleted.
Every field of a decision now has a structured home:

| Decision concept | Structured beads primitive |
|---|---|
| awaiting a ruling | label **`signoff:pending`** + status open/in_progress |
| where to read | **`external_ref`** — one URL (the PR/SDD). Open it; never parse it. |
| what it gates | real **`blocks` dependency edges** (the graph) |
| the verdict | **`br close <id> --reason "DECIDED: …"`** |

The close is the whole point: `br close --reason` records the verdict
structurally **and** the dependency graph auto-unblocks every dependent. There
is no "remove a label" step that fails to propagate — *the gate is the edge*.
The old bug (decided, but the keystone stayed blocked) is now structurally
impossible.

**Owning lane — on queuing a decision (all structured, no prose):**

```bash
br update <id> --add-label signoff:pending --add-label pr-<NNN> \
  --external-ref https://github.com/gurdasnijor/firegrid/pull/<NNN>
# ensure the bead actually `blocks` whatever the decision gates:
br dep add <gated-id> <id>          # <gated-id> depends on <id>
```

The bead **title** is the topic; the deliberation (options, reasoning) lives
in the PR/SDD at `external_ref` — that is fine *as read-material*. The mistake
was ever treating that prose as the decision *state*. Deliberation = prose in
the PR; decision = structured bead.

**Decisioner tool (read-only — pure structured query, no markdown parsed):**

```bash
bash scripts/signoff-queue.sh            # ranked digest, keystone first
bash scripts/signoff-queue.sh --json     # structured
bash scripts/signoff-queue.sh show tf-qy4   # one item: topic, gates, ref, PR state
```

Each row shows `topic` (title), `gates` (computed from the dependency graph),
`read` (`external_ref`), and the **one** command: `br close <id> --reason
"DECIDED: <verdict>"`. `show` adds verbatim PR state and the dep-decouple
alternative (`br dep remove <gated> <id>`) for the rare case the decision must
not close the bead.

**Ranking is NOT raw bv order.** bv `topk_set` is 1-hop marginal and
under-weights a transitively-load-bearing keystone. Order: `keystone` label →
`bv … blockers_to_clear` membership → priority → age. Priority is advisory;
`keystone` is authoritative.

**Roles:**

- *Owning lane* — writer: sets `signoff:pending` + `pr-` + `external_ref` and
  the `blocks` edge on queuing. No prose contract to get wrong.
- *Coordinator* — read-only router: runs `signoff-queue.sh`, routes
  `signoff:pending` → decisioner, missing `external_ref` → bounce to lane.
  Never mutates `br`.
- *Decisioner / br-owner* — closer: `br close <id> --reason "DECIDED: …"`.
  That single transition is the verdict **and** the unblock. (If impl is still
  owed *on that bead*, instead `br dep remove <gated> <id>` to decouple just
  the gate and keep it open.) Staleness backstop: `bv --robot-alerts` /
  `--robot-label-health` on `signoff:pending`.

`jq` over `issues.jsonl` is one of the two first-class surfaces — not an
exception. Only ad-hoc `br … --json` is prohibited.

## When something looks empty or wrong

1. Don't suppress stderr. Re-run without `2>/dev/null` and read the error.
2. Inspect the JSON shape **once** (`… --json | jq 'if type=="array" then
   "array" else keys end'`) before filtering — don't guess wrapped-vs-array.
3. If filtering on labels or dependencies, you are on the wrong surface unless
   you are reading `.beads/issues.jsonl`. Switch.
4. Status moved and something disagrees? Beads wins — it is the only ledger;
   the old `FINDINGS.md`/`CONFIGS.md` no longer exist.
