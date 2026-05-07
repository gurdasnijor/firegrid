import { Effect } from "effect"
import { expect, it } from "vitest"
import { makeInMemoryDurableClockWakeupStore } from "./durable-clock/index.ts"

it("keeps durable Clock as the Firegrid runtime primitive", async () => {
  const store = makeInMemoryDurableClockWakeupStore()
  await Effect.runPromise(
    store.appendWakeup({
      id: "wakeup-1",
      scope: "runtime-test",
      deadlineMs: 10,
      appendedAtMs: 0,
    }),
  )

  await Effect.runPromise(store.markDispatched("wakeup-1"))
  await expect(Effect.runPromise(store.snapshot())).resolves.toMatchObject([
    { id: "wakeup-1", status: "dispatched" },
  ])
})
