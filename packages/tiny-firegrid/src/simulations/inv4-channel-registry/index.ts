import { defineSimulation } from "../../types.ts"
import { inv4ChannelRegistryDriver } from "./driver.ts"
import { inv4ChannelRegistryHost } from "./host.ts"

export default defineSimulation({
  id: "inv4-channel-registry",
  description:
    "INV-4: host-declared channel registry with an opaque wait_for ChannelTarget.",
  host: inv4ChannelRegistryHost,
  driver: inv4ChannelRegistryDriver,
})
