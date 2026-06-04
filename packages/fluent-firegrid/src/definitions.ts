import { Effect } from "effect"
import { FluentFiregridError } from "./error.ts"
import type { ExecutionContext, FluentRequirements } from "./schema.ts"

export type Handler<Input, Output> = (
  ctx: ExecutionContext,
  input: Input,
) => Effect.Effect<Output, unknown, FluentRequirements>

type AnyHandler = Handler<never, unknown>

export type DefinitionKind = "service" | "object" | "workflow"

export interface Definition<
  Name extends string,
  Kind extends DefinitionKind,
  Handlers extends Record<string, AnyHandler>,
> {
  readonly name: Name
  readonly _kind: Kind
  readonly handlers: Handlers
}

export type ServiceDefinition<
  Name extends string,
  Handlers extends Record<string, AnyHandler>,
> = Definition<Name, "service", Handlers>

export type ObjectDefinition<
  Name extends string,
  Handlers extends Record<string, AnyHandler>,
> = Definition<Name, "object", Handlers>

export type WorkflowDefinition<
  Name extends string,
  Handlers extends Record<string, AnyHandler>,
> = Definition<Name, "workflow", Handlers>

type InputOf<H> = H extends Handler<infer Input, unknown> ? Input : never
type OutputOf<H> = H extends Handler<never, infer Output> ? Output : never

type ServiceClient<Handlers extends Record<string, AnyHandler>> = {
  readonly [Key in keyof Handlers]: (
    input: InputOf<Handlers[Key]>,
  ) => Effect.Effect<OutputOf<Handlers[Key]>, unknown, FluentRequirements>
}

// fluent-firegrid-keystone.PACKAGE.2
export const service = <
  const Name extends string,
  const Handlers extends Record<string, AnyHandler>,
>(definition: {
  readonly name: Name
  readonly handlers: Handlers
}): ServiceDefinition<Name, Handlers> => ({
  name: definition.name,
  _kind: "service",
  handlers: definition.handlers,
})

export const object = <
  const Name extends string,
  const Handlers extends Record<string, AnyHandler>,
>(definition: {
  readonly name: Name
  readonly handlers: Handlers
}): ObjectDefinition<Name, Handlers> => ({
  name: definition.name,
  _kind: "object",
  handlers: definition.handlers,
})

export const workflow = <
  const Name extends string,
  const Handlers extends Record<string, AnyHandler>,
>(definition: {
  readonly name: Name
  readonly handlers: Handlers
}): WorkflowDefinition<Name, Handlers> => ({
  // fluent-firegrid-keystone.DEFINITIONS.3
  name: definition.name,
  _kind: "workflow",
  handlers: definition.handlers,
})

export const invoke = <
  Name extends string,
  Kind extends DefinitionKind,
  Handlers extends Record<string, AnyHandler>,
  Key extends keyof Handlers,
>(
  definition: Definition<Name, Kind, Handlers>,
  handlerName: Key,
  input: InputOf<Handlers[Key]>,
  ctx: ExecutionContext,
): Effect.Effect<OutputOf<Handlers[Key]>, unknown, FluentRequirements> =>
  Effect.gen(function* () {
    const handler = definition.handlers[handlerName]
    if (handler === undefined) {
      return yield* new FluentFiregridError({
        message: `Unknown handler ${String(handlerName)} on service ${definition.name}`,
      })
    }
    const typedHandler = handler as Handler<
      InputOf<Handlers[Key]>,
      OutputOf<Handlers[Key]>
    >
    return yield* typedHandler(ctx, input)
  })

export const client = <
  Name extends string,
  Kind extends DefinitionKind,
  Handlers extends Record<string, AnyHandler>,
>(
  definition: Definition<Name, Kind, Handlers>,
  ctx: ExecutionContext,
): ServiceClient<Handlers> =>
  new Proxy({}, {
    get: (_target, property) => {
      if (typeof property !== "string") return undefined
      return (input: unknown) => invoke(
        definition,
        property as keyof Handlers,
        input as InputOf<Handlers[keyof Handlers]>,
        ctx,
      )
    },
  }) as ServiceClient<Handlers>
