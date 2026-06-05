import { Before } from "@cucumber/cucumber"
import type { FluentWorld } from "./world.ts"

/**
 * `@real-agent` scenarios must launch a real native/ACP agent harness — a fake
 * recorder/codec is NOT accepted as acceptance proof. Until the live lane is
 * available (creds + a real harness), these scenarios are skipped with a clear
 * precondition rather than failing. Enable with `FIREGRID_REAL_AGENT=1`.
 */
Before({ tags: "@real-agent" }, function (this: FluentWorld) {
  if (process.env.FIREGRID_REAL_AGENT !== "1") {
    this.log(
      "precondition not met: @real-agent live lane disabled. "
        + "Set FIREGRID_REAL_AGENT=1 (with native/ACP agent creds) to run this scenario.",
    )
    return "skipped" as const
  }
  this.realAgentEnabled = true
  return undefined
})
