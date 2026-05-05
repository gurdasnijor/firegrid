import { Cause, Context, Effect, Exit, Layer } from "effect"
import { describe, expect, it } from "vitest"
import {
  HostProgramGraph,
  type HostProgramRuntime,
  SubstrateHostBoot,
} from "../../index.js"

// Graph construction E flows into the host launch error channel as
// an Exit failure value, NOT as a defect (Cause.isDie). This guards
// against regressions where a blanket Effect.orDie would convert
// graph construction failures to defects.
describe("HostProgramGraph — graph construction E surfaces as Exit failure", () => {
  it("a HostProgramGraph whose layer fails returns the failure as Exit.failure (not Cause.isDie) when the host is provided to a program", async () => {
    class FakeGraphError {
      readonly _tag = "FakeGraphError"
      constructor(readonly reason: string) {}
    }

    const failingLayer: Layer.Layer<never, FakeGraphError, HostProgramRuntime> =
      Layer.scopedContext(
        Effect.fail(new FakeGraphError("intentional graph failure")).pipe(
          Effect.map(() => Context.empty()),
        ),
      )

    const FailingGraph = HostProgramGraph.define({
      name: "failing",
      layer: failingLayer,
    })

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.void.pipe(
          Effect.provide(
            SubstrateHostBoot.embeddedDev({
              streamName: "graph-error-channel",
              program: FailingGraph,
            }),
          ),
        ),
      ),
    )

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      // Graph E surfaces as a failure, not a defect.
      expect(Cause.isDie(exit.cause)).toBe(false)
      const failureOption = Cause.failureOption(exit.cause)
      expect(failureOption._tag).toBe("Some")
      if (failureOption._tag === "Some") {
        expect(failureOption.value).toBeInstanceOf(FakeGraphError)
        expect((failureOption.value).reason).toBe(
          "intentional graph failure",
        )
      }
    }
  })

  // Companion sanity check: a successful graph still produces a
  // success Exit. Pinning that the `Effect.runPromiseExit` shape
  // above is the right discriminator.
  it("a successful HostProgramGraph runs to a success Exit", async () => {
    const SuccessGraph = HostProgramGraph.define({
      name: "success",
      layer: Layer.empty,
    })

    const exit = await Effect.runPromiseExit(
      Effect.scoped(
        Effect.void.pipe(
          Effect.provide(
            SubstrateHostBoot.embeddedDev({
              streamName: "graph-success",
              program: SuccessGraph,
            }),
          ),
        ),
      ),
    )

    expect(Exit.isSuccess(exit)).toBe(true)
  })
})
