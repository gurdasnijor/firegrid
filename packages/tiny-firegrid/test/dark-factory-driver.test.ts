import { describe, expect, it } from "vitest"
import { darkFactoryStopReasonFromText } from "../src/simulations/dark-factory/driver.ts"

describe("dark-factory driver stop predicate", () => {
  it("firegrid-dark-factory-app.CHOREOGRAPHY.3 detects terminal and finding markers without provider cycles", () => {
    expect(darkFactoryStopReasonFromText("progress only")).toBeUndefined()
    expect(
      darkFactoryStopReasonFromText("done\nDARK_FACTORY_TERMINAL success"),
    ).toBe("terminal")
    expect(
      darkFactoryStopReasonFromText(
        "blocked\nDARK_FACTORY_FINDING missing public surface",
      ),
    ).toBe("finding")
  })
})
