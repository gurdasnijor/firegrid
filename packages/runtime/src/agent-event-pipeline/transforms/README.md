# Runtime Transforms

`transforms/` is reserved for pure stream and row-shaping operators shared by
pipeline components. It is intentionally empty after the live-owner cutover.

## Pipeline Fit

Transforms sit between event/row production and side-effecting consumers:

```txt
events/authorities -> transforms -> subscribers/codecs
```

They should be ordinary functions over Effect streams or rows. If a transform
needs durable writes, live process access, or host/session state, it belongs in
a subscriber, source, codec, or pipeline composition module instead.

Typical shape:

No current production transform remains here; runtime input decoding now lives
with host-sdk workflow/session ownership.

The transform keeps the same error and requirement channels it received. That
is the signal that it is pure stream shaping, not a subscriber or authority.
When a transform needs to change channels substantially, first check whether it
is really codec decoding or subscriber behavior.

## Purity rule (review-enforced; CI guard pending)

A transform here MUST be a **pure function** over rows / events / streams. The
shape system in
[`../../../../docs/cannon/architecture/runtime-pipeline-type-boundaries.md`](../../../../../docs/cannon/architecture/runtime-pipeline-type-boundaries.md)
calls this "transforms keep the same error and requirement channels they
received."

Concretely: a `.ts` file in this directory MUST NOT export Effect-shaped work.
The following constructors are forbidden here. CI enforcement
(`firegrid-transforms-no-effect-shaped-exports`) is a documented tf-zchu
follow-up — see
[`docs/cannon/architecture/runtime-design-constraints.md`](../../../../../docs/cannon/architecture/runtime-design-constraints.md)
("Transforms purity guard — follow-up, NOT YET LANDED"). The rule pattern is
written and validated; semgrep's `--test` mode has a phantom rule-id-mismatch
interaction with the existing unit-test fixture that needs deeper
investigation or a rule-split / second-target invocation before landing.
Until then this folder is review-enforced against:

- `Effect.gen(...)`, `Effect.succeed/fail/sync/tryPromise/promise/async(...)`
- `Layer.succeed/effect/scoped/mergeAll/merge/provide(...)`
- `Workflow.make(...)`, `Activity.make(...)`, `DurableDeferred.*(...)`
- `Context.Tag(...)`, `Context.GenericTag(...)`

A pure transform may still operate over `Effect` / `Stream` values it received
as parameters (`Stream.map`, `Stream.filter`, decoding helpers, etc.). The rule
catches **construction** of Effect values or services, which is subscriber /
authority / source behavior in disguise. If a transform needs to construct an
Effect, it is not a transform.

The Shape C cutover lands `transitionInputEvent` / `transitionOutputEvent`
here (extracted from `workflow-engine/workflows/runtime-context.ts`) — those
are the canonical pure-reducer shapes this folder is built around.

Reviewer test for any transform here: it must be callable in a unit test with
no Effect environment. If providing a runtime, layer, or workflow engine is
needed to exercise it, it has crossed the purity boundary.

## Boundary Rules

- Prefer plain `Stream` functions; use `Channel` only when first-class channel
  composition is actually needed.
- Do not introduce a Firegrid transform framework.
- Keep shared selection, ordering, decoding, or mapping logic here.
- Do not import host topology or own durable table providers.
