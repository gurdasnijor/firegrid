import type {
  EventProjectorIdentity,
  EventProjectorService,
  EventSourceService,
} from "../event-pipeline.ts"

export interface ProjectionContext {
  readonly projection: {
    readonly name: string
    readonly version: string
  }
  readonly projector: EventProjectorIdentity
}

export interface StateProtocolTarget<Query = unknown> {
  readonly stateSchema: unknown
  readonly encode: (change: unknown, context: ProjectionContext) => unknown
  readonly query: <A>(
    store: unknown,
    query: ProjectionQuery<A, Query>,
  ) => ReadonlyArray<A>
}

export interface ProjectionTarget<Projected, Query = unknown, State = unknown> {
  readonly name: string
  readonly initialState: () => State
  readonly fold: (state: State, event: Projected) => State
  readonly query: <A>(state: State, query: ProjectionQuery<A, Query>) => ReadonlyArray<A>
  readonly stateProtocol?: StateProtocolTarget<Query>
}

export interface ProjectionQueryTarget<Query = unknown> {
  readonly name: string
  readonly stateProtocol?: StateProtocolTarget<Query>
}

export interface ProjectionQuery<A, Query = unknown> {
  readonly projectionName: string
  readonly target: ProjectionQueryTarget<Query>
  readonly query: Query
  readonly select: (rows: ReadonlyArray<unknown>) => ReadonlyArray<A>
}

/**
 * firegrid-materialization-engines.ENGINE.4
 * firegrid-materialization-engines.ENGINE.7
 * firegrid-materialization-engines.BOUNDARY.4
 * firegrid-materialization-engines.BOUNDARY.5
 */
export interface ProjectionDefinition<Source, Projected, Query = unknown, State = unknown> {
  readonly name: string
  readonly version: string
  readonly source: EventSourceService<Source>
  readonly projector: EventProjectorService<Source, Projected>
  readonly target: ProjectionTarget<Projected, Query, State>
}
