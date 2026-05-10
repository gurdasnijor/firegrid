import { Context, Schema } from "effect"
import type { Effect, Stream } from "effect"
import type { Scope } from "effect"
import type { EventPipelineSummary } from "../event-pipeline.ts"
import type {
  ProjectionDefinition,
  ProjectionQuery,
} from "./ProjectionDefinition.ts"

export class ProjectionError extends Schema.TaggedError<ProjectionError>()(
  "ProjectionError",
  {
    op: Schema.String,
    cause: Schema.Unknown,
  },
) {}

export interface MaterializationStrategyService {
  readonly name: string
  readonly run: <Source, Projected, Query, State>(
    projection: ProjectionDefinition<Source, Projected, Query, State>,
  ) => Effect.Effect<EventPipelineSummary, ProjectionError>
  readonly query: <A, Query>(
    query: ProjectionQuery<A, Query>,
  ) => Effect.Effect<ReadonlyArray<A>, ProjectionError>
  readonly subscribe: <A, Query>(
    query: ProjectionQuery<A, Query>,
  ) => Stream.Stream<A, ProjectionError, Scope.Scope>
}

/**
 * firegrid-materialization-engines.ENGINE.1
 * firegrid-materialization-engines.ENGINE.2
 * firegrid-materialization-engines.ENGINE.3
 */
export class MaterializationStrategy
  extends Context.Tag("firegrid/runtime/MaterializationStrategy")<
    MaterializationStrategy,
    MaterializationStrategyService
  >()
{}

export const projectionError = (
  op: string,
  cause: unknown,
): ProjectionError =>
  new ProjectionError({ op, cause })
