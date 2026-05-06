import { Schema } from "effect"
import {
  createStateSchema,
  type CollectionDefinition,
  type StateSchema,
} from "@durable-streams/state"
import {
  ClaimAttemptRowType,
  ClaimAttemptValue,
  CompletionRowType,
  CompletionValue,
  EventStreamRowType,
  EventStreamValue,
  RunRowType,
  RunValue,
} from "./rows.ts"

// effect-native-api.SCHEMA_FIRST.3 — Standard Schema V1 exports are generated from Effect schemas for interop.
const RunStandard = Schema.standardSchemaV1(RunValue)
const CompletionStandard = Schema.standardSchemaV1(CompletionValue)
const ClaimAttemptStandard = Schema.standardSchemaV1(ClaimAttemptValue)
const EventStreamStandard = Schema.standardSchemaV1(EventStreamValue)

type SubstrateCollections = {
  readonly runs: CollectionDefinition<Schema.Schema.Type<typeof RunValue>>
  readonly completions: CollectionDefinition<
    Schema.Schema.Type<typeof CompletionValue>
  >
  readonly claimAttempts: CollectionDefinition<
    Schema.Schema.Type<typeof ClaimAttemptValue>
  >
  readonly eventStreams: CollectionDefinition<
    Schema.Schema.Type<typeof EventStreamValue>
  >
}

// durable-records-and-projections.SUBSTRATE_SCOPE.6
// durable-records-and-projections.SUBSTRATE_SCOPE.7
// Canonical substrate state schema. Row type and primary key are declared once here
// and reused by tests, producers, and the StreamDB-backed projection.
export const substrateState: StateSchema<SubstrateCollections> =
  createStateSchema({
    runs: {
      type: RunRowType,
      primaryKey: "runId",
      schema: RunStandard,
    },
    completions: {
      type: CompletionRowType,
      primaryKey: "completionId",
      schema: CompletionStandard,
    },
    claimAttempts: {
      type: ClaimAttemptRowType,
      primaryKey: "claimId",
      schema: ClaimAttemptStandard,
    },
    eventStreams: {
      type: EventStreamRowType,
      primaryKey: "id",
      schema: EventStreamStandard,
    },
  })
