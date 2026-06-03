/**
 * React bindings for DurableTable services.
 */

import {
  useLiveQuery as useTanStackLiveQuery,
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
}

declare const AnyDurableTableTagBrand: unique symbol

/**
 * `DurableTableProvider` stores heterogeneous table services by tag key and
 * `useDurableTable` re-narrows each lookup at the call site. This named
 * aggregate keeps that type erasure local to the React provider boundary.
 */
type AnyDurableTableTag =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- provider stores heterogeneous table tags and re-narrows per lookup
  & Context.Tag<any, any>
  & { readonly [AnyDurableTableTagBrand]?: never }

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

type DurableTableProviderStatus =
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
  // React hooks throw synchronously to surface provider acquisition failures
  // and missing-provider misuse. Throw the original error object directly so
  // React error boundaries receive it, not a FiberFailure wrapper.
  throw error
}

interface DurableTableProviderProps<E> {
  readonly children?: ReactNode
  readonly fallback?: ReactNode
  // The provider stores services under tag keys and `useDurableTable`
  // re-narrows each value for the requested tag.
  readonly layer: Layer.Layer<unknown, E, never>
  readonly onError?: (error: unknown) => void
  readonly tables: ReadonlyArray<AnyDurableTableTag>
}

const closeScope = (scope: Scope.CloseableScope): void => {
  // React unmount boundary: release the Effect Scope acquired by the provider.
  // eslint-disable-next-line no-restricted-syntax
  void Effect.runPromise(Scope.close(scope, Exit.void))
}

const acquireServices = <E>(options: {
  readonly layer: Layer.Layer<unknown, E, never>
  readonly tables: ReadonlyArray<AnyDurableTableTag>
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
 * Builds the supplied DurableTable layer once for this provider lifetime and
 * closes the backing Effect Scope when the provider unmounts.
 */
export function DurableTableProvider<E>(
  props: DurableTableProviderProps<E>,
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
 * Retrieves a shared DurableTable service acquired by DurableTableProvider.
 */
export function useDurableTable<Tag extends AnyDurableTableTag>(
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
