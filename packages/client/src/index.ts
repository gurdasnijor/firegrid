// launchable-substrate-host.PACKAGING.3
// launchable-substrate-host.PACKAGING.7
// @durable-agent-substrate/client is the normal application-facing
// dependency. The first launchable slice ships the package boundary
// only; the Effect-native client root API (SubstrateClient,
// SubstrateClientLive, work.declare, choreography.scheduleAt,
// event-plane emit/read) lands in later slices.
export {}
