import {
  FluentControlSurface,
  FluentRuntimeLive,
  FluentStore,
  makeFluentControlHttp,
} from "@firegrid/fluent-runtime"
import { Effect, Layer, Runtime } from "effect"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type {
  FirelabHost,
  FirelabHostEnv,
} from "../../types.ts"
import {
  agentName,
  discoveryPath,
  entityId,
  surfaceId,
} from "./scenario.ts"

const jsonHeaders = { "content-type": "application/json" }

const normalizeBaseUrl = (
  baseUrl: string,
): string => baseUrl.replace(/\/+$/u, "")

const readBody = (
  request: IncomingMessage,
): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const chunks: Array<Uint8Array> = []
    request.on("data", chunk => {
      if (typeof chunk === "string") {
        chunks.push(Buffer.from(chunk))
      } else if (chunk instanceof Uint8Array) {
        chunks.push(chunk)
      }
    })
    request.on("end", () => resolve(Buffer.concat(chunks)))
    request.on("error", reject)
  })

const writeNodeResponse = async (
  response: Response,
  outgoing: ServerResponse,
): Promise<void> => {
  outgoing.statusCode = response.status
  response.headers.forEach((value, key) => {
    outgoing.setHeader(key, value)
  })
  const body = Buffer.from(await response.arrayBuffer())
  outgoing.end(body)
}

const nodeRequestToFetch = async (
  request: IncomingMessage,
  baseUrl: string,
): Promise<Request> => {
  const method = request.method ?? "GET"
  const url = new URL(request.url ?? "/", baseUrl)
  const body = method === "GET" || method === "HEAD"
    ? undefined
    : await readBody(request)
  const headers = Object.fromEntries(
    Object.entries(request.headers).flatMap(([key, value]) => {
      if (value === undefined) return []
      return [[key, Array.isArray(value) ? value.join(",") : value]]
    }),
  )
  return new Request(url, {
    method,
    headers,
    ...(body === undefined ? {} : { body: new Uint8Array(body) }),
  })
}

const publishDiscovery = (
  env: FirelabHostEnv,
  controlBaseUrl: string,
): Effect.Effect<void, Error> =>
  Effect.tryPromise({
    try: async () => {
      const streamUrl = `${normalizeBaseUrl(env.durableStreamsBaseUrl)}/v1/stream/${
        discoveryPath(env.namespace)
      }`
      const create = await fetch(streamUrl, {
        method: "PUT",
        headers: jsonHeaders,
      })
      if (!create.ok && create.status !== 409) {
        throw new Error(`create discovery stream failed with ${create.status}: ${await create.text()}`)
      }
      const append = await fetch(streamUrl, {
        method: "POST",
        headers: jsonHeaders,
        body: JSON.stringify([{ surfaceId, baseUrl: controlBaseUrl }]),
      })
      if (!append.ok) {
        throw new Error(`append discovery stream failed with ${append.status}: ${await append.text()}`)
      }
    },
    catch: cause => cause instanceof Error ? cause : new Error(String(cause)),
  }).pipe(
    Effect.withSpan("firegrid.sim.fluent_control_surface_send_read.discovery.publish", {
      attributes: {
        "fluent_runtime.control_http.surface_id": surfaceId,
        "fluent_runtime.control_http.base_url": controlBaseUrl,
      },
    }),
  )

const startControlServer = (
  env: FirelabHostEnv,
) =>
  Effect.gen(function*() {
    const store = yield* FluentStore
    const control = yield* FluentControlSurface
    const http = makeFluentControlHttp(control)
    const runtime = yield* Effect.runtime<never>()

    yield* store.createSession({
      sessionId: entityId,
      agent: agentName,
    })

    const server = yield* Effect.acquireRelease(
      Effect.async<ReturnType<typeof createServer>, Error>((resume) => {
        const nodeServer = createServer((request, response) => {
          void (async () => {
            try {
              const address = nodeServer.address()
              const port = typeof address === "object" && address !== null ? address.port : 0
              const fetchRequest = await nodeRequestToFetch(request, `http://127.0.0.1:${port}`)
              const fetchResponse = await Runtime.runPromise(runtime)(http.handle(fetchRequest))
              await writeNodeResponse(fetchResponse, response)
            } catch (cause) {
              response.statusCode = 500
              response.setHeader("content-type", "application/json")
              response.end(JSON.stringify({ error: String(cause) }))
            }
          })()
        })
        nodeServer.listen(0, "127.0.0.1", () => {
          resume(Effect.succeed(nodeServer))
        })
        nodeServer.once("error", cause => {
          resume(Effect.fail(cause instanceof Error ? cause : new Error(String(cause))))
        })
      }),
      server => Effect.promise(() =>
        new Promise<void>((resolve, reject) => {
          server.close(error => {
            if (error) {
              reject(error)
            } else {
              resolve()
            }
          })
        }),
      ),
    )
    const address = server.address()
    if (typeof address !== "object" || address === null) {
      return yield* Effect.fail(new Error("control server did not bind to a TCP port"))
    }
    const baseUrl = `http://127.0.0.1:${address.port}`
    yield* publishDiscovery(env, baseUrl)
    yield* Effect.never
  }).pipe(
    Effect.withSpan("firegrid.sim.fluent_control_surface_send_read.host"),
  )

export const host = (
  env: FirelabHostEnv,
): Layer.Layer<FirelabHost, unknown> =>
  Layer.scopedDiscard(
    startControlServer(env).pipe(
      Effect.provide(FluentRuntimeLive({
        durableStreamsBaseUrl: env.durableStreamsBaseUrl,
        namespace: env.namespace,
      })),
    ),
  )
