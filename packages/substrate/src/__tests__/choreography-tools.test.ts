import { DurableStream } from "@durable-streams/client"
import { Cause, Effect, Exit, Layer, Schema } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  ChoreographyLive,
  ChoreographyTools,
  OwnerId,
  WorkId,
  currentWorkContextLayer,
  triggerMatchersLayer,
  type ChoreographySuspension,
  type ChoreographyTrigger,
  type TriggerMatcher,
} from "../choreography/index.ts"
import { SubstrateProducerLive, WorkProducer } from "../producer.ts"
import { rebuildProjection } from "../stream.ts"
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

const matcherAccept: TriggerMatcher = () =>
  Effect.succeed({ kind: "match", value: "ok" } as const)

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

const fullLayer = (
  streamUrl: string,
  matchers: Record<string, TriggerMatcher>,
  ctx: { workId: string; ownerId: string },
) =>
  Layer.provideMerge(
    ChoreographyLive({ streamUrl }),
    Layer.mergeAll(
      DurableWaitsLive({ streamUrl }),
      triggerMatchersLayer(matchers),
      currentWorkContextLayer({
        workId: WorkId(ctx.workId),
        ownerId: OwnerId(ctx.ownerId),
      }),
    ),
  )

// choreography-facade.TOOL_BINDINGS.7
// The neutral binding harness exposes a tool name, an Effect Schema input
// schema, and an Effect handler. Every tool conforms to this shape.
describe("choreography-facade.TOOL_BINDINGS.7 — every neutral binding exposes name, inputSchema, and handle", () => {
  it("ChoreographyTools.make returns sleep, wait_for, schedule_me, and awaitable bindings each shaped { name, inputSchema, handle }", () => {
    const tools = ChoreographyTools.make({ streamUrl: "stub" })
    const entries = Object.entries(tools) as ReadonlyArray<
      [keyof typeof tools, (typeof tools)[keyof typeof tools]]
    >
    for (const [key, binding] of entries) {
      expect(typeof binding.name).toBe("string")
      expect(binding.name.length).toBeGreaterThan(0)
      expect(typeof binding.handle).toBe("function")
      expect(binding.inputSchema).toBeDefined()
      // Tool name matches its property key (substrate uses neutral names).
      expect(binding.name).toBe(key)
    }
  })
})

// choreography-facade.TOOL_BINDINGS.1
// ChoreographyTools.make exposes sleep, wait_for, schedule_me, and
// awaitable bindings; these tool names are NOT new substrate-native row
// families.
describe("choreography-facade.TOOL_BINDINGS.1 — ChoreographyTools exposes sleep / wait_for / schedule_me / awaitable", () => {
  it("the four expected tool names are present and no extras", () => {
    const tools = ChoreographyTools.make({ streamUrl: "stub" })
    const keys = Object.keys(tools).sort()
    expect(keys).toEqual(["awaitable", "schedule_me", "sleep", "wait_for"])
  })
})

// choreography-facade.TOOL_BINDINGS.2
// Agent tool bindings call the SAME choreography lowering used by runtime
// APIs. The sleep tool produces the same durable shape (timer completion +
// blocked run) as Choreography.sleep.
describe("choreography-facade.TOOL_BINDINGS.2 — sleep tool lowers to the same durable shape as runtime Choreography.sleep", () => {
  it("invoking the sleep tool decodes durationMs, blocks the run on a timer completion, and returns ChoreographySuspension { suspended:true, operation:'sleep', workId, completionId }", async () => {
    const url = await createSubstrateStream("tools-sleep")
    const runId = "run-tools-sleep-1"
    await Effect.runPromise(declareRun(url, runId))

    const tools = ChoreographyTools.make({ streamUrl: url })
    // Decode raw JSON-shaped input through the schema (TOOL_BINDINGS.3).
    const input = Schema.decodeUnknownSync(tools.sleep.inputSchema)({
      durationMs: 1500,
    })

    const susp: ChoreographySuspension = await Effect.runPromise(
      tools.sleep.handle(input).pipe(
        Effect.provide(
          fullLayer(url, {}, { workId: runId, ownerId: "owner-tools-sleep" }),
        ),
      ),
    )

    expect(susp.suspended).toBe(true)
    expect(susp.operation).toBe("sleep")
    expect(susp.workId).toBe(runId)
    expect(typeof susp.completionId).toBe("string")

    const snap = await rebuildProjection({ url })
    const run = snap.runs.get(runId)
    expect(run?.state).toBe("blocked")
    expect(run?.blockedOnCompletionId).toBe(susp.completionId)
    const completion = snap.completions.get(susp.completionId)
    expect(completion?.kind).toBe("timer")
    expect(completion?.state).toBe("pending")
    const data = completion?.data as { durationMs: number }
    expect(data.durationMs).toBe(1500)
  })
})

// choreography-facade.TOOL_BINDINGS.3
// Tool inputs are decoded via Effect Schema-derived schemas, not through
// hand-written parallel decoders. Decoding a malformed wait_for payload
// fails at the schema boundary.
describe("choreography-facade.TOOL_BINDINGS.3 — tool inputs are decoded with Effect Schema-derived schemas", () => {
  it("wait_for tool input decodes a typed ChoreographyTrigger and rejects malformed payloads at the schema boundary", () => {
    const tools = ChoreographyTools.make({ streamUrl: "stub" })

    // Valid payload decodes to the typed ChoreographyTrigger.
    const decoded = Schema.decodeUnknownSync(tools.wait_for.inputSchema)({
      trigger: {
        _tag: "ProjectionMatch",
        label: "session-terminal:r-1",
        projectionKey: "plane.session.byRequestId:r-1",
        matcherId: "fixture.session.terminal",
      },
      timeoutMs: 60_000,
    })
    expect(decoded.trigger._tag).toBe("ProjectionMatch")
    expect(decoded.timeoutMs).toBe(60_000)

    // Malformed (missing matcherId): decode throws.
    expect(() =>
      Schema.decodeUnknownSync(tools.wait_for.inputSchema)({
        trigger: {
          _tag: "ProjectionMatch",
          label: "x",
          projectionKey: "k",
        },
      }),
    ).toThrow()
  })
})

// choreography-facade.TOOL_BINDINGS.2
// wait_for tool lowers to the same projection_match completion shape as
// Choreography.waitFor.
describe("choreography-facade.TOOL_BINDINGS.2 — wait_for tool lowers to the same projection_match durable shape as runtime Choreography.waitFor", () => {
  it("wait_for tool writes a pending projection_match completion carrying the typed trigger description, blocks the run, and returns ChoreographySuspension", async () => {
    const url = await createSubstrateStream("tools-wait-for")
    const runId = "run-tools-wait-1"
    await Effect.runPromise(declareRun(url, runId))

    const tools = ChoreographyTools.make({ streamUrl: url })
    const trigger: ChoreographyTrigger = {
      _tag: "ProjectionMatch",
      label: "permission-resolved:p-1",
      projectionKey: "plane.permission.byId:p-1",
      matcherId: "fixture.permission.resolved",
    }
    const input = Schema.decodeUnknownSync(tools.wait_for.inputSchema)({
      trigger,
      timeoutMs: 5 * 60 * 1000,
    })

    const susp = await Effect.runPromise(
      tools.wait_for.handle(input).pipe(
        Effect.provide(
          fullLayer(
            url,
            { "fixture.permission.resolved": matcherAccept },
            { workId: runId, ownerId: "owner-tools-wait" },
          ),
        ),
      ),
    )

    expect(susp.operation).toBe("wait_for")
    expect(susp.workId).toBe(runId)

    const snap = await rebuildProjection({ url })
    const run = snap.runs.get(runId)
    expect(run?.state).toBe("blocked")
    expect(run?.blockedOnCompletionId).toBe(susp.completionId)
    const completion = snap.completions.get(susp.completionId)
    expect(completion?.kind).toBe("projection_match")
    expect(completion?.state).toBe("pending")
    const data = completion?.data as {
      trigger: { kind: string; description: ChoreographyTrigger }
    }
    expect(data.trigger.kind).toBe("projection_match")
    expect(data.trigger.description).toStrictEqual(trigger)
  })
})

// choreography-facade.TOOL_BINDINGS.5
// schedule_me lowers to substrate scheduleAt (not a substrate-native
// schedule_me row family). It does NOT block the current run and returns
// the substrate ScheduleAtResult; it does NOT return ChoreographySuspension.
describe("choreography-facade.TOOL_BINDINGS.5 — schedule_me lowers to the substrate scheduleAt operation and does not block the current run", () => {
  it("schedule_me writes a pending scheduled_work completion via Choreography.scheduleAt; current run remains state=started; result is ScheduleAtResult, not ChoreographySuspension", async () => {
    const url = await createSubstrateStream("tools-schedule-me")
    const runId = "run-tools-sched-1"
    await Effect.runPromise(declareRun(url, runId))

    const tools = ChoreographyTools.make({ streamUrl: url })
    const atMs = Date.now() + 60_000
    const input = Schema.decodeUnknownSync(tools.schedule_me.inputSchema)({
      atMs,
      input: { reason: "follow-up" },
    })

    // schedule_me is non-suspending; even though we install a
    // CurrentWorkContext for completeness, the handle does not require
    // it. (See the next test for the no-context proof.)
    const result = await Effect.runPromise(
      tools.schedule_me.handle(input).pipe(
        Effect.provide(
          fullLayer(url, {}, { workId: runId, ownerId: "owner-tools-sched" }),
        ),
      ),
    )

    expect(result.whenMs).toBe(atMs)
    expect(typeof result.completionId).toBe("string")
    // Result shape is NOT a ChoreographySuspension: `suspended` is absent.
    expect((result as unknown as { suspended?: unknown }).suspended).toBeUndefined()

    const snap = await rebuildProjection({ url })
    const run = snap.runs.get(runId)
    expect(run?.state).toBe("started")
    expect(run?.blockedOnCompletionId).toBeUndefined()
    const completion = snap.completions.get(result.completionId)
    expect(completion?.kind).toBe("scheduled_work")
    expect(completion?.state).toBe("pending")
  })
})

// choreography-facade.TOOL_BINDINGS.5
// schedule_me must run without CurrentWorkContext or TriggerMatchers in
// scope, mirroring the runtime CHOREOGRAPHY_API.4 boundary.
describe("choreography-facade.TOOL_BINDINGS.5 — schedule_me runs without CurrentWorkContext and without TriggerMatchers", () => {
  it("schedule_me handle composes with ChoreographyLive + DurableWaitsLive only; no CurrentWorkContext / TriggerMatchers layers required", async () => {
    const url = await createSubstrateStream("tools-schedule-me-no-ctx")
    const tools = ChoreographyTools.make({ streamUrl: url })
    const atMs = Date.now() + 30_000
    const input = Schema.decodeUnknownSync(tools.schedule_me.inputSchema)({
      atMs,
      input: { kind: "noop" },
    })

    const minimalLayer = Layer.provideMerge(
      ChoreographyLive({ streamUrl: url }),
      DurableWaitsLive({ streamUrl: url }),
    )

    const result = await Effect.runPromise(
      tools.schedule_me.handle(input).pipe(Effect.provide(minimalLayer)),
    )
    expect(result.whenMs).toBe(atMs)
    const snap = await rebuildProjection({ url })
    expect(snap.completions.get(result.completionId)?.kind).toBe(
      "scheduled_work",
    )
  })
})

// choreography-facade.TOOL_BINDINGS.2
// awaitable tool lowers to the same work-scoped externally-resolved
// awakeable shape as runtime Choreography.awaitAwakeable.
describe("choreography-facade.TOOL_BINDINGS.2 — awaitable tool lowers to the same work-scoped awakeable shape as runtime Choreography.awaitAwakeable", () => {
  it("awaitable tool blocks the run on awk:work:<runId>:<name> and returns ChoreographySuspension", async () => {
    const url = await createSubstrateStream("tools-awaitable")
    const runId = "run-tools-awk-1"
    await Effect.runPromise(declareRun(url, runId))

    const tools = ChoreographyTools.make({ streamUrl: url })
    const input = Schema.decodeUnknownSync(tools.awaitable.inputSchema)({
      name: "approval",
    })

    const susp = await Effect.runPromise(
      tools.awaitable.handle(input).pipe(
        Effect.provide(
          fullLayer(url, {}, { workId: runId, ownerId: "owner-tools-awk" }),
        ),
      ),
    )

    const expectedKey = `awk:work:${runId}:approval`
    expect(susp.operation).toBe("awakeable")
    expect(susp.workId).toBe(runId)
    expect(susp.completionId).toBe(expectedKey)

    const snap = await rebuildProjection({ url })
    expect(snap.runs.get(runId)?.blockedOnCompletionId).toBe(expectedKey)
    expect(snap.completions.get(expectedKey)?.kind).toBe(
      "externally_resolved_awakeable",
    )
  })
})

// choreography-facade.SUSPENSION.4
// wrapSuspending must NOT translate an interrupt into a successful
// ChoreographySuspension when the run was already blocked before the
// tool call. The pre-call retained-fold guard rejects non-"started"
// runs as defects so the harness only reports a suspension that this
// invocation actually drove (started → blocked transition).
describe("choreography-facade.SUSPENSION.4 — wrapSuspending refuses pre-existing blocked state and does not translate a later interrupt into a successful ChoreographySuspension", () => {
  it("a second sleep tool invocation under the same CurrentWorkContext fails as a defect when the run is already blocked from an earlier sleep tool call", async () => {
    const url = await createSubstrateStream("tools-pre-blocked")
    const runId = "run-tools-pre-blocked-1"
    await Effect.runPromise(declareRun(url, runId))

    const tools = ChoreographyTools.make({ streamUrl: url })
    const input = Schema.decodeUnknownSync(tools.sleep.inputSchema)({
      durationMs: 1,
    })
    const layer = fullLayer(url, {}, {
      workId: runId,
      ownerId: "owner-tools-pre-blocked",
    })

    // First sleep tool invocation: succeeds; run is now blocked.
    const first = await Effect.runPromise(
      tools.sleep.handle(input).pipe(Effect.provide(layer)),
    )
    expect(first.suspended).toBe(true)
    expect(first.operation).toBe("sleep")

    // Re-fetch a fresh snapshot to confirm the precondition.
    const midSnap = await rebuildProjection({ url })
    expect(midSnap.runs.get(runId)?.state).toBe("blocked")

    // Second invocation under the SAME CurrentWorkContext. The pre-call
    // guard observes state="blocked" and dies BEFORE the choreography
    // call would have run; no new ChoreographySuspension is returned.
    const exit = await Effect.runPromiseExit(
      tools.sleep.handle(input).pipe(Effect.provide(layer)),
    )
    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(Cause.isDie(exit.cause)).toBe(true)
      // Crucially: not interrupted-only, so a runtime that recovers from
      // interrupt would never see a misleading suspension result.
      expect(Cause.isInterruptedOnly(exit.cause)).toBe(false)
    }

    // The run is still blocked on the FIRST completion; no re-pointing.
    const finalSnap = await rebuildProjection({ url })
    const finalRun = finalSnap.runs.get(runId)
    expect(finalRun?.state).toBe("blocked")
    expect(finalRun?.blockedOnCompletionId).toBe(first.completionId)
  })
})

// choreography-facade.SUSPENSION.6
// choreography-facade.SUSPENSION.7
// Tool-binding presentation maps a verified suspension to a neutral
// ChoreographySuspension carrying suspended=true, operation, branded
// workId, and branded completionId.
describe("choreography-facade.SUSPENSION.6 — suspending tools return a neutral ChoreographySuspension carrying suspended=true + operation + branded workId + branded completionId", () => {
  it("the sleep tool's handle resolves with a value matching the ChoreographySuspension shape and does not surface an interrupt to the caller", async () => {
    const url = await createSubstrateStream("tools-suspension-shape")
    const runId = "run-tools-shape-1"
    await Effect.runPromise(declareRun(url, runId))

    const tools = ChoreographyTools.make({ streamUrl: url })
    const input = Schema.decodeUnknownSync(tools.sleep.inputSchema)({
      durationMs: 1,
    })

    const susp = await Effect.runPromise(
      tools.sleep.handle(input).pipe(
        Effect.provide(
          fullLayer(url, {}, { workId: runId, ownerId: "owner-tools-shape" }),
        ),
      ),
    )

    expect(Object.keys(susp).sort()).toEqual([
      "completionId",
      "operation",
      "suspended",
      "workId",
    ])
    expect(susp.suspended).toBe(true)
    expect(["sleep", "wait_for", "awakeable"]).toContain(susp.operation)
    expect(typeof susp.workId).toBe("string")
    expect(typeof susp.completionId).toBe("string")
  })
})

// choreography-facade.TOOL_BINDINGS.4
// Tool input/output shapes do NOT expose raw completions, raw runs,
// claims, stream URLs, or DSS envelopes to the agent. The schemas are
// the public surface; surface them and look for banned vocabulary.
describe("choreography-facade.TOOL_BINDINGS.4 — tool inputs and outputs do not expose raw completions, runs, claims, stream URLs, or DSS envelopes", () => {
  it("input schema fields contain no banned identifier names", () => {
    const tools = ChoreographyTools.make({ streamUrl: "stub" })
    const banned = /completionId|claimId|runId|streamUrl|envelope|claimAttempt|projection|cursor/i
    // Decode a representative minimal value for each tool and inspect
    // the resulting object's keys at depth 1.
    const samples: ReadonlyArray<{ tool: string; keys: ReadonlyArray<string> }> = [
      {
        tool: "sleep",
        keys: Object.keys(
          Schema.decodeUnknownSync(tools.sleep.inputSchema)({ durationMs: 1 }),
        ),
      },
      {
        tool: "wait_for",
        keys: Object.keys(
          Schema.decodeUnknownSync(tools.wait_for.inputSchema)({
            trigger: {
              _tag: "ProjectionMatch",
              label: "x",
              projectionKey: "k",
              matcherId: "m",
            },
          }),
        ),
      },
      {
        tool: "schedule_me",
        keys: Object.keys(
          Schema.decodeUnknownSync(tools.schedule_me.inputSchema)({
            atMs: 0,
            input: {},
          }),
        ),
      },
      {
        tool: "awaitable",
        keys: Object.keys(
          Schema.decodeUnknownSync(tools.awaitable.inputSchema)({
            name: "n",
          }),
        ),
      },
    ]
    for (const s of samples) {
      for (const k of s.keys) {
        expect(`${s.tool}.${k}`).not.toMatch(banned)
      }
    }
  })
})

// choreography-facade.TOOL_BINDINGS.6
// Tool descriptors and wire result shapes remain adapter/profile owned;
// substrate ships only the neutral binding harness and neutral suspension
// result. The harness must NOT include adapter-specific descriptor fields
// (e.g. JSON-Schema, OpenAI/Anthropic/MCP-specific metadata).
describe("choreography-facade.TOOL_BINDINGS.6 — substrate exposes only a neutral { name, inputSchema, handle } binding; descriptor and wire-result shapes remain adapter-owned", () => {
  it("ChoreographyToolBinding properties contain only name, inputSchema, and handle — no jsonSchema/description/parameters/output adapter fields", () => {
    const tools = ChoreographyTools.make({ streamUrl: "stub" })
    const bindings = Object.values(tools) as ReadonlyArray<
      (typeof tools)[keyof typeof tools]
    >
    for (const binding of bindings) {
      const keys = Object.keys(binding).sort()
      expect(keys).toEqual(["handle", "inputSchema", "name"])
    }
  })
})

// choreography-facade.CurrentWorkContext indirection — pin that the tool
// handle for suspending operations correctly forwards CurrentWorkContext
// to the underlying choreography service. Two tool invocations under
// different CurrentWorkContext layers each block the matching run.
describe("choreography-facade.CURRENT_WORK_CONTEXT.1 — tool handles read workId from CurrentWorkContext just like the runtime API", () => {
  it("two sleep-tool invocations under different CurrentWorkContext layers each block their matching run", async () => {
    const url = await createSubstrateStream("tools-ctx")
    const runA = "run-tools-ctx-A"
    const runB = "run-tools-ctx-B"
    await Effect.runPromise(declareRun(url, runA))
    await Effect.runPromise(declareRun(url, runB))

    const tools = ChoreographyTools.make({ streamUrl: url })
    const input = Schema.decodeUnknownSync(tools.sleep.inputSchema)({
      durationMs: 1,
    })

    const runUnder = async (workId: string) => {
      return Effect.runPromise(
        tools.sleep
          .handle(input)
          .pipe(
            Effect.provide(
              fullLayer(url, {}, { workId, ownerId: `owner-${workId}` }),
            ),
          ),
      )
    }

    const suspA = await runUnder(runA)
    const suspB = await runUnder(runB)
    expect(suspA.workId).toBe(runA)
    expect(suspB.workId).toBe(runB)
    expect(suspA.completionId).not.toBe(suspB.completionId)
  })
})
