# Docs Taxonomy And Lifecycle

Doc-Class: internal-contract
Status: active
Owner: Firegrid Architecture
Created: 2026-05-21

## Why This Exists

`docs/` mixes four very different kinds of writing:

- the product story we tell people who do not work on Firegrid;
- the load-bearing interface and boundary contracts the team must honor;
- past design records and research evidence that explain how we got here;
- the small set of documents a coordinator or lane actually reads to dispatch
  work right now.

When those are interleaved without markers, stale research and superseded SDDs
get picked up as if they were current direction. That has already caused
implementation drift (for example, `docs/README.md` presenting the deleted
`durable-tools` plane as "current" long after `durable-tools` was removed).

This document defines a small, mandatory taxonomy so any reader — human or
agent — can tell, in one glance at the header, what a doc is for and whether it
can be trusted as current.

## The Marker

Every doc under `docs/` that is meant to be read by the team should carry a
two-line header directly under the title:

```md
# <Title>

Doc-Class: <public-narrative | internal-contract | historical-reference | dispatchable>
Status: <draft | active | ratified | superseded | historical | retired>
```

Older docs use a free-form `Status:` prose line. That is fine to keep, but new
and touched docs should add the structured `Doc-Class` line. The `Status:` line
may stay descriptive as long as it begins with one of the lifecycle words
above.

## Doc-Class (Audience + Role)

| Doc-Class | Who reads it | What it may contain | What it must NOT do |
| --- | --- | --- | --- |
| `public-narrative` | External / product / new readers | The story, the value, stable user-facing shape, quickstart | Canonize unstable internal APIs; depend on system-specific internals |
| `internal-contract` | The team building Firegrid | Load-bearing boundaries, invariants, interface contracts, package firewalls | Be aspirational without a lifecycle status; mix in product marketing |
| `historical-reference` | Anyone tracing rationale | Past SDDs, research, findings, handoffs, evidence | Be used to dispatch current work; be assumed accurate against `main` |
| `dispatchable` | Coordinators and lanes | Current source-of-truth used to assign and execute work *today* | Contradict shipped architecture; be left stale after a cutover |

The distinction that prevents drift is **dispatchable vs historical-reference**.
A doc being well-written, recent, or detailed does not make it dispatchable.
A doc is dispatchable only if it is currently true against `main` and listed in
the dispatch allowlist (see below).

`internal-contract` and `dispatchable` overlap: a ratified boundary contract is
both. Use `internal-contract` when the doc's job is to state an invariant, and
`dispatchable` when its job is to scope active work. A doc may carry both roles
in prose; pick the primary one for the header.

## Status (Lifecycle)

| Status | Meaning |
| --- | --- |
| `draft` | Framing/proposal; not yet ratified. May change. Not a dispatch source unless a dispatch explicitly scopes it. |
| `active` | Current and in force. Trustworthy against `main`. |
| `ratified` | Decision recorded and signed off; an `active` contract with a decision history. |
| `superseded` | Replaced by a newer doc; keep for rationale. Name the successor. |
| `historical` | Past evidence/record. Useful context, not current guidance. |
| `retired` | Kept only so links do not break; do not read for guidance. |

## The Default Rule (How To Avoid Marking Hundreds Of Files)

> **A doc is `historical-reference` by default. It is `dispatchable` or an
> active `internal-contract` only if it is listed in `docs/cannon/README.md`.**

`docs/cannon/README.md` is the **dispatch allowlist**. If a doc is not linked
there, treat it as historical-reference regardless of how current it looks. This
keeps the marking cost bounded: we curate one index instead of stamping every
file, and the index is the single thing that must stay honest after a cutover.

Consequences:

- Coordinators and lanes dispatch only from docs reachable through
  `docs/cannon/README.md`.
- `docs/sdds/`, `docs/research/`, `docs/proposals/`, `docs/reviews/`,
  `docs/handoffs/`, and `docs/investigations/` are historical-reference unless a
  cannon entry promotes a specific file.
- When a doc is promoted into cannon, add the structured `Doc-Class`/`Status`
  header to that file in the same change.

## When You Land A Cutover

Architecture cutovers are the moment docs go stale. When a PR changes shipped
architecture (a router cutover, a substrate swap, a boundary move), the same
change — or an immediate follow-up — must:

1. Update `docs/cannon/README.md` so the dispatch allowlist matches `main`.
2. Mark any doc the cutover contradicts as `superseded` or `historical`, and
   name the successor.
3. Promote the new source-of-truth doc into cannon with an `active`/`ratified`
   header.

This is the docs side of the transactional cutover rule
(`docs/cannon/architecture/transactional-cutover-rule.md`): code and its
governing docs ship together, or the doc debt is tracked as a blocking bead.

## Public vs Internal Split

Do not stuff system-specific internals into `public-narrative` docs (root
`README.md`, package READMEs, `docs/cannon/vision/`). When a public doc needs a
detailed internal counterpart, create an `internal-contract` companion under
`docs/architecture/` or `docs/sdds/` and link to it, rather than growing the
public doc with engine/table/stream coordinates that will drift.

## Quick Decision Guide

```txt
Is this doc the product story for outside readers?      -> public-narrative
Does it state an invariant/boundary the team must honor? -> internal-contract
Is it a past record/evidence/finding?                    -> historical-reference
Is it what a lane reads to do work right now?            -> dispatchable
Not sure, and not in docs/cannon/README.md?              -> historical-reference
```
