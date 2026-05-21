import { defineSimulation } from "../../types.ts"
import { durableChannelsSyncAsyncDriver } from "./driver.ts"
import { durableChannelsSyncAsyncHost } from "./host.ts"

export default defineSimulation({
  id: "durable-channels-sync-async-spike",
  description:
    "tf-lfxs: one-trace validation of sync call-style reflection barrier plus async send/wait_for durable mailbox.",
  host: durableChannelsSyncAsyncHost,
  driver: durableChannelsSyncAsyncDriver,
})
