import {
  PermissionDecisionSchema,
  type PermissionDecision,
} from "@firegrid/protocol/session-facade"
import { Option, Schema } from "effect"
import {
  DarkFactoryFactSchema,
  DarkFactoryRunSchema,
  type DarkFactoryFact,
  type DarkFactoryRun,
} from "./tables.ts"

const PermissionResolutionPayloadSchema = Schema.Struct({
  permissionRequestId: Schema.String.pipe(Schema.minLength(1)),
  decision: PermissionDecisionSchema,
})

const PhaseCompletedPayloadSchema = Schema.Struct({
  phase: Schema.String.pipe(Schema.minLength(1)),
  status: Schema.optional(Schema.Literal("completed")),
})

const ProviderEffectPayloadSchema = Schema.Struct({
  effectType: Schema.String.pipe(Schema.minLength(1)),
  status: Schema.optional(Schema.String.pipe(Schema.minLength(1))),
  payload: Schema.optional(Schema.Unknown),
})

export const FactoryRunProjectionSchema = DarkFactoryRunSchema
export type FactoryRunProjection = DarkFactoryRun

export const FactoryPermissionProjectionSchema = Schema.Struct({
  factoryRunKey: Schema.String,
  permissionRequestId: Schema.String,
  status: Schema.Literal("resolved"),
  decision: PermissionDecisionSchema,
  fact: DarkFactoryFactSchema,
})
export type FactoryPermissionProjection = Schema.Schema.Type<
  typeof FactoryPermissionProjectionSchema
>

export const FactoryPhaseProjectionSchema = Schema.Struct({
  factoryRunKey: Schema.String,
  phase: Schema.String,
  status: Schema.Literal("completed"),
  fact: DarkFactoryFactSchema,
})
export type FactoryPhaseProjection = Schema.Schema.Type<
  typeof FactoryPhaseProjectionSchema
>

export const FactoryProviderEffectProjectionSchema = Schema.Struct({
  factoryRunKey: Schema.String,
  effectType: Schema.String,
  status: Schema.optional(Schema.String),
  externalEventKey: Schema.String,
  fact: DarkFactoryFactSchema,
  payload: Schema.Unknown,
})
export type FactoryProviderEffectProjection = Schema.Schema.Type<
  typeof FactoryProviderEffectProjectionSchema
>

export type PermissionDecisionTag = PermissionDecision["_tag"]

export const factoryPermissionProjectionFromFact = (
  fact: DarkFactoryFact,
): Option.Option<FactoryPermissionProjection> => {
  if (fact.eventType !== "permission.resolved") return Option.none()
  if (fact.factoryRunKey === undefined) return Option.none()
  const payload = Schema.decodeUnknownOption(PermissionResolutionPayloadSchema)(
    fact.payload,
  )
  return Option.map(payload, decoded => ({
    factoryRunKey: fact.factoryRunKey!,
    permissionRequestId: decoded.permissionRequestId,
    status: "resolved" as const,
    decision: decoded.decision,
    fact,
  }))
}

export const factoryPhaseProjectionFromFact = (
  fact: DarkFactoryFact,
): Option.Option<FactoryPhaseProjection> => {
  if (fact.eventType !== "factory.phase.completed") return Option.none()
  if (fact.factoryRunKey === undefined) return Option.none()
  const payload = Schema.decodeUnknownOption(PhaseCompletedPayloadSchema)(
    fact.payload,
  )
  return Option.map(payload, decoded => ({
    factoryRunKey: fact.factoryRunKey!,
    phase: decoded.phase,
    status: "completed" as const,
    fact,
  }))
}

export const factoryProviderEffectProjectionFromFact = (
  fact: DarkFactoryFact,
): Option.Option<FactoryProviderEffectProjection> => {
  if (fact.eventType !== "factory.provider.effect") return Option.none()
  if (fact.factoryRunKey === undefined) return Option.none()
  const payload = Schema.decodeUnknownOption(ProviderEffectPayloadSchema)(
    fact.payload,
  )
  return Option.map(payload, decoded => ({
    factoryRunKey: fact.factoryRunKey!,
    effectType: decoded.effectType,
    ...(decoded.status === undefined ? {} : { status: decoded.status }),
    externalEventKey: fact.externalEventKey,
    fact,
    payload: fact.payload,
  }))
}
