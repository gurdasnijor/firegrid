import { DurableStream } from "@durable-streams/client"
import type { ChangeEvent } from "@durable-streams/state"
import { Effect, Either } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import * as substrate from "../index.ts"
import {
  CompletionNotFoundError,
  CompletionProducer,
  IllegalCompletionTransition,
  ProducerStreamError,
  SubstrateProducerLive,
  WorkProducer,
} from "../producer.ts"
import { substrateState } from "../state-schema.ts"
import { rebuildProjection } from "../stream.ts"
import { freshStreamUrl, startTestServer, stopTestServer } from "./helpers.ts"

beforeAll(async () => {
  await startTestServer()
})

afterAll(async () => {
  await stopTestServer()
})

// Test fixture: create the underlying Durable Stream so the producer
// layer can append to it. Returns the URL.
// Optional `seed` pre-appends fixture rows (allowed only for seeding a
// pending completion before terminalization tests, per
// semantic-producer.PACKAGE_BOUNDARY.1).
async function createSubstrateStream(
  label: string,
  seed: ReadonlyArray<ChangeEvent> = [],
): Promise<string> {
  const url = freshStreamUrl(label)
  const stream = await DurableStream.create({ url, contentType: "application/json" })
  for (const event of seed) {
    await stream.append(JSON.stringify(event))
  }
  return url
}

const runProducer = <A, E>(
  layer: ReturnType<typeof SubstrateProducerLive>,
  program: Effect.Effect<A, E, WorkProducer | CompletionProducer>,
): Promise<A> => Effect.runPromise(program.pipe(Effect.provide(layer)))

const runProducerEither = <A, E>(
  layer: ReturnType<typeof SubstrateProducerLive>,
  program: Effect.Effect<A, E, WorkProducer | CompletionProducer>,
): Promise<Either.Either<A, E>> =>
  Effect.runPromise(Effect.either(program).pipe(Effect.provide(layer)))

describe("semantic-producer.PRODUCER_EFFECT", () => {
  it("semantic-producer.PRODUCER_EFFECT.1 — declareWork produces durable.run state in the run projection", async () => {
    const url = await createSubstrateStream("declare-1")
    const layer = SubstrateProducerLive({ streamUrl: url })

    const result = await runProducer(
      layer,
      Effect.gen(function* () {
        const wp = yield* WorkProducer
        return yield* wp.declareWork({ runId: "run-1" })
      }),
    )
    expect(result).toEqual({ runId: "run-1", state: "started" })

    const snapshot = await rebuildProjection({ url })
    const run = snapshot.runs.get("run-1")
    expect(run).toBeDefined()
    expect(run?.state).toBe("started")
  })

  it("semantic-producer.PRODUCER_EFFECT.2 — resolveCompletion produces durable.completion resolved terminal in the projection", async () => {
    // Seed a pending completion (fixture-only, per PACKAGE_BOUNDARY.1).
    const seed = substrateState.completions.insert({
      value: { completionId: "c-1", kind: "externally_resolved_awakeable", state: "pending" },
    })
    const url = await createSubstrateStream("resolve-1", [seed])
    const layer = SubstrateProducerLive({ streamUrl: url })

    const result = await runProducer(
      layer,
      Effect.gen(function* () {
        const cp = yield* CompletionProducer
        return yield* cp.resolveCompletion({ completionId: "c-1", result: { x: 42 } })
      }),
    )
    expect(result).toEqual({ completionId: "c-1", state: "resolved" })

    const snapshot = await rebuildProjection({ url })
    expect(snapshot.completions.get("c-1")?.state).toBe("resolved")
    expect(snapshot.completions.get("c-1")?.result).toEqual({ x: 42 })
  })

  it("semantic-producer.PRODUCER_EFFECT.2 — rejectCompletion produces durable.completion rejected terminal", async () => {
    const seed = substrateState.completions.insert({
      value: { completionId: "c-2", kind: "externally_resolved_awakeable", state: "pending" },
    })
    const url = await createSubstrateStream("reject-1", [seed])
    const layer = SubstrateProducerLive({ streamUrl: url })

    const result = await runProducer(
      layer,
      Effect.gen(function* () {
        const cp = yield* CompletionProducer
        return yield* cp.rejectCompletion({ completionId: "c-2", error: { code: "BOOM" } })
      }),
    )
    expect(result).toEqual({ completionId: "c-2", state: "rejected" })

    const snapshot = await rebuildProjection({ url })
    expect(snapshot.completions.get("c-2")?.state).toBe("rejected")
    expect(snapshot.completions.get("c-2")?.error).toEqual({ code: "BOOM" })
  })

  it("semantic-producer.PRODUCER_EFFECT.2 — cancelCompletion produces durable.completion cancelled terminal", async () => {
    const seed = substrateState.completions.insert({
      value: { completionId: "c-3", kind: "timer", state: "pending" },
    })
    const url = await createSubstrateStream("cancel-1", [seed])
    const layer = SubstrateProducerLive({ streamUrl: url })

    const result = await runProducer(
      layer,
      Effect.gen(function* () {
        const cp = yield* CompletionProducer
        return yield* cp.cancelCompletion({ completionId: "c-3", terminalReason: "ttl" })
      }),
    )
    expect(result).toEqual({ completionId: "c-3", state: "cancelled" })

    const snapshot = await rebuildProjection({ url })
    expect(snapshot.completions.get("c-3")?.state).toBe("cancelled")
    expect(snapshot.completions.get("c-3")?.terminalReason).toBe("ttl")
  })

  it("semantic-producer.PRODUCER_EFFECT.3 — methods do not hide meaningful state in process memory (rebuild reflects every call)", async () => {
    // Two declareWork calls; both must be visible in a fresh rebuild.
    const url = await createSubstrateStream("no-hidden-state")
    const layer = SubstrateProducerLive({ streamUrl: url })

    await runProducer(
      layer,
      Effect.gen(function* () {
        const wp = yield* WorkProducer
        yield* wp.declareWork({ runId: "run-A" })
        yield* wp.declareWork({ runId: "run-B" })
      }),
    )

    const snapshot = await rebuildProjection({ url })
    expect(snapshot.runs.get("run-A")?.state).toBe("started")
    expect(snapshot.runs.get("run-B")?.state).toBe("started")
    expect(snapshot.runs.size).toBe(2)
  })

  it("semantic-producer.PRODUCER_EFFECT.4 — producer does not author derived projection rows (claimAttempts stays empty after declare/terminalize)", async () => {
    const seed = substrateState.completions.insert({
      value: { completionId: "c-4", kind: "timer", state: "pending" },
    })
    const url = await createSubstrateStream("no-derived", [seed])
    const layer = SubstrateProducerLive({ streamUrl: url })

    await runProducer(
      layer,
      Effect.gen(function* () {
        const wp = yield* WorkProducer
        const cp = yield* CompletionProducer
        yield* wp.declareWork({ runId: "run-D" })
        yield* cp.resolveCompletion({ completionId: "c-4", result: 1 })
      }),
    )

    const snapshot = await rebuildProjection({ url })
    expect(snapshot.claimAttempts.size).toBe(0)
  })
})

describe("semantic-producer.PRODUCER_ROLE", () => {
  it("semantic-producer.PRODUCER_ROLE.2 — declareWork returns durable identity + projection-relevant fields, not a handle", async () => {
    const url = await createSubstrateStream("identity-1")
    const layer = SubstrateProducerLive({ streamUrl: url })
    const result = await runProducer(
      layer,
      Effect.gen(function* () {
        const wp = yield* WorkProducer
        return yield* wp.declareWork({ runId: "run-id" })
      }),
    )
    expect(result).toEqual({ runId: "run-id", state: "started" })
    expect(Object.keys(result).sort()).toEqual(["runId", "state"])
    // No nested handle/object/promise leaked.
    for (const v of Object.values(result)) {
      expect(typeof v).toBe("string")
    }
  })

  it("semantic-producer.PRODUCER_ROLE.2 — terminalization returns identity + terminal state, not a handle", async () => {
    const seed = substrateState.completions.insert({
      value: { completionId: "c-id", kind: "timer", state: "pending" },
    })
    const url = await createSubstrateStream("identity-2", [seed])
    const layer = SubstrateProducerLive({ streamUrl: url })
    const result = await runProducer(
      layer,
      Effect.gen(function* () {
        const cp = yield* CompletionProducer
        return yield* cp.resolveCompletion({ completionId: "c-id", result: "ok" })
      }),
    )
    expect(result).toEqual({ completionId: "c-id", state: "resolved" })
    expect(Object.keys(result).sort()).toEqual(["completionId", "state"])
  })

  it("semantic-producer.PRODUCER_ROLE.4 — declareWork does not require a runtime participant to exist", async () => {
    // No operator, no runner, no handler is registered; declareWork still
    // succeeds and produces an observable durable.run row.
    const url = await createSubstrateStream("no-participant")
    const layer = SubstrateProducerLive({ streamUrl: url })
    const result = await runProducer(
      layer,
      Effect.gen(function* () {
        const wp = yield* WorkProducer
        return yield* wp.declareWork()
      }),
    )
    expect(result.state).toBe("started")
    const snapshot = await rebuildProjection({ url })
    expect(snapshot.runs.get(result.runId)?.state).toBe("started")
  })

  it("semantic-producer.PRODUCER_ROLE.2 — declareWork without explicit runId generates a stable identity", async () => {
    const url = await createSubstrateStream("auto-id")
    const layer = SubstrateProducerLive({ streamUrl: url })
    const result = await runProducer(
      layer,
      Effect.gen(function* () {
        const wp = yield* WorkProducer
        return yield* wp.declareWork()
      }),
    )
    // UUID v4 shape.
    expect(result.runId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
  })
})

describe("producer error semantics", () => {
  it("terminalizing a non-existent completion fails with CompletionNotFoundError", async () => {
    const url = await createSubstrateStream("not-found")
    const layer = SubstrateProducerLive({ streamUrl: url })
    const result = await runProducerEither(
      layer,
      Effect.gen(function* () {
        const cp = yield* CompletionProducer
        return yield* cp.resolveCompletion({ completionId: "missing", result: 1 })
      }),
    )
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(CompletionNotFoundError)
    }
  })

  it("effect-native-api.EFFECT_SERVICES.6 — re-terminalizing an already-terminal completion fails in the Effect error channel with IllegalCompletionTransition", async () => {
    const seed = substrateState.completions.insert({
      value: { completionId: "c-err", kind: "timer", state: "pending" },
    })
    const url = await createSubstrateStream("already-terminal", [seed])
    const layer = SubstrateProducerLive({ streamUrl: url })

    await runProducer(
      layer,
      Effect.gen(function* () {
        const cp = yield* CompletionProducer
        yield* cp.resolveCompletion({ completionId: "c-err", result: "first" })
      }),
    )

    // Second terminalization attempt: the producer surfaces the state-machine
    // guard rejection in the Effect error channel (recoverable via Effect.either).
    const result = await runProducerEither(
      layer,
      Effect.gen(function* () {
        const cp = yield* CompletionProducer
        return yield* cp.resolveCompletion({ completionId: "c-err", result: "again" })
      }),
    )
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(IllegalCompletionTransition)
    }

    // Sanity: the projection still reflects the first valid terminal.
    const snapshot = await rebuildProjection({ url })
    expect(snapshot.completions.get("c-err")?.state).toBe("resolved")
    expect(snapshot.completions.get("c-err")?.result).toBe("first")
  })

  it("appending to a non-existent stream surfaces ProducerStreamError", async () => {
    // A URL that was never created on the test server.
    const url = freshStreamUrl("never-created")
    const layer = SubstrateProducerLive({ streamUrl: url })
    const result = await runProducerEither(
      layer,
      Effect.gen(function* () {
        const wp = yield* WorkProducer
        yield* wp.declareWork({ runId: "ghost" })
      }),
    )
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left).toBeInstanceOf(ProducerStreamError)
    }
  })
})

// Reference all error classes so unused-import lints don't strip them; these
// types are part of the producer's public surface for consumer error handling.
void ProducerStreamError
void IllegalCompletionTransition
void CompletionNotFoundError

describe("Slice 3 boundaries (structural — semantic-producer + effect-native-api)", () => {
  const exports = substrate as unknown as Record<string, unknown>

  it("semantic-producer.PRODUCER_ROLE.6 — producer services do not expose raw stream append or envelope construction", async () => {
    const url = await createSubstrateStream("no-raw-append")
    const layer = SubstrateProducerLive({ streamUrl: url })
    const services = await runProducer(
      layer,
      Effect.gen(function* () {
        const wp = yield* WorkProducer
        const cp = yield* CompletionProducer
        return { wp, cp }
      }),
    )
    for (const svc of [services.wp, services.cp]) {
      const keys = Object.keys(svc as unknown as Record<string, unknown>)
      for (const k of keys) {
        expect(k).not.toMatch(/append/i)
        expect(k).not.toMatch(/envelope/i)
        expect(k).not.toMatch(/^stream$/i)
      }
    }
    // Service methods are limited to declared semantic operations.
    expect(Object.keys(services.wp).sort()).toEqual(["declareWork"])
    expect(Object.keys(services.cp).sort()).toEqual([
      "cancelCompletion",
      "rejectCompletion",
      "resolveCompletion",
    ])
  })

  it("semantic-producer.PRODUCER_EFFECT.6 — the Slice 3 producer module does not expose sleep/waitFor/scheduleWork/awakeable-key/ready-work/operator/claim", async () => {
    // Scope: the producer module itself. Other slices may legitimately add
    // ready-work derivation (Slice 4), wait APIs (Slice 7), operator/claim
    // surfaces (Slice 5/6) to the broader package — the constraint is about
    // what ships INSIDE the producer feature.
    const producerMod = await import("../producer.ts")
    const producerNames = Object.keys(producerMod)
    for (const symbol of [
      "sleep",
      "waitFor",
      "scheduleWork",
      "awakeable",
      "awakeableKey",
      "workScopedAwakeableKey",
      "globalAwakeableKey",
      "deriveReadyWork",
      "ReadyWorkProjection",
      "Operator",
      "DurableOperator",
      "ClaimProducer",
      "claim",
    ]) {
      expect(producerNames).not.toContain(symbol)
    }
  })

  it("effect-native-api.EFFECT_SERVICES.2 — services expose semantic operations, not raw helpers", () => {
    // The exported producer module names two services and one layer factory.
    expect(typeof exports.WorkProducer).toBe("function")
    expect(typeof exports.CompletionProducer).toBe("function")
    expect(typeof exports.SubstrateProducerLive).toBe("function")
    // No raw helpers leaked.
    expect(exports.appendRaw).toBeUndefined()
    expect(exports.makeEnvelope).toBeUndefined()
  })

  it("effect-native-api.EFFECT_SERVICES.3 — config carries only streamUrl + optional contentType (no leaked stream/state/projection deps)", () => {
    // SubstrateProducerLive's signature accepts only the documented fields.
    // (Ts enforces this at compile time; runtime smoke-test ensures the
    // factory accepts a minimal config and returns a Layer.)
    const layer = SubstrateProducerLive({ streamUrl: "https://example.invalid/x" })
    expect(typeof layer).toBe("object")
  })

  it("semantic-producer.PRODUCER_ROLE.7 — live wiring config is the layer factory; no separate config service is exported from the package surface", () => {
    // No SubstrateProducerConfig (or any other Tag) leaks from the package.
    expect(exports.SubstrateProducerConfig).toBeUndefined()
    expect(exports.ProducerConfig).toBeUndefined()
    // The single supported wiring is via the layer factory.
    expect(typeof exports.SubstrateProducerLive).toBe("function")
  })

  it("effect-native-api.EFFECT_SERVICES.4 — wait APIs are not part of the Slice 3 producer module", async () => {
    // Scope: producer.ts module. Slice 7 legitimately adds DurableWaits to
    // the broader package; the constraint is that the producer feature
    // does not own those APIs.
    const producerMod = await import("../producer.ts")
    const producerNames = Object.keys(producerMod)
    for (const symbol of [
      "sleep",
      "waitFor",
      "scheduleWork",
      "DurableWaits",
      "AwakeableProducer",
    ]) {
      expect(producerNames).not.toContain(symbol)
    }
  })

  it("effect-native-api.EFFECT_SERVICES.5 — operator running is not part of the Slice 3 producer surface", () => {
    expect(exports.runOperator).toBeUndefined()
    expect(exports.OperatorRunner).toBeUndefined()
    expect(exports.DurableOperator).toBeUndefined()
  })

  it("effect-native-api.NO_FRAMEWORK_REGISTRY.1 — no top-level DurableService.define registry", () => {
    expect(exports.DurableService).toBeUndefined()
    expect(exports.defineDurableService).toBeUndefined()
  })

  it("effect-native-api.NO_FRAMEWORK_REGISTRY.2 — no DurableWorker.make authoring pattern", () => {
    expect(exports.DurableWorker).toBeUndefined()
    expect(exports.makeDurableWorker).toBeUndefined()
  })

  it("semantic-producer.NO_RUNTIME_STACK.1, .2, .3, .4 — no CLI / ACP / custom StreamDB wrapper / row-schema ownership leak", () => {
    // NO_RUNTIME_STACK.1 — no CLI binary
    // (substrate package.json has no `bin` field)
    expect(exports.runCli).toBeUndefined()
    expect(exports.cli).toBeUndefined()
    // NO_RUNTIME_STACK.2 — no ACP/MCP/conductor/process/etc.
    for (const symbol of [
      "ACP",
      "MCP",
      "Conductor",
      "spawn",
      "execute",
      "Provider",
      "Sandbox",
      "ResourceTransport",
      "ToolTransport",
    ]) {
      expect(exports[symbol]).toBeUndefined()
    }
    // NO_RUNTIME_STACK.3 — no custom StreamDB wrapper class
    expect(exports.DurableSubstrateStreamDB).toBeUndefined()
    expect(exports.SubstrateStreamDBWrapper).toBeUndefined()
    // NO_RUNTIME_STACK.4 — feature does not own row schemas (rows are still
    // defined in rows.ts; producer is a thin layer over them).
    expect(exports.RunValue).toBeDefined()
    expect(exports.CompletionValue).toBeDefined()
  })

  it("semantic-producer.PACKAGE_BOUNDARY.3 — substrate does not present as a higher-level application or runtime client", () => {
    expect(exports.startApp).toBeUndefined()
    expect(exports.runApp).toBeUndefined()
    expect(exports.RuntimeClient).toBeUndefined()
    expect(exports.AgentClient).toBeUndefined()
  })
})

describe("launchable-substrate-host.CLIENT_SURFACE.11 — declareWork keeps idempotency metadata out of the durable.run row value", () => {
  it("WorkProducer.declareWork forwards idempotencyKey as a ChangeEvent header, not a RunValue field", async () => {
    const url = await createSubstrateStream("declare-idempotency")
    const layer = SubstrateProducerLive({ streamUrl: url })

    const idempotencyKey = "demo:review-1"
    const declared = await runProducer(
      layer,
      Effect.gen(function* () {
        const wp = yield* WorkProducer
        return yield* wp.declareWork({
          runId: "run-idempotency",
          idempotencyKey,
        })
      }),
    )
    expect(declared.runId).toBe("run-idempotency")

    const snap = await rebuildProjection({ url })
    const run = snap.runs.get("run-idempotency")
    expect(run).toBeDefined()
    expect(run?.state).toBe("started")
    // RunValue must NOT carry idempotencyKey on the row.
    expect((run as Record<string, unknown>).idempotencyKey).toBeUndefined()

    // Read the raw stream and confirm the durable.run insert event
    // carries idempotencyKey on its headers.
    const handle = new DurableStream({ url, contentType: "application/json" })
    const res = await handle.stream({ offset: "-1", live: false })
    const items = (await res.json()) as ReadonlyArray<ChangeEvent>
    const runEvent = items.find(
      (it) => it.type === "durable.run" && it.key === "run-idempotency",
    )
    expect(runEvent).toBeDefined()
    expect(
      (runEvent!.headers as unknown as Record<string, string>).idempotencyKey,
    ).toBe(idempotencyKey)
  })
})

describe("launchable-substrate-host.CLIENT_SURFACE.12 — declareWork stores caller input as substrate-generic durable.run data", () => {
  it("WorkProducer.declareWork({ data }) materializes the caller's input on the durable.run row's data field", async () => {
    const url = await createSubstrateStream("declare-data")
    const layer = SubstrateProducerLive({ streamUrl: url })

    const data = { kind: "review", target: "README.md" } as const
    await runProducer(
      layer,
      Effect.gen(function* () {
        const wp = yield* WorkProducer
        return yield* wp.declareWork({ runId: "run-with-data", data })
      }),
    )

    const snap = await rebuildProjection({ url })
    const run = snap.runs.get("run-with-data")
    expect(run?.state).toBe("started")
    expect(run?.data).toStrictEqual(data)
  })

  it("WorkProducer.declareWork without data leaves the row's data field absent", async () => {
    const url = await createSubstrateStream("declare-no-data")
    const layer = SubstrateProducerLive({ streamUrl: url })

    await runProducer(
      layer,
      Effect.gen(function* () {
        const wp = yield* WorkProducer
        return yield* wp.declareWork({ runId: "run-without-data" })
      }),
    )

    const snap = await rebuildProjection({ url })
    const run = snap.runs.get("run-without-data")
    expect(run?.state).toBe("started")
    expect(run?.data).toBeUndefined()
  })
})
