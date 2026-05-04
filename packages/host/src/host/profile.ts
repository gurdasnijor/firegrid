// launchable-substrate-host.RUNTIME_COMPOSITION.1
// launchable-substrate-host.RUNTIME_COMPOSITION.2
// launchable-substrate-host.RUNTIME_COMPOSITION.3
// launchable-substrate-host.RUNTIME_COMPOSITION.8
//
// `SubstrateHostProfile` is the in-process configuration consumed by
// SubstrateHostLive. Profiles are ordinary Effect layers and values
// supplied at host construction time; the substrate host does NOT
// fetch profiles from durable state, nor does it dynamically import
// arbitrary modules. Slice 4 only commits to the structural placeholder;
// the subscriber/operator/event-plane fields are populated by Slice 5+.
export interface SubstrateHostProfile {
  readonly subscribers?: {
    readonly timer?: boolean
    readonly scheduledWork?: boolean
  }
}

export const emptyProfile: SubstrateHostProfile = {}
