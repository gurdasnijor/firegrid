import { NodeContext } from "@effect/platform-node"
import {
  LocalProcessSandboxProvider,
  SandboxProvider,
} from "@firegrid/runtime/sources/sandbox"
import { Effect, Layer } from "effect"

interface SandboxCommandActivityInput {
  readonly sessionId: string
  readonly argv: ReadonlyArray<string>
}

const sandboxLive = LocalProcessSandboxProvider.layer().pipe(
  Layer.provide(NodeContext.layer),
)

// fluent-runtime-workbench.SUBSTRATE.3
export const executeSandboxCommandActivity = (
  input: SandboxCommandActivityInput,
) =>
  Effect.gen(function* () {
    const sandboxProvider = yield* SandboxProvider
    const sandbox = yield* sandboxProvider.getOrCreate({
      workingDir: process.cwd(),
      labels: {
        session: input.sessionId,
        kind: "fluent-workbench-local-process",
      },
    })
    return yield* sandboxProvider.execute(sandbox, {
      argv: input.argv,
      cwd: process.cwd(),
    })
  }).pipe(Effect.provide(sandboxLive))
