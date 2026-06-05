import { describe, expect, it } from "vitest"
import type {
  AgentAdapter,
  AgentConnection,
  ClientIntent,
  PreparedResume,
  SpawnOptions,
  StreamEnvelope,
} from "../src/Adapter.ts"
import { createBridge } from "../src/Bridge.ts"

// A FAKE adapter/connection — valid ONLY below the acceptance layer (unit
// tests). The real-agent E2E path must spawn a real native/ACP harness; a fake
// is never acceptance proof (fluent-agent-adapter-contract.feature).

interface FakeConnection extends AgentConnection {
  readonly fire: (raw: object) => void
  readonly fireExit: (code: number | null) => void
  readonly sent: Array<object>
}

const makeFakeConnection = (): FakeConnection => {
  let onMsg: ((raw: object) => void) | undefined
  let onExit: ((code: number | null) => void) | undefined
  const sent: Array<object> = []
  return {
    onMessage: (handler) => { onMsg = handler },
    send: (raw) => { sent.push(raw) },
    kill: () => {},
    on: (_event, handler) => { onExit = handler },
    fire: (raw) => onMsg?.(raw),
    fireExit: (code) => onExit?.(code),
    sent,
  }
}

interface FakeAdapterHandle {
  readonly adapter: AgentAdapter
  readonly spawnCalls: ReadonlyArray<SpawnOptions>
  readonly connection: () => FakeConnection
}

const makeFakeAdapter = (options?: {
  readonly prepareResume?: (history: ReadonlyArray<StreamEnvelope>) => PreparedResume
  readonly rejectResumeSpawn?: boolean
}): FakeAdapterHandle => {
  const spawnCalls: Array<SpawnOptions> = []
  let last: FakeConnection | undefined
  const adapter: AgentAdapter = {
    agentType: "codex",
    spawn: (spawnOptions) => {
      spawnCalls.push(spawnOptions)
      if (options?.rejectResumeSpawn === true && spawnOptions.resume !== undefined) {
        return Promise.reject(new Error("resume rejected"))
      }
      last = makeFakeConnection()
      return Promise.resolve(last)
    },
    parseDirection: (raw) => {
      const r = raw as { readonly kind?: string; readonly id?: string | number }
      if (r.kind === "request" && r.id !== undefined) return { type: "request", id: r.id }
      if (r.kind === "response" && r.id !== undefined) return { type: "response", id: r.id }
      return { type: "notification" }
    },
    isTurnComplete: (raw) => (raw as { readonly type?: string }).type === "turn_complete",
    translateClientIntent: (intent) => ({ native: intent }),
    prepareResume: (history) => Promise.resolve(options?.prepareResume?.(history) ?? {}),
  }
  return { adapter, spawnCalls, connection: () => last as FakeConnection }
}

const nativeIntent = (sent: object): ClientIntent => (sent as { readonly native: ClientIntent }).native
const lifecycleType = (raw: unknown): string | undefined =>
  (raw as { readonly type?: string }).type

describe("fluent agent bridge — non-invasive binding", () => {
  it("records raw harness output and emits session_started lifecycle", async () => {
    const records: Array<StreamEnvelope> = []
    const fake = makeFakeAdapter()
    const bridge = createBridge(fake.adapter, {
      recordEnvelope: (e) => records.push(e),
      spawnOptions: { cwd: "/w" },
    })
    await bridge.start()

    expect(records.some((e) => e.direction === "bridge" && lifecycleType(e.raw) === "session_started")).toBe(true)

    fake.connection().fire({ type: "assistant", text: "hi" })
    const agentEnvelope = records.find((e) => e.direction === "agent")
    expect(agentEnvelope).toBeDefined()
    expect((agentEnvelope?.raw as { readonly text?: string }).text).toBe("hi")
  })

  it("forwards the next prompt only after the native turn completes", async () => {
    const fake = makeFakeAdapter()
    const bridge = createBridge(fake.adapter, { recordEnvelope: () => {}, spawnOptions: { cwd: "/w" } })
    await bridge.start()
    const conn = fake.connection()

    bridge.prompt("first")
    bridge.prompt("second")
    expect(conn.sent.length).toBe(1)
    expect((nativeIntent(conn.sent[0]!) as { text: string }).text).toBe("first")

    conn.fire({ type: "turn_complete" })
    expect(conn.sent.length).toBe(2)
    expect((nativeIntent(conn.sent[1]!) as { text: string }).text).toBe("second")
  })

  it("records a session_ended lifecycle on harness exit (never silently dropped)", async () => {
    const records: Array<StreamEnvelope> = []
    const fake = makeFakeAdapter()
    const bridge = createBridge(fake.adapter, { recordEnvelope: (e) => records.push(e), spawnOptions: { cwd: "/w" } })
    await bridge.start()
    fake.connection().fireExit(0)
    expect(records.some((e) => e.direction === "bridge" && lifecycleType(e.raw) === "session_ended")).toBe(true)
  })

  it("interrupt synthesizes cancellations for all pending requests before the native interrupt", async () => {
    const records: Array<StreamEnvelope> = []
    const fake = makeFakeAdapter()
    const bridge = createBridge(fake.adapter, { recordEnvelope: (e) => records.push(e), spawnOptions: { cwd: "/w" } })
    await bridge.start()
    const conn = fake.connection()
    bridge.prompt("go")
    conn.fire({ kind: "request", id: "req-1" })
    conn.fire({ kind: "request", id: "req-2" })

    bridge.interrupt()

    const cancelIndexes = conn.sent
      .map((s, i) => ({ intent: nativeIntent(s), i }))
      .filter(({ intent }) => intent.type === "control_response" && intent.response.subtype === "cancelled")
      .map(({ i }) => i)
    const interruptIndex = conn.sent.findIndex((s) => nativeIntent(s).type === "interrupt")
    expect(cancelIndexes.length).toBe(2)
    expect(interruptIndex).toBeGreaterThan(Math.max(...cancelIndexes))
  })

  it("resumes natively: prepareResume → spawn with resumeId → replay unfinished prompts", async () => {
    const records: Array<StreamEnvelope> = []
    const history: ReadonlyArray<StreamEnvelope> = [
      { direction: "user", raw: { type: "user_message", text: "earlier" } }, // unfinished — no turn_complete after
    ]
    const fake = makeFakeAdapter({ prepareResume: () => ({ resumeId: "thread-42" }) })
    const bridge = createBridge(fake.adapter, {
      recordEnvelope: (e) => records.push(e),
      spawnOptions: { cwd: "/w" },
      history,
    })
    await bridge.start()

    expect(fake.spawnCalls[0]?.resume).toBe("thread-42")
    expect(records.some((e) => e.direction === "bridge" && lifecycleType(e.raw) === "session_resumed")).toBe(true)
    expect(
      fake.connection().sent.some((s) => {
        const intent = nativeIntent(s)
        return intent.type === "user_message" && intent.text === "earlier"
      }),
    ).toBe(true)
  })

  it("fresh-spawn fallback is allowed only when pending prompts can bridge", async () => {
    const recordsA: Array<StreamEnvelope> = []
    const fallbackBridge = createBridge(
      makeFakeAdapter({ prepareResume: () => ({ resumeId: "x" }), rejectResumeSpawn: true }).adapter,
      {
        recordEnvelope: (e) => recordsA.push(e),
        spawnOptions: { cwd: "/w" },
        history: [{ direction: "user", raw: { type: "user_message", text: "pending" } }],
      },
    )
    await fallbackBridge.start()
    expect(recordsA.some((e) => lifecycleType(e.raw) === "resume_fallback")).toBe(true)

    const noPendingBridge = createBridge(
      makeFakeAdapter({ prepareResume: () => ({ resumeId: "x" }), rejectResumeSpawn: true }).adapter,
      {
        recordEnvelope: () => {},
        spawnOptions: { cwd: "/w" },
        history: [
          { direction: "user", raw: { type: "user_message", text: "done" } },
          { direction: "agent", raw: { type: "turn_complete" } }, // closes the prompt → no pending
        ],
      },
    )
    await expect(noPendingBridge.start()).rejects.toThrow("resume rejected")
  })
})
