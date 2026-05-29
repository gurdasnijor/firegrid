# subscribers/keyed-dispatch/

SHAPE: C infrastructure

Generic keyed-dispatch helper for Shape C subscribers. It consumes a typed
`Stream` of `{ key, event }` facts, serializes same-key handler calls with a
per-key mutex, and lets different keys progress concurrently.

This folder is infrastructure for subscriber materialization; it does not own
RuntimeContext state, does not read or write durable tables directly, and does
not import workflow machinery. Call sites supply the typed durable source and
the per-event handler.

Public subpath: `@firegrid/runtime/subscribers/keyed-dispatch`.

Compatibility alias: `@firegrid/runtime/runtime-keyed-subscriber` points here
until remaining external consumers retarget.

## Dedup discipline — identity-keyed, not sequence-keyed

A Shape C handler's dedup gate must key on the **domain identity** of
the fact, not on a kernel-allocated sequence. The reason is load-bearing:

- Intent-derived rows (input intents, permission responses, tool
  results) do **not** carry a kernel sequence. Their identity is the
  domain id the producer supplied (`inputId`, `permissionRequestId`,
  `toolUseId`).
- A sequence-keyed gate (`event.sequence ?? -1 <= lastProcessedSeq`)
  silently drops every intent-derived row on every fresh subscriber
  start, because `lastProcessedSeq` starts at `-1` and the row's
  sequence is `undefined`.
- An identity-keyed gate (`processedIds: Set<string>`, indexed by the
  domain id) survives restart: redelivery of the same row finds the id
  in the set and skips dispatch without dropping the action.

### What's safe to keep sequence-keyed

Outputs DO carry a kernel-allocated sequence (e.g. `session.agent_output`
rows have a monotonic `sequence` per `(contextId, activityAttempt)`).
For output observation, `lastProcessedOutputSequence` advances
monotonically and a sequence-cursor is the right shape.

| Fact kind | Dedup key |
| --- | --- |
| `input` (intent-derived) | identity (`inputId`) — Set membership |
| `permission_response` | identity (`permissionRequestId`) — Set membership |
| `tool_result` | identity (`toolUseId`) — Set membership |
| `output_transition` / dense output | sequence (`lastProcessedOutputSequence`) — monotonic cursor |
| `terminal` | identity (`runEventId`) — Set membership; first-valid-terminal-wins via `insertOrGet` |

### Reference

The `wave-d-a-shape-b-input-identity-dedup` simulation
(`packages/tiny-firegrid/src/simulations/wave-d-a-shape-b-input-identity-dedup/`)
asserts both halves: identity-keyed dedup dispatches the first input
(test 2), restart redelivery skips without dropping (test 3),
output-sequence cursor advances monotonically (test 4). The
falsification baseline (test 1) reproduces the
sequence-keyed-drops-every-input bug from the prior production handler
`subscribers/runtime-context/handler.ts:103-120`. The fact-kind dispatch
is the same per-key mutex this folder owns; the identity discipline
applies inside the handler.

See also: [docs/architecture/runtime-context-fact-matrix.md](../../../../../docs/architecture/runtime-context-fact-matrix.md)
§ "How a fact actually flows" — the matrix routing keys are the
identity keys for dedup.
