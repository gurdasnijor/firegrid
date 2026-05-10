# 008 Materialization Strategy Report

## Extraction Decision

`packages/materialization` has not earned extraction yet. The strategy shape is
staged under `@firegrid/runtime/data-plane/materialization/{core,raw-fold,state-protocol}`
so tracer 002 can keep passing through production runtime package code while
tracer 006 finishes the host root that will select a strategy.

The package boundary is now visible: `core` depends on Effect and local
source/projector vocabulary only, while `state-protocol` is the place that
depends on Durable Streams. A later package extraction should move `core` first
and leave State Protocol as an adapter package or subpath.

## Materialize Follow-Up

Materialize remains provider-backed in this tracer per
`firegrid-materialization-engines.MATERIALIZE.5`. It still needs a
`MaterializeStrategy` adapter that maps a projection definition into provider
provisioning, ingestion, typed query, and subscription methods without exposing
Materialize as a special top-level engine.

## Design Answers

- `MaterializationStrategy` is both a plain value and an Effect service Tag. The
  plain value is easy for tests and staging helpers; the Tag is ready for the
  runtime host root.
- Raw-fold exposes a simpler local query model because it folds projected
  events directly into an in-memory target state and evaluates typed projection
  queries over that state.
- State Protocol fits as a strategy when the host supplies State Protocol
  stream configuration and the projection remains backend-neutral; the session
  target query path reads the Durable Streams State Protocol stream through the
  same `SessionProjectionQuery` payload used by raw-fold.
- Strategy queries carry a projection name, logical target name, typed query
  payload, and typed result selector instead of flattening provider queries into
  SQL strings.
- The dependency boundary is that `core` exports source, projector, projection,
  strategy, and query vocabulary without importing Durable Streams or runtime
  control-plane modules per `firegrid-materialization-engines.BOUNDARY.4`.
