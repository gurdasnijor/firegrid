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

declare const AnyDurableTableTagBrand: unique symbol

/**
 * TFIND-044 (Option B — localized named coarse aggregate; SDD
 * `docs/proposals/SDD_DURABLE_TABLE_REACT_LIVE_QUERY.md` §0, Gurdas
 * signed off).
 *
 * The `DurableTableProvider` seam is **inherently heterogeneous and
 * type-erased by design**: `acquireServices` resolves each tag by its
 * string `key` into a `ReadonlyMap<string, unknown>`, and consumers
 * re-narrow per tag at `useDurableTable`. A single shared `ROut`
 * generic therefore cannot — and need not — carry N distinct precise
 * DurableTable `<Self>` identities once TFIND-005's curry makes them
 * precise (it produced `flamecast main.tsx:360` TS2322). Option A would
 * reconstruct precision this boundary immediately discards.
 *
 * `AnyDurableTableTag` is that one explicit, **named** aggregate,
 * confined to this seam; every `DurableTable` stays precise everywhere
 * else. This is categorically distinct from the TFIND-005 bug: that was
 * a *diffuse, implicit, unnamed* `any` leaking from
 * `defineDurableTable`'s return that silently discharged *unrelated*
 * required tags across every host/engine composition. This is a
 * *single, named, explicit* coarsening at one boundary that is already
 * `unknown`-typed by design and discharges nothing elsewhere. The
 * optional phantom brand makes the seam role visible in types while
 * keeping arbitrary heterogeneous real tags assignable without casts.
 */
export type AnyDurableTableTag =
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- seam is heterogeneous-and-erased by design (see above); the single localized, named coarsening for TFIND-044 Option B
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
  // `ROut` is a free generic *inferred per call site* from the supplied
  // layer — never assigned to a fixed supertype — so the precise
  // `DurableTable<Self>()` identities a composed layer provides flow
  // through without the `Layer<precise> ⊄ Layer<unknown>` contravariance
  // trap. The provider is genuinely ROut-agnostic at runtime: it resolves
  // each tag by string `key` into a `ReadonlyMap<string, unknown>` below
  // and consumers re-narrow per tag at `useDurableTable`. `tables` stays
  // the signed-off, named `AnyDurableTableTag` aggregate (TFIND-044
  // Option B); only the `layer` side is decoupled here. No cast, no
  // `any`, no invented layer.
  readonly layer: Layer.Layer<ROut, E, never>
  readonly onError?: (error: unknown) => void
  readonly tables: ReadonlyArray<AnyDurableTableTag>
}

const closeScope = (scope: Scope.CloseableScope): void => {
  // React unmount boundary: release the Effect Scope acquired by the provider.
  // eslint-disable-next-line no-restricted-syntax
  void Effect.runPromise(Scope.close(scope, Exit.void))
}

const acquireServices = <ROut, E>(options: {
  readonly layer: Layer.Layer<ROut, E, never>
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
// `Service` is captured *directly* from the tag's Service type parameter
// (`Context.Tag<any, Service>`), not via the deferred
// `Context.Tag.Service<Tag>` conditional. Under the precise
// `DurableTable<Self>()` curry, `Self` is a self-referential class, so
// `Context.Tag.Service<typeof Tag>` stays an unresolved conditional that
// `@tanstack/react-db`'s deep query-builder inference cannot see through
// (it degraded the collection row to `Ref<object | …>`). A direct
// inference variable resolves eagerly. `tables` still uses the
// signed-off named `AnyDurableTableTag`; the `any` here is only the
// Identifier position of that same seam (heterogeneous-by-design), not a
// new `any`/cast/paper.
export function useDurableTable<Service>(
  table: AnyDurableTableTag &
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Identifier position only; same heterogeneous-by-design seam as `AnyDurableTableTag` (TFIND-044 Option B). Captures `Service` directly for eager inference.
    Context.Tag<any, Service>,
): Service {
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

  return state.services.get(table.key) as Service
}
