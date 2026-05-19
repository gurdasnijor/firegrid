# How decisions work (structured, beads-native)

A decision — "we are blocked until a human rules on X" — is **structured
state in beads**, not prose in a doc that someone scrapes back out. This page
is the whole contract. It is short on purpose.

## The model

A bead awaiting a ruling carries four structured things. Nothing is parsed
from markdown.

| Concept | Where it lives |
|---|---|
| awaiting a ruling | label **`signoff:pending`** (+ status open/in_progress) |
| where to read the reasoning | **`external_ref`** — one URL: the PR/SDD |
| what it unblocks | real **`blocks` dependency edges** |
| the verdict | the `--reason` of **`br close`** |

The deliberation — options, trade-offs, the SDD — is prose and **belongs in
the PR/SDD**. That is fine. The decision *state* is the bead. Never conflate
them; never parse the SDD for state.

## The one transition that matters

```bash
br close <id> --reason "DECIDED: <one-line verdict>"
```

This is the entire close. It records the verdict structurally **and** the
dependency graph auto-unblocks every dependent (`br ready` / `bv` recompute
immediately). There is no separate "remove the label" step — and historically
that step is exactly what got skipped, leaving the keystone blocked while
everyone believed it was decided. In this model that failure is impossible:
the gate *is* the dependency edge, and `br close` resolves it.

If the decision is made but implementation is still owed *on that same bead*,
don't close it — decouple just the gate instead:

```bash
br dep remove <gated-id> <id>     # the decision no longer blocks <gated-id>
```

## Three roles

**Owning lane** (the engineer/agent that needs the ruling) — on queuing:

```bash
br update <id> --add-label signoff:pending --add-label pr-<NNN> \
  --external-ref https://github.com/gurdasnijor/firegrid/pull/<NNN>
br dep add <gated-id> <id>        # ensure the bead blocks what it gates
```

The bead **title** is the topic. Everything else the decisioner needs is at
`external_ref`. There is no prose template to fill in or get wrong.

**Coordinator** — read-only router. Runs `bash scripts/signoff-queue.sh`,
routes `signoff:pending` items to the decisioner, bounces any with no
`external_ref` back to the owning lane. **Never mutates `br`.**

**Decisioner** (br-owner) — runs the queue, opens `external_ref`, decides,
and closes with the one transition above. Done.

## Seeing the queue

```bash
bash scripts/signoff-queue.sh            # ranked digest, keystone-first
bash scripts/signoff-queue.sh show <id>  # one item: topic, gates, ref, PR state
bash scripts/signoff-queue.sh --json     # for agents
```

It is a pure structured query (labels, status, `external_ref`, the dependency
graph, `bv` rank). No markdown is parsed anywhere — there is nothing to be
brittle about. `<id>` accepts a bead id, `TFIND-NNN`, or `#PR`.

Ranking is keystone-label → `bv` blocker → priority → age. The `keystone`
label is the authoritative load-bearing signal (bv's marginal gain
under-weights a transitively-load-bearing keystone); priority is advisory.

## The invariant

> A decision is not "made" until `br close --reason` (or `br dep remove`) has
> run. Not chat, not the PR review, not a label. Until then the queue keeps
> surfacing it — correctly. Deciding *is* the structured transition.

## Why not an SDD/PR field, or Obsidian?

The SDD/PR is the right place for the *reasoning* and stays there, linked via
`external_ref`. It is the wrong place for decision *state* — parsing prose for
state is what made the old approach brittle. Obsidian (incl. the Templates
plugin) only produces unstructured markdown in a vault outside git: no schema,
no dependency graph, no auto-unblock, and a parallel store that re-creates the
stale-ledger problem. Beads already has every structured primitive a decision
needs; use it.
