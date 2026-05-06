import { execFileSync } from "node:child_process"
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import process from "node:process"

const repoRoot = resolve(import.meta.dirname, "..")
const tempRoot = mkdtempSync(join(tmpdir(), "firegrid-client-pack-"))
const packDir = join(tempRoot, "packs")
const consumerDir = join(tempRoot, "consumer")

const run = (command, args, cwd = repoRoot) => {
  execFileSync(command, args, {
    cwd,
    stdio: "inherit",
    env: { ...process.env, CI: "true" },
  })
}

const packedTarball = (nameFragment) => {
  const matches = readdirSync(packDir)
    .filter((file) => file.endsWith(".tgz") && file.includes(nameFragment))
    .sort()
  if (matches.length !== 1) {
    throw new Error(
      `Expected one ${nameFragment} tarball in ${packDir}, found ${matches.join(", ")}`,
    )
  }
  return join(packDir, matches[0])
}

const packedManifest = (tarball) =>
  JSON.parse(
    execFileSync("tar", ["-xOf", tarball, "package/package.json"], {
      encoding: "utf8",
    }),
  )

const assertNoWorkspaceDependencies = (manifest) => {
  const dependencies = manifest.dependencies ?? {}
  const workspaceDependencies = Object.entries(dependencies).filter(([, spec]) =>
    String(spec).startsWith("workspace:"),
  )
  if (workspaceDependencies.length > 0) {
    throw new Error(
      `Packed ${manifest.name} still has workspace dependencies: ${workspaceDependencies
        .map(([name, spec]) => `${name}@${spec}`)
        .join(", ")}`,
    )
  }
}

try {
  mkdirSync(packDir)
  mkdirSync(consumerDir)

  run("pnpm", ["--filter", "@firegrid/substrate", "run", "build"])
  run("pnpm", ["--filter", "@firegrid/client", "run", "build"])
  run("pnpm", [
    "--dir",
    "packages/substrate",
    "pack",
    "--pack-destination",
    packDir,
  ])
  run("pnpm", [
    "--dir",
    "packages/client",
    "pack",
    "--pack-destination",
    packDir,
  ])

  const substrateTarball = packedTarball("firegrid-substrate")
  const clientTarball = packedTarball("firegrid-client")
  const substrateManifest = packedManifest(substrateTarball)
  const clientManifest = packedManifest(clientTarball)
  assertNoWorkspaceDependencies(substrateManifest)
  assertNoWorkspaceDependencies(clientManifest)

  writeFileSync(
    join(consumerDir, "package.json"),
    `${JSON.stringify(
      {
        name: "firegrid-client-pack-smoke",
        private: true,
        type: "module",
        dependencies: {
          "@firegrid/client": `file:${clientTarball}`,
          "@firegrid/substrate": `file:${substrateTarball}`,
          effect: "^3.18.0",
        },
        pnpm: {
          overrides: {
            "@firegrid/substrate": `file:${substrateTarball}`,
          },
        },
        devDependencies: {
          typescript: "^5.9.3",
        },
      },
      null,
      2,
    )}\n`,
  )

  writeFileSync(
    join(consumerDir, "tsconfig.json"),
    `${JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "ESNext",
          moduleResolution: "Bundler",
          lib: ["ES2022", "DOM"],
          strict: true,
          skipLibCheck: true,
          noEmit: true,
        },
        include: ["index.ts"],
      },
      null,
      2,
    )}\n`,
  )

  writeFileSync(
    join(consumerDir, "index.ts"),
    `import { EventStream, FiregridClient, FiregridClientLive, Operation } from "@firegrid/client"
import { EventStreamClientLive } from "@firegrid/client/event-streams"
import { Effect, Schema, Stream } from "effect"

const Echo = Operation.define({
  name: "external.echo",
  input: Schema.Struct({
    message: Schema.String,
  }),
  output: Schema.Struct({
    message: Schema.String,
    length: Schema.Number,
  }),
})

const UiEvents = EventStream.define({
  name: "external.ui.events",
  event: Schema.Struct({
    type: Schema.Literal("clicked"),
    message: Schema.String,
  }),
})

const ClientLive = FiregridClientLive({
  streamUrl: "http://127.0.0.1:4437/v1/stream/firegrid",
  clientId: "external-pack-smoke",
})

const EventStreamLive = EventStreamClientLive({
  streamUrl: "http://127.0.0.1:4437/v1/stream/firegrid",
  clientId: "external-pack-smoke",
})

const program = Effect.gen(function* () {
  const client = yield* FiregridClient
  const handle = yield* client.send(Echo, { message: "hello" })
  yield* client.emit(UiEvents, { type: "clicked", message: "hello" })
  const output = yield* client.result(Echo, handle)
  yield* client.observe(Echo, handle).pipe(
    Stream.runForEach((state) => Effect.log(state)),
    Effect.fork,
  )
  yield* client.events(UiEvents).pipe(
    Stream.runForEach((event) => Effect.log(event)),
    Effect.fork,
  )
  return output.length
})

void program.pipe(Effect.provide(ClientLive))
void EventStreamLive
`,
  )

  // firegrid-package-migration.PACKAGE_DISTRIBUTION.1
  // firegrid-package-migration.PACKAGE_DISTRIBUTION.2
  // firegrid-package-migration.PACKAGE_DISTRIBUTION.3
  // firegrid-package-migration.PACKAGE_DISTRIBUTION.4
  // firegrid-package-migration.PACKAGE_DISTRIBUTION.5
  run("pnpm", ["install", "--lockfile=false"], consumerDir)
  run("pnpm", ["exec", "tsc", "--noEmit", "-p", "tsconfig.json"], consumerDir)
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}
