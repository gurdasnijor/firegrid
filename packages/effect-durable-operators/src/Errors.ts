import { Schema } from "effect"

// effect-durable-operators.PACKAGE.3: errors are Schema.TaggedError so they
// remain serializable and matchable across durable boundaries.

export class DurableTableError extends Schema.TaggedError<DurableTableError>()(
  "DurableTableError",
  {
    table: Schema.String,
    cause: Schema.Defect,
  },
) {}

export class DurableProjectionError extends Schema.TaggedError<DurableProjectionError>()(
  "DurableProjectionError",
  {
    projection: Schema.String,
    cause: Schema.Defect,
  },
) {}

export class DurableConsumerError extends Schema.TaggedError<DurableConsumerError>()(
  "DurableConsumerError",
  {
    consumer: Schema.String,
    cause: Schema.Defect,
  },
) {}

export class CheckpointError extends Schema.TaggedError<CheckpointError>()(
  "CheckpointError",
  {
    subscriberId: Schema.String,
    key: Schema.String,
    cause: Schema.optional(Schema.Defect),
  },
) {}
