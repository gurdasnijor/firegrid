/**
 * AtMostOnce semantic test for local-process stdin delivery.
 *
 * Implements:
 *  - effect-durable-operators.FIREGRID_PROOF.4 — runtime input stdin
 *    delivery records AtMostOnce claim through a DurableTable checkpoint
 *    collection before bytes are emitted; failure injected between the
 *    durable claim and the byte emission must not cause the same input row
 *    to be redelivered on restart.
 *  - firegrid-agent-ingress.DELIVERY.3 — delivery progress is durable.
 */

import { FetchHttpClient } from "@effect/platform"
import { startDurableStreamsTestServer } from "@firegrid/durable-streams/test-utils"
import {
  type RuntimeIngressRow,
  RuntimeIngressRowSchema,
} from "@firegrid/protocol/runtime-ingress"
import { DurableStream } from "effect-durable-streams"
import { Effect, Fiber, Option, Stream } from "effect"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import {
  localProcessStdinDelivery,
  RuntimeInputDeliveryTable,
  runtimeInputDeliveryLayer,
} from "./local-process-stdin-delivery.ts"
import { runtimeIngressError } from "../../runtime-ingress/schema.ts"

let server: Awaited<ReturnType<typeof startDurableStreamsTestServer>>

beforeAll(async () => {
  server = await startDurableStreamsTestServer()
})
afterAll(async () => {
  await server.stop()
})

const appendIngressRow = (streamUrl: string, row: RuntimeIngressRow) =>
  DurableStream.define({
    endpoint: { url: streamUrl },
    schema: RuntimeIngressRowSchema,
  }).append(row).pipe(
    Effect.asVoid,
    Effect.provide(FetchHttpClient.layer),
  )

const makeRow = (
  contextId: string,
  ingressId: string,
  text: string,
): RuntimeIngressRow => ({
  type: "firegrid.runtime_ingress.requested",
  id: `row-${ingressId}`,
  at: "2026-05-12T00:00:00.000Z",
  ingressId,
  contextId,
  kind: "message",
  authoredBy: "client",
  payload: { type: "text", text },
  createdAt: "2026-05-12T00:00:00.000Z",
})

describe("localProcessStdinDelivery", () => {
  it("effect-durable-operators.FIREGRID_PROOF.4 firegrid-agent-ingress.DELIVERY.3 AtMostOnce: failure between claim and byte emission durably skips the row on restart", async () => {
    const inputUrl = await server.createStreamUrl("runtime-input-atmost")
    const checkpointUrl = await server.createStreamUrl(
      "runtime-input-atmost-checkpoints",
    )
    const contextId = "ctx-am1"
    const subscriberId = "runtime-context:local-process:stdin"
    const ingressId = "ing-1"

    await Effect.runPromise(
      appendIngressRow(inputUrl, makeRow(contextId, ingressId, "hello-once")),
    )

    const checkpointLayer = runtimeInputDeliveryLayer({
      checkpointStreamUrl: checkpointUrl,
    })

    // First run: failure is injected AFTER the claim upsert completes (the
    // generated DurableTable upsert action awaits txid before resolving) and
    // BEFORE any byte chunk reaches downstream. The stream's first attempt
    // must fail; the claim row must remain durable so a second run skips
    // this ingressId.
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const deliveryStream = localProcessStdinDelivery({
            streamUrl: inputUrl,
            contextId,
            subscriberId,
            onClaimedBeforeEmit: () =>
              Effect.fail(
                runtimeIngressError(
                  "test-injected",
                  "failure injected between claim and emit",
                  contextId,
                  ingressId,
                ),
              ),
          })

          const result = yield* Stream.runCollect(deliveryStream).pipe(
            Effect.either,
          )
          // The injected failure surfaces as Left; we do not require any
          // particular error path beyond "not Right".
          expect(result._tag).toBe("Left")
        }).pipe(
          Effect.provide(checkpointLayer),
          Effect.provide(FetchHttpClient.layer),
        ),
      ),
    )

    // The claim row MUST be visible in the checkpoint table because the
    // DurableTable upsert action awaits txid before the failure hook runs.
    const claimed = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const table = yield* RuntimeInputDeliveryTable
          return yield* table.checkpoints.get({ subscriberId, ingressId })
        }).pipe(
          Effect.provide(checkpointLayer),
          Effect.provide(FetchHttpClient.layer),
        ),
      ),
    )
    expect(Option.isSome(claimed)).toBe(true)
    if (Option.isSome(claimed)) {
      expect(typeof claimed.value.claimedAt).toBe("string")
    }

    // Second run: no injection. The durable claim row from the first run
    // should cause the same ingress row to be SKIPPED — zero bytes emitted.
    const secondRunChunks = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const deliveryStream = localProcessStdinDelivery({
            streamUrl: inputUrl,
            contextId,
            subscriberId,
          })
          const chunks: Array<Uint8Array> = []
          const fiber = yield* Effect.fork(
            Stream.runForEach(deliveryStream, (chunk) =>
              Effect.sync(() => {
                chunks.push(chunk)
              }),
            ),
          )
          yield* Effect.sleep("250 millis")
          yield* Fiber.interrupt(fiber)
          return chunks
        }).pipe(
          Effect.provide(checkpointLayer),
          Effect.provide(FetchHttpClient.layer),
        ),
      ),
    )

    expect(secondRunChunks).toEqual([])
  })

  it("effect-durable-operators.FIREGRID_PROOF.4 emits one chunk for an unclaimed input row", async () => {
    const inputUrl = await server.createStreamUrl("runtime-input-happy")
    const checkpointUrl = await server.createStreamUrl(
      "runtime-input-happy-checkpoints",
    )
    const contextId = "ctx-happy"
    const subscriberId = "runtime-context:local-process:stdin"
    const ingressId = "ing-happy"

    await Effect.runPromise(
      appendIngressRow(inputUrl, makeRow(contextId, ingressId, "hello")),
    )

    const checkpointLayer = runtimeInputDeliveryLayer({
      checkpointStreamUrl: checkpointUrl,
    })

    const decoder = new TextDecoder()
    const chunks = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const deliveryStream = localProcessStdinDelivery({
            streamUrl: inputUrl,
            contextId,
            subscriberId,
          })
          const collected: Array<string> = []
          const fiber = yield* Effect.fork(
            Stream.runForEach(deliveryStream, (chunk) =>
              Effect.sync(() => {
                collected.push(decoder.decode(chunk))
              }),
            ),
          )
          yield* Effect.sleep("250 millis")
          yield* Fiber.interrupt(fiber)
          return collected
        }).pipe(
          Effect.provide(checkpointLayer),
          Effect.provide(FetchHttpClient.layer),
        ),
      ),
    )

    expect(chunks).toEqual(["hello\n"])
  })
})
