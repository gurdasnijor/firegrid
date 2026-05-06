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

Minimum flow:

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
