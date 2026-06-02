// tf-0awo.26 — cross-attempt output-flush boundary reproduction.
//
// VALIDATION INSTRUMENT ONLY — NOT A PRODUCTION PATH. The public client surface
// pins `attempt = DEFAULT_ATTEMPT` (channel-bindings.ts:75), so #818/tf-0awo.20
// could not reach a second drain. Production has no trigger that bumps the
// attempt; this test reproduces the boundary the §12 cutover must clear by
// driving the REAL `ProductionCodecAdapterLive` through the exact sequence the
// workflow body issues across a retry — `startOrAttach(ctx,0)` → (drain 0
// writes attempt-0 rows) → `deregister(ctx)` → `startOrAttach(ctx,1)` → (drain
// 1 writes attempt-1 rows) — over a REAL spawned ACP agent and a REAL host-wide
// `RuntimeOutputTable` journal. No backdoor: the codec session, sandbox process
// and drain are production code; only the explicit attempt bump (which the
// channel router would supply) is supplied by the test.
//
// The source claim under test (codec-adapter.ts:497-502): `deregister` does
// `Scope.close(entry.scope)`, which interrupts AND awaits the forkScoped drain
// fiber before returning — so drain-0 stops appending before `startOrAttach(1)`
// builds drain-1, and the host-wide append order stays partitioned
// (all attempt-0 rows, then all attempt-1 rows): SEQUENCED, not concurrent.
//
// Evidence (the deliverable): a host-scoped observer records every
// `RuntimeOutputTable.events` row in arrival/append order; the test reports the
// (append_index, attempt, sequence) partition and asserts no attempt-0 row
// appends AFTER an attempt-1 row (interleave) — a failure here IS the finding.

import { IdGenerator, Prompt } from "@effect/ai"
import { NodeContext } from "@effect/platform-node"
import { DurableStreamTestServer } from "@durable-streams/server"
import { createRequire } from "node:module"
import path from "node:path"
import { Effect, Layer, Ref, Schema, Stream } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  HostIdSchema,
  makeHostStreamPrefix,
  makeRuntimeContext,
  RuntimeControlPlaneTable,
  RuntimeOutputTable,
  runtimeControlPlaneStreamUrl,
  runtimeOutputStreamUrl,
  type RuntimeContextIntent,
} from "@firegrid/protocol/launch"
import { ProductionCodecAdapterLive } from "../../src/unified/codec-adapter.ts"
import {
  RuntimeContextSessionAdapter,
  type SessionInputPayload,
} from "../../src/unified/adapter.ts"
import { FiregridRuntimeContextMcpBaseUrlLive } from "../../src/unified/mcp-host/runtime-context-mcp-base-url.ts"
import {
  CodecOutputJournalFromRuntimeOutputTableLive,
  ContextResolverFromControlPlaneTableLive,
} from "../../src/tables/codec-adapter-providers.ts"
import {
  LocalProcessSandboxProvider,
  RuntimeEnvResolverPolicy,
} from "../../src/sources/sandbox/index.ts"
import { AgentInputEventSchema } from "../../src/events/contract.ts"

const repoRoot = path.resolve(import.meta.dirname, "../../../..")
const requireFromTest = createRequire(import.meta.url)
const tsxCli = requireFromTest.resolve("tsx/cli")
const fakeAgent = path.join(
  repoRoot,
  "packages/tiny-firegrid/src/bin/fake-acp-agent-process.ts",
)

const encodeAgentInputEvent = Schema.encodeSync(AgentInputEventSchema)

const promptInput = (text: string, key: string): SessionInputPayload => ({
  kind: "prompt",
  payloadJson: JSON.stringify(
    encodeAgentInputEvent({
      _tag: "Prompt",
      prompt: Prompt.userMessage({ content: [Prompt.textPart({ text })] }),
      correlationId: key,
    }),
  ),
})

interface RecordedRow {
  readonly appendIndex: number
  readonly attempt: number
  readonly sequence: number
}

describe("tf-0awo.26 — cross-attempt output-flush boundary (validation instrument, not a production path)", () => {
  let server: DurableStreamTestServer
  let baseUrl: string

  beforeAll(async () => {
    server = new DurableStreamTestServer({ port: 0, host: "127.0.0.1" })
    baseUrl = await server.start()
  })

  afterAll(async () => {
    await server.stop()
  })

  it("deregister flushes the prior attempt's drain before the retry's first append (SEQUENCED, not interleaved)", async () => {
    const namespace = "crossattempt"
    const contextId = `ctx_crossattempt_${Date.now()}`
    const json = "application/json"

    const tables = Layer.merge(
      RuntimeControlPlaneTable.layer({
        streamOptions: {
          url: runtimeControlPlaneStreamUrl({ baseUrl, namespace }),
          contentType: json,
        },
      }),
      RuntimeOutputTable.layer({
        streamOptions: {
          url: runtimeOutputStreamUrl({ baseUrl, namespace }),
          contentType: json,
        },
      }),
    )

    // The REAL production adapter stack (mirrors host.ts defaultProductionAdapterLayer),
    // over the shared host-wide tables so the test can both seed the context row
    // and read the journal the drain writes.
    const env = ProductionCodecAdapterLive.pipe(
      Layer.provide(
        LocalProcessSandboxProvider.layer().pipe(Layer.provide(NodeContext.layer)),
      ),
      Layer.provide(
        Layer.succeed(IdGenerator.IdGenerator, IdGenerator.defaultIdGenerator),
      ),
      Layer.provide(ContextResolverFromControlPlaneTableLive),
      Layer.provide(CodecOutputJournalFromRuntimeOutputTableLive),
      Layer.provide(RuntimeEnvResolverPolicy.denyAll),
      Layer.provide(FiregridRuntimeContextMcpBaseUrlLive),
      Layer.provideMerge(tables),
    )

    const recorded = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function*() {
          const control = yield* RuntimeControlPlaneTable
          const output = yield* RuntimeOutputTable
          const adapter = yield* RuntimeContextSessionAdapter

          // Host-scoped observer: capture every row in host-wide append order
          // (the projection emits current + live changes in append order — the
          // exact read the §12 cutover relies on).
          const log = yield* Ref.make<ReadonlyArray<RecordedRow>>([])
          yield* output.events.rows().pipe(
            Stream.filter((row) => row.contextId === contextId),
            Stream.runForEach((row) =>
              Ref.update(log, (rows) => [
                ...rows,
                {
                  appendIndex: rows.length,
                  attempt: row.activityAttempt,
                  sequence: row.sequence,
                },
              ]),
            ),
            Effect.catchAllCause(() => Effect.void),
            Effect.forkScoped,
          )

          // Seed the context row the adapter resolves + spawns from. Real ACP
          // example agent as the spawn target; no env bindings (denyAll is fine).
          const hostId = yield* Schema.decode(HostIdSchema)("crossattempt-host")
          const intent: RuntimeContextIntent = {
            provider: "local-process",
            config: {
              argv: [process.execPath, tsxCli, fakeAgent],
              cwd: repoRoot,
              agent: "fake-acp-agent",
              agentProtocol: "acp",
            },
            journal: [],
          }
          yield* control.contexts.insertOrGet(
            makeRuntimeContext({
              contextId,
              createdAtMs: Date.now(),
              runtime: intent,
              host: {
                hostId,
                streamPrefix: makeHostStreamPrefix({ namespace, hostId }),
                boundAtMs: Date.now(),
              },
            }),
          )

          // ── ATTEMPT 0 ───────────────────────────────────────────────────
          yield* adapter.startOrAttach(contextId, 0)
          yield* adapter.send(contextId, 0, promptInput("attempt-0 turn", "ca-0"))
          // Let drain-0 land a (partial) burst, then hit the boundary while it
          // may still have an in-flight append — maximal interleave exposure.
          yield* Effect.sleep("500 millis")

          // ── BOUNDARY: deregister awaits the drain-0 fiber (claim under test) ─
          yield* adapter.deregister(contextId)

          // ── ATTEMPT 1 (fresh drain, fresh sequenceRef=0) ─────────────────
          yield* adapter.startOrAttach(contextId, 1)
          yield* adapter.send(contextId, 1, promptInput("attempt-1 turn", "ca-1"))
          yield* Effect.sleep("2500 millis")

          return yield* Ref.get(log)
        }).pipe(Effect.provide(env)),
      ),
    )

    // ── Report the evidence (the deliverable) ───────────────────────────────
    const table = recorded
      .map((r) => `  append=${r.appendIndex} attempt=${r.attempt} sequence=${r.sequence}`)
      .join("\n")
    const a0 = recorded.filter((r) => r.attempt === 0)
    const a1 = recorded.filter((r) => r.attempt === 1)
    const firstA1 = recorded.findIndex((r) => r.attempt === 1)
    const interleaved =
      firstA1 >= 0 && recorded.slice(firstA1).some((r) => r.attempt === 0)
    console.log(
      `\n[tf-0awo.26] host-wide append order (${recorded.length} rows; attempt0=${a0.length} attempt1=${a1.length}; interleaved=${interleaved}):\n${table}\n`,
    )

    // Reproduction must produce BOTH drains (else the boundary wasn't exercised).
    expect(a0.length, "attempt-0 produced no rows — boundary not exercised").toBeGreaterThan(0)
    expect(a1.length, "attempt-1 produced no rows — second drain not built").toBeGreaterThan(0)

    // THE CLAIM: no attempt-0 row appends after an attempt-1 row (SEQUENCED).
    // A failure here is the INTERLEAVE finding (=> tf-0awo.23 must re-establish
    // (attempt, sequence) ordering as a property of the read).
    expect(interleaved, "attempt-0 drain interleaved with attempt-1 drain in host-wide append order").toBe(false)

    // Each attempt's own sequence is contiguous from 0 under its single
    // sequenceRef (no duplicate; a gap would indicate a dropped/cut tail append).
    for (const group of [a0, a1]) {
      const seqs = group.map((r) => r.sequence)
      expect(seqs, "sequence not contiguous 0..n-1 for an attempt").toEqual(
        seqs.map((_, i) => i),
      )
    }
  }, 30_000)
})
