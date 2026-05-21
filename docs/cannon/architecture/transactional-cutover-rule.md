# Transactional Cutover Rule

Status: canonical architecture/process invariant
Date: 2026-05-21

Firegrid does not accept half-shipped replacement architecture in production
packages.

`packages/tiny-firegrid/` is the exception. It is the sandbox for spikes,
evidence, partial demonstrations, and intentionally disposable prototypes.
Half-ships are allowed there as long as they are not presented as production
implementation.

If a feature, refactor, or SDD starts replacing an existing path, the work is
done only when the replacement is the production path and the old path is
removed, retired behind a deliberately named compatibility boundary, or
explicitly classified as still blocking the cutover.

## Rule

Replacement work outside `packages/tiny-firegrid/` must be transactional.

That means a PR, bead, or wave that changes product code, public docs, package
boundaries, SDK surfaces, runtime behavior, or canonical architecture may close
as complete only if one of these is true:

1. **Direct cutover:** the new path fully replaces the old path, the old path is
   deleted or made unreachable, and tests prove the new path covers the former
   behavior.
2. **Explicit bridge:** the old and new paths intentionally coexist for a short
   time, but the bridge is named in code/docs, has an owner, has a deletion
   target, and has a blocking follow-up bead that cannot be bypassed.
3. **Spike only:** the work is labeled as evidence, not production completion.
   It may validate a direction, but it must not close the implementation work it
   motivates.

Anything else is a half-ship and is not acceptable outside tiny-firegrid.

Inside `packages/tiny-firegrid/`, partial work is acceptable when it is labeled
as a spike, fixture, simulation, or finding generator. The moment code moves
from tiny-firegrid into `packages/client-sdk`, `packages/runtime`,
`packages/host-sdk`, `packages/protocol`, apps, CLI, or canonical docs, the
transactional rule applies.

## Beads Discipline

Broad replacement beads must not be closed as superseded by narrower slices
unless the remaining replacement work is captured in a new blocking bead before
closure.

When a broad bead is split:

- the broad bead must name which slice landed;
- the broad bead must name what did not land;
- every unlanded part must be represented by a follow-up bead;
- downstream work must depend on the follow-up, not on the narrow slice alone.

Closing a broad bead because "the important first slice landed" is invalid.

## Review Discipline

Reviewers should reject replacement PRs that leave both paths alive without a
declared bridge contract.

The PR description should answer:

- What existing path is being replaced?
- What old imports, exports, APIs, files, or runtime flows disappear?
- If anything remains, why is it still needed?
- What exact bead owns its deletion or final reconciliation?
- What tests prove callers can use the new path without the old ceremony?

If the answer is "the old path remains for later" and there is no blocking bead,
the PR is not a finished cutover.

## Example: Durable Sync/Async Channels

`tf-lfxs` validated durable sync/async channel framing in tiny-firegrid, which
was allowed to be partial. `tf-lf9p` then moved into production code and shipped
the first production slice: dependent session writes no longer require explicit
`session.whenReady` before `session.prompt` or `session.start`.

That does not mean the global sync/async channel implementation is done. It
means one replacement slice landed. The remaining callable/channel operations
still require a production closure audit and, where needed, transactional
cutovers.

The lesson is the rule: a GREEN spike plus one production slice is not a
completed feature unless the old concept is gone everywhere it was meant to
replace.

## Bridge Contract

Temporary bridges are allowed only when they are visible and scheduled for
removal.

A valid bridge has:

- a named reason;
- a bounded scope;
- an owner;
- a deletion or reconciliation bead;
- tests that cover both the bridge behavior and the target behavior;
- documentation stating that the bridge is not the architecture.

Undocumented coexistence is not a bridge. It is architectural debt.
