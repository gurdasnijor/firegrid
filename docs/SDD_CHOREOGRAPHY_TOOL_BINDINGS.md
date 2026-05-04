# SDD: Choreography And Agent Tool Bindings

Status: proposal
Created: 2026-05-04
Owner: Durable Agent Substrate

## Problem

Fireline-style systems need operations such as:

- `sleep(durationMs)`;
- `waitFor(trigger, timeoutMs?)`;
- `scheduleMe(when, prompt)`;
- `execute(sandbox, input)`;
- `spawn(agent, prompt)`;
- `spawnAll(tasks)`.

These operations should be usable from:

- runtime/client APIs;
- agent tool surfaces;
- middleware/policy layers;
- tests and scenario drivers.

The substrate should support the durable semantics, but these names are
Fireline/profile-level operations. They should not all become substrate-native
row families.

## Design Goal

Define operation implementations once in a higher-layer profile, then bind
them to multiple surfaces:

```text
Fireline operation implementation
  -> runtime/client method
  -> agent tool descriptor
  -> tests/scenario driver
```

The operation implementation lowers to substrate facades:

```text
Projection
Work pipeline
Awaitable
Event plane producer
Subscriber profile
```

## Operation Mapping

### sleep(durationMs)

```text
tool/runtime call
  -> domain trace event
  -> Awaitable.timer
  -> timer subscriber resolves when due
  -> caller observes durable completion/projection
```

The agent should not receive raw completion controls.

### waitFor(trigger, timeoutMs?)

Default path:

```text
Projection.until(query, predicate, timeout)
```

Durable suspension path:

```text
Awaitable.projection(...)
  -> projection-match subscriber resolves/cancels
```

Use the durable suspension path only when a runtime needs the wait to survive
ownership/process changes independently of the caller Effect.

### scheduleMe(when, prompt)

```text
operation call
  -> domain scheduled-prompt row
  -> Awaitable.scheduled
  -> scheduled subscriber resolves eligibility
  -> Work pipeline claims ready scheduled prompt
  -> promptability policy check
  -> domain prompt intent row
```

The timer only makes the scheduled prompt eligible. Promptability remains a
higher-layer policy.

### execute(sandbox, input)

```text
operation call
  -> domain execution request row
  -> Work pipeline claims execution
  -> provider/tool transport invoked
  -> domain execution terminal row
```

Provider, sandbox, resource, and permission policy remain above the substrate.

### spawn / spawnAll

```text
operation call
  -> domain child launch/prompt rows
  -> Work pipeline claims launch side effects
  -> Projection.until child terminal rows
  -> aggregate terminal results
```

Spawn is not a substrate primitive. It is composed from event planes,
projections, Work pipelines, and waits.

## ACP Permission Binding

ACP permission requests should be handled by a profile:

```text
ACP request_permission
  -> ACP event plane emits permission-requested observation
  -> Fireline/Firepixel domain permission row is created
  -> UI/policy updates domain permission row
  -> adapter maps terminal domain permission to ACP response
```

If a runtime must suspend while waiting for a decision, it may use an awaitable
or Projection until. That choice belongs to the profile policy, not the ACP
event observer itself.

## Open Questions

1. Which operations should be exposed by the first Fireline profile package?
2. Should operation definitions include Effect Schema for agent tool input and
   output, or should tool binding generate schema from separate definitions?
3. Should `waitFor` accept only projection queries at first, or also external
   event triggers?
4. Should `spawnAll` use a first-class aggregate helper, or stay as
   `Effect.forEach` plus `Projection.until` until fan-in pressure is proven?
