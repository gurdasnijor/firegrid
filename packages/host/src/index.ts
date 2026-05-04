// launchable-substrate-host.PACKAGING.4
// launchable-substrate-host.PACKAGING.8
// @durable-agent-substrate/host owns launchable process wiring. The
// first launchable slice ships the package boundary only; the
// Effect-native launch and composition API (SubstrateHost.attached,
// SubstrateHost.embeddedDev, SubstrateHost.bootPlanFromConfig,
// SubstrateHost.withHost, SubstrateHostLive, diagnostics) lands in
// later slices.
//
// launchable-substrate-host.PACKAGING.9
// A separate CLI or dev package is deferred until host process-launch
// concerns outgrow this package.
export {}
