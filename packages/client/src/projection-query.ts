import {
  EventPlane,
  PlaneProjectionReadError,
  PlaneProjectionWaitTimeout,
  type EventPlaneDefinition,
  type PlaneProjectionQuery,
  type PlaneSnapshot,
} from "@firegrid/substrate/event-plane"
import type { StreamStateDefinition } from "@durable-streams/state"
import { Context, Effect, Layer, Schema, Stream, type Duration } from "effect"

export interface ProjectionQueryClientConfig {
  readonly streamUrl: string
  readonly contentType?: string
}

export interface ProjectionQueryUntilOptions extends ProjectionQueryClientConfig {
  readonly timeout?: Duration.DurationInput
}

export class ProjectionCursor extends Schema.TaggedClass<ProjectionCursor>()(
  "firegrid/ProjectionCursor",
  {
    descriptor: Schema.String,
    boundary: Schema.Literal("initial", "snapshot"),
    __firegridProjectionCursor: Schema.Literal("ProjectionCursor"),
  },
) {
  static readonly is = Schema.is(ProjectionCursor)
  static readonly initial = (descriptor: { readonly name: string }): ProjectionCursor =>
    ProjectionCursor.make({
      descriptor: descriptor.name,
      boundary: "initial",
      __firegridProjectionCursor: "ProjectionCursor",
    })
}

const makeCursor = (
  descriptor: string,
  boundary: ProjectionCursor["boundary"],
): ProjectionCursor =>
  ProjectionCursor.make({
    descriptor,
    boundary,
    __firegridProjectionCursor: "ProjectionCursor",
  })

export class ProjectionQueryReadError extends Schema.TaggedError<ProjectionQueryReadError>()(
  "firegrid/ProjectionQueryReadError",
  {
    descriptor: Schema.String,
    reason: Schema.Literal(
      "decode-failure",
      "malformed-cursor",
      "retention-gap",
      "missing-stream",
      "closed-stream",
      "transport-read-failure",
    ),
    cause: Schema.optional(Schema.Unknown),
  },
) {
  static readonly is = Schema.is(ProjectionQueryReadError)
}

export class ProjectionQueryTimeout extends Schema.TaggedError<ProjectionQueryTimeout>()(
  "firegrid/ProjectionQueryTimeout",
  {
    descriptor: Schema.String,
    label: Schema.String,
    elapsed: Schema.Duration,
  },
) {
  static readonly is = Schema.is(ProjectionQueryTimeout)
}

export interface ProjectionSnapshotResult<A> {
  readonly value: A
  readonly cursor: ProjectionCursor
}

export type ProjectionPredicate<A> = (value: A) => boolean
export type ProjectionCollectionKey<S extends StreamStateDefinition> =
  Extract<keyof PlaneSnapshot<S>, string>
export type ProjectionCollectionRow<
  S extends StreamStateDefinition,
  K extends ProjectionCollectionKey<S>,
> = PlaneSnapshot<S>[K] extends ReadonlyMap<string, infer A> ? A : never

export interface ProjectionCollectionRef<
  S extends StreamStateDefinition,
  K extends ProjectionCollectionKey<S>,
  Row = ProjectionCollectionRow<S, K>,
> {
  readonly key: K
  readonly __row?: Row
}

export type ProjectionCollectionRefRow<Ref> =
  Ref extends { readonly __row?: infer Row } ? Row : never

export type ProjectionOrderValue =
  | string
  | number
  | boolean
  | Date
  | null
  | undefined

export type ProjectionOrderDirection = "asc" | "desc"

export interface LiveProjectionQueryBuilder<
  S extends StreamStateDefinition,
  Row,
  Result,
> {
  readonly where: (
    predicate: (row: Row) => boolean,
  ) => LiveProjectionQueryBuilder<S, Row, Result>

  readonly orderBy: (
    selector: (row: Row) => ProjectionOrderValue,
    direction?: ProjectionOrderDirection,
  ) => LiveProjectionQueryBuilder<S, Row, Result>

  readonly limit: (count: number) => LiveProjectionQueryBuilder<S, Row, Result>

  readonly select: <Next>(
    selector: (row: Row) => Next,
  ) => LiveProjectionQueryBuilder<S, Row, ReadonlyArray<Next>>

  readonly count: () => LiveProjectionQueryBuilder<S, Row, number>

  readonly toProjectionQuery: (
    label?: string,
  ) => PlaneProjectionQuery<S, Result, ProjectionQueryReadError, never>
}

export interface LiveProjectionQueryFactory<S extends StreamStateDefinition> {
  readonly collection: <
    K extends ProjectionCollectionKey<S>,
    Row = ProjectionCollectionRow<S, K>,
  >(
    key: K,
  ) => ProjectionCollectionRef<S, K, Row>

  readonly from: <
    Alias extends string,
    Ref extends ProjectionCollectionRef<S, ProjectionCollectionKey<S>, unknown>,
  >(
    source: Record<Alias, Ref>,
  ) => LiveProjectionQueryBuilder<
    S,
    { readonly [P in Alias]: ProjectionCollectionRefRow<Ref> },
    ReadonlyArray<{ readonly [P in Alias]: ProjectionCollectionRefRow<Ref> }>
  >
}

export type LiveProjectionQuerySpec<
  S extends StreamStateDefinition,
  Result,
> = (
  query: LiveProjectionQueryFactory<S>,
) => {
  readonly toProjectionQuery: (
    label?: string,
  ) => PlaneProjectionQuery<S, Result, ProjectionQueryReadError, never>
}

interface LiveProjectionPlan<Row> {
  readonly label: string
  readonly collectionKey: string
  readonly alias: string
  readonly sourceCount: number
  readonly predicates: ReadonlyArray<(row: Row) => boolean>
  readonly orderings: ReadonlyArray<{
    readonly selector: (row: Row) => ProjectionOrderValue
    readonly direction: ProjectionOrderDirection
  }>
  readonly limitCount?: number
  readonly selector?: (row: Row) => unknown
  readonly aggregate?: "count"
}

const compareOrderValue = (
  left: ProjectionOrderValue,
  right: ProjectionOrderValue,
): number => {
  const a = left instanceof Date ? left.getTime() : left
  const b = right instanceof Date ? right.getTime() : right
  if (a === b) return 0
  if (a === null || a === undefined) return 1
  if (b === null || b === undefined) return -1
  return a < b ? -1 : 1
}

const makeLiveProjectionQueryBuilder = <
  S extends StreamStateDefinition,
  Row,
  Result,
>(
  plan: LiveProjectionPlan<Row>,
): LiveProjectionQueryBuilder<S, Row, Result> => ({
  where: (predicate) =>
    makeLiveProjectionQueryBuilder<S, Row, Result>({
      ...plan,
      predicates: [...plan.predicates, predicate],
    }),

  orderBy: (selector, direction = "asc") =>
    makeLiveProjectionQueryBuilder<S, Row, Result>({
      ...plan,
      orderings: [...plan.orderings, { selector, direction }],
    }),

  limit: (count) =>
    makeLiveProjectionQueryBuilder<S, Row, Result>({
      ...plan,
      limitCount: count,
    }),

  select: (selector) =>
    makeLiveProjectionQueryBuilder<S, Row, ReadonlyArray<ReturnType<typeof selector>>>({
      ...plan,
      selector,
    }),

  count: () =>
    makeLiveProjectionQueryBuilder<S, Row, number>({
      ...plan,
      aggregate: "count",
    }),

  toProjectionQuery: (label = plan.label) => ({
    label,
    authority: "observational",
    evaluate: (snapshot) => {
      if (plan.sourceCount !== 1) {
        return Effect.fail(
          ProjectionQueryReadError.make({
            descriptor: plan.collectionKey,
            reason: "decode-failure",
            cause: "liveQuery.from supports exactly one collection in this MVP",
          }),
        )
      }
      const rows = [...snapshot[plan.collectionKey as keyof PlaneSnapshot<S>].values()]
        .map((value) => ({ [plan.alias]: value }) as Row)
        .filter((row) => plan.predicates.every((predicate) => predicate(row)))
        .sort((left, right) => {
          for (let index = 0; index < plan.orderings.length; index += 1) {
            const order = plan.orderings[index]
            if (order === undefined) return 0
            const compared = compareOrderValue(order.selector(left), order.selector(right))
            if (compared !== 0) {
              return order.direction === "asc" ? compared : -compared
            }
          }
          return 0
        })
      const limited =
        plan.limitCount === undefined ? rows : rows.slice(0, plan.limitCount)
      if (plan.aggregate === "count") return Effect.succeed(limited.length as Result)
      const selected = plan.selector === undefined
        ? limited
        : limited.map((row) => plan.selector?.(row))
      return Effect.succeed(selected as Result)
    },
  }),
})

export const createLiveProjectionQueryFactory = <
  S extends StreamStateDefinition,
>(): LiveProjectionQueryFactory<S> => {
  const from = <
    Alias extends string,
    Ref extends ProjectionCollectionRef<S, ProjectionCollectionKey<S>, unknown>,
  >(
    source: Record<Alias, Ref>,
  ): LiveProjectionQueryBuilder<
    S,
    { readonly [P in Alias]: ProjectionCollectionRefRow<Ref> },
    ReadonlyArray<{ readonly [P in Alias]: ProjectionCollectionRefRow<Ref> }>
  > => {
    const entries = Object.entries(source) as Array<[Alias, Ref]>
    const [alias, collection] = entries[0] ?? ["__invalid" as Alias, { key: "__invalid" } as Ref]
    type Row = { readonly [P in Alias]: ProjectionCollectionRefRow<Ref> }
    return makeLiveProjectionQueryBuilder<
      S,
      Row,
      ReadonlyArray<Row>
    >({
      alias,
      collectionKey: collection.key,
      label: `${collection.key}`,
      orderings: [],
      predicates: [],
      sourceCount: entries.length,
    })
  }

  return {
    collection: (key) => ({ key }),
    from,
  }
}

export interface ProjectionUntilOptions {
  readonly timeout?: Duration.DurationInput
}

export interface ProjectionUntilFromOptions extends ProjectionUntilOptions {
  readonly cursor: ProjectionCursor
}

const isPresent = <A>(value: A): value is NonNullable<A> =>
  value !== undefined && value !== null

export interface ProjectionQueryHandle<
  S extends StreamStateDefinition,
> {
  readonly snapshot: <A, E>(
    query: PlaneProjectionQuery<S, A, E, never>,
  ) => Effect.Effect<ProjectionSnapshotResult<A>, ProjectionQueryReadError | E>

  readonly stream: <A, E>(
    query: PlaneProjectionQuery<S, A, E, never>,
    cursor: ProjectionCursor,
  ) => Stream.Stream<A, ProjectionQueryReadError | E>

  readonly observe: <A, E>(
    query: PlaneProjectionQuery<S, A, E, never>,
  ) => Stream.Stream<A, ProjectionQueryReadError | E>

  readonly until: <A, E>(
    query: PlaneProjectionQuery<S, A, E, never>,
    options: ProjectionUntilOptions,
  ) => Effect.Effect<
    NonNullable<A>,
    ProjectionQueryTimeout | ProjectionQueryReadError | E
  >

  readonly untilWhere: <A, E>(
    query: PlaneProjectionQuery<S, A, E, never>,
    predicate: ProjectionPredicate<A>,
    options: ProjectionUntilOptions,
  ) => Effect.Effect<A, ProjectionQueryTimeout | ProjectionQueryReadError | E>

  readonly untilFrom: <A, E>(
    query: PlaneProjectionQuery<S, A, E, never>,
    predicate: ProjectionPredicate<A>,
    options: ProjectionUntilFromOptions,
  ) => Effect.Effect<A, ProjectionQueryTimeout | ProjectionQueryReadError | E>
}

export interface ProjectionQueryClientService {
  readonly projectionFor: <Name extends string, S extends StreamStateDefinition>(
    plane: EventPlaneDefinition<Name, S>,
  ) => ProjectionQueryHandle<S>
}

export class ProjectionQueryClient extends Context.Tag(
  "firegrid/ProjectionQueryClient",
)<ProjectionQueryClient, ProjectionQueryClientService>() {}

const mapReadError = (
  descriptor: string,
  cause: unknown,
): ProjectionQueryReadError =>
  ProjectionQueryReadError.make({
    descriptor,
    reason: "transport-read-failure",
    cause,
  })

const mapTimeout = (
  descriptor: string,
  cause: PlaneProjectionWaitTimeout,
): ProjectionQueryTimeout =>
  ProjectionQueryTimeout.make({
    descriptor,
    label: cause.label,
    elapsed: cause.elapsed,
  })

const validateCursor = (
  descriptor: string,
  cursor: ProjectionCursor,
): Effect.Effect<void, ProjectionQueryReadError> => {
  if (
    cursor?._tag !== "firegrid/ProjectionCursor" ||
    cursor.__firegridProjectionCursor !== "ProjectionCursor"
  ) {
    return Effect.fail(
      ProjectionQueryReadError.make({
        descriptor,
        reason: "malformed-cursor",
        cause: cursor,
      }),
    )
  }
  if (cursor.descriptor !== descriptor) {
    return Effect.fail(
      ProjectionQueryReadError.make({
        descriptor,
        reason: "malformed-cursor",
        cause: cursor,
      }),
    )
  }
  return Effect.void
}

const timeoutOption = (
  timeout: Duration.DurationInput | undefined,
): ProjectionUntilOptions =>
  timeout === undefined ? {} : { timeout }

export const buildProjectionQueryClientService = (
  cfg: ProjectionQueryClientConfig,
): ProjectionQueryClientService => ({
  projectionFor: <Name extends string, S extends StreamStateDefinition>(
    plane: EventPlaneDefinition<Name, S>,
  ) => {
    const descriptor = plane.name
    const layer = EventPlane.layer(plane, cfg)

    // firegrid-client-projection-api.BROWSER_SAFE_FACADE.1
    // firegrid-projection-query.AUTHORITY_BOUNDARY.2
    // This facade composes the public EventPlane subpath only. It does not
    // expose raw durable collections, kernel, claim, completion, or terminal
    // authority.
    const withProjection = <A, E>(
      effect: Effect.Effect<
        A,
        PlaneProjectionReadError | E,
        `event-plane/${Name}/Projection`
      >,
    ) =>
      Effect.scoped(effect.pipe(Effect.provide(layer))).pipe(
        Effect.mapError((cause) =>
          cause instanceof PlaneProjectionReadError
            ? mapReadError(descriptor, cause.cause)
            : cause,
        ),
      )
    const handle: ProjectionQueryHandle<S> = {
      snapshot: <A, E>(query: PlaneProjectionQuery<S, A, E, never>) =>
        withProjection(
          Effect.gen(function* () {
            const projection = yield* plane.Projection
            // firegrid-projection-query.QUERY_HANDLES.3
            const value = yield* projection.snapshot(query)
            return {
              value,
              cursor: makeCursor(descriptor, "snapshot"),
            }
          }),
        ),

      stream: <A, E>(
        query: PlaneProjectionQuery<S, A, E, never>,
        cursor: ProjectionCursor,
      ) =>
        // firegrid-projection-query.QUERY_HANDLES.4
        Stream.fromEffect(validateCursor(descriptor, cursor)).pipe(
          Stream.flatMap(() => handle.observe(query)),
        ),

      observe: <A, E>(query: PlaneProjectionQuery<S, A, E, never>) =>
        // firegrid-projection-query.QUERY_HANDLES.4
        //
        // Use one projection stream subscription for snapshot-plus-live UI reads.
        // Composing snapshot() and stream(cursor) would acquire two reads and can
        // drop a live update between them. Until EventPlane exposes durable
        // no-gap cursors, duplicate-safe output is preferable to gap-prone output.
        Stream.unwrap(
          Effect.gen(function* () {
            const projection = yield* plane.Projection
            return projection.stream(query)
          }),
        ).pipe(
          Stream.provideLayer(layer),
          Stream.mapError((cause) =>
            cause instanceof PlaneProjectionReadError
              ? mapReadError(descriptor, cause.cause)
              : cause,
          ),
        ),

      until: <A, E>(
        query: PlaneProjectionQuery<S, A, E, never>,
        options: ProjectionUntilOptions,
      ) =>
        // firegrid-projection-query.QUERY_HANDLES.5
        handle.untilWhere(query, isPresent, options).pipe(
          Effect.map((value) => value as NonNullable<A>),
        ),

      untilWhere: <A, E>(
        query: PlaneProjectionQuery<S, A, E, never>,
        predicate: ProjectionPredicate<A>,
        options: ProjectionUntilOptions,
      ) =>
        // firegrid-projection-query.QUERY_HANDLES.5
        handle.snapshot(query).pipe(
          Effect.flatMap((snapshot) => {
            if (predicate(snapshot.value)) return Effect.succeed(snapshot.value)
            return handle.untilFrom(query, predicate, {
              cursor: snapshot.cursor,
              ...timeoutOption(options.timeout),
            })
          }),
        ),

      untilFrom: <A, E>(
        query: PlaneProjectionQuery<S, A, E, never>,
        predicate: ProjectionPredicate<A>,
        options: ProjectionUntilFromOptions,
      ) =>
        // firegrid-projection-query.QUERY_HANDLES.5
        validateCursor(descriptor, options.cursor).pipe(
          Effect.flatMap(() =>
            withProjection(
              Effect.gen(function* () {
                const projection = yield* plane.Projection
                return yield* projection.until(
                  query,
                  predicate,
                  timeoutOption(options.timeout),
                )
              }),
            ),
          ),
          Effect.mapError((cause) =>
            cause instanceof PlaneProjectionWaitTimeout
              ? mapTimeout(descriptor, cause)
              : cause,
          ),
        ),
    }
    return handle
  },
})

export const ProjectionQueryClientLive = (
  cfg: ProjectionQueryClientConfig,
): Layer.Layer<ProjectionQueryClient> =>
  Layer.succeed(
    ProjectionQueryClient,
    buildProjectionQueryClientService(cfg),
  )

export const createProjectionQueryClient = (
  cfg: ProjectionQueryClientConfig,
): ProjectionQueryClientService => buildProjectionQueryClientService(cfg)

export const observe = <
  Name extends string,
  S extends StreamStateDefinition,
  A,
  E,
>(
  plane: EventPlaneDefinition<Name, S>,
  query: PlaneProjectionQuery<S, A, E, never>,
  cfg: ProjectionQueryClientConfig,
): Stream.Stream<A, ProjectionQueryReadError | E> =>
  createProjectionQueryClient(cfg).projectionFor(plane).observe(query)

export const toProjectionQuery = <
  S extends StreamStateDefinition,
  Result,
>(
  spec: LiveProjectionQuerySpec<S, Result>,
  label?: string,
): PlaneProjectionQuery<S, Result, ProjectionQueryReadError, never> =>
  spec(createLiveProjectionQueryFactory<S>()).toProjectionQuery(label)

export const liveQuery = <
  Name extends string,
  S extends StreamStateDefinition,
  Result,
>(
  plane: EventPlaneDefinition<Name, S>,
  spec: LiveProjectionQuerySpec<S, Result>,
  cfg: ProjectionQueryClientConfig,
): Stream.Stream<Result, ProjectionQueryReadError> =>
  observe(plane, toProjectionQuery(spec), cfg)

export const until = <
  Name extends string,
  S extends StreamStateDefinition,
  A,
  E,
>(
  plane: EventPlaneDefinition<Name, S>,
  query: PlaneProjectionQuery<S, A, E, never>,
  options: ProjectionQueryUntilOptions,
): Effect.Effect<
  NonNullable<A>,
  ProjectionQueryTimeout | ProjectionQueryReadError | E
> =>
  createProjectionQueryClient(options)
    .projectionFor(plane)
    .until(query, timeoutOption(options.timeout))

export const untilWhere = <
  Name extends string,
  S extends StreamStateDefinition,
  A,
  E,
>(
  plane: EventPlaneDefinition<Name, S>,
  query: PlaneProjectionQuery<S, A, E, never>,
  predicate: ProjectionPredicate<A>,
  options: ProjectionQueryUntilOptions,
): Effect.Effect<A, ProjectionQueryTimeout | ProjectionQueryReadError | E> =>
  createProjectionQueryClient(options)
    .projectionFor(plane)
    .untilWhere(query, predicate, timeoutOption(options.timeout))

export const projectionFor = <
  Name extends string,
  S extends StreamStateDefinition,
>(
  plane: EventPlaneDefinition<Name, S>,
): Effect.Effect<ProjectionQueryHandle<S>, never, ProjectionQueryClient> =>
  Effect.map(ProjectionQueryClient, (client) => client.projectionFor(plane))

export type { PlaneSnapshot }
export type { PlaneProjectionQuery as ProjectionQuery } from "@firegrid/substrate/event-plane"
