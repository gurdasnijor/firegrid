# Fluent Firegrid Authoring Design

Doc-Class: internal-contract
Status: draft
Owner: Firegrid Architecture

This document defines `packages/fluent-firegrid` from the application layer
down. It intentionally stops before deployment shape. Durable Streams substrate
mechanics are discussed only as pushdown targets.

## Purpose

`fluent-firegrid` is the authoring package for application code that wants
Effect-native durable execution semantics without importing a deployment
binding, a worker, or Durable Streams clients.

It provides:

- typed service/object/workflow definitions;
- handler descriptors for later binding;
- `run` as a named durable step over an abstract step journal capability;
- replay through declared success and typed-failure schemas;
- deterministic journal keys;
- durable wait/timer/invoke vocabulary only where it can lower to abstract
  durable capabilities;
- local composition through Effect, not a bespoke scheduler.

It does not provide:

- HTTP, MCP, ACP, or provider ingress;
- entity control APIs such as send, fork, tag, schedule, read, head, or delete;
- Durable Streams stream URL construction, clients, consumers, leases, wakes,
  retries, timers, or predicate subscriptions;
- managed harness loops or native resume artifacts.

## Application Contract

An application author should be able to define product behavior without knowing
where the durable substrate is deployed:

```ts
export const incidents = service({
  name: "incidents",
  handlers: {
    triage: handler({
      input: TriageInput,
      output: TriageResult,
      run: (input) =>
        Effect.gen(function* () {
          const classification = yield* run("classify", classify(input), {
            value: Classification,
          })

          return yield* run("persist", persist(classification), {
            value: TriageResult,
          })
        }),
    }),
  },
})
```

The important contract is not the exact helper spelling. The important contract
is that the definition carries enough public metadata for later binding:

- entity kind and name;
- handler names;
- input and output schemas or serde descriptors;
- durable step names chosen by the author;
- the Effect body to invoke once durable capabilities are provided.

## Handler Edge

Durability enters only at the handler edge. Something outside
`fluent-firegrid` selects durable identity and producer context, then invokes
the authored body with the minimal durable capabilities it needs.

```text
external runner / test / deployment binding
  select durable identity + producer identity
  provide StepJournal / WaitJournal / TimerJournal as needed
  invoke fluent-firegrid handler
    run("step", effect, schemas)
      read existing journal event by step key
      or execute effect and append terminal step event
```

The authored body must not import Durable Streams. The authoring package must
not expose Durable Streams-backed implementations from its root public API. A
test-only or integration seam may exist, but it remains separate from the
authoring surface.

## Design Rule

Use this rule when deciding where a new capability belongs:

| Capability can be described as | Location |
|---|---|
| typed product behavior, handler shape, replay schemas, deterministic step keys | `fluent-firegrid` |
| append/read/fork/close, producer fencing, consumer claim/ack/lease, wake retry, scheduled wake, generic predicate subscription, generic named-step storage | `packages/durable-streams` fork |
| product ingress, admission, auth, harness adaptation, product/session facts | deferred; not part of the current `fluent-firegrid` design |

If a feature can be described without Firegrid product nouns, it is a substrate
candidate. If a feature requires Firegrid product nouns, it is not part of the
current `fluent-firegrid` authoring contract.

## Deferred Durable Primitives

Durable `sleep`, external `wait_for`, durable child sessions, scheduled
triggers, and cross-session wakeups are authoring vocabulary only when their
generic durable mechanics are available from `packages/durable-streams` or are
specified there first.

Until then, `fluent-firegrid` may expose them as deferred design vocabulary or
compile-time gaps, but it must not implement:

- a scheduler;
- a timer wheel;
- a predicate matching engine;
- a worker lease table;
- a cursor store;
- a Durable Streams proxy.

## Dependency Rule

```text
application code -> fluent-firegrid
fluent-firegrid  -> no deployment binding, no Durable Streams clients
durable mechanics -> packages/durable-streams
```
