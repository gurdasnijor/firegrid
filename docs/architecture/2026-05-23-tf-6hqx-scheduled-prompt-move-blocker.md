# tf-6hqx — ScheduledPromptWorkflow physical move BLOCKED

Date: 2026-05-23
Status: BLOCKER reported (per Lane 3 dispatch directive: "STOP and report exact blocker instead of bridging")
Lane: post-#726 cleanup Lane 3 (Shape D wait/scheduled relocation)
Co-shipped slice: tf-hpr0 WaitForWorkflow relocation (LANDED in same PR)

## Blocker

`subscribers/scheduled-prompt/workflow.ts` cannot be created at the
canonical target path. The body imports `appendScheduledPromptIntent`
from `producers/ingress-writers/scheduled-prompt-append.ts`, which the
HARD STOP dep-cruise rule `runtime-subscribers-no-producers-import`
forbids from any file under `subscribers/`.

### Exact error

```
error runtime-subscribers-no-producers-import: \
  packages/runtime/src/subscribers/scheduled-prompt/workflow.ts → \
  packages/runtime/src/producers/ingress-writers/scheduled-prompt-append.ts
```

### Rule statement (`.dependency-cruiser.cjs:185-192`)

> HARD STOP per the target-tree roadmap: subscribers/ must not import
> producers/, full stop. Subscribers depend on typed lower-tier sources
> (tables/, transforms/, channels/, events/). A subscriber that needs
> producer behavior either needs a typed table read (cleaner) or itself
> crosses into producer responsibilities (wrong tier).

## Why the dispatcher's STOP rule was triggered

Per the Lane 3 dispatch directive:

> If the move turns out to require substrate/body changes, STOP and
> report exact blocker instead of bridging.

The mover considered four options. All require substrate/body change:

| Option | Why it's not "just a move" |
|---|---|
| (a) Carve-out in `runtime-subscribers-no-producers-import` | Bridge code — banned by the cleanup wave's no-bridge rule and by the rule's HARD STOP framing |
| (b) Move `scheduled-prompt-append.ts` out of `producers/ingress-writers/` | Substrate-side relocation of a producer module |
| (c) Inline the producer logic inside the subscriber body | Subscriber takes on producer responsibility (the rule comment explicitly names this as the wrong tier) |
| (d) Add a typed write channel/table API for input-intent append that subscribers may use | Body reshape: requires a new typed surface and migrating call sites |

None is a pure relocation. Per the directive, mover stops and reports.

## Sibling slice (tf-hpr0) lands cleanly

`subscribers/wait-router/workflow.ts` does NOT trip the same rule:

```
subscribers/wait-router/workflow.ts
  → transforms/field-equals.ts   (allowed)
  → streams/index.ts              (allowed — streams/ is a runtime-internal
                                   source tier, not producers/)
```

That move is included in this PR.

## Acceptance against Lane 3 dispatch

> Acceptance: pnpm preflight green; no wait-for/scheduled-prompt source
> remains under workflow-engine/workflows.

- ✅ `wait-for.ts` removed from `workflow-engine/workflows/`; lives at
  `subscribers/wait-router/workflow.ts`.
- ⚠ `scheduled-prompt.ts` remains at `workflow-engine/workflows/`;
  forward-target shim continues to re-export from
  `subscribers/scheduled-prompt/index.ts`. Partial acceptance: the wait
  half meets the move bar; the scheduled half is unblocked by reshape.
- ✅ `pnpm preflight` green with this partial state (carve-outs +
  baselines reflect the reverted half).

## Unblock paths (recommend (d))

A dispatched bead should answer:

1. **Producer-side relocation (option b)**: where does the input-intent
   append authority belong? Renaming the file does not actually solve
   the layering question — producers/ exists to host write-authority
   modules.
2. **Typed write API (option d)**: would extending the channel router to
   expose a typed write capability for `runtime-input-intent` (sibling
   of the existing typed-source ingress reads) let the subscriber stay
   pure? The append is already idempotent on intent key via
   `insertOrGet`, so a typed write route over that is a clean fit and
   stays inside the subscribers/-allowed import set.

Recommendation: dispatch a follow-up bead with shape `tf-6hqx-write-api`
that adds the typed input-intent write surface (or a typed table-write
capability) consumable from subscribers/, then re-run the physical move
on top of it. The reshape is a small, scoped substrate addition — exactly
the "substrate change" the directive said belongs in its own slice.
