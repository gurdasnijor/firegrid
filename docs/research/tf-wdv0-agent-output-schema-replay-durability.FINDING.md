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
