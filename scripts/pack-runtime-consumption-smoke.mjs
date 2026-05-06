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
const tempRoot = mkdtempSync(join(tmpdir(), "firegrid-runtime-pack-"))
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
  run("pnpm", ["--filter", "@firegrid/runtime", "run", "build"])
  run("pnpm", [
    "--dir",
    "packages/substrate",
    "pack",
    "--pack-destination",
    packDir,
  ])
  run("pnpm", [
    "--dir",
    "packages/runtime",
    "pack",
    "--pack-destination",
    packDir,
  ])

  const substrateTarball = packedTarball("firegrid-substrate")
  const runtimeTarball = packedTarball("firegrid-runtime")
  const substrateManifest = packedManifest(substrateTarball)
  const runtimeManifest = packedManifest(runtimeTarball)
  assertNoWorkspaceDependencies(substrateManifest)
  assertNoWorkspaceDependencies(runtimeManifest)
  if (runtimeManifest.bin?.firegrid !== "./dist/bin/firegrid.js") {
    throw new Error("Packed @firegrid/runtime does not expose the built firegrid binary")
  }

  writeFileSync(
    join(consumerDir, "package.json"),
    `${JSON.stringify(
      {
        name: "firegrid-runtime-pack-smoke",
        private: true,
        type: "module",
        dependencies: {
          "@durable-streams/state": "^0.2.5",
          "@firegrid/runtime": `file:${runtimeTarball}`,
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
          lib: ["ES2022"],
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
    `import { createStateSchema } from "@durable-streams/state"
import {
  Firegrid,
  run,
  type FiregridRunOptions,
  type FiregridRuntimeConnection,
} from "@firegrid/runtime"
import { EventPlane } from "@firegrid/substrate/event-plane"
import {
  EventStream,
  Operation,
  RunWait,
  triggerMatchersLayer,
} from "@firegrid/substrate"
import { Context, Effect, Layer, Schema, type Scope } from "effect"

const streamUrl = "http://127.0.0.1:4437/v1/stream/firegrid"

const Echo = Operation.define({
  name: "external.runtime.echo",
  input: Schema.Struct({
    message: Schema.String,
  }),
  output: Schema.Struct({
    message: Schema.String,
    length: Schema.Number,
  }),
})

const UiEvents = EventStream.define({
  name: "external.runtime.ui.events",
  event: Schema.Struct({
    message: Schema.String,
  }),
})

const PixelRow = Schema.Struct({
  id: Schema.String,
  color: Schema.String,
})

const PixelPlane = EventPlane.define({
  name: "external.pixel",
  state: createStateSchema({
    pixels: {
      type: "external.pixel.row",
      primaryKey: "id",
      schema: Schema.standardSchemaV1(PixelRow),
    },
  }),
})

class AppAdapter extends Context.Tag("external/AppAdapter")<
  AppAdapter,
  { readonly prefix: string }
>() {}

const AdapterLive = Layer.succeed(AppAdapter, { prefix: "pack" })

const HandlerLive = Firegrid.handler(Echo, (input) =>
  Effect.gen(function* () {
    const adapter = yield* AppAdapter
    const wait = yield* RunWait
    void wait
    return {
      message: \`\${adapter.prefix}:\${input.message}\`,
      length: input.message.length,
    }
  }),
)

const MaterializerLive = Firegrid.eventStream(UiEvents, (event) =>
  Effect.gen(function* () {
    const producer = yield* PixelPlane.Producer
    yield* producer.emit(
      PixelPlane.state.pixels.insert({
        value: { id: "pixel-1", color: event.message },
      }),
    )
  }),
)

const RuntimeLive = Firegrid.composeRuntime({
  handlers: [HandlerLive],
  subscribers: [
    Firegrid.subscribers.timer,
    Firegrid.subscribers.scheduledWork,
    Firegrid.subscribers.projectionMatch({
      evaluate: () => Effect.succeed({ kind: "no-match" as const }),
    }),
    MaterializerLive,
  ],
  provide: [
    AdapterLive,
    EventPlane.layer(PixelPlane, { streamUrl }),
    RunWait.layer({ streamUrl }),
    triggerMatchersLayer({
      "external.pixel.ready": () =>
        Effect.succeed({ kind: "no-match" as const }),
    }),
  ],
})

const connection: FiregridRuntimeConnection = { streamUrl }
const options: FiregridRunOptions<unknown, never> = {
  connection,
  runtime: RuntimeLive,
}

const program: Effect.Effect<never, unknown, Scope.Scope> = run(options)

// firegrid-package-migration.PACKAGE_DISTRIBUTION.6
// firegrid-package-migration.PACKAGE_DISTRIBUTION.7
// firegrid-package-migration.PACKAGE_DISTRIBUTION.8
void program
`,
  )

  run("pnpm", ["install", "--lockfile=false"], consumerDir)
  run("pnpm", ["exec", "tsc", "--noEmit", "-p", "tsconfig.json"], consumerDir)
} finally {
  rmSync(tempRoot, { recursive: true, force: true })
}
