/**
 * Runtime input host configuration.
 *
 * Models runtime input as a single tagged capability rather than two
 * sibling optional URLs. This makes the misconfiguration
 * "session input without checkpoints" (or vice versa) **unrepresentable** —
 * no ad-hoc validation, no `Layer.fail` guard.
 *
 * Discriminated members:
 *  - `RuntimeInputDisabled` — no runtime input capability. Prompt
 *    facts cannot be delivered to the runtime; the runtime starts with
 *    no stdin source.
 *  - `RuntimeInputDurableStreams` — durable input enabled. Requires
 *    both a `sessionInput` stream (the public input-fact stream that
 *    `Firegrid.prompt` writes to) AND a `checkpoints` stream owned by
 *    `effect-durable-operators.ConsumerCheckpointStoreLive`.
 *
 * Trusted construction is via the class constructors (`new
 * RuntimeInputDurableStreams({...})` etc.). Decoding via
 * `Schema.decodeUnknown(RuntimeInputStreamsSchema)` stays available for
 * the public host-config boundary where the input is read from an
 * unknown source (e.g. CLI args, env, JSON).
 */

import { Schema } from "effect"

export class RuntimeInputDisabled extends Schema.TaggedClass<RuntimeInputDisabled>()(
  "RuntimeInputDisabled",
  {},
) {}

export class RuntimeInputDurableStreams extends Schema.TaggedClass<RuntimeInputDurableStreams>()(
  "RuntimeInputDurableStreams",
  {
    sessionInput: Schema.String,
    checkpoints: Schema.String,
  },
) {}

export const RuntimeInputStreamsSchema = Schema.Union(
  RuntimeInputDisabled,
  RuntimeInputDurableStreams,
)
export type RuntimeInputStreams = Schema.Schema.Type<typeof RuntimeInputStreamsSchema>

// Convenience singleton for the disabled case. The class has no fields
// so all instances are equivalent; exposing one removes the small
// awkwardness of `new RuntimeInputDisabled({})` at every call site.
export const runtimeInputDisabled: RuntimeInputDisabled = new RuntimeInputDisabled()
