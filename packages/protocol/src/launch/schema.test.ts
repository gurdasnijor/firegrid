import { Either, Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  local,
  normalizeRuntimeIntent,
  PublicLaunchRequestSchema,
  runtimeContextStateSchema,
  RuntimeJournalEventSchema,
  compareRuntimeOutputOrder,
  isAfterRuntimeOutputCursor,
  type RuntimeContext,
  type RuntimeEvent,
} from "./index.ts"
import { sessionStateSchema } from "../session/index.ts"

describe("@firegrid/protocol launch schema", () => {
  it("firegrid-durable-launch-runtime-operator.LAUNCH_ROWS.1 firegrid-durable-launch-runtime-operator.LAUNCH_ROWS.7 encodes normalized runtime contexts as control-plane state rows", async () => {
    const context: RuntimeContext = {
      contextId: "ctx-1",
      createdAt: "2026-05-07T00:00:00.000Z",
      runtime: {
        provider: "local-process",
        config: {
          argv: ["node", "--version"],
        },
        journal: [
          { source: "stdout", format: "jsonl", target: "events" },
          { source: "stderr", format: "text-lines", target: "logs" },
        ],
      },
    }

    const row = runtimeContextStateSchema.contexts.upsert({
      value: context,
      headers: { txid: "ctx-1" },
    })

    expect(row.type).toEqual("firegrid.runtime.context")
  })

  it("firegrid-durable-launch-runtime-operator.LAUNCH_ROWS.6 rejects public launch requests with env or journal fields", () => {
    const decoded = Schema.decodeUnknownEither(PublicLaunchRequestSchema)({
      runtime: {
        provider: "local-process",
        config: {
          argv: ["node", "--version"],
          env: {
            ANTHROPIC_API_KEY: "must-not-persist",
          },
        },
        journal: [
          { source: "stdout", format: "jsonl", target: "events" },
          { source: "stderr", format: "text-lines", target: "logs" },
        ],
      },
    })

    expect(Either.isLeft(decoded)).toBe(true)
  })

  it("firegrid-durable-launch-runtime-operator.JOURNAL_ROWS.3 decodes runtime event rows without parsing provider JSON", () => {
    const event = Schema.decodeUnknownSync(RuntimeJournalEventSchema)({
      type: "firegrid.runtime.output.stdout",
      id: "event-1",
      at: "2026-05-07T00:00:00.000Z",
      event: {
        eventId: "event-1",
        contextId: "ctx-1",
        activityAttempt: 1,
        sequence: 0,
        source: "stdout",
        format: "jsonl",
        receivedAt: "2026-05-07T00:00:00.000Z",
        raw: "{\"type\":\"assistant\"}",
      },
    })

    expect(event).toMatchObject({
      type: "firegrid.runtime.output.stdout",
      event: {
        raw: "{\"type\":\"assistant\"}",
      },
    })
  })

  it("firegrid-durable-launch-runtime-operator.LAUNCH_ROWS.8 keeps local JSONL defaults out of public helper output until normalization", () => {
    const publicRuntime = local.jsonl({
      argv: ["node", "--version"],
    })
    expect("journal" in publicRuntime).toBe(false)

    const normalized = normalizeRuntimeIntent(publicRuntime)
    expect(normalized.journal).toContainEqual({
      source: "stdout",
      format: "jsonl",
      target: "events",
    })
  })

  it("durable-records-and-projections.RECORDS.3 orders runtime output by documented cursor", () => {
    const first: RuntimeEvent = {
      eventId: "event-1",
      contextId: "ctx-1",
      activityAttempt: 1,
      sequence: 0,
      source: "stdout",
      format: "jsonl",
      receivedAt: "2026-05-07T00:00:00.000Z",
      raw: "{}",
    }
    const second: RuntimeEvent = {
      ...first,
      eventId: "event-2",
      sequence: 1,
    }
    const retry: RuntimeEvent = {
      ...first,
      eventId: "event-3",
      activityAttempt: 2,
      sequence: 0,
    }

    expect([retry, second, first].sort(compareRuntimeOutputOrder)).toEqual([
      first,
      second,
      retry,
    ])
    expect(isAfterRuntimeOutputCursor(first, { activityAttempt: 1, sequence: 0 })).toBe(false)
    expect(isAfterRuntimeOutputCursor(second, { activityAttempt: 1, sequence: 0 })).toBe(true)
    expect(isAfterRuntimeOutputCursor(retry, { activityAttempt: 1, sequence: 99 })).toBe(true)
  })

  it("durable-records-and-projections.PROJECTIONS.5 encodes session projection rows as State Protocol changes", () => {
    const session = sessionStateSchema.sessions.upsert({
      value: {
        sessionId: "session_ctx_1",
        contextId: "ctx_1",
        status: "active",
      },
      headers: { txid: "session-txid" },
    })
    const message = sessionStateSchema.messages.upsert({
      value: {
        messageId: "msg_ctx_1_1_0",
        sessionId: "session_ctx_1",
        contextId: "ctx_1",
        role: "assistant",
        text: "pong",
        sourceRuntimeEventId: "event_ctx_1_1_0",
        createdAt: "2026-05-08T00:00:00.000Z",
      },
      headers: { txid: "message-txid" },
    })

    expect(session.type).toEqual("firegrid.session")
    expect(message.type).toEqual("firegrid.session.message")
  })
})
