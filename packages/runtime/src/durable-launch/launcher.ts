import { stream as readStream } from "@durable-streams/client"
import type { CommandExecutor } from "@effect/platform/CommandExecutor"
import type { StreamPlaneRef } from "@firegrid/protocol/launch"
import type { RuntimeLaunchRequest } from "@firegrid/protocol/launch"
import type { Scope } from "effect"
import { Effect, Schema } from "effect"
import {
  getOrCreateSandbox,
  SandboxProvider,
  type SandboxProviderError,
} from "./execution/sandbox.ts"
import { envForLaunch, type SecretResolver } from "./resources/secrets.ts"
import {
  acquireRuntimeLaunchStore,
  type RuntimeLaunchStore,
  type RuntimeLaunchStoreError,
} from "./store.ts"

export class RuntimeLaunchError extends Schema.TaggedError<RuntimeLaunchError>()(
  "RuntimeLaunchError",
  {
    op: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

interface RunLaunchOnceOptions {
  readonly launchStreamUrl: string
  readonly launchId: string
  readonly attempt?: number
}

interface RunLaunchOnceResult {
  readonly launchId: string
  readonly processAttemptId: string
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

const nowIso = (): string => new Date().toISOString()

const eventId = (
  processAttemptId: string,
  status: string,
): string => `${processAttemptId}:${status}:${crypto.randomUUID()}`

const appendProcessEvent = (
  store: RuntimeLaunchStore,
  launch: RuntimeLaunchRequest,
  processAttemptId: string,
  attempt: number,
  status: "started" | "ready" | "exited" | "failed",
  extras: {
    readonly exitCode?: number
    readonly message?: string
  } = {},
): Effect.Effect<void, RuntimeLaunchStoreError> =>
  store.appendRuntimeProcessEvent({
    processEventId: eventId(processAttemptId, status),
    processAttemptId,
    launchId: launch.launchId,
    attempt,
    status,
    at: nowIso(),
    ...extras,
  })

const primaryCommand = (
  launch: RuntimeLaunchRequest,
): Effect.Effect<{ readonly argv: ReadonlyArray<string>; readonly cwd?: string }, RuntimeLaunchError> =>
  Effect.gen(function* () {
    const [command, ...args] = launch.target.spec.argv
    if (command === undefined) {
      return yield* new RuntimeLaunchError({
        op: "buildCommand",
        message: "launch target command argv is empty",
      })
    }
    return launch.target.spec.cwd === undefined ? {
      argv: [command, ...args],
    } : {
      argv: [command, ...args],
      cwd: launch.target.spec.cwd,
    }
  })

const sessionStream = (
  launch: RuntimeLaunchRequest,
  name: string,
): StreamPlaneRef | undefined => launch.planes.session[name]

const hasReadyRow = (
  launch: RuntimeLaunchRequest,
): Effect.Effect<boolean, RuntimeLaunchError> =>
  Effect.gen(function* () {
    const readiness = launch.target.readiness
    if (readiness === undefined) return true
    const plane = sessionStream(launch, readiness.stream)
    if (plane === undefined) {
      return yield* new RuntimeLaunchError({
        op: "readiness",
        message: `readiness stream not found: ${readiness.stream}`,
      })
    }
    const response = yield* Effect.tryPromise({
      try: () => readStream<Record<string, unknown>>({
        url: plane.streamUrl,
        live: false,
        json: true,
      }),
      catch: cause => new RuntimeLaunchError({
        op: "readiness.read",
        message: "failed to read readiness stream",
        cause,
      }),
    })
    const rows = yield* Effect.tryPromise({
      try: () => response.json<Record<string, unknown>>(),
      catch: cause => new RuntimeLaunchError({
        op: "readiness.json",
        message: "failed to decode readiness stream",
        cause,
      }),
    })
    return rows.some(row => row["type"] === readiness.rowType)
  })

export const runLaunchOnce = (
  options: RunLaunchOnceOptions,
): Effect.Effect<
  RunLaunchOnceResult,
  RuntimeLaunchError | RuntimeLaunchStoreError | SandboxProviderError,
  CommandExecutor | Scope.Scope | SecretResolver | SandboxProvider
> =>
  Effect.gen(function* () {
    const store = yield* acquireRuntimeLaunchStore({
      streamUrl: options.launchStreamUrl,
    })
    const launch = store.getLaunchRequest(options.launchId)
    if (launch === undefined) {
      return yield* new RuntimeLaunchError({
        op: "loadLaunch",
        message: `launch request not found: ${options.launchId}`,
      })
    }

    // firegrid-durable-launch-runtime-operator.LAUNCH_OPERATOR.7
    const attempt = options.attempt ?? 1
    const processAttemptId = `${launch.launchId}:attempt:${attempt}`
    yield* appendProcessEvent(store, launch, processAttemptId, attempt, "started")

    const provider = yield* SandboxProvider
    const env = yield* envForLaunch(launch)
    const sandbox = yield* getOrCreateSandbox(provider, {
      envVars: env as Record<string, string>,
      labels: { launchId: launch.launchId },
      workingDir: launch.target.spec.cwd,
      providerConfig: {
        launchId: launch.launchId,
        planes: launch.planes,
        providerWireStreamUrl: launch.planes.session["provider-wire"]?.streamUrl,
      },
    })
    const command = yield* primaryCommand(launch)
    const result = yield* provider.executeCommand(sandbox.id, {
      argv: [...command.argv],
      cwd: command.cwd,
    })
    const exitCode = result.exitCode

    const ready = yield* hasReadyRow(launch)
    if (ready) {
      yield* appendProcessEvent(store, launch, processAttemptId, attempt, "ready")
    }

    yield* appendProcessEvent(store, launch, processAttemptId, attempt, "exited", {
      exitCode,
    })
    yield* provider.destroySandbox(sandbox.id)

    return {
      launchId: launch.launchId,
      processAttemptId,
      exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
    }
  })
