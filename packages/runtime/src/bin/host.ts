/**
 * Runtime-owned Firegrid host process entrypoint.
 *
 * firegrid-runtime-process.BINARIES.10
 * firegrid-runtime-process.BINARIES.11
 * firegrid-runtime-process.BINARIES.12
 * firegrid-runtime-process.EFFECT_PLATFORM.1
 * firegrid-runtime-process.EFFECT_PLATFORM.2
 * firegrid-runtime-process.CONFIG_SURFACE.1
 */

import { Console, Effect, Layer } from "effect"
import { pathToFileURL } from "node:url"
import { firegridNodeHost } from "../node.ts"
import { resolveNodeHostOptions } from "./_resolve.ts"
import { runFiregridBinMain } from "./_main.ts"

export interface HostCliOptions {
  readonly namespace?: string
  readonly cwd?: string
  readonly otelFile?: string
  readonly mcpPort?: number
}

export const hostProgramFromOptions = (
  options: HostCliOptions,
): Effect.Effect<void, unknown, never> =>
  Effect.gen(function*() {
    yield* Console.error("Firegrid host started")
    return yield* Layer.launch(
      firegridNodeHost(resolveNodeHostOptions({
        ...(options.namespace === undefined ? {} : { namespace: options.namespace }),
        ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
        ...(options.otelFile === undefined ? {} : { otelFile: options.otelFile }),
        ...(options.mcpPort === undefined ? {} : { mcpPort: options.mcpPort }),
      })),
    ).pipe(Effect.zipRight(Effect.never))
  }).pipe(Effect.scoped)

export const runFiregridHostMain = (): void => {
  runFiregridBinMain(hostProgramFromOptions({}))
}

const isDirectRun = process.argv[1] !== undefined
  && pathToFileURL(process.argv[1]).href === import.meta.url

if (isDirectRun) {
  runFiregridHostMain()
}
