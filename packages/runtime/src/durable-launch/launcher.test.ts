import { DurableStream, stream as readStream } from "@durable-streams/client"
import { DurableStreamTestServer } from "@durable-streams/server"
import { NodeContext } from "@effect/platform-node"
import type { RuntimeLaunchRequest } from "@firegrid/protocol/launch"
import { Effect, Layer, Redacted } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  LocalProcessSandboxProviderLive,
} from "./execution/providers/local-process.ts"
import {
  ValTownSandboxProviderLive,
} from "./execution/providers/val-town.ts"
import {
  runLaunchOnce,
  RuntimeLaunchError,
} from "./launcher.ts"
import {
  SecretResolver,
} from "./resources/secrets.ts"
import {
  makeRuntimeLaunchStore,
  type RuntimeLaunchStore,
} from "./store.ts"

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

const withLaunchStore = async <A>(
  streamUrl: string,
  use: (store: RuntimeLaunchStore) => Promise<A>,
): Promise<A> => {
  const store = await Effect.runPromise(makeRuntimeLaunchStore({ streamUrl }))
  try {
    return await use(store)
  } finally {
    await Effect.runPromise(store.close)
  }
}

const valTownTracerSource = `
export default async function(request: Request): Promise<Response> {
  const payload = await request.json()
  const secretAvailable = (Deno.env.get("FIREGRID_TRACER_SECRET") ?? "").length > 0
  const row = {
    type: "flamecast.provider.ready",
    launchId: payload.launchId,
    sessionId: "fc_session_val_town_tracer",
    provider: "val-town-tracer",
    text: "hello from val town tracer",
    secretAvailable
  }
  if (typeof payload.providerWireStreamUrl === "string" && payload.providerWireStreamUrl.length > 0) {
    const response = await fetch(payload.providerWireStreamUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify([row])
    })
    if (!response.ok) {
      return new Response(await response.text(), { status: 502 })
    }
  }
  return Response.json({ ok: true, row })
}
`.trim()

describe("durable launch tracer bullet", () => {
  it("firegrid-durable-launch-runtime-operator.PLANES.1 firegrid-durable-launch-runtime-operator.PLANES.5 firegrid-durable-launch-runtime-operator.LAUNCH_OPERATOR.7 starts a local runtime with stream plane env bindings", async () => {
    const launchStreamUrl = await createStreamUrl("launch-control")
    const providerWireStreamUrl = await createStreamUrl("provider-wire")
    const childCode = `
const streamUrl = process.env.FLAMECAST_PROVIDER_WIRE_STREAM_URL
if (!streamUrl) throw new Error("missing provider wire stream")
const row = {
  type: "flamecast.provider.ready",
  launchId: process.env.FIREGRID_LAUNCH_ID,
  sessionId: "fc_session_tracer",
  provider: "flamecast-local-tracer",
  text: "hello from launched runtime",
  secretAvailable: process.env.ANTHROPIC_API_KEY === "tracer-secret-value"
}
const response = await fetch(streamUrl, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify([row])
})
if (!response.ok) {
  console.error(await response.text())
  process.exit(1)
}
`
    const launch: RuntimeLaunchRequest = {
      launchId: "launch:flamecast-tracer",
      requestedAt: new Date().toISOString(),
      target: {
        kind: "command",
        spec: {
          argv: [process.execPath, "--input-type=module", "-e", childCode],
          protocol: "stdio-json",
        },
        readiness: {
          stream: "provider-wire",
          rowType: "flamecast.provider.ready",
          predicateRef: "flamecast-tracer-ready-v1",
        },
        rebuild: {
          inputs: ["provider-wire"],
          strategy: "replay",
          entrypointRef: "flamecast-tracer-replay-v1",
        },
      },
      planes: {
        session: {
          "provider-wire": {
            kind: "stream",
            role: "events",
            streamUrl: providerWireStreamUrl,
          },
        },
        execution: {
          "agent-process": {
            kind: "local-process",
          },
        },
        resources: {
          workspace: {
            kind: "filesystem-mount",
            ref: "volume:tracer-workspace",
            mountPath: "/workspace",
          },
          anthropic: {
            kind: "secret",
            ref: "secret:anthropic-api-key",
          },
        },
      },
      bindings: [
        {
          kind: "env",
          name: "FLAMECAST_PROVIDER_WIRE_STREAM_URL",
          from: {
            plane: "session",
            name: "provider-wire",
            field: "streamUrl",
          },
        },
        {
          kind: "env-secret",
          name: "ANTHROPIC_API_KEY",
          from: {
            plane: "resources",
            name: "anthropic",
            field: "ref",
          },
        },
      ],
      restartPolicy: {
        mode: "never",
      },
    }

    await withLaunchStore(launchStreamUrl, async (store) => {
      await Effect.runPromise(store.appendLaunchRequest(launch))
    })

    const TestLayer = Layer.mergeAll(
      LocalProcessSandboxProviderLive,
      SecretResolver.layer({
        resolve: ref =>
          ref === "secret:anthropic-api-key"
            ? Effect.succeed(Redacted.make("tracer-secret-value"))
            : Effect.fail(new RuntimeLaunchError({
              op: "testSecretResolver",
              message: `unexpected secret ref ${ref}`,
            })),
      }),
      NodeContext.layer,
    )

    const result = await Effect.runPromise(
      Effect.scoped(
        runLaunchOnce({
          launchStreamUrl,
          launchId: launch.launchId,
        }).pipe(
          Effect.provide(TestLayer),
        ),
      ),
    )

    expect(result).toMatchObject({
      launchId: launch.launchId,
      exitCode: 0,
    })

    await withLaunchStore(launchStreamUrl, async (store) => {
      const statuses = store.runtimeProcessEvents()
        .filter(event => event.launchId === launch.launchId)
        .map(event => event.status)
      expect(statuses).toEqual(expect.arrayContaining(["started", "ready", "exited"]))
    })

    const providerWire = await readStream<Record<string, unknown>>({
      url: providerWireStreamUrl,
      live: false,
      json: true,
    })
    const rows = await providerWire.json()

    expect(rows).toContainEqual(expect.objectContaining({
      type: "flamecast.provider.ready",
      launchId: launch.launchId,
      sessionId: "fc_session_tracer",
      secretAvailable: true,
    }))
  })

  const valTownToken = process.env.VAL_TOWN_API_KEY ?? process.env.VAL_TOWN_API_TOKEN
  const remoteIt = process.env.FIREGRID_REMOTE_TRACER_PROVIDER === "val-town" &&
      valTownToken !== undefined
    ? it
    : it.skip

  remoteIt("firegrid-durable-launch-runtime-operator.REMOTE_TRACER.1 firegrid-durable-launch-runtime-operator.REMOTE_TRACER.4 deploys a Val Town tracer with remote env handoff", async () => {
    const token = Redacted.make(valTownToken ?? "")
    const launchStreamUrl = await createStreamUrl("val-town-launch-control")
    const launchId = `launch:val-town-tracer:${crypto.randomUUID()}`

    const launch: RuntimeLaunchRequest = {
      launchId,
      requestedAt: new Date().toISOString(),
      target: {
        kind: "command",
        spec: {
          argv: ["val-town-tracer"],
        },
      },
      planes: {
        session: {},
        execution: {
          "agent-process": {
            kind: "hosted-adapter",
            provider: "val-town",
          },
        },
        resources: {
          tracerSecret: {
            kind: "secret",
            ref: "secret:val-town-tracer-secret",
          },
        },
      },
      bindings: [
        {
          kind: "env-secret",
          name: "FIREGRID_TRACER_SECRET",
          from: {
            plane: "resources",
            name: "tracerSecret",
            field: "ref",
          },
        },
      ],
      restartPolicy: {
        mode: "never",
      },
    }

    await withLaunchStore(launchStreamUrl, async (store) => {
      await Effect.runPromise(store.appendLaunchRequest(launch))
    })

    const TestLayer = Layer.mergeAll(
      ValTownSandboxProviderLive({
        token,
        httpSource: valTownTracerSource,
      }),
      SecretResolver.layer({
        resolve: ref =>
          ref === "secret:val-town-tracer-secret"
            ? Effect.succeed(Redacted.make("remote-tracer-secret-value"))
            : Effect.fail(new RuntimeLaunchError({
              op: "testSecretResolver",
              message: `unexpected secret ref ${ref}`,
            })),
      }),
      NodeContext.layer,
    )

    const result = await Effect.runPromise(
      Effect.scoped(
        runLaunchOnce({ launchStreamUrl, launchId }).pipe(
          Effect.provide(TestLayer),
        ),
      ),
    )

    expect(result).toMatchObject({
      launchId,
      exitCode: 0,
    })

    const response = JSON.parse(result.stdout) as {
      readonly row?: Record<string, unknown>
    }

    expect(response.row).toMatchObject({
      type: "flamecast.provider.ready",
      launchId,
      sessionId: "fc_session_val_town_tracer",
      secretAvailable: true,
    })
  }, 30_000)
})
