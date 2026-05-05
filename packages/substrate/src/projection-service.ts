import { Duration, Effect, Option, Stream } from "effect"

interface ProjectionCoreQuery<Snapshot, A, E = never, R = never> {
  readonly label: string
  readonly evaluate: (snapshot: Snapshot) => Effect.Effect<A, E, R>
}

interface ProjectionCore<Snapshot, ReadError, TimeoutError> {
  readonly snapshot: <A, E, R>(
    query: ProjectionCoreQuery<Snapshot, A, E, R>,
  ) => Effect.Effect<A, ReadError | E, R>

  readonly stream: <A, E, R>(
    query: ProjectionCoreQuery<Snapshot, A, E, R>,
  ) => Stream.Stream<A, ReadError | E, R>

  readonly until: <A, E, R>(
    query: ProjectionCoreQuery<Snapshot, A, E, R>,
    predicate: (value: A) => boolean,
    options?: {
      readonly timeout?: Duration.DurationInput
    },
  ) => Effect.Effect<A, TimeoutError | ReadError | E, R>
}

interface Subscription {
  readonly unsubscribe: () => void
}

interface ProjectionCoreInput<Db, Snapshot, TimeoutError> {
  readonly db: Db
  readonly snapshotFromDb: (db: Db) => Snapshot
  readonly subscribe: (
    db: Db,
    evaluateAndEmit: () => void,
  ) => ReadonlyArray<Subscription>
  readonly timeout: (
    label: string,
    elapsed: Duration.Duration,
  ) => TimeoutError
}

// firegrid-remediation-hardening.CODE_REUSE.4
export const buildProjectionCore = <Db, Snapshot, ReadError, TimeoutError>(
  input: ProjectionCoreInput<Db, Snapshot, TimeoutError>,
): ProjectionCore<Snapshot, ReadError, TimeoutError> => {
  const snapshot: ProjectionCore<Snapshot, ReadError, TimeoutError>["snapshot"] = (
    query,
  ) => Effect.suspend(() => query.evaluate(input.snapshotFromDb(input.db)))

  const stream: ProjectionCore<Snapshot, ReadError, TimeoutError>["stream"] = (
    query,
  ) =>
    Stream.asyncScoped((emit) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const evaluateAndEmit = () => {
            void emit.fromEffect(query.evaluate(input.snapshotFromDb(input.db)))
          }
          return input.subscribe(input.db, evaluateAndEmit)
        }),
        (subs) => Effect.sync(() => subs.forEach((s) => s.unsubscribe())),
      ),
    )

  const until: ProjectionCore<Snapshot, ReadError, TimeoutError>["until"] = (
    query,
    predicate,
    options,
  ) => {
    const findFirst = stream(query).pipe(
      Stream.filter(predicate),
      Stream.runHead,
      Effect.flatMap((opt) =>
        Option.match(opt, {
          onNone: () => Effect.fail(input.timeout(query.label, Duration.zero)),
          onSome: (value) => Effect.succeed(value),
        }),
      ),
    )
    if (options?.timeout === undefined) return findFirst
    const timeout = Duration.decode(options.timeout)
    return findFirst.pipe(
      Effect.timeoutFail({
        duration: timeout,
        onTimeout: () => input.timeout(query.label, timeout),
      }),
    )
  }

  return { snapshot, stream, until }
}
