import { Clock, Context, Effect, Layer, Match, Schema } from "effect"
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

export const SandboxStdinEmissionClaimLive = Layer.effect(
  SandboxStdinEmissionClaim,
  Effect.gen(function* () {
    const table = yield* SandboxSupervisorCommandTable
    return SandboxStdinEmissionClaim.of({
      claim: command =>
        Effect.gen(function* () {
          const claimedAtMs = yield* Clock.currentTimeMillis
          const result = yield* table.stdinEmissionClaims.insertOrGet({
            ...command,
            claimedAtMs,
          })
          return Match.value(result).pipe(
            Match.tag("Inserted", () => true),
            Match.tag("Found", () => false),
            Match.exhaustive,
          )
        }),
    })
  }),
)

const hexDigest = (bytes: ArrayBuffer): string =>
  [...new Uint8Array(bytes)]
    .map(byte => byte.toString(16).padStart(2, "0"))
    .join("")

export const stdinEmissionCommandId = (input: {
  readonly contextId: string
  readonly inputId: string
  readonly bytes: Uint8Array
}): Effect.Effect<string> =>
  Effect.promise(async () => {
    const prefix = new TextEncoder().encode(`${input.contextId}\0${input.inputId}\0`)
    const content = new Uint8Array(prefix.byteLength + input.bytes.byteLength)
    content.set(prefix, 0)
    content.set(input.bytes, prefix.byteLength)
    const digest = await crypto.subtle.digest("SHA-256", content)
    return `stdin:${hexDigest(digest).slice(0, 32)}`
  })
