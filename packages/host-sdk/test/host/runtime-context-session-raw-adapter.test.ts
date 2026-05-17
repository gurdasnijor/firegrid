import { Prompt } from "@effect/ai"
import {
  local,
  makeHostStreamPrefix,
  normalizeRuntimeIntent,
  type HostId,
  type RuntimeContext,
  type RuntimeEventRow,
  type RuntimeLogLineRow,
} from "@firegrid/protocol/launch"
import {
  RuntimeEnvResolverPolicy,
  SandboxProvider,
  SandboxStdinEmissionClaim,
  type ExecutionResult,
  type Sandbox,
  type SandboxCommand,
  SandboxProviderError,
} from "@firegrid/runtime/sources/sandbox"
import {
  Effect,
  Layer,
  Stream,
} from "effect"
import { describe, expect, it } from "vitest"
import {
  PerContextRuntimeOutputWriter,
} from "../../src/host/per-context-runtime-output.ts"
import {
  RawRuntimeContextWorkflowSessionLive,
} from "../../src/host/runtime-context-session/raw-adapter.ts"
import {
  RuntimeContextWorkflowSession,
  type RuntimeContextSessionCommand,
} from "../../src/host/runtime-context-workflow-core.ts"

const context = (
  contextId: string,
): RuntimeContext => ({
  contextId,
  createdAt: new Date().toISOString(),
  runtime: normalizeRuntimeIntent(local.jsonl({
    argv: ["node", "-e", "unused by fake provider"],
    agentProtocol: "raw",
  })),
  host: {
    hostId: "host-a" as HostId,
    streamPrefix: makeHostStreamPrefix({
      namespace: `raw-adapter-${contextId}`,
      hostId: "host-a" as HostId,
    }),
    boundAtMs: Date.now(),
  },
})

const promptCommand = (
  commandId: string,
  text: string,
): RuntimeContextSessionCommand => ({
  _tag: "AgentInput",
  commandId,
  event: {
    _tag: "Prompt",
    correlationId: commandId,
    prompt: Prompt.userMessage({
      content: [Prompt.textPart({ text })],
    }),
  },
})

const waitUntil = (
  predicate: () => boolean,
  label: string,
) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (predicate()) return
      yield* Effect.sleep("25 millis")
    }
    return yield* Effect.fail(new Error(`timed out waiting for ${label}`))
  })

const fakeSandbox = (id: string): Sandbox => ({
  id,
  provider: "fake",
  state: "running",
  labels: {},
  connectionInfo: {},
  metadata: {},
})

const fakeExecution: ExecutionResult = {
  exitCode: 0,
  stdout: "",
  stderr: "",
  truncated: false,
  timedOut: false,
}

const testLayer = (state: {
  readonly events: Array<RuntimeEventRow>
  readonly logs: Array<RuntimeLogLineRow>
  readonly streamStarts: Array<ReadonlyArray<string>>
  readonly emitted: Array<string>
}) =>
  RawRuntimeContextWorkflowSessionLive.pipe(
    Layer.provideMerge(Layer.succeed(
      PerContextRuntimeOutputWriter,
      PerContextRuntimeOutputWriter.of({
        appendAgentEvent: (runtimeContext, activityAttempt, sequence, event) =>
          Effect.sync(() => {
            const row: RuntimeEventRow = {
              eventId: {
                contextId: runtimeContext.contextId,
                activityAttempt,
                target: "events",
                sequence,
              },
              contextId: runtimeContext.contextId,
              activityAttempt,
              sequence,
              source: "stdout",
              format: "jsonl",
              receivedAt: new Date().toISOString(),
              raw: JSON.stringify(event),
            }
            state.events.push(row)
            return row
          }),
        appendEventRow: (_runtimeContext, row) =>
          Effect.sync(() => {
            state.events.push(row)
            return row
          }),
        appendLogLine: (_runtimeContext, row) =>
          Effect.sync(() => {
            state.logs.push(row)
            return row
          }),
      }),
    )),
    Layer.provideMerge(Layer.succeed(
      SandboxStdinEmissionClaim,
      SandboxStdinEmissionClaim.of({
        claim: command =>
          Effect.sync(() => {
            if (state.emitted.includes(command.commandId)) return false
            state.emitted.push(command.commandId)
            return true
          }),
      }),
    )),
    Layer.provideMerge(SandboxProvider.layer({
      name: "fake",
      capabilities: {
        persistent: false,
        snapshot: false,
        streaming: true,
        fileUpload: false,
        interactiveShell: false,
        gpu: false,
      },
      create: config => Effect.succeed(fakeSandbox(JSON.stringify(config.labels ?? {}))),
      getOrCreate: config => Effect.succeed(fakeSandbox(JSON.stringify(config.labels ?? {}))),
      find: () => Effect.succeed(undefined),
      execute: () => Effect.succeed(fakeExecution),
      executeMany: () => Effect.succeed([]),
      stream: (_sandbox, command: SandboxCommand) => {
        state.streamStarts.push(command.argv)
        const stdin = typeof command.stdin === "string"
          ? Stream.succeed(new TextEncoder().encode(command.stdin))
          : command.stdin ?? Stream.empty
        return stdin.pipe(
          Stream.mapError(cause =>
            new SandboxProviderError({
              provider: "fake",
              op: "stdin",
              message: "fake stdin stream failed",
              cause,
            })),
          Stream.map(bytes => ({
            type: "output" as const,
            channel: "stdout" as const,
            text: new TextDecoder().decode(bytes).trim(),
          })),
        )
      },
      openBytePipe: () =>
        Effect.fail({
          _tag: "SandboxProviderError",
          provider: "fake",
          op: "openBytePipe",
          message: "not used by raw adapter tests",
        } as never),
      upload: () => Effect.void,
      download: () => Effect.void,
      destroy: () => Effect.succeed(true),
    })),
    Layer.provideMerge(RuntimeEnvResolverPolicy.denyAll),
  )

describe("RawRuntimeContextWorkflowSessionLive", () => {
  it("keeps stdin Queue local to RawAdapter while preserving send ordering", async () => {
    const state = {
      events: [] as Array<RuntimeEventRow>,
      logs: [] as Array<RuntimeLogLineRow>,
      streamStarts: [] as Array<ReadonlyArray<string>>,
      emitted: [] as Array<string>,
    }
    const runtimeContext = context(`ctx_${crypto.randomUUID()}`)

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* RuntimeContextWorkflowSession
          yield* session.startOrAttach(runtimeContext, 1)
          yield* waitUntil(() => state.streamStarts.length === 1, "raw stream start")
          yield* session.startOrAttach(runtimeContext, 1)
          yield* session.send(runtimeContext, 1, promptCommand("input-1", "first"))
          yield* session.send(runtimeContext, 1, promptCommand("input-2", "second"))
          yield* waitUntil(() => state.events.length === 2, "raw stdout rows")
        }).pipe(Effect.provide(testLayer(state))),
      ),
    )

    expect(state.streamStarts).toHaveLength(1)
    expect(state.events.map(row => row.raw)).toEqual(["first", "second"])
  })

  it("uses the durable stdin claim so duplicate sends do not emit duplicate bytes", async () => {
    const state = {
      events: [] as Array<RuntimeEventRow>,
      logs: [] as Array<RuntimeLogLineRow>,
      streamStarts: [] as Array<ReadonlyArray<string>>,
      emitted: [] as Array<string>,
    }
    const runtimeContext = context(`ctx_${crypto.randomUUID()}`)
    const command = promptCommand("input-duplicate", "only once")

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* RuntimeContextWorkflowSession
          yield* session.startOrAttach(runtimeContext, 1)
          yield* waitUntil(() => state.streamStarts.length === 1, "raw stream start")
          yield* session.send(runtimeContext, 1, command)
          yield* session.send(runtimeContext, 1, command)
          yield* waitUntil(() => state.events.length === 1, "deduped raw stdout row")
        }).pipe(Effect.provide(testLayer(state))),
      ),
    )

    expect(state.emitted).toEqual(["input-duplicate"])
    expect(state.events.map(row => row.raw)).toEqual(["only once"])
  })

  it("lazily reattaches from send when the in-memory raw registry is empty", async () => {
    const state = {
      events: [] as Array<RuntimeEventRow>,
      logs: [] as Array<RuntimeLogLineRow>,
      streamStarts: [] as Array<ReadonlyArray<string>>,
      emitted: [] as Array<string>,
    }
    const runtimeContext = context(`ctx_${crypto.randomUUID()}`)

    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* RuntimeContextWorkflowSession
          const accepted = yield* session.send(
            runtimeContext,
            1,
            promptCommand("input-reattach", "from send"),
          )
          yield* waitUntil(() => state.events.length === 1, "reattached raw stdout row")
          return accepted
        }).pipe(Effect.provide(testLayer(state))),
      ),
    )

    expect(state.streamStarts).toHaveLength(1)
    expect(state.events.map(row => row.raw)).toEqual(["from send"])
  })
})
