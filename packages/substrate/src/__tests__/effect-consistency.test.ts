import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import {
  ClaimMissingCursorError,
  ClaimStreamError,
  ClaimWinnerMissingError,
} from "../execution/operator-errors.ts"
import { RunNotFoundError } from "../execution/operator.ts"
import {
  CompletionProducer,
  SubstrateProducerLive,
  WorkProducer,
} from "../write-api/producer.ts"
import { RetainedReadError } from "../retained-records.ts"
import { WaitsStreamError } from "../execution/waits.ts"

const source = (relative: string) =>
  readFileSync(fileURLToPath(new URL(`../${relative}`, import.meta.url)), "utf8")

describe("firegrid-remediation-hardening.EFFECT_CONSISTENCY.2 + effect-native-api.EFFECT_SERVICES.11 — expected errors are tagged data errors", () => {
  it("firegrid-remediation-hardening.EFFECT_CONSISTENCY.2 — migrated substrate errors carry recoverable Effect tags", async () => {
    const claimStream = new ClaimStreamError({ cause: "boom" })
    expect(claimStream).toBeInstanceOf(ClaimStreamError)
    expect(claimStream._tag).toBe("ClaimStreamError")

    const claimMissingCursor = new ClaimMissingCursorError({
      streamUrl: "http://example.invalid/stream",
    })
    expect(claimMissingCursor).toBeInstanceOf(ClaimMissingCursorError)
    expect(claimMissingCursor._tag).toBe("ClaimMissingCursorError")

    const claimWinnerMissing = new ClaimWinnerMissingError({ workId: "work-1" })
    expect(claimWinnerMissing).toBeInstanceOf(ClaimWinnerMissingError)
    expect(claimWinnerMissing._tag).toBe("ClaimWinnerMissingError")

    const retained = new RetainedReadError({ cause: "decode" })
    expect(retained).toBeInstanceOf(RetainedReadError)
    expect(retained._tag).toBe("RetainedReadError")

    const runNotFound = new RunNotFoundError({ runId: "run-1" })
    expect(runNotFound).toBeInstanceOf(RunNotFoundError)
    expect(runNotFound._tag).toBe("RunNotFoundError")

    const waits = new WaitsStreamError({ cause: "append" })
    expect(waits).toBeInstanceOf(WaitsStreamError)
    expect(waits._tag).toBe("WaitsStreamError")

    const recovered = await Effect.runPromise(
      Effect.fail(waits).pipe(
        Effect.catchTag("WaitsStreamError", (error) =>
          Effect.succeed(error._tag),
        ),
      ),
    )
    expect(recovered).toBe("WaitsStreamError")
  })

  it("effect-native-api.EFFECT_SERVICES.11 — public expected error classes do not hand-roll _tag by extending Error", () => {
    for (const file of [
      "execution/operator-errors.ts",
      "execution/operator.ts",
      "retained-records.ts",
      "execution/waits.ts",
      "coordination/choreography/service.ts",
    ]) {
      const text = source(file)
      expect(text).not.toMatch(/class \w+ extends Error/)
      expect(text).not.toContain("readonly _tag =")
    }
  })
})

describe("firegrid-remediation-hardening.EFFECT_CONSISTENCY.1 + effect-native-api.EFFECT_SERVICES.12 — substrate service convention", () => {
  it("firegrid-remediation-hardening.EFFECT_CONSISTENCY.1 — producer services use Context.Tag plus explicit live layer construction", () => {
    const text = source("write-api/producer.ts")
    expect(text).not.toContain("Effect.Service")
    expect(text).not.toContain(".Default")
    expect(text).toContain('Context.Tag("Substrate/WorkProducer")')
    expect(text).toContain("Substrate/CompletionProducer")
    // firegrid-remediation-hardening.EFFECT_CONSISTENCY.5 — WorkProducer
    // captures `IdGen` at layer-build time, so the live constructor is
    // `Layer.effect` rather than `Layer.succeed`. CompletionProducer
    // remains a value-only `Layer.succeed`.
    expect(text).toContain("Layer.effect(\n      WorkProducer")
    expect(text).toContain("Layer.succeed(CompletionProducer")
  })

  it("effect-native-api.EFFECT_SERVICES.12 — producer services compose through Effect.provide and Effect.all", async () => {
    const layer = SubstrateProducerLive({
      streamUrl: "http://127.0.0.1:1/substrate/unreached",
    })

    const services = await Effect.runPromise(
      Effect.all({
        work: WorkProducer,
        completions: CompletionProducer,
      }).pipe(Effect.provide(layer)),
    )

    expect(Object.keys(services.work)).toEqual(["declareWork"])
    expect(Object.keys(services.completions).sort()).toEqual([
      "cancelCompletion",
      "rejectCompletion",
      "resolveCompletion",
    ])
  })
})
