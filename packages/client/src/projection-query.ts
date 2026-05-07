import {
  EventPlane,
  PlaneProjectionReadError,
  PlaneProjectionWaitTimeout,
  type EventPlaneDefinition,
  type PlaneProjectionQuery,
  type PlaneSnapshot,
} from "@firegrid/substrate/event-plane"
import type { StreamStateDefinition } from "@durable-streams/state"
import { Context, Data, Effect, Layer, Stream, type Duration } from "effect"

export interface ProjectionQueryClientConfig {
  readonly streamUrl: string
  readonly contentType?: string
}

export interface ProjectionCursor {
  readonly _tag: "firegrid/ProjectionCursor"
  readonly descriptor: string
  readonly boundary: "initial" | "snapshot"
  readonly __firegridProjectionCursor: "ProjectionCursor"
}

const makeCursor = (
  descriptor: string,
  boundary: ProjectionCursor["boundary"],
): ProjectionCursor =>
  ({
    _tag: "firegrid/ProjectionCursor",
    descriptor,
    boundary,
    __firegridProjectionCursor: "ProjectionCursor",
  })

export const ProjectionCursor = {
  initial: (descriptor: { readonly name: string }): ProjectionCursor =>
    makeCursor(descriptor.name, "initial"),
}

export class ProjectionQueryReadError extends Data.TaggedError(
  "firegrid/ProjectionQueryReadError",
)<{
  readonly descriptor: string
  readonly reason:
    | "decode-failure"
    | "malformed-cursor"
    | "retention-gap"
    | "missing-stream"
    | "closed-stream"
    | "transport-read-failure"
  readonly cause?: unknown
}> {}

export class ProjectionQueryTimeout extends Data.TaggedError(
  "firegrid/ProjectionQueryTimeout",
)<{
  readonly descriptor: string
  readonly label: string
  readonly elapsed: Duration.Duration
}> {}

export interface ProjectionSnapshotResult<A> {
  readonly value: A
  readonly cursor: ProjectionCursor
}

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
    predicate: (value: A) => boolean,
    options: {
      readonly timeout?: Duration.DurationInput
    },
  ) => Effect.Effect<A, ProjectionQueryTimeout | ProjectionQueryReadError | E>

  readonly untilFrom: <A, E>(
    query: PlaneProjectionQuery<S, A, E, never>,
    predicate: (value: A) => boolean,
    options: {
      readonly cursor: ProjectionCursor
      readonly timeout?: Duration.DurationInput
    },
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
  new ProjectionQueryReadError({
    descriptor,
    reason: "transport-read-failure",
    cause,
  })

const mapTimeout = (
  descriptor: string,
  cause: PlaneProjectionWaitTimeout,
): ProjectionQueryTimeout =>
  new ProjectionQueryTimeout({
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
      new ProjectionQueryReadError({
        descriptor,
        reason: "malformed-cursor",
        cause: cursor,
      }),
    )
  }
  if (cursor.descriptor !== descriptor) {
    return Effect.fail(
      new ProjectionQueryReadError({
        descriptor,
        reason: "malformed-cursor",
        cause: cursor,
      }),
    )
  }
  return Effect.void
}

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
          Stream.flatMap(() =>
            Stream.unwrap(
              Effect.gen(function* () {
                const projection = yield* plane.Projection
                return projection.stream(query)
              }),
            ).pipe(Stream.provideLayer(layer)),
          ),
          Stream.mapError((cause) =>
            cause instanceof PlaneProjectionReadError
              ? mapReadError(descriptor, cause.cause)
              : cause,
          ),
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
        predicate: (value: A) => boolean,
        options: {
          readonly timeout?: Duration.DurationInput
        },
      ) =>
        // firegrid-projection-query.QUERY_HANDLES.5
        handle.snapshot(query).pipe(
          Effect.flatMap((snapshot) => {
            if (predicate(snapshot.value)) return Effect.succeed(snapshot.value)
            return handle.untilFrom(query, predicate, {
              cursor: snapshot.cursor,
              ...(options.timeout !== undefined
                ? { timeout: options.timeout }
                : {}),
            })
          }),
        ),

      untilFrom: <A, E>(
        query: PlaneProjectionQuery<S, A, E, never>,
        predicate: (value: A) => boolean,
        options: {
          readonly cursor: ProjectionCursor
          readonly timeout?: Duration.DurationInput
        },
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
                  {
                    ...(options.timeout !== undefined
                      ? { timeout: options.timeout }
                      : {}),
                  },
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

export const projectionFor = <
  Name extends string,
  S extends StreamStateDefinition,
>(
  plane: EventPlaneDefinition<Name, S>,
): Effect.Effect<ProjectionQueryHandle<S>, never, ProjectionQueryClient> =>
  Effect.map(ProjectionQueryClient, (client) => client.projectionFor(plane))

export type { PlaneSnapshot }
export type { PlaneProjectionQuery as ProjectionQuery } from "@firegrid/substrate/event-plane"
