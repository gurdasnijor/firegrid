/**
 * Pins the load-bearing invariant that `engine.deferredDone` is idempotent
 * (first-writer-wins) on `${executionId}/${deferredName}`.
 *
 * This is a *Firegrid engine* property, not an upstream `@effect/workflow`
 * guarantee — upstream `DurableDeferred.done` specifies no idempotency
 * semantics. Runtime-owned workflows rely on it when replay re-drives a
 * completion activity after an earlier completion already won. If this
 * invariant regresses, restart replay can lose exactly-once resolution.
 *
 * See the implementation at
 * packages/runtime/src/workflow-engine/internal/engine-runtime.ts:252-266.
 *
 * Harness mirrors DurableStreamsWorkflowEngine.test.ts: a real local
 * @durable-streams server, fresh per-test stream URLs, async `it` +
 * `Effect.runPromise` via `runWith`.
 */

import { DurableDeferred, Workflow, WorkflowEngine } from "@effect/workflow"
import { DurableStreamTestServer } from "@durable-streams/server"
import { Effect, Exit, Layer, Schema } from "effect"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  DurableStreamsWorkflowEngine,
  type WorkflowEngineDurableStateOptions,
  WorkflowEngineTable,
  type WorkflowEngineTableService,
} from "../../src/workflow-engine/DurableStreamsWorkflowEngine.ts"

let server: DurableStreamTestServer | undefined
let baseUrl: string | undefined

beforeEach(async () => {
  server = new DurableStreamTestServer({ port: 0, host: "127.0.0.1" })
  baseUrl = await server.start()
})

afterEach(async () => {
  await server?.stop()
  server = undefined
  baseUrl = undefined
})

const runWith = <A, E>(
  options: WorkflowEngineDurableStateOptions,
  workflowLayer: unknown,
  effect: Effect.Effect<A, E, unknown>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      effect.pipe(
        Effect.provide(
          (workflowLayer as Layer.Layer<never, unknown, unknown>).pipe(
            Layer.provideMerge(
              DurableStreamsWorkflowEngine.layer(options) as Layer.Layer<
                never,
                unknown,
                unknown
              >,
            ),
          ),
        ),
      ) as Effect.Effect<A, unknown, never>,
    ),
  )

const inspectTable = async <A>(
  streamUrl: string,
  inspect: (table: WorkflowEngineTableService) => Effect.Effect<A, unknown>,
): Promise<A> =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const table = yield* WorkflowEngineTable
        return yield* inspect(table)
      }).pipe(
        Effect.provide(
          WorkflowEngineTable.layer({
            streamOptions: { url: streamUrl, contentType: "application/json" },
          }),
        ),
      ),
    ),
  )

describe("engine.deferredDone idempotency", () => {
  it("keeps the first exit when deferredDone is called twice with different exits", async () => {
    if (!baseUrl) throw new Error("server not started")
    const streamUrl = `${baseUrl}/v1/stream/deferred-idem-success-${crypto.randomUUID()}`
    const deferredName = "idem-approval"
    const Approval = DurableDeferred.make(deferredName, {
      success: Schema.String,
    })
    const IdemWorkflow = Workflow.make({
      name: "deferred-idem-workflow",
      payload: Schema.Struct({ id: Schema.String }),
      success: Schema.String,
      idempotencyKey: payload => payload.id,
    })
    const workflowLayer = IdemWorkflow.toLayer(() =>
      DurableDeferred.await(Approval),
    )
    const executionId = await Effect.runPromise(
      IdemWorkflow.executionId({ id: "idem" }),
    )

    // Suspend the workflow on the deferred.
    await runWith(
      { streamUrl },
      workflowLayer,
      IdemWorkflow.execute({ id: "idem" }, { discard: true }),
    )

    // Two completions for the same (executionId, deferredName) with different
    // exits — exactly the shape a match-then-reconcile or match-then-timeout
    // race produces. Called the way reconcile.ts / wait-router.ts call it.
    await runWith(
      { streamUrl },
      workflowLayer,
      Effect.gen(function* () {
        const engine = yield* WorkflowEngine.WorkflowEngine
        // Pass the schema-bearing deferred (as production reconcile.ts /
        // wait-router.ts do via matchDeferredFor) so the exit encodes
        // against the real success/error schema, not the Void/Never default.
        yield* engine.deferredDone(Approval, {
          workflowName: IdemWorkflow.name,
          executionId,
          deferredName,
          exit: Exit.succeed("first-writer"),
        })
        yield* engine.deferredDone(Approval, {
          workflowName: IdemWorkflow.name,
          executionId,
          deferredName,
          exit: Exit.succeed("second-writer-should-be-ignored"),
        })
      }),
    )

    const result = await runWith(
      { streamUrl },
      workflowLayer,
      IdemWorkflow.execute({ id: "idem" }),
    )
    const replay = await runWith(
      { streamUrl },
      workflowLayer,
      IdemWorkflow.execute({ id: "idem" }),
    )

    expect(result).toBe("first-writer")
    expect(replay).toBe("first-writer")

    // Exactly one deferred row persisted for the key.
    const deferredRows = await inspectTable(streamUrl, table =>
      table.deferreds.query(coll =>
        coll.toArray.filter(
          row => row.deferredKey === `${executionId}/${deferredName}`,
        ),
      ),
    )
    expect(deferredRows).toHaveLength(1)
  })

  it("keeps a first failure exit even when a later success completion arrives", async () => {
    if (!baseUrl) throw new Error("server not started")
    const streamUrl = `${baseUrl}/v1/stream/deferred-idem-failure-${crypto.randomUUID()}`
    const deferredName = "idem-approval-fail"
    const Approval = DurableDeferred.make(deferredName, {
      success: Schema.String,
      error: Schema.String,
    })
    const IdemFailWorkflow = Workflow.make({
      name: "deferred-idem-failure-workflow",
      payload: Schema.Struct({ id: Schema.String }),
      success: Schema.String,
      error: Schema.String,
      idempotencyKey: payload => payload.id,
    })
    const workflowLayer = IdemFailWorkflow.toLayer(() =>
      DurableDeferred.await(Approval),
    )
    const executionId = await Effect.runPromise(
      IdemFailWorkflow.executionId({ id: "idem-fail" }),
    )

    await runWith(
      { streamUrl },
      workflowLayer,
      IdemFailWorkflow.execute({ id: "idem-fail" }, { discard: true }),
    )

    await runWith(
      { streamUrl },
      workflowLayer,
      Effect.gen(function* () {
        const engine = yield* WorkflowEngine.WorkflowEngine
        // Schema-bearing deferred so the failure exit encodes against
        // error: Schema.String (matches production matchDeferredFor usage).
        yield* engine.deferredDone(Approval, {
          workflowName: IdemFailWorkflow.name,
          executionId,
          deferredName,
          exit: Exit.fail("denied-first"),
        })
        yield* engine.deferredDone(Approval, {
          workflowName: IdemFailWorkflow.name,
          executionId,
          deferredName,
          exit: Exit.succeed("approved-too-late"),
        })
      }),
    )

    const result = await runWith(
      { streamUrl },
      workflowLayer,
      IdemFailWorkflow.execute({ id: "idem-fail" }).pipe(Effect.either),
    )

    expect(result).toMatchObject({ _tag: "Left", left: "denied-first" })
  })
})
