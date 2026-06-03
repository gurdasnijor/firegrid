import { Context, type Effect, Schema } from "effect"
import {
  DurableTable,
  type DurableTableError,
} from "effect-durable-operators"

const StdinEmissionClaimRowSchema = Schema.Struct({
  commandId: Schema.String.pipe(DurableTable.primaryKey),
  contextId: Schema.String,
  inputId: Schema.String,
  byteLength: Schema.Number,
  claimedAtMs: Schema.Number,
})
export type StdinEmissionClaimRow = Schema.Schema.Type<
  typeof StdinEmissionClaimRowSchema
>

const sandboxSupervisorCommandSchemas = {
  stdinEmissionClaims: StdinEmissionClaimRowSchema,
} as const

export class SandboxSupervisorCommandTable extends DurableTable(
  "firegrid.sandboxSupervisor",
  sandboxSupervisorCommandSchemas,
) {}

export interface SandboxStdinEmissionCommand {
  readonly commandId: string
  readonly contextId: string
  readonly inputId: string
  readonly byteLength: number
}

export class SandboxStdinEmissionClaim extends Context.Tag(
  "@firegrid/runtime/SandboxStdinEmissionClaim",
)<SandboxStdinEmissionClaim, {
  readonly claim: (
    command: SandboxStdinEmissionCommand,
  ) => Effect.Effect<boolean, DurableTableError>
}>() {}
