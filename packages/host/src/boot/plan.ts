// launchable-substrate-host.HOST_CONFIGURATION.1
// launchable-substrate-host.HOST_CONFIGURATION.2
// launchable-substrate-host.HOST_CONFIGURATION.3
// launchable-substrate-host.HOST_CONFIGURATION.4
// launchable-substrate-host.HOST_CONFIGURATION.5
// launchable-substrate-host.HOST_CONFIGURATION.6
//
// `SubstrateHostBootPlan` is the resolved tagged union the host
// runtime consumes. Boot plans can be built from explicit options or
// decoded from Effect Config (see ./from-config.ts). Missing stream
// URL selects embedded-dev mode; a configured URL selects attached
// mode and the host does NOT own the remote Durable Streams process.
export type BootMode = "embedded-dev" | "attached"

export interface EmbeddedDevHostPlan {
  readonly _tag: "EmbeddedDevHost"
  readonly processId: string
  readonly headers: Readonly<Record<string, string>>
  readonly durableStreams: {
    readonly host: string
    readonly port: number
    readonly streamName: string
  }
}

export interface AttachedHostPlan {
  readonly _tag: "AttachedHost"
  readonly processId: string
  readonly headers: Readonly<Record<string, string>>
  readonly streamUrl: string
}

export type SubstrateHostBootPlan = EmbeddedDevHostPlan | AttachedHostPlan

export const bootModeOf = (plan: SubstrateHostBootPlan): BootMode =>
  plan._tag === "EmbeddedDevHost" ? "embedded-dev" : "attached"
