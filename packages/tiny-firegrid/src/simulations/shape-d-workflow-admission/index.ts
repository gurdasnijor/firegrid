import { defineSimulation } from "../../types.ts"
import { shapeDWorkflowAdmissionDriver } from "./driver.ts"
import { shapeDWorkflowAdmissionHost } from "./host.ts"

export default defineSimulation({
  id: "shape-d-workflow-admission",
  description:
    "tf-28b8: classify which target subscribers truly need Shape D workflow "
    + "machinery. Probe 1 tool execution (Activity memoization vs durable result "
    + "identity), Probe 2 wait routing (DurableDeferred mailbox vs durable "
    + "completion), Probe 3 scheduled prompt (DurableClock true-future delivery). "
    + "Each probe runs a Shape C arm (keyed handler over DurableTable) against a "
    + "Shape D arm over the real DurableStreamsWorkflowEngine and reports C or D.",
  host: shapeDWorkflowAdmissionHost,
  driver: shapeDWorkflowAdmissionDriver,
})
