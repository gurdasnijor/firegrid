import { DurableStream } from "@durable-streams/client"
import { DurableStreamTestServer } from "@durable-streams/server"
import { Effect } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { makeFlamecastDb } from "../shared/db.ts"
import { processAcceptedAgentsWebhooks } from "./agent-webhooks.ts"

let server: DurableStreamTestServer | undefined

beforeEach(async () => {
  server = new DurableStreamTestServer({ port: 0, host: "127.0.0.1" })
  await server.start()
})

afterEach(async () => {
  await server?.stop()
  server = undefined
})

const createStreamUrl = async (name: string): Promise<string> => {
  if (!server) throw new Error("server not started")
  const streamUrl = `${server.url}/v1/stream/${name}-${crypto.randomUUID()}`
  await DurableStream.create({
    url: streamUrl,
    contentType: "application/json",
  })
  return streamUrl
}

describe("Flamecast Agents stream webhook workflow", () => {
  it("stream-webhook-workflows.LOCAL_RUNTIME.2 and stream-webhook-workflows.WORKFLOW_PROCESSING.3 processes a stream-ingested webhook through workflow activity once", async () => {
    const streamUrl = await createStreamUrl("flamecast-agent-webhook")
    const db = makeFlamecastDb(streamUrl)
    await db.preload()
    try {
      await db.actions.acceptAgentsWebhook({
        webhookId: "provider-event-1",
        sessionId: "session-1",
        turnId: "turn-1",
        ordinal: 1,
        userMessage: "Summarize the workflow pivot",
        assistantText: "The runtime now declares webhook work as workflows and activities.",
        summary: "Webhook processed through workflow.",
      }).isPersisted.promise
      await db.actions.acceptAgentsWebhook({
        webhookId: "provider-event-1",
        sessionId: "session-1",
        turnId: "turn-1",
        ordinal: 1,
        userMessage: "Summarize the workflow pivot",
        assistantText: "The runtime now declares webhook work as workflows and activities.",
        summary: "Webhook processed through workflow.",
      }).isPersisted.promise

      await Effect.runPromise(processAcceptedAgentsWebhooks(streamUrl, db))
      await Effect.runPromise(processAcceptedAgentsWebhooks(streamUrl, db))

      const webhook = db.collections.agentWebhooks.get("provider-event-1")
      const messages = Array.from(db.collections.messages.state.values())
      const session = db.collections.sessions.get("session-1")

      expect(webhook?.status).toBe("processed")
      expect(messages).toHaveLength(2)
      expect(messages.find((message) => message.role === "assistant")?.text)
        .toBe("The runtime now declares webhook work as workflows and activities.")
      expect(session?.status).toBe("complete")
      expect(session?.turnCount).toBe(1)
    } finally {
      db.close()
    }
  })
})
