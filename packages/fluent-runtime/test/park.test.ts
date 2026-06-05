import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import type { AgentAdapter } from "../src/Adapter.ts"
import { executePark, parkTransportFor, type ParkSuspensionRecord } from "../src/Park.ts"

// Fake adapter — valid only below the acceptance layer. The real-harness E2E (a
// real native/ACP harness actually ending its turn on the run-terminating
// result, then re-entering on wake) is creds-gated; see fluent-park-interface.feature.

const adapterWithPark = (): AgentAdapter => ({
  agentType: "codex",
  // spawn rejects: executePark must NOT drive the model loop while parking.
  spawn: () => Promise.reject(new Error("spawn must not be called during park")),
  parseDirection: () => ({ type: "notification" }),
  isTurnComplete: () => false,
  translateClientIntent: (intent) => ({ native: intent }),
  prepareResume: () => Promise.resolve({}),
  // mechanism (b): a native result the harness treats as ending the turn.
  runTerminatingToolResult: (toolCallId) => ({ type: "tool_result", toolCallId, endTurn: true }),
})

const adapterWithoutPark = (): AgentAdapter => ({
  agentType: "codex",
  spawn: () => Promise.reject(new Error("not used")),
  parseDirection: () => ({ type: "notification" }),
  isTurnComplete: () => false,
  translateClientIntent: (intent) => ({ native: intent }),
  prepareResume: () => Promise.resolve({}),
  // no runTerminatingToolResult — transport offers no end-of-turn.
})

describe("fluent park interface — transport end-of-turn (mechanism b)", () => {
  it("the parking tool ends the harness turn via a run-terminating result, recording the suspension first", () => {
    const log: Array<string> = []
    const sent: Array<object> = []
    const records: Array<ParkSuspensionRecord> = []
    const transport = parkTransportFor(adapterWithPark())
    expect(transport).toBeDefined()

    const outcome = Effect.runSync(executePark(
      {
        toolCallId: "call-1",
        reason: "wait_for github.pr.merged",
        waitIntent: { channel: "github.pr.merged", afterOffset: "7" },
      },
      {
        recordSuspension: (record) => Effect.sync(() => { log.push("record"); records.push(record) }),
        sendToolResult: (raw) => Effect.sync(() => { log.push("send"); sent.push(raw) }),
        endTurn: Effect.sync(() => { log.push("endTurn") }),
        transport: transport as NonNullable<typeof transport>,
      },
    ))

    // durable suspension recorded BEFORE the run-terminating result is returned,
    // then the turn ends over the transport
    expect(log).toEqual(["record", "send", "endTurn"])
    expect(records[0]).toMatchObject({
      type: "turn_parked",
      toolCallId: "call-1",
      waitIntent: { channel: "github.pr.merged", afterOffset: "7" },
    })
    // a run-terminating result was sent (mechanism b) — the harness ends the turn
    expect(sent[0]).toMatchObject({ endTurn: true, toolCallId: "call-1" })
    expect(outcome._tag).toBe("Parked")
  })

  it("records a durable suspension sufficient for native re-entry, without driving the model loop", () => {
    const records: Array<ParkSuspensionRecord> = []
    const transport = parkTransportFor(adapterWithPark())

    // The fake adapter's spawn rejects; executePark never calls it — Firegrid does
    // not own/re-drive the model loop while parking. (No throw ⇒ spawn untouched.)
    Effect.runSync(executePark(
      { toolCallId: "c2", reason: "approval", waitIntent: { channel: "approval:send" } },
      {
        recordSuspension: (record) => Effect.sync(() => { records.push(record) }),
        sendToolResult: () => Effect.void,
        endTurn: Effect.void,
        transport: transport as NonNullable<typeof transport>,
      },
    ))

    // the suspension carries what a wake needs to re-register + re-enter natively
    // (native re-entry itself is Bridge.start → Adapter.prepareResume, gated for a real harness)
    expect(records[0]).toEqual({
      type: "turn_parked",
      toolCallId: "c2",
      reason: "approval",
      waitIntent: { channel: "approval:send" },
    })
  })

  it("model-voluntary turn ending is not accepted: no run-terminating result ⇒ park cannot be proven", () => {
    const transport = parkTransportFor(adapterWithoutPark())
    // Mechanism (b) is unavailable, so there is no transport to drive executePark:
    // a turn could only end if the model voluntarily stopped (mechanism a), which
    // this interface rejects as proof of a durable park.
    expect(transport).toBeUndefined()
  })
})
