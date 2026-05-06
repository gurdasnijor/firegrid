import { Effect, Either, Layer, Schema } from "effect"
import { describe, expect, it } from "vitest"
import * as ChoreographySurface from "../coordination/choreography/index.ts"
import {
  ChoreographyTimeout,
  ChoreographyTrigger,
  CompletionId,
  CurrentWorkContext,
  MissingTriggerMatcherError,
  OwnerId,
  ProjectionMatchTrigger,
  TriggerMatchers,
  WorkId,
  currentWorkContextLayer,
  dispatchTrigger,
  triggerMatchersLayer,
  type ChoreographyOperation,
  type ChoreographySuspension,
  type CurrentWorkContextValue,
  type TriggerMatcher,
} from "../coordination/choreography/index.ts"

// choreography-facade.CURRENT_WORK_CONTEXT.2
// choreography-facade.CURRENT_WORK_CONTEXT.3
// Brands have no runtime cost and prevent accidental swapping at the
// choreography boundary. The constructor narrows a string into the branded
// type without changing the value.
describe("choreography-facade.CURRENT_WORK_CONTEXT.3 — branded WorkId/CompletionId/OwnerId are nominal over string", () => {
  it("WorkId/CompletionId/OwnerId narrow strings to nominal brands without changing runtime value", () => {
    const w = WorkId("run-abc")
    const c = CompletionId("cmp-123")
    const o = OwnerId("owner-7")
    expect(w).toBe("run-abc")
    expect(c).toBe("cmp-123")
    expect(o).toBe("owner-7")
    // Type-level: brands are not assignable to each other or to plain
    // string. The expect-error checks document that.
    // @ts-expect-error WorkId is not assignable to CompletionId
    const _wrong1: typeof c = w
    // @ts-expect-error plain string is not assignable to WorkId
    const _wrong2: typeof w = "run-abc"
    void _wrong1
    void _wrong2
  })
})

// choreography-facade.CURRENT_WORK_CONTEXT.5
// In v1, CurrentWorkContext.workId carries the same string identity as the
// durable.run runId. We model that by feeding a runId-shaped string straight
// into the WorkId brand.
describe("choreography-facade.CURRENT_WORK_CONTEXT.5 — workId is the durable.run runId", () => {
  it("a runId-shaped string flows directly into WorkId without translation", () => {
    const runId = "run-from-declare-work"
    const value: CurrentWorkContextValue = {
      workId: WorkId(runId),
      ownerId: OwnerId("owner-1"),
    }
    expect(value.workId).toBe(runId)
  })
})

// choreography-facade.CURRENT_WORK_CONTEXT.1
// choreography-facade.CURRENT_WORK_CONTEXT.2
// Choreography operations read identity from CurrentWorkContext. The tag is
// resolved through ordinary Layer/provide composition; no global state.
describe("choreography-facade.CURRENT_WORK_CONTEXT.1 — Effect-provided CurrentWorkContext", () => {
  it("CurrentWorkContext is resolved via Layer-provided value and exposes branded ids plus optional metadata", async () => {
    const provided: CurrentWorkContextValue = {
      workId: WorkId("run-1"),
      ownerId: OwnerId("owner-a"),
      correlationId: "corr-1",
      causationId: "cause-1",
      telemetry: { service: "test" },
    }

    const program = Effect.gen(function* () {
      const ctx = yield* CurrentWorkContext
      return ctx
    })

    const observed = await Effect.runPromise(
      program.pipe(Effect.provide(currentWorkContextLayer(provided))),
    )
    expect(observed).toStrictEqual(provided)
    expect(observed.workId).toBe("run-1")
    expect(observed.ownerId).toBe("owner-a")
    expect(observed.correlationId).toBe("corr-1")
    expect(observed.causationId).toBe("cause-1")
    expect(observed.telemetry).toEqual({ service: "test" })
  })
})

// choreography-facade.TRIGGERS.1
// choreography-facade.TRIGGERS.3
// choreography-facade.TRIGGERS.4
// v1 supports projection-match triggers only. The trigger payload contains
// only serializable string fields (label, projectionKey, matcherId) and
// does NOT embed function predicates or raw projection objects.
describe("choreography-facade.TRIGGERS.1 — v1 trigger union exposes projection-match only", () => {
  it("ProjectionMatchTrigger decodes label/projectionKey/matcherId and tags the value as ProjectionMatch", () => {
    const decoded = Schema.decodeUnknownSync(ProjectionMatchTrigger)({
      _tag: "ProjectionMatch",
      label: "permission-resolved:p-1",
      projectionKey: "plane.permission.byId:p-1",
      matcherId: "fixture.permission.resolved",
    })
    expect(decoded._tag).toBe("ProjectionMatch")
    expect(decoded.label).toBe("permission-resolved:p-1")
    expect(decoded.projectionKey).toBe("plane.permission.byId:p-1")
    expect(decoded.matcherId).toBe("fixture.permission.resolved")
  })
})

// choreography-facade.TRIGGERS.4
describe("choreography-facade.TRIGGERS.4 — trigger schema rejects function predicates and non-string fields", () => {
  it("decoding fails when matcherId is missing or fields are non-string", () => {
    const decode = Schema.decodeUnknownEither(ProjectionMatchTrigger)
    expect(Either.isLeft(decode({ _tag: "ProjectionMatch", label: "x", projectionKey: "k" }))).toBe(true)
    expect(
      Either.isLeft(
        decode({
          _tag: "ProjectionMatch",
          label: "x",
          projectionKey: "k",
          matcherId: () => true,
        }),
      ),
    ).toBe(true)
  })
})

// choreography-facade.TRIGGERS.2
// Runtime APIs and tool bindings share the same Schema for trigger input.
// Round-tripping through encode/decode preserves the discriminator and the
// data fields so a tool wire payload and a runtime call decode identically.
describe("choreography-facade.TRIGGERS.2 — runtime API and tool bindings share one trigger schema", () => {
  it("encode then decode of a ChoreographyTrigger value is structurally identical", () => {
    const value = {
      _tag: "ProjectionMatch" as const,
      label: "session-terminal:req-1",
      projectionKey: "plane.session.byRequestId:req-1",
      matcherId: "fixture.session.terminal",
    }
    const encoded = Schema.encodeSync(ChoreographyTrigger)(value)
    const decoded = Schema.decodeUnknownSync(ChoreographyTrigger)(encoded)
    expect(decoded).toStrictEqual(value)
  })
})

// choreography-facade.TRIGGERS.5
// choreography-facade.TRIGGERS.6
// Matchers are layer-scoped. Two layers built with different matcher maps
// produce isolated lookups; there is no global mutable matcher registry.
describe("choreography-facade.TRIGGERS.5 — TriggerMatchers is a layer-scoped service keyed by matcherId", () => {
  it("triggerMatchersLayer registers matchers by id and returns them through TriggerMatchers.lookup", async () => {
    const matcher: TriggerMatcher = (_t) =>
      Effect.succeed({ kind: "match", value: "ok" })

    const program = Effect.gen(function* () {
      const svc = yield* TriggerMatchers
      const m = yield* svc.lookup("fixture.alpha")
      return yield* m({
        _tag: "ProjectionMatch",
        label: "l",
        projectionKey: "k",
        matcherId: "fixture.alpha",
      })
    })

    const result = await Effect.runPromise(
      program.pipe(
        Effect.provide(triggerMatchersLayer({ "fixture.alpha": matcher })),
      ),
    )
    expect(result).toStrictEqual({ kind: "match", value: "ok" })
  })
})

// choreography-facade.TRIGGERS.6
describe("choreography-facade.TRIGGERS.6 — no global mutable matcher registry", () => {
  it("two independent layer instances yield independent matchers; one layer's id is unknown to the other", async () => {
    const program = Effect.gen(function* () {
      const svc = yield* TriggerMatchers
      return yield* Effect.either(svc.lookup("fixture.alpha"))
    })

    const layerA = triggerMatchersLayer({
      "fixture.alpha": (_t) => Effect.succeed({ kind: "no-match" } as const),
    })
    const layerB = triggerMatchersLayer({
      "fixture.beta": (_t) => Effect.succeed({ kind: "no-match" } as const),
    })

    const a = await Effect.runPromise(
      program.pipe(Effect.provide(layerA)),
    )
    const b = await Effect.runPromise(
      program.pipe(Effect.provide(layerB)),
    )

    expect(Either.isRight(a)).toBe(true)
    expect(Either.isLeft(b)).toBe(true)
  })
})

// choreography-facade.TRIGGERS.7
// dispatchTrigger is exhaustive over the union. v1 has a single variant;
// adding a new variant must force an explicit case at compile time.
describe("choreography-facade.TRIGGERS.7 — exhaustive lowering dispatch over the trigger union", () => {
  it("dispatchTrigger routes ProjectionMatch to the ProjectionMatch case", () => {
    const trigger: ProjectionMatchTrigger = {
      _tag: "ProjectionMatch",
      label: "x",
      projectionKey: "k",
      matcherId: "m",
    }
    const out = dispatchTrigger(trigger, {
      ProjectionMatch: (t) => `pm:${t.label}`,
    })
    expect(out).toBe("pm:x")
  })
})

// choreography-facade.TRIGGERS.8
// Looking up an unknown matcherId is a typed runtime configuration error,
// not a silent no-op.
describe("choreography-facade.TRIGGERS.8 — missing matcher fails as an explicit runtime configuration error", () => {
  it("lookup of an unregistered matcherId fails with MissingTriggerMatcherError carrying the matcherId", async () => {
    const program = Effect.gen(function* () {
      const svc = yield* TriggerMatchers
      return yield* svc.lookup("fixture.unknown")
    })

    const result = await Effect.runPromise(
      Effect.either(program).pipe(Effect.provide(triggerMatchersLayer({}))),
    )
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(MissingTriggerMatcherError)
      expect(result.left.matcherId).toBe("fixture.unknown")
    }
  })
})

// choreography-facade.ERRORS.1
// choreography-facade.ERRORS.2
// choreography-facade.ERRORS.4
// ChoreographyTimeout is the only v1 recoverable tagged choreography error.
// It carries a branded CompletionId and the absolute durable deadlineAtMs.
describe("choreography-facade.ERRORS.1 — ChoreographyTimeout is the only v1 recoverable tagged choreography error", () => {
  it("ChoreographyTimeout is a tagged Data error carrying CompletionId and deadlineAtMs", () => {
    const err = new ChoreographyTimeout({
      completionId: CompletionId("cmp-1"),
      deadlineAtMs: 1_700_000_000_000,
    })
    expect(err._tag).toBe("substrate/ChoreographyTimeout")
    expect(err.completionId).toBe("cmp-1")
    expect(err.deadlineAtMs).toBe(1_700_000_000_000)
  })
})

// choreography-facade.ERRORS.3
// The v1 facade does not raise ChoreographyTimeout; the type is reserved
// for host-runtime resume from a timed-out or cancelled suspended wait.
// This test pins the v1 surface: the foundation module exports the type
// but the foundation module exposes no API that raises it.
describe("choreography-facade.ERRORS.3 — ChoreographyTimeout is reserved for host-runtime resume; v1 does not raise it from foundations", () => {
  it("the foundation module exposes the type without an internal raise path", () => {
    // The type is exported and constructible.
    const err = new ChoreographyTimeout({
      completionId: CompletionId("cmp-2"),
      deadlineAtMs: 0,
    })
    expect(err).toBeInstanceOf(ChoreographyTimeout)
    // The foundation export surface contains no function whose name implies
    // a v1 timeout-raising path. This pins the boundary against future
    // accidental drift in this slice.
    const names = Object.keys(ChoreographySurface)
    const offenders = names.filter((n) =>
      /timeout|raise|resume|continuation|replay/i.test(n) &&
      n !== "ChoreographyTimeout",
    )
    expect(offenders).toEqual([])
  })
})

// choreography-facade.SUSPENSION.7
// ChoreographySuspension contains suspended=true, operation, branded
// workId, and branded completionId. The foundation slice ships only the
// type; producers of the value land in later commits.
describe("choreography-facade.SUSPENSION.7 — ChoreographySuspension shape", () => {
  it("a ChoreographySuspension value carries suspended=true, operation, branded workId, and branded completionId", () => {
    const v: ChoreographySuspension = {
      suspended: true,
      operation: "sleep",
      workId: WorkId("run-z"),
      completionId: CompletionId("cmp-z"),
    }
    expect(v.suspended).toBe(true)
    expect(v.operation).toBe("sleep")
    expect(v.workId).toBe("run-z")
    expect(v.completionId).toBe("cmp-z")
  })
})

// choreography-facade.CHOREOGRAPHY_API.4
// scheduleAt creates scheduled_work intent and does NOT block the current
// run, so it cannot produce a ChoreographySuspension. The
// ChoreographyOperation union must reject "schedule_at".
describe("choreography-facade.CHOREOGRAPHY_API.4 — scheduleAt is non-blocking; schedule_at is not a ChoreographySuspension operation", () => {
  it("ChoreographyOperation does not include \"schedule_at\"", () => {
    const allowed: ReadonlyArray<ChoreographyOperation> = [
      "sleep",
      "wait_for",
      "awakeable",
    ]
    expect(allowed).not.toContain("schedule_at" as ChoreographyOperation)
    // Type-level: assigning "schedule_at" to ChoreographyOperation is a
    // compile error. The expect-error directive on the next line documents
    // the constraint and will fail typecheck if "schedule_at" ever
    // re-enters the union.
    // @ts-expect-error "schedule_at" is not a valid ChoreographyOperation
    const _bad: ChoreographyOperation = "schedule_at"
    void _bad
  })
})

// choreography-facade.BOUNDARY.1
// choreography-facade.BOUNDARY.3
// The foundation export surface introduces no DurableChannel,
// CompletionChannel, workflow SDK, global registry, or broad error
// taxonomy beyond ChoreographyTimeout.
describe("choreography-facade.BOUNDARY.3 — no DurableChannel/CompletionChannel/workflow SDK/global registry/broad error taxonomy", () => {
  it("foundation exports do not include any banned vocabulary", () => {
    const banned = [
      "DurableChannel",
      "CompletionChannel",
      "Workflow",
      "WorkflowSDK",
      "globalMatcherRegistry",
      "MatcherRegistry",
      "registerMatcher",
      "Session",
      "Prompt",
      "Permission",
      "Provider",
      "Sandbox",
      "ToolCall",
      "Spawn",
      "Execute",
      "ScheduleMe",
      "ForkSession",
      "ForkWork",
    ]
    const found = banned.filter((b) => b in ChoreographySurface)
    expect(found).toEqual([])
  })
})

// choreography-facade.CURRENT_WORK_CONTEXT.1
// Smoke test that current-work-context composes with other layers without
// needing a special framework. This proves CURRENT_WORK_CONTEXT.1 end-to-
// end against ordinary Layer.merge.
describe("choreography-facade.CURRENT_WORK_CONTEXT.1 — composes with other choreography layers via ordinary Layer composition", () => {
  it("CurrentWorkContext and TriggerMatchers can be merged and consumed in one program", async () => {
    const program = Effect.gen(function* () {
      const ctx = yield* CurrentWorkContext
      const svc = yield* TriggerMatchers
      const m = yield* svc.lookup("fixture.compose")
      const out = yield* m({
        _tag: "ProjectionMatch",
        label: ctx.workId,
        projectionKey: "k",
        matcherId: "fixture.compose",
      })
      return { workId: ctx.workId, out }
    })

    const composed = Layer.mergeAll(
      currentWorkContextLayer({
        workId: WorkId("run-compose"),
        ownerId: OwnerId("owner-compose"),
      }),
      triggerMatchersLayer({
        "fixture.compose": (_t) =>
          Effect.succeed({ kind: "match", value: "v" } as const),
      }),
    )

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(composed)),
    )
    expect(result.workId).toBe("run-compose")
    expect(result.out).toStrictEqual({ kind: "match", value: "v" })
  })
})
