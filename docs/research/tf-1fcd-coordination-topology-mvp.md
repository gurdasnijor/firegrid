# tf-1fcd Coordination Topology MVP

This tiny-firegrid simulation shows the same deterministic item bench through
three coordination shapes:

- `monolithic`: one participant observes the item events and reports every item.
- `orchestrated`: a supervisor participant writes dispatch rows, workers read
  their assignments, and the supervisor gathers report rows.
- `choreographed`: peer participants read the shared item-event channel and
  deterministically partition work without supervisor dispatch.

The host owns one DurableTable-backed bench substrate and exposes item events,
worker actions, dispatch, and reports as channel contracts. Participant
identities are launched through
`Firegrid.sessions.createOrLoad(...).prompt(...).start()` with the primitive
runtime-context MCP profile enabled, reusing the tf-t47b launch surface. The
base MVP does not require provider-backed tool-use agents; no deterministic
fake LLM is used.
