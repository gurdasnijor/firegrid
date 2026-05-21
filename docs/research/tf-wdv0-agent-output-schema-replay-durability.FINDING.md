# tf-wdv0 Finding: AgentOutputEvent Schema Replay Durability

Verdict: STRICT-DECODE-MIGRATION-RISK.

Persisted runtime output rows are decoded through a closed
`AgentOutputEventSchema` union. If a future writer persists an event with a new
`AgentOutputEvent._tag`, an older reader will fail schema decoding and drop the
row from observation instead of preserving it as an unknown event.

## Evidence

- Runtime output rows are decoded as a
  `RuntimeAgentOutputEnvelopeSchema` whose `event` field is
  `AgentOutputEventSchema`:
  `packages/runtime/src/agent-event-pipeline/events/output.ts:5`.
- `decodeRuntimeAgentOutputEnvelope` runs
  `Schema.decodeUnknownEither(RuntimeAgentOutputEnvelopeSchema)` and returns
  `Option.none()` on decode failure:
  `packages/runtime/src/agent-event-pipeline/events/output.ts:32`.
- `runtimeAgentOutputObservationFromRow` maps the decoded envelope into an
  observation, so a decode failure leaves the row unobserved:
  `packages/runtime/src/agent-event-pipeline/events/output.ts:45`.
- The current protocol schema defines a closed tagged union of
  `Ready`, `TextChunk`, `ToolUse`, `PermissionRequest`, `TurnComplete`,
  `Status`, `Error`, and `Terminated`:
  `packages/protocol/src/agent-output/schema.ts:55` and
  `packages/protocol/src/agent-output/schema.ts:92`.
- Effect `TaggedStruct` encodes the `_tag` field as a literal, and
  `Schema.Union` builds from the listed members:
  `repos/effect/packages/effect/src/Schema.ts:3009` and
  `repos/effect/packages/effect/src/Schema.ts:1292`.
- Effect's union parser builds a discriminant search tree, records a parse
  issue for unknown tagged values, and returns `Either.left` when no union
  member matches. Literal parsing is strict equality:
  `repos/effect/packages/effect/src/ParseResult.ts:482`,
  `repos/effect/packages/effect/src/ParseResult.ts:1345`,
  `repos/effect/packages/effect/src/ParseResult.ts:1455`, and
  `repos/effect/packages/effect/src/ParseResult.ts:1488`.

## Conclusion

This is durable for rows written with the current event variants, but it is not
permissive across future unknown `_tag` variants. Mixed-version replay or
downgrade after a new `AgentOutputEvent` variant has been persisted can silently
lose those rows at observation time. A future migration that needs forward
compatibility should add an explicit unknown/fallback event shape or a separate
permissive envelope path.

## Resolution — tf-8s7d (2026-05-21)

Closed by tf-8s7d as the first concrete application of the tf-ypq9
schema-evolution policy
(`docs/cannon/architecture/schema-evolution-and-error-ownership.md`,
PR #541).

The chosen migration approach is the "decode-with-fallback" option
(Option A from the tf-wdv0 mitigation list, also the dispatch's
preferred approach):

- A sibling `AgentUnknownEventSchema` is added in
  `packages/protocol/src/agent-output/schema.ts` — a `TaggedStruct`
  with `_tag: "AgentOutputUnknown"`, `unknownTag: string`, and an
  optional `payload: Unknown`. Preserves the original `_tag` and the
  event payload for downstream consumers that choose to surface,
  audit, or drop.
- A new `tryDecodeRuntimeAgentOutputEnvelope` in
  `packages/protocol/src/session-facade/schema.ts` is the two-pass
  decoder: strict first (preserves the typed surface for known
  variants), permissive structural parse on strict failure (yields
  the `AgentUnknownEvent` terminal arm).
- `runtimeAgentOutputObservationFromRow` switched to the forgiving
  decoder; the observation layer maps `AgentOutputUnknown` to
  `Option.none()` so the typed `RuntimeAgentOutputObservation`
  surface stays exhaustive on KNOWN variants. The crash-vs-drop
  difference is invisible at the observation seam today; the load-
  bearing improvement is that future readers wired through
  `tryDecodeRuntimeAgentOutputEnvelope` can now SURFACE the unknown
  variant rather than silently dropping it.

The strict `AgentOutputEventSchema` is unchanged — strict decode for
known tags stays per the dispatch's non-goal ("the forgiving arm is a
TERMINAL fallback, not a default looseness").

Tests covering both failure mode and fix are in
`packages/protocol/test/session-facade/schema.test.ts` under the
`tf-8s7d agent-output forward-compatibility` describe block.

Migration tier (per tf-ypq9 §"Schema Evolution"): this row family is
replay-facing; the chosen mechanism corresponds to the policy clause
"decode old and current row versions through a migration union before
the row reaches execution code" applied symmetrically (old reader
decodes future writer's row).
