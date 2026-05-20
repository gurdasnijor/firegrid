import { describe, expect, it } from "vitest"
import {
  FiregridRuntimeObservationSourceNames,
} from "../../src/observations/schema.ts"
import {
  FiregridRuntimeObservationSourceNames as AgentToolsObservationSourceNames,
} from "../../src/agent-tools/schema.ts"

describe("runtime observation source names", () => {
  it("firegrid-schema-projection-contract.CLIENT_PROJECTION.6 exports source names from the neutral protocol observation module", () => {
    expect(FiregridRuntimeObservationSourceNames.agentOutputEvents).toBe(
      "firegrid.runtime.agent-output-events",
    )
    expect(AgentToolsObservationSourceNames).toBe(
      FiregridRuntimeObservationSourceNames,
    )
  })
})
