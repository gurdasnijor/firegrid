# LT-01: Local-to-Remote Agent Shift

Status: draft scenario

This litmus test proves whether Firegrid can support the replatforming goal:
run Flamecast locally, then shift an agent/session to another Flamecast
instance participating in the same durable substrate without losing durable
state or duplicating externally visible side effects.

## Target Story

1. A developer runs Flamecast locally against Firegrid.
2. A Flamecast agent backed by a deterministic test provider starts producing
   durable session facts.
3. A second Flamecast/Firegrid host joins the same durable topology or imports
   a selected durable scope.
4. The first host releases, drains, or becomes stale under a documented policy.
5. The second host materializes resources, advertises ingress, claims ownership,
   and resumes/reprovisions the provider according to a declared profile.
6. The client continues observing through Firegrid public query/event handles.

## Required Proofs

- session operation lifecycle remains queryable;
- app-owned EventStream history replays from durable state;
- projection query follows from a cursor without a gap;
- resource materialization finishes before provider reattach;
- new owner satisfies lease/fence/epoch rules before side effects;
- old and new owners do not perform the same external side effect;
- runtime presence is used only for public ingress/discovery;
- provider reattach behavior is Flamecast-owned and explicitly classified.

## Acai Mapping

Before implementation, convert this scenario into an Acai litmus spec, either:

```text
features/firegrid/litmus-lt-01-local-to-remote-shift.feature.yaml
```

or a Flamecast-owned litmus spec if the smoke lives entirely in
`flamecast-agents`.

The litmus spec should cite:

- `firegrid-platform-invariants.*`
- `firegrid-projection-query.*`
- `firegrid-runtime-presence.*`
- `firegrid-execution-plane-resources.*`
- `firegrid-runtime-ownership-transfer.*`
- `flamecast-product-contract.*`

## Non-Goals

LT-01 does not require live process migration. It may reprovision a
functionally equivalent provider instance from durable state and
Flamecast-owned resource semantics.
