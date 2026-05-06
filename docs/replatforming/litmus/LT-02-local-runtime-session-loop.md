# LT-02: Local Runtime Session Loop

Status: draft scenario

This litmus test proves the first product-shaped Flamecast-on-Firegrid
experience. It is intentionally stronger than a substrate-only smoke: the
Flamecast web UI remains the user control surface while a local runtime process
executes the session through Firegrid public runtime mechanics.

## Target Story

1. A user opens `flamecast.dev/ui` and starts a session with a local
   runtime-backed provider.
2. Flamecast accepts the product request through its normal API and lowers the
   session work into app-owned Firegrid descriptors.
3. A local Flamecast runtime process built on `@firegrid/runtime` connects to
   the same durable stream topology.
4. The local runtime composes handlers, subscribers, EventPlane layers,
   EventStream emitters, and wait layers through `Firegrid.composeRuntime`.
5. The runtime claims or observes the durable work, executes a deterministic
   test provider, emits normalized Flamecast session events, and terminalizes
   the turn through handler return or typed `Effect.fail`.
6. The Flamecast web UI shows the session timeline, runtime state, and terminal
   result through durable reads rather than private runtime transport.
7. The user sends a follow-up message from the UI. That input becomes a durable
   prompt, steering, or control row that the local runtime can pick up without
   the UI knowing the runtime's private transport details.

## Architecture Shape

```text
Flamecast web UI
  -> Flamecast API and auth shell
  -> app-owned Operation / EventStream / EventPlane descriptors
  -> Firegrid durable substrate
  -> local Flamecast runtime process using @firegrid/runtime
  -> normalized Flamecast events and typed terminalization
  -> Flamecast web UI query/replay/live-tail
```

The local process is not a generic Firegrid agent. It is a Flamecast-owned
runtime adapter process that consumes Firegrid primitives. Firegrid provides the
durable operation, event, wait, projection, runtime, presence, and tracing
mechanics. Flamecast owns session, provider, event, prompt, permission,
credential, and UI semantics.

## Required Proofs

- the UI can start a session against a local/runtime-backed provider;
- the runtime process is discoverable or selectable without exposing private
  host transport as a product API;
- runtime code uses `@firegrid/runtime` in a Node tier and the browser/Worker
  path uses only browser-safe Firegrid client surfaces;
- all Flamecast session events are app-owned EventStream or EventPlane content;
- UI timeline reads use durable query/replay/live-tail mechanics, not a direct
  local runtime socket;
- follow-up UI messages lower to durable intent, steering, or control rows;
- the runtime reaches blocked-pending or request-visible state before external
  result rows are appended in the harness;
- terminalization uses handler return or typed `Effect.fail`;
- stopping and restarting the local runtime does not lose durable session
  history or make the UI lose the session handle.

## Platform Capabilities Exercised

This litmus should cite and exercise these Firegrid capability lanes once their
Acai specs exist:

- `firegrid-platform-invariants.*`
- `flamecast-product-contract.*`
- `firegrid-agent-runtime-substrate.*`
- `firegrid-projection-query.*`
- `firegrid-client-projection-api.*`
- `firegrid-runtime-presence.*`
- `firegrid-claimed-intent-transport.*`
- `firegrid-observability.*`

Durable subscriber/webhook and ownership-transfer lanes are not required for
the first LT-02 proof. They become relevant when the local runtime receives
external callbacks or when the session shifts to another host.

## Suggested Harness

Use a deterministic local provider before attempting Claude Code or Think:

```text
user starts session from UI
Flamecast API creates app-owned session operation
local runtime observes or claims work
runtime emits user_message and turn_started
runtime waits for a deterministic provider result or computes one inline
runtime emits assistant_message and turn_complete
UI reads timeline and terminal session state
user sends follow-up from UI
runtime picks up the durable follow-up row and completes a second turn
```

The first harness may run the Flamecast API and UI against a test topology or a
local development instance, but it should preserve the same boundary:
Firegrid is the durable substrate; Flamecast owns the public product API and UI.

## Success Criteria

LT-02 is successful when a reviewer can use the Flamecast UI to:

1. create a local-runtime-backed session;
2. watch events stream into the session timeline;
3. send a follow-up message without reconnecting or restarting the runtime;
4. refresh the browser and replay the same session state from durable data;
5. stop and restart the local runtime process, then complete another turn.

## Non-Goals

LT-02 does not prove full local-to-remote host shift; LT-01 covers that. It does
not require live process migration, real provider credentials, WorkOS changes,
customer webhook delivery, Standard Webhooks signing, provider callback tokens,
or sandbox lifecycle replacement.

