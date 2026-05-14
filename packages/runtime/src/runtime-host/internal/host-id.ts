// firegrid-host-context-authority.RUNTIME_CONTEXT_HOST_AUTHORITY.3
//
// Stable host identity acquisition for the runtime host.
//
// Resolution order:
//   1. options.hostId (test/override-friendly).
//   2. FIREGRID_HOST_ID env var (operator-configured).
//   3. `$HOME/.firegrid/host-id` file (auto-provisioned; created on
//      first read for unattended deployments).
//
// The fresh-id generation only fires when both the env var and the
// file are missing, and the generated id is immediately persisted so
// the next process boot sees the same value. This file lives under
// `runtime-host/internal/**` and is excluded from the semgrep
// `firegrid-no-random-durable-identity` rule because it owns the
// first-time-generation gate.

import { FileSystem, Path } from "@effect/platform"
import { homedir } from "node:os"
import { Config, Effect, Option } from "effect"
import type { HostId } from "@firegrid/protocol/launch"

const HOST_ID_FILE_BASENAME = "host-id"
const HOST_ID_DIR_BASENAME = ".firegrid"
const FIREGRID_HOST_ID_PREFIX = "firegrid-host-"

const generateStableHostId = (): HostId =>
  // crypto.randomUUID is the standard runtime entropy source for the
  // first-time stable id generation; this path is the only sanctioned
  // uuid call for host identity. It is excluded from the
  // `firegrid-no-random-durable-identity` guardrail by file path
  // (`runtime-host/internal/**`).
  `${FIREGRID_HOST_ID_PREFIX}${crypto.randomUUID()}` as HostId

const readHostIdFromFile = (filePath: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const exists = yield* fs.exists(filePath)
    if (!exists) return Option.none<HostId>()
    const contents = yield* fs.readFileString(filePath)
    const trimmed = contents.trim()
    if (trimmed.length === 0) return Option.none<HostId>()
    return Option.some(trimmed as HostId)
  })

const writeHostIdToFile = (filePath: string, hostId: HostId) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    yield* fs.makeDirectory(path.dirname(filePath), { recursive: true })
    yield* fs.writeFileString(filePath, hostId)
  })

const fileBackedHostId = Effect.gen(function* () {
  const path = yield* Path.Path
  const filePath = path.join(homedir(), HOST_ID_DIR_BASENAME, HOST_ID_FILE_BASENAME)
  const existing = yield* readHostIdFromFile(filePath)
  return yield* Option.match(existing, {
    onSome: Effect.succeed,
    onNone: () =>
      Effect.gen(function* () {
        const fresh = generateStableHostId()
        yield* writeHostIdToFile(filePath, fresh)
        return fresh
      }),
  })
})

/**
 * Acquire a stable host id from (in order): the supplied override, the
 * `FIREGRID_HOST_ID` env var, or the persistent
 * `$HOME/.firegrid/host-id` file (auto-provisioned).
 */
export const acquireStableHostId = (
  override: string | undefined,
): Effect.Effect<HostId, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    if (override !== undefined) return override as HostId
    const fromEnv = yield* Config.option(Config.string("FIREGRID_HOST_ID"))
    return yield* Option.match(fromEnv, {
      onSome: (value) => Effect.succeed(value as HostId),
      onNone: () => fileBackedHostId,
    })
  }).pipe(Effect.orDie)
