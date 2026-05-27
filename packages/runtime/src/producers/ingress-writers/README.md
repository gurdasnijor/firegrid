# producers/ingress-writers/

Logical pipeline position: **3** (subfolder of `producers/`). Reserved scaffold.

Per `docs/architecture/2026-05-22-runtime-physical-target-tree.md`, this folder
is the canonical home for **append authorities that bridge live boundaries into
durable rows**:

> `runtime-input-append.ts` — external input -> input intent rows
> `per-context-output.ts`  — `AgentSession.outputs -> RuntimeOutputTable.events`

It is currently a **scaffold-only** placement. Concrete moves into this folder
are blocked on a tier-rule decision: `producers/README.md` and the dep-cruiser
configuration forbid `subscribers/` from importing `producers/`, but Shape D
subscribers (`scheduled-prompt/`, `runtime-control/`) and the public
`composition/host-public.ts:appendRuntimeIngress` entrypoint do legitimately
need to write input-intent rows.

Two existing helpers are mis-placed today as a side effect:

- `tables/scheduled-prompt-append.ts:appendScheduledPromptIntent` — append
  helper living in `tables/` because the Shape D subscriber that calls it
  can't currently import `producers/`. Contradicts `tables/README.md`
  ("tables/ does NOT own append/write authority").
- `composition/host-public.ts:appendRuntimeIngress` — append-side call living
  in `composition/`. Contradicts `composition/README.md` ("Layer.* wiring only,
  no producer append calls").

The resolution is tracked in #756. Two plausible paths:

1. **Add a carveout** in `producers/README.md` + dep-cruiser allowing
   `subscribers/<shape-D>/` to import a narrow set of `producers/ingress-writers/`
   modules. Pros: simplest mechanical move; matches the role of these helpers.
   Cons: weakens the "subscribers don't import producers" invariant.
2. **Introduce a typed write capability tag** for each ingress family (e.g.,
   `RuntimeInputIngressAppender`, `ScheduledPromptIngressAppender`). The Tag
   lives somewhere both producers and subscribers can import (likely
   `channels/` or a new `capabilities/` folder); the Live binding implementing
   it lives here in `producers/ingress-writers/`; subscribers depend on the
   Tag through the Effect requirement channel. Pros: keeps the tier rule
   intact; matches the Effect-native capability pattern documented in
   `ARCHITECTURE.md` "Effect-Native Capability Rules". Cons: more files.

Until that decision lands, this folder stays empty and the existing helpers
stay in their (acknowledged) wrong-tier homes.

## May import (once populated)

- `events/`, `tables/`
- protocol schemas
- `effect`, `@effect/platform`, transport SDKs

## Must not import

- peer-tier `transforms/`, `channels/`
- `subscribers/`, `composition/`
