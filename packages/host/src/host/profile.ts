// launchable-substrate-host.RUNTIME_COMPOSITION.1
// launchable-substrate-host.RUNTIME_COMPOSITION.3
// launchable-substrate-host.RUNTIME_COMPOSITION.8
// launchable-substrate-host.RUNTIME_COMPOSITION.9
//
// `SubstrateHostProfile` is the in-process configuration consumed
// by SubstrateHostLive. Profiles are ordinary values supplied at
// host construction time; the substrate host does NOT fetch
// profiles from durable state, nor does it dynamically import
// arbitrary modules. The current shape covers the timer and
// scheduled-work subscribers only; event-plane definitions,
// projection-match evaluators, operator programs, and provider /
// adapter layers are not yet wired and will be added when the
// corresponding profile kinds run.
export interface SubstrateHostProfile {
  readonly subscribers?: {
    readonly timer?: boolean
    readonly scheduledWork?: boolean
  }
}

export const emptyProfile: SubstrateHostProfile = {}
