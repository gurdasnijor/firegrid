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

/**
 * Test harness for DurableTable tests. Owns the upstream Durable Streams
 * test server lifecycle and hands out fresh per-test URLs. DurableTable
 * tests bind the table to one of these URLs via `WorkflowTable.layer({
 * streamOptions: { url, ... } })`; the layer's acquisition handles backing
 * stream creation, so tests do not pre-create streams.
 */
export class TestStreamServer {
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

  /**
   * Produce a fresh, unique durable-stream URL backed by this server. Each
   * call yields a distinct path so tests do not collide across files.
   */
  url(name: string): string {
    if (this.baseUrl === undefined) throw new Error("server not started")
    return `${this.baseUrl}/v1/stream/${name}-${crypto.randomUUID()}`
  }
}
