import type { Effect } from "effect"
import type { Journal } from "./journal.ts"
import type { ExecutionContext, FluentRequirements } from "./schema.ts"

export type Handler<Input, Output> = (
  ctx: ExecutionContext,
  input: Input,
) => Effect.Effect<Output, unknown, FluentRequirements>

export type Operation<
  Output,
  Error = unknown,
  Requirements = Journal | FluentRequirements,
> = Effect.fn.Return<
  Output,
  Error,
  Requirements
>

export type GeneratorHandler<Input, Output> = (
  input: Input,
) => Operation<Output>

export type DefinitionHandler = (...args: Array<never>) => unknown

export type DefinitionKind = "service" | "object" | "workflow"

export interface Definition<
  Name extends string,
  Kind extends DefinitionKind,
  Handlers extends Record<string, DefinitionHandler>,
> {
  readonly name: Name
  readonly _kind: Kind
  readonly handlers: Handlers
}

export type ServiceDefinition<
  Name extends string,
  Handlers extends Record<string, DefinitionHandler>,
> = Definition<Name, "service", Handlers>

export type ObjectDefinition<
  Name extends string,
  Handlers extends Record<string, DefinitionHandler>,
> = Definition<Name, "object", Handlers>

export type WorkflowDefinition<
  Name extends string,
  Handlers extends Record<string, DefinitionHandler>,
> = Definition<Name, "workflow", Handlers>

// fluent-firegrid-keystone.PACKAGE.2
export const service = <
  const Name extends string,
  const Handlers extends Record<string, DefinitionHandler>,
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
  const Handlers extends Record<string, DefinitionHandler>,
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
  const Handlers extends Record<string, DefinitionHandler>,
>(definition: {
  readonly name: Name
  readonly handlers: Handlers
}): WorkflowDefinition<Name, Handlers> => ({
  // fluent-firegrid-keystone.DEFINITIONS.3
  name: definition.name,
  _kind: "workflow",
  handlers: definition.handlers,
})
