/**
 * In-process `SandboxProvider` returning a `TransformStream`-backed
 * `AgentByteStream`. Lets `ProductionCodecAdapterLive.openBytePipe`
 * resolve against the FixtureAgent harness instead of spawning a
 * child process — same code path the production adapter uses with
 * `LocalProcessSandboxProvider`, only the underlying I/O changes.
 *
 * Queue model: callers arm a fixture via `registry.armNext(makeAgent)`
 * BEFORE `adapter.startOrAttach` runs. The next `openBytePipe` call
 * consumes the head of the queue, instantiates the agent on its
 * `acp.AgentSideConnection`, and returns the harness's byte stream.
 *
 * One fixture per context attempt. Scenarios that drive a single
 * agent call `armNext` once.
 */

import type * as acp from "@agentclientprotocol/sdk"
import {
  defaultCapabilities,
  type Sandbox,
  SandboxProvider,
  SandboxProviderError,
  type SandboxProviderService,
} from "@firegrid/runtime/sources/sandbox"
import { Deferred, Effect, Layer, Ref } from "effect"
import {
  type AcpFixtureHarness,
  makeAcpFixtureHarness,
  startFixtureAgent,
} from "./acp-fixture-agent.ts"

export interface ArmedFixture<A extends acp.Agent> {
  readonly harness: Effect.Effect<AcpFixtureHarness>
  readonly agent: Effect.Effect<A>
}

export interface AcpFixtureRegistry {
  /**
   * Push a fixture onto the queue. Returns a handle whose `harness`
   * and `agent` resolve when `openBytePipe` consumes the fixture.
   */
  readonly armNext: <A extends acp.Agent>(
    makeAgent: (connection: acp.AgentSideConnection) => A,
  ) => Effect.Effect<ArmedFixture<A>>
}

export interface AcpFakeSandboxProvider {
  readonly layer: Layer.Layer<SandboxProvider>
  readonly registry: AcpFixtureRegistry
}

interface PendingFixture {
  readonly makeAgent: (connection: acp.AgentSideConnection) => acp.Agent
  readonly harnessDeferred: Deferred.Deferred<AcpFixtureHarness>
  readonly agentDeferred: Deferred.Deferred<acp.Agent>
}

const fakeSandbox = (id: string): Sandbox => ({
  id,
  provider: "acp-fixture",
  state: "running",
  labels: {},
  connectionInfo: {},
  metadata: {},
})

const providerError = (op: string, message: string): SandboxProviderError =>
  new SandboxProviderError({
    provider: "acp-fixture",
    op,
    message,
  })

export const buildAcpFakeSandboxProvider = (): Effect.Effect<AcpFakeSandboxProvider> =>
  Effect.gen(function*() {
    const queue = yield* Ref.make<ReadonlyArray<PendingFixture>>([])
    const nextId = yield* Ref.make(0)

    const allocSandboxId = (): Effect.Effect<string> =>
      Ref.modify(nextId, (n) => [`acp-fixture-${n}`, n + 1])

    const dequeueFixture = (): Effect.Effect<PendingFixture | undefined> =>
      Ref.modify(queue, (q) => {
        if (q.length === 0) return [undefined, q]
        const [head, ...rest] = q
        return [head, rest]
      })

    const registry: AcpFixtureRegistry = {
      armNext: <A extends acp.Agent>(
        makeAgent: (connection: acp.AgentSideConnection) => A,
      ) =>
        Effect.gen(function*() {
          const harnessDeferred = yield* Deferred.make<AcpFixtureHarness>()
          const agentDeferred = yield* Deferred.make<acp.Agent>()
          yield* Ref.update(queue, (q) => [
            ...q,
            {
              makeAgent: makeAgent as (c: acp.AgentSideConnection) => acp.Agent,
              harnessDeferred,
              agentDeferred,
            } satisfies PendingFixture,
          ])
          return {
            harness: Deferred.await(harnessDeferred),
            agent: Deferred.await(agentDeferred).pipe(
              Effect.map((a) => a as A),
            ),
          } satisfies ArmedFixture<A>
        }),
    }

    const service: SandboxProviderService = {
      name: "acp-fixture",
      capabilities: { ...defaultCapabilities },
      create: () =>
        Effect.gen(function*() {
          const id = yield* allocSandboxId()
          return fakeSandbox(id)
        }),
      getOrCreate: () =>
        Effect.gen(function*() {
          const id = yield* allocSandboxId()
          return fakeSandbox(id)
        }),
      find: () => Effect.succeed(undefined),
      execute: (_sandbox, _command) =>
        Effect.fail(providerError("execute", "acp-fixture sandbox does not execute commands")),
      executeMany: (_sandbox, _commands) =>
        Effect.fail(providerError("executeMany", "acp-fixture sandbox does not execute commands")),
      stream: (_sandbox, _command) => {
        throw providerError("stream", "acp-fixture sandbox does not stream commands")
      },
      openBytePipe: (_sandbox, _command) =>
        Effect.gen(function*() {
          const fixture = yield* dequeueFixture()
          if (fixture === undefined) {
            return yield* Effect.fail(providerError(
              "openBytePipe",
              "no fixture armed — call registry.armNext before startOrAttach",
            ))
          }
          const harness = yield* makeAcpFixtureHarness
          const agent = startFixtureAgent(harness, fixture.makeAgent)
          yield* Deferred.succeed(fixture.harnessDeferred, harness)
          yield* Deferred.succeed(fixture.agentDeferred, agent)
          return harness.bytes
        }),
      upload: () => Effect.fail(providerError("upload", "unsupported")),
      download: () => Effect.fail(providerError("download", "unsupported")),
      destroy: () => Effect.succeed(true),
    }

    return {
      layer: Layer.succeed(SandboxProvider, service),
      registry,
    } satisfies AcpFakeSandboxProvider
  })
