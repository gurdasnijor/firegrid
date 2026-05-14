# 021: Follow-Up Prompt Ingress To A Running Context

Status: scenario-proven through `scenarios/firegrid/src/tracer-021.test.ts`.

This is the concrete proof for **Tracer I** from
[019-workflow-driven-runtime-next-wave.md](./019-workflow-driven-runtime-next-wave.md).
It is the RFC client-model bridge between today's `--prompt` initial input and
future session-shaped prompt APIs — the same durable ingress path that
agent-facing tools will later call instead of inventing private prompt
channels.

## Scope

A client/app drives a long-running agent context. After the child is already
running, the client appends one or more follow-up prompts. The substrate must:

- record each follow-up as a durable `RuntimeIngressTable.inputs` row before
  any provider byte is emitted to the child;
- assign explicit per-context sequence numbers at write time;
- treat duplicate prompts with the same idempotency key as the same logical
  input — both the durable row and the provider-visible delivery must be
  deduplicated;
- record provider delivery progress in `RuntimeIngressTable.deliveries`;
- never open stdin / ACP / WebSocket / HTTP / provider transport directly from
  the client;
- never synchronously invoke a workflow, operator, or provider dispatcher as
  the authority path.

## Product surface (no changes in this tracer)

The follow-up surface is the existing public client API:

```ts
Firegrid.prompt(request: PublicPromptRequest)
  -> Effect.Effect<RuntimeIngressInputRow, ...>
```

with the durable shape:

```ts
PublicPromptRequest = {
  contextId:      string
  payload:        unknown   // provider-neutral content; encoder lives at adapter boundary
  idempotencyKey?: string   // deterministic dedup; same key => same inputId
  metadata?:      Record<string, string>
}
```

No `RuntimeContextHandle.sendInput` sugar is added. No runtime-side
duplicate of the client append path is consolidated in this tracer — the
client `appendPrompt` and runtime-host `appendRuntimeIngress` produce
identical durable behavior (the runtime version adds an `inputEnabled` gate)
and intentionally live in separate scopes. Their consolidation, if needed,
is out of scope here.

## Linked ACIDs

- `firegrid-agent-ingress.INGRESS.1` — durable input table rows with
  contextId / kind / payload / authoredBy / createdAt / status / optional
  sequence / metadata.
- `firegrid-agent-ingress.INGRESS.2` — same durable ingress model covers
  initial and follow-up prompts.
- `firegrid-agent-ingress.INGRESS.3` — duplicate idempotency-keyed writes do
  not create duplicate logical inputs.
- `firegrid-agent-ingress.INGRESS.4` — ordering by explicit durable sequence,
  not wall-clock or stream append order.
- `firegrid-agent-ingress.INGRESS.6` — input append does not synchronously
  invoke a workflow / operator / provider dispatcher.
- `firegrid-agent-ingress.INGRESS.9` — writer assigns explicit per-context
  sequence at the durable table write boundary.
- `firegrid-agent-ingress.DELIVERY.1` — providers consume sequenced rows
  through the adapter boundary only.
- `firegrid-agent-ingress.DELIVERY.3` — delivery progress is in the durable
  deliveries collection.
- `firegrid-agent-ingress.DELIVERY.5` — provider-owned subscriptions read
  sequenced inputs, write a delivery claim before emission.
- `firegrid-agent-ingress.HOST.1` / `HOST.3` — host owns ingress topology;
  initial and follow-up inputs use the same path.

## Acceptance evidence

The scenario test (`scenarios/firegrid/src/tracer-021.test.ts`) asserts:

1. **Sequenced durable inputs.** After two follow-up prompts with distinct
   idempotency keys, `RuntimeIngressTable.inputs` contains exactly two rows
   for the context. Each row has `status === "sequenced"`, an explicit
   non-negative `sequence`, a `sequencedAt` timestamp, and `authoredBy ===
   "client"`. Sequence numbers are strictly ordered.
2. **Idempotent duplicate.** A third call to `Firegrid.prompt` with the same
   idempotency key as the second prompt returns the existing input row
   (same `inputId`), does not append a new row, and does not produce a
   second child-visible marker.
3. **Durable delivery progress.** `RuntimeIngressTable.deliveries` contains
   one row per delivered input, each with a non-empty `claimedAt` and the
   local-process stdin `subscriberId`.
4. **Child marker via runtime output.** `RuntimeOutputTable.events` contains
   exactly two assistant markers, one per logical input, in sequence order.
5. **No transport bypass.** The test never opens a process stdin, ACP
   channel, WebSocket, or HTTP request directly. The only public surface
   touched is `Firegrid.launch` and `Firegrid.prompt`.

## Known gap: terminal / not-live contexts

`Firegrid.prompt` today is a pure durable-write surface: it appends a
sequenced ingress row regardless of whether the runtime context is alive,
exited, or never launched. There is no `RuntimeContext.status`
state-machine (deliberately — see tracer 019). The current product surface
therefore **cannot** return a typed "context not live" failure.

Observed behavior today, validated by the tracer:

- After the child exits and `startRuntime` resolves, calling
  `Firegrid.prompt` again **succeeds** at the durable write — a new
  `inputs` row is recorded with the next explicit sequence.
- No `deliveries` row appears for that input (no live provider).
- No new `events` row appears (no live child).

This is consistent with INGRESS.1 (durable intent always recorded) but does
not yet provide the typed not-live failure that the wave doc calls out.
Closing the gap requires either:

- a small read-time check that fails the public `prompt` call when the
  latest `runs` row for the context is terminal (`exited` / `failed`); or
- a HostWorkflow-driven liveness signal (Tracer E in 019).

**This tracer does not implement that gap.** It documents it and proves the
current durable behavior so a future PR can close it without changing the
public surface contract.

## Out of scope (hard rejects upheld)

- No Firegrid HTTP/RPC prompt endpoint.
- No direct local-process stdin control surface exposed to clients.
- No per-message workflow activity.
- No private tool-specific prompt path.
- No `RuntimeContext.status` state-machine revival.
- No `DurableConsumer` / `Projection` / `Source` abstractions.
- No broad client redesign or new `RuntimeContextHandle` sugar.

## Implementation note

The same `Firegrid.prompt(...)` write that delivers an initial prompt
through `firegrid:run --prompt` also delivers follow-up prompts. The two
paths converge at `RuntimeIngressTable.inputs` and diverge only at the
caller: `firegrid:run` constructs the row inline at the binary boundary;
the long-running client/app writes through `@firegrid/client`. Both end up
as `kind: "message"`, `authoredBy: "client"` rows that the local-process
stdin delivery subscription claims and emits.
