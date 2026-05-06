# Replatforming Harness

Status: draft

The first validation harness should be deterministic and small. Use it before
real provider adapters such as Claude Code or Think.

## Harness Requirements

- runs locally in CI;
- consumes packed Firegrid packages;
- uses only public Firegrid surfaces;
- uses a deterministic test agent/provider;
- writes app-owned EventStream/EventPlane descriptors;
- proves operation send, Pending observation, wait, external result append,
  wake, typed terminalization, replay, and query;
- can later be extended to host-shift and durable subscriber tests.

## Package Consumption Rules

The harness must:

- pin a 40-character Firegrid SHA;
- assert `git rev-parse HEAD` equals the pin;
- build and pack `@firegrid/substrate`, `@firegrid/client`, and
  `@firegrid/runtime` as needed;
- install with `file:<absolute-tmp-path>` tarball specifiers;
- use `pnpm.overrides` for transitive `@firegrid/substrate` when required;
- reject `workspace:`, `link:`, `../firegrid`, committed dist, and committed
  tarballs;
- scan for forbidden internal/source tokens.

## First Smoke

The substrate-only minimum flow is still useful for package-consumption and
runtime mechanics:

```text
client sends operation
runtime handler emits app-owned request row
client/test observes Pending or request visibility
external writer appends app-owned result row
RunWait/projection-match wakes handler
handler returns typed success or typed failure
client.result observes terminal value
client.events/projection query replays durable history
```

The smoke should not use provider credentials, WorkOS, real browser automation,
real customer webhooks, sandbox lifecycle, or product cleanup paths.

## First Product-Shaped Litmus

The higher-value Flamecast proof is `LT-02-local-runtime-session-loop.md`.
It should keep the Flamecast web UI as the control surface while a local
Flamecast runtime process uses `@firegrid/runtime` to execute work through the
same durable topology.

Minimum flow:

```text
user starts session from Flamecast UI
Flamecast API lowers session work to app-owned Firegrid descriptors
local runtime composed with Firegrid.composeRuntime observes or claims work
runtime emits normalized Flamecast events
UI reads timeline through durable replay/live-tail
user sends follow-up from UI
runtime consumes durable follow-up/control row
handler terminalizes the next turn through return or typed Effect.fail
browser refresh replays the same session state
```

This proof should not bypass Flamecast's product API with a direct test client
unless the bypass is explicitly limited to harness setup.
