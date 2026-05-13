/**
 * React bindings for DurableTable services.
 *
 * Implements:
 *  - effect-durable-operators.REACT.1
 *  - effect-durable-operators.REACT.2
 *  - effect-durable-operators.REACT.3
 *  - effect-durable-operators.REACT.4
 *  - effect-durable-operators.REACT.5
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
    readonly status: "loading"
  }
  | {
    readonly status: "ready"
    readonly services: ReadonlyMap<string, unknown>
  }
  | {
    readonly status: "error"
    readonly error: unknown
  }

export type DurableTableProviderStatus =
  | {
    readonly status: "loading"
    readonly error?: undefined
  }
  | {
    readonly status: "ready"
    readonly error?: undefined
  }
  | {
    readonly status: "error"
    readonly error: unknown
  }

const DurableTableReactContext = createContext<DurableTableReactState | undefined>(
  undefined,
)

const failReactHook = (error: unknown): never => {
  // effect-durable-operators.REACT.5
  // React hooks throw synchronously to surface provider acquisition failures
  // and missing-provider misuse. Throw the original error object directly so
  // React error boundaries receive it, not a FiberFailure wrapper.
  throw error
}

export interface DurableTableProviderProps<ROut, E> {
  readonly children?: ReactNode
  readonly fallback?: ReactNode
  readonly layer: Layer.Layer<ROut, E, never>
  readonly onError?: (error: unknown) => void
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly tables: ReadonlyArray<Context.Tag<ROut, any>>
}

const closeScope = (scope: Scope.CloseableScope): void => {
  // React unmount boundary: release the Effect Scope acquired by the provider.
  // eslint-disable-next-line no-restricted-syntax
  void Effect.runPromise(Scope.close(scope, Exit.void))
}

const acquireServices = <ROut, E>(options: {
  readonly layer: Layer.Layer<ROut, E, never>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly tables: ReadonlyArray<Context.Tag<ROut, any>>
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
  const [state, setState] = useState<DurableTableReactState>({ status: "loading" })
  const [initialOptions] = useState(() => ({
    layer: props.layer,
    onError: props.onError,
    tables: props.tables,
  }))

  useEffect(() => {
    let active = true
    let acquiredScope: Scope.CloseableScope | undefined

    // React mount boundary: acquire shared DurableTable services once for this
    // provider lifetime.
    // eslint-disable-next-line no-restricted-syntax
    void Effect.runPromise(acquireServices({
      layer: initialOptions.layer,
      tables: initialOptions.tables,
    })).then(
      ({ scope, services }) => {
        if (!active) {
          closeScope(scope)
          return
        }
        acquiredScope = scope
        setState({ status: "ready", services })
      },
      (error: unknown) => {
        if (!active) return
        initialOptions.onError?.(error)
        setState({ status: "error", error })
      },
    )

    return () => {
      active = false
      if (acquiredScope !== undefined) {
        closeScope(acquiredScope)
      }
    }
  }, [initialOptions])

  return createElement(
    DurableTableReactContext.Provider,
    { value: state },
    state.status === "loading" ? props.fallback ?? null : props.children,
  )
}

/**
 * effect-durable-operators.REACT.4
 *
 * Surfaces provider acquisition state without exposing the internal service
 * map held by the provider.
 */
export function useDurableTableProviderStatus(): DurableTableProviderStatus {
  const state = useContext(DurableTableReactContext)
  if (state === undefined) return { status: "loading" }
  if (state.status === "error") {
    return { status: "error", error: state.error }
  }
  return { status: state.status }
}

/**
 * effect-durable-operators.REACT.3
 *
 * Retrieves a shared DurableTable service acquired by DurableTableProvider.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function useDurableTable<Tag extends Context.Tag<any, any>>(
  table: Tag,
): Context.Tag.Service<Tag> {
  const state = useContext(DurableTableReactContext)
  if (state === undefined || state.status === "loading") {
    return failReactHook(new Error("DurableTableProvider is not ready"))
  }
  if (state.status === "error") {
    return failReactHook(state.error)
  }

  if (!state.services.has(table.key)) {
    return failReactHook(
      new Error(`DurableTableProvider did not acquire table: ${table.key}`),
    )
  }

  return state.services.get(table.key) as Context.Tag.Service<Tag>
}
