import { Schema } from "effect"
import { createStateSchema } from "@durable-streams/state"
import {
  ClaimAttemptRowType,
  ClaimAttemptValue,
  CompletionRowType,
  CompletionValue,
  RunRowType,
  RunValue,
} from "./rows.ts"

// effect-native-api.SCHEMA_FIRST.3 — Standard Schema V1 exports are generated from Effect schemas for interop.
const RunStandard = Schema.standardSchemaV1(RunValue)
const CompletionStandard = Schema.standardSchemaV1(CompletionValue)
const ClaimAttemptStandard = Schema.standardSchemaV1(ClaimAttemptValue)

// durable-records-and-projections.SUBSTRATE_SCOPE.6
// durable-records-and-projections.SUBSTRATE_SCOPE.7
// Canonical substrate state schema. Row type and primary key are declared once here
// and reused by tests, producers, and the StreamDB-backed projection.
export const substrateState = createStateSchema({
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
})
