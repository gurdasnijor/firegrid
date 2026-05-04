// launchable-substrate-host.PACKAGING.5
// @durable-agent-substrate/lab owns development inspection and scenario
// workbench UI. The first launchable slice ships the package boundary
// only; the Vite React app, scenario harnesses, inspector panels, and
// CLI entrypoint land in later slices.
//
// launchable-substrate-host.LAB_INSPECTOR.1
// launchable-substrate-host.LAB_INSPECTOR.6
// The lab is an example/dev application built on the same substrate
// client used by other consuming runtimes; it does not receive
// privileged write authority beyond the substrate client.
//
// launchable-substrate-host.SCENARIOS.6
// First-slice scenario harnesses live under packages/lab and are not
// exported from the production client root.
export {}
