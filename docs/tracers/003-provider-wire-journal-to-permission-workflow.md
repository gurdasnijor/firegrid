# 003: Provider-Wire Journal To Permission Workflow

Date: 2026-05-08

Status: planned

Substrate: this tracer starts from the provider-wire journal produced by tracer
001 and uses `@effect/workflow` plus `DurableDeferred` to model a durable
human-in-the-loop permission decision.

## Goal

Prove the smallest permission path from:

```txt
durable provider-wire row indicating a permission request
```

to:

```txt
durable permission request state, human approval wait, and response input row
```

This tracer proves that permission handling is an independent downstream
consumer over the journal, not a special case inside agent launch.

## Starting Point

A provider-wire row exists for a tool or action request that requires approval.
The concrete provider wire format is provider-owned; the permission workflow
uses a provider-specific detector to recognize the request.

## End Point

The permission workflow has:

- appended permission-request state for UI/client observation;
- created or referenced a `DurableDeferred` token for the decision;
- suspended until approval or rejection is resolved;
- appended a durable input/decision row that a later stdin/session-delivery
  tracer can send back to the agent.

## Minimum Path

1. Read retained provider-wire rows.
2. Detect one permission-request-shaped provider event.
3. Start a permission workflow keyed by the provider event identity.
4. Append State Protocol permission-request state.
5. Wait on `DurableDeferred`.
6. Resolve the deferred from an external approval action.
7. Append a durable response/input row derived from the decision.

## Invariants

1. **Permission source.** Permission state is derived from a durable
   provider-wire row, not from a live process callback.
2. **Durable wait.** Human approval uses workflow/deferred state, so the wait
   survives worker restart.
3. **No launch coupling.** The launch workflow does not know which provider
   events require human approval.
