// Shared between host (binds) and driver (connects). The firelab runner can't
// thread a host-assigned random port to the static driver Effect, so the sim
// fixes one.
export const WORKBENCH_PORT = 39517
