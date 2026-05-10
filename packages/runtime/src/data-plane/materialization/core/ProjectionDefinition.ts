import type {
  EventProjectorService,
  EventSourceService,
} from "../event-pipeline.ts"

export interface ProjectionTarget<Projected, Query = unknown, State = unknown> {
  readonly name: string
  readonly initialState: () => State
  readonly fold: (state: State, event: Projected) => State
  readonly query: <A>(state: State, query: ProjectionQuery<A, Query>) => ReadonlyArray<A>
}

export interface ProjectionQuery<A, Query = unknown> {
  readonly projectionName: string
  readonly targetName: string
  readonly query: Query
  readonly select: (rows: ReadonlyArray<unknown>) => ReadonlyArray<A>
}

/**
 * firegrid-materialization-engines.ENGINE.4
 */
export interface ProjectionDefinition<Source, Projected, Query = unknown, State = unknown> {
  readonly name: string
  readonly version: string
  readonly source: EventSourceService<Source>
  readonly projector: EventProjectorService<Source, Projected>
  readonly target: ProjectionTarget<Projected, Query, State>
}
