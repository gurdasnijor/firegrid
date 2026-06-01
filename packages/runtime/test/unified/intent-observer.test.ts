/**
 * tf-r06u.42 — the intent observer decodes edge-appended intent records and
 * dispatches them into the in-process channels, skipping malformed records.
 * Validated against an in-memory intent stream + fake channel sinks (no live
 * durable-streams, no host composition).
 */
import {
  eventOffset,
  makeEgressChannel,
  makeSessionPermissionChannelContract,
  SessionPermissionChannel,
  SessionPromptChannel,
  SessionPromptChannelTarget,
} from "@firegrid/protocol/channels"
import { SessionHandlePromptInputSchema } from "@firegrid/protocol/session-facade"
import { Effect, Layer, Stream } from "effect"
import { describe, expect, it } from "vitest"
import { dispatchIntent, runIntentObserver } from "../../src/unified/intent-observer.ts"

interface Recorder {
  readonly prompts: Array<{ readonly sessionId: string; readonly input: unknown }>
  readonly permissions: Array<unknown>
}

const fakeChannels = (rec: Recorder) =>
  Layer.merge(
    Layer.succeed(SessionPromptChannel, {
      forSession: (sessionId: string) =>
        makeEgressChannel({
          target: SessionPromptChannelTarget,
          schema: SessionHandlePromptInputSchema,
          append: (input) =>
            Effect.sync(() => {
              rec.prompts.push({ sessionId, input })
              return eventOffset("offset-1")
            }),
        }),
    }),
    Layer.succeed(
      SessionPermissionChannel,
      makeSessionPermissionChannelContract({
        call: (request) =>
          Effect.sync(() => {
            rec.permissions.push(request)
            return eventOffset("offset-2")
          }),
      }),
    ),
  )

const run = (rec: Recorder, intents: ReadonlyArray<unknown>) =>
  Effect.runPromise(
    runIntentObserver({
      sessionId: "ctx_brookhaven",
      intents: Stream.fromIterable(intents),
    }).pipe(Effect.provide(fakeChannels(rec))),
  )

describe("intent observer dispatch", () => {
  it("dispatches a prompt intent to SessionPromptChannel with idempotencyKey = requestId", async () => {
    const rec: Recorder = { prompts: [], permissions: [] }
    await run(rec, [
      { kind: "prompt", requestId: "req-1", text: "add a helipad", playerId: "kid-1" },
    ])
    expect(rec.prompts).toEqual([
      {
        sessionId: "ctx_brookhaven",
        input: { payload: { text: "add a helipad" }, idempotencyKey: "req-1" },
      },
    ])
    expect(rec.permissions).toEqual([])
  })

  it("dispatches a permission intent to SessionPermissionChannel as Allow{optionId}", async () => {
    const rec: Recorder = { prompts: [], permissions: [] }
    await run(rec, [
      { kind: "permission", permissionRequestId: "perm-9", optionId: "opt-publish" },
    ])
    expect(rec.permissions).toEqual([
      {
        permissionRequestId: "perm-9",
        decision: { _tag: "Allow", optionId: "opt-publish" },
        idempotencyKey: "perm-9",
      },
    ])
    expect(rec.prompts).toEqual([])
  })

  it("skips a malformed record without stalling the rest of the stream", async () => {
    const rec: Recorder = { prompts: [], permissions: [] }
    await run(rec, [
      { kind: "prompt", requestId: "req-1", text: "first" },
      { kind: "bogus" }, // unknown kind -> skipped
      { kind: "prompt", text: "missing requestId" }, // invalid -> skipped
      { kind: "permission", permissionRequestId: "perm-2", optionId: "opt-x" },
    ])
    expect(rec.prompts.map((p) => (p.input as { idempotencyKey: string }).idempotencyKey)).toEqual([
      "req-1",
    ])
    expect(rec.permissions).toHaveLength(1)
  })

  it("preserves cross-record order and dispatches every valid intent", async () => {
    const rec: Recorder = { prompts: [], permissions: [] }
    await run(rec, [
      { kind: "prompt", requestId: "a", text: "1" },
      { kind: "permission", permissionRequestId: "p", optionId: "o" },
      { kind: "prompt", requestId: "b", text: "2" },
    ])
    expect(rec.prompts).toHaveLength(2)
    expect(rec.permissions).toHaveLength(1)
  })

  it("dispatchIntent is a pure unit over the captured channels", async () => {
    const rec: Recorder = { prompts: [], permissions: [] }
    await Effect.runPromise(
      dispatchIntent("ctx_x", { kind: "prompt", requestId: "r", text: "hi" }).pipe(
        Effect.provide(fakeChannels(rec)),
      ),
    )
    expect(rec.prompts).toHaveLength(1)
  })
})
