import { DurableStreamTestServer } from "@durable-streams/server"
import { FetchHttpClient, type HttpClient } from "@effect/platform"
import { Effect, ManagedRuntime, type Scope } from "effect"

export const startBenchServer = async () => {
  const server = new DurableStreamTestServer({ port: 0, host: "127.0.0.1" })
  const url = await server.start()
  return {
    url,
    streamUrl: (name: string) => `${url}/v1/stream/${name}-${crypto.randomUUID()}`,
    stop: () => server.stop(),
  }
}

export const makeEffectRuntime = () => ManagedRuntime.make(FetchHttpClient.layer)

export type EffectRuntime = ReturnType<typeof makeEffectRuntime>

type EffectReq = HttpClient.HttpClient | Scope.Scope

export const runScoped = <A, E>(
  runtime: EffectRuntime,
  eff: Effect.Effect<A, E, EffectReq>,
): Promise<A> => runtime.runPromise(Effect.scoped(eff))
