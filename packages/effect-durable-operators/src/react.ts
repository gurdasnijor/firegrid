/**
 * React bindings for DurableTable services.
 *
 * Implements:
 *  - effect-durable-operators.REACT.1
 *  - effect-durable-operators.REACT.2
 *  - effect-durable-operators.REACT.3
 *  - effect-durable-operators.REACT.4
 */

import {
  useLiveQuery as useTanStackLiveQuery,
  useLiveSuspenseQuery as useTanStackLiveSuspenseQuery,
} from "@tanstack/react-db"
import {
  Context,
  Effect,
  Exit,
  Layer,
  Scope,
} from "effect"
import {
  createContext,
  createElement,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react"

export {
  useTanStackLiveQuery as useDurableLiveQuery,
  useTanStackLiveSuspenseQuery as useDurableLiveSuspenseQuery,
}

type DurableTableReactState =
  | {
    readonly _tag: "Loading"
  }
  | {
    readonly _tag: "Ready"
    readonly services: ReadonlyMap<string, unknown>
  }
  | {
    readonly _tag: "Error"
    readonly error: unknown
  }

const DurableTableReactContext = createContext<DurableTableReactState | undefined>(
  undefined,
)

const failReactHook = (error: unknown): never =>
  // React error boundary boundary: hooks must throw synchronously to surface
  // provider acquisition failures and missing-provider misuse.
  // eslint-disable-next-line no-restricted-syntax
  Effect.runSync(Effect.fail(error))

export interface DurableTableProviderProps<ROut, E> {
  readonly children: ReactNode
  readonly fallback?: ReactNode
  readonly layer: Layer.Layer<ROut, E, never>
  readonly onError?: (error: unknown) => void
  readonly tables: ReadonlyArray<Context.Tag<ROut, unknown>>
}

const closeScope = (scope: Scope.CloseableScope): void => {
  // React unmount boundary: release the Effect Scope acquired by the provider.
  // eslint-disable-next-line no-restricted-syntax
  void Effect.runPromise(Scope.close(scope, Exit.void))
}

const acquireServices = <ROut, E>(options: {
  readonly layer: Layer.Layer<ROut, E, never>
  readonly tables: ReadonlyArray<Context.Tag<ROut, unknown>>
}): Effect.Effect<
  {
    readonly scope: Scope.CloseableScope
    readonly services: ReadonlyMap<string, unknown>
  },
  E
> =>
  Effect.gen(function* () {
    const scope = yield* Scope.make()
    const context = yield* Layer.buildWithScope(scope)(options.layer).pipe(
      Effect.catchAll((error: E) =>
        Scope.close(scope, Exit.void).pipe(
          Effect.zipRight(Effect.fail(error)),
        ),
      ),
    )

    const services = options.tables.reduce((acc, table) => {
      acc.set(table.key, Context.unsafeGet(context, table))
      return acc
    }, new Map<string, unknown>())

    return { scope, services }
  })

/**
 * effect-durable-operators.REACT.2
 *
 * Builds the supplied DurableTable layer once for this provider lifetime and
 * closes the backing Effect Scope when the provider unmounts.
 */
export function DurableTableProvider<ROut, E>(
  props: DurableTableProviderProps<ROut, E>,
): ReactNode {
  const [state, setState] = useState<DurableTableReactState>({ _tag: "Loading" })

  useEffect(() => {
    let active = true
    let acquiredScope: Scope.CloseableScope | undefined

    // React mount boundary: acquire shared DurableTable services once for this
    // provider lifetime.
    // eslint-disable-next-line no-restricted-syntax
    void Effect.runPromise(acquireServices({
      layer: props.layer,
      tables: props.tables,
    })).then(
      ({ scope, services }) => {
        if (!active) {
          closeScope(scope)
          return
        }
        acquiredScope = scope
        setState({ _tag: "Ready", services })
      },
      (error: unknown) => {
        if (!active) return
        props.onError?.(error)
        setState({ _tag: "Error", error })
      },
    )

    return () => {
      active = false
      if (acquiredScope !== undefined) {
        closeScope(acquiredScope)
      }
    }
  }, [props.layer, props.onError, props.tables])

  if (state._tag === "Loading") {
    return props.fallback ?? null
  }
  if (state._tag === "Error") {
    return failReactHook(state.error)
  }

  return createElement(
    DurableTableReactContext.Provider,
    { value: state },
    props.children,
  )
}

export function useDurableTableProviderStatus(): DurableTableReactState {
  const state = useContext(DurableTableReactContext)
  return state ?? { _tag: "Loading" }
}

/**
 * effect-durable-operators.REACT.3
 *
 * Retrieves a shared DurableTable service acquired by DurableTableProvider.
 */
export function useDurableTable<Tag extends Context.Tag<unknown, unknown>>(
  table: Tag,
): Context.Tag.Service<Tag> {
  const state = useContext(DurableTableReactContext)
  if (state === undefined || state._tag === "Loading") {
    return failReactHook(new Error("DurableTableProvider is not ready"))
  }
  if (state._tag === "Error") {
    return failReactHook(state.error)
  }

  if (!state.services.has(table.key)) {
    return failReactHook(
      new Error(`DurableTableProvider did not acquire table: ${table.key}`),
    )
  }

  return state.services.get(table.key) as Context.Tag.Service<Tag>
}
