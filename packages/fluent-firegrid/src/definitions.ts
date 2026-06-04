import { Effect } from "effect"
import { FluentFiregridError } from "./error.ts"
import { execute } from "./execute.ts"
import type { Operation } from "./operation.ts"
import type { ExecutionContext, FluentRequirements } from "./schema.ts"

export type Handler<Input, Output> = (
  ctx: ExecutionContext,
  input: Input,
) => Effect.Effect<Output, unknown, FluentRequirements>

type AnyHandler = Handler<never, unknown>
type AnyOperationHandler = (input: never) => Operation<unknown>
type HandlerEntry = AnyHandler | AnyOperationHandler

type HandlerEntryInput<Entry> =
  Entry extends Handler<infer Input, unknown> ? Input
    : Entry extends (input: infer Input) => Operation<unknown> ? Input
    : never

type HandlerEntryOutput<Entry> =
  Entry extends Handler<never, infer Output> ? Output
    : Entry extends (input: never) => Operation<infer Output> ? Output
    : never

type NormalizeHandlers<Entries extends Record<string, HandlerEntry>> = {
  readonly [Key in keyof Entries]: Handler<
    HandlerEntryInput<Entries[Key]>,
    HandlerEntryOutput<Entries[Key]>
  >
}

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


const isExecutionHandler = (entry: HandlerEntry): entry is AnyHandler =>
  entry.length >= 2

const normalizeHandlers = <const Entries extends Record<string, HandlerEntry>>(
  entries: Entries,
): NormalizeHandlers<Entries> => {
  const normalized: Record<string, AnyHandler> = {}
  const keys = Object.keys(entries)
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]
    if (key === undefined) continue
    const entry = entries[key]
    if (entry === undefined) continue
    normalized[key] = ((ctx: ExecutionContext, input: never) => {
      if (isExecutionHandler(entry)) return entry(ctx, input)
      return execute(ctx, entry(input))
    })
  }
  return normalized as NormalizeHandlers<Entries>
}

// fluent-firegrid-keystone.PACKAGE.2
export const service = <
  const Name extends string,
  const Handlers extends Record<string, HandlerEntry>,
>(definition: {
  readonly name: Name
  readonly handlers: Handlers
}): ServiceDefinition<Name, NormalizeHandlers<Handlers>> => ({
  name: definition.name,
  _kind: "service",
  handlers: normalizeHandlers(definition.handlers),
})

export const object = <
  const Name extends string,
  const Handlers extends Record<string, HandlerEntry>,
>(definition: {
  readonly name: Name
  readonly handlers: Handlers
}): ObjectDefinition<Name, NormalizeHandlers<Handlers>> => ({
  name: definition.name,
  _kind: "object",
  handlers: normalizeHandlers(definition.handlers),
})

export const workflow = <
  const Name extends string,
  const Handlers extends Record<string, HandlerEntry>,
>(definition: {
  readonly name: Name
  readonly handlers: Handlers
}): WorkflowDefinition<Name, NormalizeHandlers<Handlers>> => ({
  // fluent-firegrid-keystone.DEFINITIONS.3
  name: definition.name,
  _kind: "workflow",
  handlers: normalizeHandlers(definition.handlers),
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
