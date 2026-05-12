import { DurableStreamTestServer } from "@durable-streams/server"
import { FetchHttpClient, type HttpClient } from "@effect/platform"
import { type Effect, type Scope } from "effect"
import * as EffectImpl from "effect/Effect"

type Reqs = FetchHttpClient.Fetch | HttpClient.HttpClient | Scope.Scope

export const runtime = <A, E>(eff: Effect.Effect<A, E, Reqs>) =>
  EffectImpl.runPromise(
    EffectImpl.scoped(
      eff.pipe(EffectImpl.provide(FetchHttpClient.layer)) as Effect.Effect<A, E, Scope.Scope>,
    ),
  )

export class TestStreamServer {
  // Encapsulates the upstream test server so individual tests don't have to
  // care about its lifecycle.
  private server?: DurableStreamTestServer
  baseUrl?: string

  async start(): Promise<string> {
    this.server = new DurableStreamTestServer({ port: 0, host: "127.0.0.1" })
    this.baseUrl = await this.server.start()
    return this.baseUrl
  }

  async stop(): Promise<void> {
    if (this.server !== undefined) await this.server.stop()
  }

  url(name: string): string {
    if (this.baseUrl === undefined) throw new Error("server not started")
    return `${this.baseUrl}/v1/stream/${name}-${crypto.randomUUID()}`
  }
}
