# Firegrid handoff archive

## Current handoff packet — START HERE

**Root `README.md`** (refreshed on PR #529, `tf-4eye`) is now the canonical
entry point — reflects current architecture (protocol → bindings → runtime;
channels as agent surface; host-sdk as binding/composition; durable-tools
gone) and points to `docs/cannon/`.

**[`sprint-to-private-beta/`](./sprint-to-private-beta/00-README.md)** — the
active handoff packet for the next 3-lane team finishing canonical-doc
convergence and driving Firegrid to private beta. Read its `00-README.md` for
the read order (which now begins with the refreshed root README and
`docs/cannon/`).

**Companion (live on main):** `docs/cannon/README.md` — gary's canonical
mirror/index for source-of-truth surfaces (architecture, SDDs, research, RFCs,
vision, handoffs). Originals untouched; cannon/ is the discoverability layer.

## Persistent companion (still relevant)

**[`COORDINATOR_HANDOFF_s6_dark_factory.md`](./COORDINATOR_HANDOFF_s6_dark_factory.md)**
— the prior arc's handoff. Its §0 META-PROCESS RULE, §3 operational tooling,
§4 working discipline, §8 post-mortem, and §9 closing-turn lessons are still
load-bearing. The §10 ARC CLOSURE confirms the §6 dark-factory live-run
landed; the older sections of the same doc are pre-closure context.

## Archive (point-in-time; historically useful, no longer the active map)

- **`coordinator-handoff.md`** (2026-05-16) — Host SDK execution-phase handoff
  predating the canonical convergence wave. PR #280 SDK plane split has
  long-since landed; subsequent work is captured in the canonical doc + the
  current sprint folder.
- **`TEAM_INDEX.md`** (2026-05-16) — companion to the above. Same era.
