import {
  LaunchAuthorizedBindingSchema,
  RuntimeConfigSchema,
  type LaunchAuthorizedBinding,
  type RuntimeConfig,
} from "@firegrid/protocol/launch"
import { Schema } from "effect"

export const defaultFactoryNamespace = "firegrid-factory"

export const FactoryConfigSchema = Schema.Struct({
  planner: RuntimeConfigSchema,
  authorizedBindings: Schema.optional(Schema.Array(LaunchAuthorizedBindingSchema)),
  providerCapabilities: Schema.optional(Schema.Array(Schema.String)),
}).annotations({
  identifier: "firegrid.darkFactory.config",
  title: "Dark factory config",
  parseOptions: {
    onExcessProperty: "error",
  },
})
export type FactoryConfig = Schema.Schema.Type<typeof FactoryConfigSchema>

const parseEnvRef = (ref: string): string | undefined =>
  ref.startsWith("env:") ? ref.slice("env:".length) : undefined

export const authorizedBindingsFromPlanner = (
  planner: RuntimeConfig,
): ReadonlyArray<LaunchAuthorizedBinding> =>
  planner.envBindings?.flatMap(binding => {
    const envName = parseEnvRef(binding.ref)
    return envName === undefined ? [] : [[binding.name, envName] as const]
  }) ?? []

export const decodeFactoryConfig = Schema.decodeUnknownSync(FactoryConfigSchema)
