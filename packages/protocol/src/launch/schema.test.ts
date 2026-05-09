import { Either, Schema } from "effect"
import { describe, expect, it } from "vitest"
import {
  local,
  normalizeRuntimeIntent,
  PublicLaunchRequestSchema,
  runtimeContextStateSchema,
  RuntimeJournalEventSchema,
  type RuntimeContext,
} from "./index.ts"

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
})
