import { DurableStream } from "@durable-streams/client"
import { createStateSchema } from "@durable-streams/state"
import { Duration, Effect, Layer, Schema, TestClock, TestContext } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  ChoreographyLive,
  ChoreographyTools,
  Choreography,
  OwnerId,
  WorkId,
  currentWorkContextLayer,
  triggerMatchersLayer,
  type ChoreographyTrigger,
  type TriggerMatcher,
} from "../choreography/index.ts"
import { EventPlane } from "../event-plane/index.ts"
import { SubstrateProducerLive, WorkProducer } from "../producer.ts"
import { rebuildProjection } from "../stream.ts"
import {
  runProjectionMatchSubscriber,
  runScheduledWorkSubscriber,
} from "../subscribers.ts"
import { DurableWaitsLive } from "../waits.ts"
import {
  freshStreamUrl,
  startTestServer,
  stopTestServer,
} from "./helpers.ts"

beforeAll(async () => {
  await startTestServer()
})

afterAll(async () => {
  await stopTestServer()
})

async function createSubstrateStream(label: string): Promise<string> {
  const url = freshStreamUrl(label)
  await DurableStream.create({ url, contentType: "application/json" })
  return url
}

const declareRun = (streamUrl: string, runId: string) =>
  Effect.gen(function* () {
    const wp = yield* WorkProducer
    return yield* wp.declareWork({ runId })
  }).pipe(Effect.provide(SubstrateProducerLive({ streamUrl })))

// =====================================================================
// COMMON_USAGE_EXAMPLES.1 + COMMON_USAGE_EXAMPLES.4
// Fake Firepixel-shaped "required-action / permission" event plane.
// The plane is caller-owned: substrate sees it as opaque event-plane
// rows, NOT as an ACP / Fireline / Firepixel substrate-native row family.
// =====================================================================

const RequiredActionRow = Schema.Struct({
  permissionId: Schema.String,
  status: Schema.Literal("requested", "resolved"),
  decision: Schema.optional(Schema.Literal("allow", "deny")),
  toolCallId: Schema.optional(Schema.String),
})
type RequiredActionRow = Schema.Schema.Type<typeof RequiredActionRow>

const buildRequiredActionPlane = () => {
  const state = createStateSchema({
    rows: {
      type: "example.required_action.permission",
      primaryKey: "permissionId",
      schema: Schema.standardSchemaV1(RequiredActionRow),
    },
  })
  return EventPlane.define({
    name: "example.required_action",
    state,
  })
}

// Helper: build a projection-match trigger pointing at the plane.
const permissionResolvedTrigger = (
  permissionId: string,
): ChoreographyTrigger => ({
  _tag: "ProjectionMatch",
  label: `permission-resolved:${permissionId}`,
  projectionKey: `example.required_action.permission:${permissionId}`,
  matcherId: "example.required_action.permission_resolved",
})

// choreography-facade.COMMON_USAGE_EXAMPLES.1
// choreography-facade.COMMON_USAGE_EXAMPLES.4
describe("choreography-facade.COMMON_USAGE_EXAMPLES.1 — fake ACP-permission-shaped event-plane example using waitFor", () => {
  it("Firepixel-shaped permission flow: emit requested → Choreography.waitFor blocks the run → emit resolved → projection-match subscriber resolves the completion → run is now ready-derivable", async () => {
    const url = await createSubstrateStream("examples-acp-permission")
    const runId = "run-permission-1"
    const permissionId = "perm-7"
    await Effect.runPromise(declareRun(url, runId))

    const plane = buildRequiredActionPlane()
    const planeLayer = EventPlane.layer(plane, { streamUrl: url })

    // Pre-emit the "requested" plane row through the plane producer
    // BEFORE blocking the run, mimicking an ACP adapter that observed
    // session/request_permission. This row is caller-owned vocabulary;
    // the substrate sees it as an opaque event-plane row.
    {
      const program = Effect.gen(function* () {
        const producer = yield* plane.Producer
        yield* producer.emit(
          plane.state.rows.insert({
            value: {
              permissionId,
              status: "requested",
              toolCallId: "tc-42",
            },
          }),
        )
      })
      await Effect.runPromise(
        program.pipe(Effect.provide(planeLayer)),
      )
    }

    // The TriggerMatchers entry only needs to satisfy the create-time
    // presence check; the matcher BODY is irrelevant for waitFor itself
    // (the projection-match subscriber's per-call evaluator does the
    // real matching at resolve time).
    const presenceMatcher: TriggerMatcher = () =>
      Effect.succeed({ kind: "no-match" } as const)

    // Run Choreography.waitFor; it will interrupt after the durable
    // completion + blocked run are committed. We capture the
    // completionId by reading the run's blockedOnCompletionId after the
    // interrupt resolves.
    const waitProgram = Effect.gen(function* () {
      const choreo = yield* Choreography
      yield* choreo.waitFor(
        permissionResolvedTrigger(permissionId),
        { timeout: Duration.minutes(10) },
      )
    })
    const choreoLayer = Layer.provideMerge(
      ChoreographyLive({ streamUrl: url }),
      Layer.mergeAll(
        DurableWaitsLive({ streamUrl: url }),
        triggerMatchersLayer({
          "example.required_action.permission_resolved": presenceMatcher,
        }),
        currentWorkContextLayer({
          workId: WorkId(runId),
          ownerId: OwnerId("owner-permission"),
        }),
      ),
    )
    await Effect.runPromiseExit(
      waitProgram.pipe(Effect.provide(choreoLayer)),
    )

    const blockedSnap = await rebuildProjection({ url })
    const blockedRun = blockedSnap.runs.get(runId)
    expect(blockedRun?.state).toBe("blocked")
    const completionId = blockedRun!.blockedOnCompletionId!
    const pending = blockedSnap.completions.get(completionId)
    expect(pending?.kind).toBe("projection_match")
    expect(pending?.state).toBe("pending")

    // Approval UI emits the "resolved" plane row.
    await Effect.runPromise(
      Effect.gen(function* () {
        const producer = yield* plane.Producer
        yield* producer.emit(
          plane.state.rows.upsert({
            value: {
              permissionId,
              status: "resolved",
              decision: "allow",
              toolCallId: "tc-42",
            },
          }),
        )
      }).pipe(Effect.provide(planeLayer)),
    )

    // Projection-match subscriber: per-call evaluator reads the plane
    // projection through ordinary read-side code (rebuildProjection
    // gives the substrate snapshot; for the plane snapshot we read raw
    // plane rows via the plane projection layer). For test simplicity
    // we read the plane state through a fresh DurableStream session.
    const evaluator: import("../subscribers.ts").ProjectionMatchEvaluator = (
      _substrateSnapshot,
      _trigger,
      _completion,
    ) =>
      Effect.gen(function* () {
        // Read the plane's resolved row directly from raw stream items.
        // (A live host would pull plane state from PlaneProjection; the
        // matcher for choreography-facade.COMMON_USAGE_EXAMPLES.1 only
        // needs to demonstrate that a caller-supplied evaluator can
        // resolve a projection-match completion against caller-owned
        // plane rows.)
        const handle = new DurableStream({
          url,
          contentType: "application/json",
        })
        const res = yield* Effect.tryPromise({
          try: () => handle.stream({ offset: "-1", live: false }),
          catch: (cause) => cause,
        })
        const items = (yield* Effect.tryPromise({
          try: () => res.json(),
          catch: (cause) => cause,
        })) as ReadonlyArray<{
          type?: string
          value?: RequiredActionRow
        }>
        const resolved = items.find(
          (it) =>
            it.type === "example.required_action.permission" &&
            it.value?.permissionId === permissionId &&
            it.value.status === "resolved",
        )
        if (resolved === undefined) {
          return { kind: "no-match" as const }
        }
        return {
          kind: "match" as const,
          value: { decision: resolved.value!.decision },
        }
      })

    const subscriberResult = await Effect.runPromise(
      runProjectionMatchSubscriber({ streamUrl: url, evaluate: evaluator }),
    )
    expect(subscriberResult.resolvedIds).toContain(completionId)

    // Final state: completion resolved, run is ready-derivable.
    const finalSnap = await rebuildProjection({ url })
    const completion = finalSnap.completions.get(completionId)
    expect(completion?.state).toBe("resolved")
    const result = completion?.result as { matchedValue: { decision: string } }
    expect(result.matchedValue.decision).toBe("allow")
    expect(finalSnap.runs.get(runId)?.state).toBe("blocked")
    // Ready-work derivation will pick up the run on the next scan
    // because state="blocked" and the awaited completion is now
    // "resolved" (ready-work-projection.READY_WORK_PROJECTION.*).
  })
})

// =====================================================================
// COMMON_USAGE_EXAMPLES.2 + COMMON_USAGE_EXAMPLES.4
// Delayed Firepixel-shaped self-prompt via Choreography.scheduleAt and
// the substrate scheduled-work subscriber. The substrate resolves "time
// reached"; live promptability is a runtime concern and is not modelled
// here (per docs/SDD_CHOREOGRAPHY_FACADE.md).
// =====================================================================

describe("choreography-facade.COMMON_USAGE_EXAMPLES.2 — delayed scheduled-work example using scheduleAt and the scheduled-work subscriber", () => {
  it("Firepixel-shaped delayed self-prompt: scheduleAt creates a scheduled_work completion → scheduled-work subscriber resolves it once the durable due time has elapsed → resolved completion preserves whenMs and the caller's input", async () => {
    const url = await createSubstrateStream("examples-delayed-prompt")

    // The caller-supplied input is Firepixel-shaped (a follow-up prompt),
    // not a generic email/payment placeholder.
    const followUpInput = {
      kind: "example.prompt.follow_up",
      promptText: "Continue investigating the deploy regression.",
      sessionId: "sess-42",
    }

    // Use a wall-clock-relative whenMs slightly in the past so the
    // subscriber sees it as eligible on first scan.
    const whenMs = Date.now() - 1000

    const program = Effect.gen(function* () {
      const choreo = yield* Choreography
      return yield* choreo.scheduleAt({ at: whenMs, input: followUpInput })
    })

    const minimalLayer = Layer.provideMerge(
      ChoreographyLive({ streamUrl: url }),
      DurableWaitsLive({ streamUrl: url }),
    )

    const result = await Effect.runPromise(
      program.pipe(Effect.provide(minimalLayer)),
    )
    expect(result.whenMs).toBe(whenMs)

    // Pre-subscriber state: scheduled_work pending.
    const preSnap = await rebuildProjection({ url })
    const pre = preSnap.completions.get(result.completionId)
    expect(pre?.kind).toBe("scheduled_work")
    expect(pre?.state).toBe("pending")
    const preData = pre?.data as { whenMs: number; input: typeof followUpInput }
    expect(preData.whenMs).toBe(whenMs)
    expect(preData.input).toStrictEqual(followUpInput)

    // Run the substrate's scheduled-work subscriber. It uses the
    // current Effect Clock (real wall clock here) and resolves the
    // completion since whenMs is in the past.
    const subscriberResult = await Effect.runPromise(
      runScheduledWorkSubscriber({ streamUrl: url }),
    )
    expect(subscriberResult.resolvedIds).toContain(result.completionId)

    // Resolved completion preserves whenMs and the caller's opaque input
    // (durable-subscribers.SCHEDULED_WORK_SUBSCRIBER.4).
    const postSnap = await rebuildProjection({ url })
    const post = postSnap.completions.get(result.completionId)
    expect(post?.state).toBe("resolved")
    const postResult = post?.result as {
      whenMs: number
      input: typeof followUpInput
    }
    expect(postResult.whenMs).toBe(whenMs)
    expect(postResult.input).toStrictEqual(followUpInput)
  })
})

// =====================================================================
// COMMON_USAGE_EXAMPLES.3 + COMMON_USAGE_EXAMPLES.4
// Tool-layer sleep proves identical durable lowering to the runtime API.
// Two sleep paths against two streams must produce indistinguishable
// durable.completion + durable.run shapes; the only difference is the
// presentation (interrupt vs ChoreographySuspension value).
// =====================================================================

describe("choreography-facade.COMMON_USAGE_EXAMPLES.3 — tool-layer sleep example proving identical durable lowering to the runtime API", () => {
  it("running Choreography.sleep and ChoreographyTools.sleep with the same durationMs against two parallel streams produces structurally identical timer completion + blocked run shapes", async () => {
    const urlRuntime = await createSubstrateStream("examples-sleep-runtime")
    const urlTool = await createSubstrateStream("examples-sleep-tool")
    const runRuntimeId = "run-sleep-runtime-1"
    const runToolId = "run-sleep-tool-1"
    await Effect.runPromise(declareRun(urlRuntime, runRuntimeId))
    await Effect.runPromise(declareRun(urlTool, runToolId))

    const durationMs = 1500

    // Runtime path: Choreography.sleep interrupts on success.
    const runtimeProgram = Effect.gen(function* () {
      const choreo = yield* Choreography
      yield* choreo.sleep(Duration.millis(durationMs))
    })
    const runtimeLayer = Layer.provideMerge(
      ChoreographyLive({ streamUrl: urlRuntime }),
      Layer.mergeAll(
        DurableWaitsLive({ streamUrl: urlRuntime }),
        triggerMatchersLayer({}),
        currentWorkContextLayer({
          workId: WorkId(runRuntimeId),
          ownerId: OwnerId("owner-sleep-runtime"),
        }),
      ),
    )
    await Effect.runPromiseExit(
      runtimeProgram.pipe(
        Effect.provide(runtimeLayer),
        // Pin the runtime sleep clock so dueAtMs is deterministic.
        Effect.provide(TestContext.TestContext),
        Effect.zipLeft(TestClock.setTime(0)),
      ),
    )

    // Tool path: ChoreographyTools.sleep returns a ChoreographySuspension.
    const tools = ChoreographyTools.make({ streamUrl: urlTool })
    const toolInput = Schema.decodeUnknownSync(tools.sleep.inputSchema)({
      durationMs,
    })
    const toolLayer = Layer.provideMerge(
      ChoreographyLive({ streamUrl: urlTool }),
      Layer.mergeAll(
        DurableWaitsLive({ streamUrl: urlTool }),
        triggerMatchersLayer({}),
        currentWorkContextLayer({
          workId: WorkId(runToolId),
          ownerId: OwnerId("owner-sleep-tool"),
        }),
      ),
    )
    const susp = await Effect.runPromise(
      tools.sleep.handle(toolInput).pipe(
        Effect.provide(toolLayer),
        Effect.provide(TestContext.TestContext),
        Effect.zipLeft(TestClock.setTime(0)),
      ),
    )

    // The presentations differ; the durable lowering must not.
    const runtimeSnap = await rebuildProjection({ url: urlRuntime })
    const toolSnap = await rebuildProjection({ url: urlTool })

    const runtimeRun = runtimeSnap.runs.get(runRuntimeId)
    const toolRun = toolSnap.runs.get(runToolId)
    expect(runtimeRun?.state).toBe("blocked")
    expect(toolRun?.state).toBe("blocked")

    const runtimeCompletion = runtimeSnap.completions.get(
      runtimeRun!.blockedOnCompletionId!,
    )
    const toolCompletion = toolSnap.completions.get(susp.completionId)
    expect(runtimeCompletion?.kind).toBe("timer")
    expect(toolCompletion?.kind).toBe("timer")
    expect(runtimeCompletion?.state).toBe("pending")
    expect(toolCompletion?.state).toBe("pending")

    // Same data fields on the timer completion: durationMs identical;
    // the field shape (durationMs + dueAtMs) is the same; dueAtMs may
    // differ across streams because of subtle timing, but with TestClock
    // pinned to 0 both should equal durationMs.
    const runtimeData = runtimeCompletion!.data as {
      durationMs: number
      dueAtMs: number
    }
    const toolData = toolCompletion!.data as {
      durationMs: number
      dueAtMs: number
    }
    expect(runtimeData.durationMs).toBe(durationMs)
    expect(toolData.durationMs).toBe(durationMs)
    expect(Object.keys(runtimeData).sort()).toEqual(Object.keys(toolData).sort())

    // Both runs are blocked on the timer completion id by `blockedOnCompletionId`.
    expect(runtimeRun!.blockedOnCompletionId).toBe(runtimeCompletion!.completionId)
    expect(toolRun!.blockedOnCompletionId).toBe(toolCompletion!.completionId)
  })
})

// =====================================================================
// choreography-facade.BOUNDARY.1
// Confirm that no ACP / Fireline / Firepixel / session / prompt /
// permission / provider / sandbox / tool-call / spawn / execute /
// schedule_me row family appears in the substrate's authoritative
// projection after running the examples above. Caller-owned plane rows
// (example.required_action.permission) exist on the stream but are
// NOT substrate-native: substrate's projection only covers
// durable.run / durable.completion / durable.claim.attempt.
// =====================================================================

describe("choreography-facade.BOUNDARY.1 — examples introduce no ACP/Fireline/Firepixel substrate-native row families", () => {
  it("substrate ProjectionSnapshot continues to contain only durable.run / durable.completion / durable.claim.attempt rows after the example flows run", async () => {
    const url = await createSubstrateStream("examples-boundary")
    const runId = "run-boundary-1"
    await Effect.runPromise(declareRun(url, runId))

    const plane = buildRequiredActionPlane()
    const planeLayer = EventPlane.layer(plane, { streamUrl: url })
    await Effect.runPromise(
      Effect.gen(function* () {
        const producer = yield* plane.Producer
        yield* producer.emit(
          plane.state.rows.insert({
            value: { permissionId: "p-x", status: "requested" },
          }),
        )
      }).pipe(Effect.provide(planeLayer)),
    )

    // Run a runtime sleep and a scheduleAt to populate substrate state.
    await Effect.runPromiseExit(
      Effect.gen(function* () {
        const choreo = yield* Choreography
        yield* choreo.scheduleAt({ at: Date.now() + 60_000, input: {} })
        yield* choreo.sleep(Duration.millis(1))
      }).pipe(
        Effect.provide(
          Layer.provideMerge(
            ChoreographyLive({ streamUrl: url }),
            Layer.mergeAll(
              DurableWaitsLive({ streamUrl: url }),
              triggerMatchersLayer({}),
              currentWorkContextLayer({
                workId: WorkId(runId),
                ownerId: OwnerId("owner-boundary"),
              }),
            ),
          ),
        ),
      ),
    )

    const snap = await rebuildProjection({ url })
    // Substrate ProjectionSnapshot exposes exactly three collections:
    // runs, completions, claimAttempts. There is no "permissions",
    // "sessions", "prompts", "spawns", "schedule_me", or other Firepixel
    // row family on the substrate snapshot.
    const snapKeys = Object.keys(snap).filter((k) => k !== "foldVersion").sort()
    expect(snapKeys).toEqual(["claimAttempts", "completions", "runs"])

    // The plane row we emitted exists on the raw stream but is invisible
    // to the substrate's authoritative projection.
    const handle = new DurableStream({ url, contentType: "application/json" })
    const items = (await (await handle.stream({
      offset: "-1",
      live: false,
    })).json()) as ReadonlyArray<{ type?: string }>
    const planeRows = items.filter(
      (it) => it.type === "example.required_action.permission",
    )
    expect(planeRows.length).toBeGreaterThan(0)
    // None of those caller-owned types ever entered the substrate snapshot.
    for (const it of items) {
      if (it.type === undefined) continue
      const isSubstrateAuthority =
        it.type === "durable.run" ||
        it.type === "durable.completion" ||
        it.type === "durable.claim.attempt" ||
        it.type === "durable.trace"
      const isCallerOwned =
        it.type === "example.required_action.permission"
      expect(isSubstrateAuthority || isCallerOwned).toBe(true)
    }
  })
})
