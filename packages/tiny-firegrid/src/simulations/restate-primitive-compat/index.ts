import { defineSimulation } from "../../types.ts"
import { restatePrimitiveCompatDriver } from "./driver.ts"

export default defineSimulation({
  id: "restate-primitive-compat",
  description:
    "Workbench simulation mapping Restate sdk-gen Operation/Future combinators "
    + "onto Firegrid's lower durable substrate and emitting trace evidence for compat gaps.",
  launchHost: false,
  driver: restatePrimitiveCompatDriver,
})
