# SDD: Durable Channels - Sync and Async Agent Communication

Status: canonized framing - **validated by the tf-lfxs spike and production-closed by tf-1r3h (2026-05-21)**
Created: 2026-05-20
Owner: Firegrid Runtime / Agent Tool Surface
Validation: `tf-lfxs-durable-channels-sync-async.FINDING.md` (both modes proven with existing substrate; no new verb; no Effect-interface leakage) + `tf-1r3h-durable-sync-async-closure-audit.md` (production closure classification and tests)
Follow-on to: `SDD_FIREGRID_AGENT_BODY_PLAN.md` (channels as nervous system; the verb set)
Grounded in: `SDD_FIREGRID_ONE_SUBSTRATE_PRIMITIVE.md` (DurableTable as the one substrate primitive)

The body-plan SDD defines *channels* - the typed, named, directional capability
surface (ingress / egress / call / bidirectional) and the small fixed verb set.
This follow-on names the **two communication modes** the verb set splits into,
shows how each lowers to the one substrate primitive, and makes the
load-bearing claim: **both modes are durable by construction.**

It introduces no new primitive. The two modes are already expressible with the
existing channel directions; this document names them and explains the
substrate mapping. The tf-lfxs spike canonized this framing narrowly: the sync
handshake earns abstraction weight because it centralizes a real bespoke
barrier, while the async mailbox phrasing remains useful terminology over
existing `send` + `wait_for` lowering and does not justify a new mailbox API.

## The two things an agent does

When an agent needs another agent's (or the world's) output, it does one of two
things:

1. **Ask and wait** - "go research candidate X, return the result before I
   continue."
2. **Fan out and move on** - "researcher, here's a candidate; scorer, here's a
   batch; I keep reasoning."

Both are load-bearing. An agent that can only synchronously wait never
parallelizes; an agent that can only fire-and-forget never consumes a result
downstream. Firegrid provides both, and they have different substrate
requirements.

## Sync path: durable handshake

"Sync" here means **synchronous from the agent's point of view**, not in-process
or same-turn. The better name for the mode is **durable handshake** (or
request/response): `call` is logically synchronous to the agent but physically
async underneath - a request row, a workflow/action, completion evidence, and a
resume. The agent writes `yield* call(...)` and sees a blocking return; the
substrate never blocks a thread.

Under the hood:

1. The verb writes a request row (the sentinel) to the substrate.
2. A durable awaitable / completion condition is materialized for that request.
3. The callee does its work in its own session or workflow.
4. When the callee finishes, terminal/reflected evidence resolves the awaitable.
5. The caller's `call` returns the result. Control proceeds.

The durable distinction is the meeting point: the caller's reasoning state is
checkpointed before the yield, the host can crash and restart, the callee can
take seven days, and the handshake still completes because the wait is backed
by durable rows / workflow state, not an in-process promise.

## Async path: send + wait_for over DurableTable

When the agent wants to fire work and keep reasoning, it does not reach for a
different primitive. It sends to a channel:

```ts
yield* send(researchChannel, { source, priority: "high" })
```

The `send` lowers to a durable append. No blocking, no handshake; the row is
durable the moment it lands. The receiver drains via `wait_for` on the
channel's change feed:

```ts
const msg = yield* wait_for(researchChannel, {
  match: { to: "researcher" },
  timeoutMs: 3_600_000,
})
```

The `wait_for` lowers to the channel's observable durable rows filtered by a
predicate. Senders queue work without blocking on a receiver. Receivers drain
at their own pace. Ordering, filtering, and priority are properties of the
schema and binding semantics, not a separate transport.

The receiver's `wait_for` is checkpointable: if nothing matches, the agent
suspends durably, consumes zero compute, and resumes when a row arrives.

## Both modes, one substrate

Neither mode is a new primitive. The one-substrate claim holds because the
handshake is durable through durable workflow state / durable completion
evidence, and the mailbox is durable because the channel append is a durable
row.

| Substrate piece | Sync handshake path | Async mailbox path |
|---|---|---|
| Durable rows | request sentinels + reflected completion evidence | append + rows change feed |
| Durable awaitable / workflow state | completion of one request | not required |
| `wait_for` | not required for the caller | the drain / observe-later path |
| `send` | not required | durable append |
| Session protocol | parent/child or create/load request-response | not required |

Firegrid did not add a "mailbox feature"; a durable append plus a well-placed
`wait_for` already is a durable mailbox. Likewise, the request-reflection
barrier is the sync handshake, not a separate client-side readiness feature.

## Effect semantic alignment: borrow semantics, do not adopt interfaces

**The rule.** Firegrid Channels do **not** extend `effect/Channel`, `Queue`, or
`Mailbox`. They are named, schema-bearing, durable capability contracts.
Effect's `Deferred`, `Queue`, `Mailbox`, `PubSub`, `Stream`, and `Sink` are
semantic references and implementation vocabulary, not the public interface.

The public contract layer stays semantic, not Effect-shaped:

```ts
IngressChannel<Row>        // durable observation / wait_for
EgressChannel<Row>         // durable append / send
CallableChannel<Req, Res>  // durable request-response / call
BidirectionalChannel<Row>  // same-schema ingress + egress
```

The bindings lower underneath to substrate-facing Effect types and Firegrid
durable operators. If future work adds true work-stealing, bounded queues,
ack/lease, or backpressure, `Queue`'s strategy vocabulary is useful naming
material, but it should surface as explicit **channel-binding metadata**, not
as inheritance from `Queue`.

## What this resolves: dispatch, then wait for reflection

This framing is not just pedagogy. It resolves a class of recurring ergonomic
problems that keep reappearing because Firegrid's substrate is fundamentally
async while a large class of operations needs synchronous "did it take effect?"
semantics.

Without a named sync mode, every such operation hand-rolls its own barrier:
`whenReady`, projection-wait-after-append, or manual completion-row
subscriptions. Each is the same pattern reinvented.

**The pattern is the sync handshake.** "Dispatch an action and wait for the
world to reflect it" is precisely `call`: the call should not return until the
action is reflected. Naming the mode means the blocking-until-reflected
machinery is owned by the callable binding, not re-derived per operation.

### Worked instance: `whenReady` was a symptom as a pre-prompt barrier

`firegrid.sessions.createOrLoad` already dispatches through a callable channel
(`HostSessionsCreateOrLoadChannel.binding.call`). Yet callers historically
needed a separate `whenReady` barrier before they could `prompt`.

That happened because the request path acked identity - returning a
`contextId` - while the dependent operation still needed reflected context
state. `whenReady` is the hand-rolled "wait for reflection" that the
result-gates-next-action boundary absorbs.

```ts
// Today: call acks, then a bespoke barrier.
const session = yield* firegrid.sessions.createOrLoad({ ... })
yield* session.whenReady
yield* session.prompt({ ... })

// The dependent operation owns the reflection barrier.
const session = yield* firegrid.sessions.createOrLoad({ ... })
yield* session.prompt({ ... })
```

`whenReady` disappears from this path not by deleting a check, but because the
dependent operation (`prompt`, and similarly `start`) waits for reflected
context state before it writes. Identity-only `createOrLoad` callers are not
handshakes by the "answer gates the next step" rule, so they still receive the
deterministic handle immediately.

**`whenReady` is removed as pre-prompt/start ceremony, not deleted as a
primitive (tf-2osu).** It was a symptom *only where a dependent client write
followed it*. It remains a legitimate, public, intentionally-unbounded
readiness primitive for the paths the dependent-write barrier does not cover:
read/observe before materialization (`snapshot` / `watchContexts`),
host-execution flows that append/start through host-sdk surfaces
(`appendRuntimeIngress` / `startRuntime`) rather than the client `prompt` /
`start` channels, and gating an eagerly-resolving concurrent consumer (e.g. a
forked `permissions.autoApprove` loop). The rule is sharp: *if a dependent
client write follows, drop `whenReady` (the write self-barriers); otherwise it
is the correct explicit readiness wait.*

One residual: `whenReady` is unbounded even for a context id that is provably
absent (no context row and no context-request row), so a typo'd id waits
forever. The dependent-write barrier already has an absent-id floor (tf-1r3h);
giving `whenReady` the same floor — fail bounded when provably absent, stay
unbounded when existing-but-slow — is tracked by tf-5sb7.

**This is no longer an assertion - the tf-lfxs spike proved the shape, and
tf-1r3h closed the production semantics.** The spike wrapped the existing
`HostSessionsCreateOrLoad` callable binding with a request-reflection barrier
to prove the same channel contract can absorb a wait with no new public verb.
The production rule is more precise than "make `createOrLoad` globally
blocking": identity-only callers can receive the deterministic handle
immediately, while dependent operations that need reflected context state own
the barrier before writing. Production `session.prompt`, `session.start`,
`firegrid.sessions.prompt`, and `firegrid.prompt` now follow that rule.

## Validation: tf-lfxs spike (GREEN, 2026-05-21)

Both modes were proven against the existing substrate in the one-trace
`durable-channels-sync-async-spike` sim:

- **Sync handshake.** The existing `HostSessionsCreateOrLoad` callable binding
  absorbed a request-reflection barrier in the binding layer. The underlying
  call retained the request-row substrate; no new primitive or public verb was
  introduced. The driver invoked the reflected binding and then exercised the
  public session prompt/start/wait surface.
- **Async mailbox.** A single neutral bidirectional channel over a sim-owned
  `DurableTable` was sufficient: existing `send` lowering appended durable
  rows, and existing `wait_for` lowering resumed through `WaitForWorkflow` and
  matched the later row. No new mailbox abstraction is justified.
- **Boundaries held.** No Effect `Channel` / `Queue` / `Mailbox` / `Stream` /
  `Sink` surfaced as Firegrid channel API, and no provider-specific channel
  contract was added.

The production follow-up from the spike is closed for the public session
write/start surface: request-reflection semantics live in callable or
dependent-operation bindings where the result gates the next client action.
`createOrLoad` itself remains request-row/identity acknowledgement because its
inline result is the handle identity, not reflected host readiness.

## Decision guide

Reach for sync (`call` / `spawn`) when:

- The answer gates the next step.
- You want the result inline in the calling turn's reasoning context.
- You want strict one-request/one-response pairing.
- The callee's time is bounded and you have no other useful work meanwhile.

Reach for async (`send` + `wait_for`) when:

- You have several units of work to start in parallel and want to keep
  reasoning.
- The sender does not need each individual result immediately.
- Work is bursty and recipients should drain at their own pace.
- You want multiple receivers in a broadcast / pub-sub shape.
- The sender might not exist when the receiver is ready to process.

Work-stealing is not free from filtering alone; it needs claim/lease/ack
semantics so two workers do not both take the same row. Treat work-stealing as
a future capacity/claim layer over the mailbox, not as a property of `match`.

## Strategic claim

Every concurrency framework has a sync/async axis. Firegrid's distinct claim is
that both modes are durable by construction, end to end, as a property of the
substrate - not an opt-in feature.

| | Sync | Async | Durable across restarts? |
|---|---|---|---|
| Firegrid | `call` / `spawn` over durable completion evidence | `send` + `wait_for` over durable rows | Both, natively |
| Go | unbuffered channel | buffered channel | Neither |
| Actor systems | request-reply via inbox | fire-and-forget via inbox | Framework-dependent |
| Temporal-style | step invoke | event signal | Yes, but orchestration-shaped |

Firegrid's sync handshake survives restarts because the awaitable resolves
through durable workflow / row state. Its async mailbox survives because the
append is the log. The guarantee is that committed messages remain observable
and the agent's reasoning state at any suspension point is checkpointed and
resumable. It is not exactly-once delivery; consumers must be idempotent unless
a stronger binding specifies claim/ack semantics.

## Summary

- Agents need both "ask and wait" and "fan out and move on."
- Firegrid ships both over the one substrate primitive.
- Sync = `call` / `spawn` as a durable handshake.
- Async = `send` + `wait_for` over durable rows.
- The tf-lfxs spike makes the SDD useful rather than merely descriptive:
  sync centralizes a real barrier, while async needs no new mailbox layer.
- No Effect Channel/Queue/Mailbox surface and no provider-specific channels are
  part of this framing.

## Cross-references

- `SDD_FIREGRID_AGENT_BODY_PLAN.md` - channel directions + verb set.
- `SDD_FIREGRID_ONE_SUBSTRATE_PRIMITIVE.md` - `DurableTable` as the one substrate primitive.
- `@effect/workflow` `DurableDeferred` - durable awakeable semantics behind sync handshakes.
- `packages/effect-durable-operators/src/DurableTable.ts` - durable append + rows behind async mode.
- `docs/research/tf-lfxs-durable-channels-sync-async.FINDING.md` - spike evidence and verdict.
