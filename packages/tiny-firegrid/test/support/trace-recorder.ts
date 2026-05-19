import {
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Supervisor,
  Tracer,
  type FiberStatus,
} from "effect"

export interface RecordedSpan {
  readonly name: string
  readonly spanId: string
  readonly traceId: string
  readonly parentSpanId?: string
  readonly kind: Tracer.SpanKind
  readonly status: "success" | "failure"
  readonly startTimeNanos: string
  readonly endTimeNanos: string
  readonly attributes: Readonly<Record<string, unknown>>
  readonly events: ReadonlyArray<{
    readonly name: string
    readonly timeNanos: string
    readonly attributes: Readonly<Record<string, unknown>>
  }>
}

export interface FiberSnapshot {
  readonly id: string
  readonly status: string
}

const fiberStatusLabel = (status: FiberStatus.FiberStatus): string => status._tag

const randomHex = (bytes: number): string => {
  const values = new Uint8Array(bytes)
  crypto.getRandomValues(values)
  return Array.from(values, value => value.toString(16).padStart(2, "0")).join("")
}

class RecordingSpan implements Tracer.Span {
  readonly _tag = "Span"
  readonly spanId: string = randomHex(8)
  readonly traceId: string
  readonly sampled = true
  readonly attributes = new Map<string, unknown>()
  readonly links: Array<Tracer.SpanLink>
  readonly events: Array<{
    readonly name: string
    readonly timeNanos: bigint
    readonly attributes: Record<string, unknown>
  }> = []
  status: Tracer.SpanStatus

  constructor(
    readonly name: string,
    readonly parent: Option.Option<Tracer.AnySpan>,
    readonly context: Tracer.Span["context"],
    links: ReadonlyArray<Tracer.SpanLink>,
    readonly startTime: bigint,
    readonly kind: Tracer.SpanKind,
    private readonly sink: Array<RecordedSpan>,
  ) {
    this.traceId = Option.isSome(parent) ? parent.value.traceId : randomHex(16)
    this.links = [...links]
    this.status = { _tag: "Started", startTime }
  }

  end(endTime: bigint, exit: Exit.Exit<unknown, unknown>): void {
    this.status = { _tag: "Ended", startTime: this.startTime, endTime, exit }
    this.sink.push({
      name: this.name,
      spanId: this.spanId,
      traceId: this.traceId,
      ...(Option.isSome(this.parent) ? { parentSpanId: this.parent.value.spanId } : {}),
      kind: this.kind,
      status: Exit.isSuccess(exit) ? "success" : "failure",
      startTimeNanos: this.startTime.toString(),
      endTimeNanos: endTime.toString(),
      attributes: Object.fromEntries(this.attributes),
      events: this.events.map(event => ({
        name: event.name,
        timeNanos: event.timeNanos.toString(),
        attributes: event.attributes,
      })),
    })
  }

  attribute(key: string, value: unknown): void {
    this.attributes.set(key, value)
  }

  event(name: string, startTime: bigint, attributes?: Record<string, unknown>): void {
    this.events.push({ name, timeNanos: startTime, attributes: attributes ?? {} })
  }

  addLinks(links: ReadonlyArray<Tracer.SpanLink>): void {
    this.links.push(...links)
  }
}

export const makeTraceRecorder = (): {
  readonly spans: ReadonlyArray<RecordedSpan>
  readonly tracer: Tracer.Tracer
} => {
  const spans: Array<RecordedSpan> = []
  const tracer = Tracer.make({
    span: (name, parent, context, links, startTime, kind) =>
      new RecordingSpan(name, parent, context, links, startTime, kind, spans),
    context: f => f(),
  })
  return { spans, tracer }
}

export const runWithTraceRecorder = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<
  {
    readonly result: A
    readonly spans: ReadonlyArray<RecordedSpan>
    readonly fibers: ReadonlyArray<FiberSnapshot>
  },
  E,
  R
> =>
  Effect.gen(function*() {
    const recorder = makeTraceRecorder()
    const supervisor = yield* Supervisor.track
    const result = yield* effect.pipe(
      Effect.withTracer(recorder.tracer),
      Effect.supervised(supervisor),
    )
    const fibers = yield* supervisor.value.pipe(
      Effect.flatMap(fibers =>
        Effect.forEach(fibers, fiber =>
          Fiber.status(fiber).pipe(
            Effect.map(status => ({
              id: String(Fiber.id(fiber)),
              status: fiberStatusLabel(status),
            })),
          )),
      ),
    )
    return { result, spans: recorder.spans, fibers }
  })

export const TraceRecorderLive = (recorder: {
  readonly tracer: Tracer.Tracer
}): Layer.Layer<never> => Layer.setTracer(recorder.tracer)
