# Next-Wave Sequencing

## Phase 1: Close Firewall Invariants

Goal: reduce substrate-boundary debt to zero or one named no-behavior shim.

Parallel lanes:

1. Runtime context workflow spine: move execution mechanics below runtime line.
2. Control-plane spine: move/hide control request dispatcher under runtime.
3. Tool execution spine: move common tool execution to runtime-owned services.
4. Host-sdk export audit: stop exporting substrate internals.
5. Methodology/examples sweep: remove `hostProjectionObserver` as taught API.
6. Guardrail lane: ratchet `.dependency-cruiser.cjs` after each merge.

Acceptance:

- `pnpm run lint:deps`;
- currentHostSdkSubstrateDebt shrinks or a finding explains why it cannot;
- runtime imports no host-sdk;
- client-sdk imports no runtime.

## Phase 1.5: Surface Hygiene Pass

This pass should happen before adding new private-beta public surface.

Work:

- Gate A barrel-export audit;
- Gate B cannon completeness check;
- Gate C methodology/examples sweep;
- Gate D span-name contract baseline;
- Gate E operation/schema single-source cleanup;
- refresh or retire stale package architecture docs;
- fix `arch:deps:client` so client-sdk diagrams are regenerable.

Why this phase exists: Phase 2 introduces external triggers and side-effect
adapters. Adding them before public-surface cleanup increases the number of
examples and docs that can copy old substrate paths.

## Phase 2: Private-Beta Functional Loop

Goal: demonstrate one real end-to-end loop with correct architectural
placement.

Recommended story:

```text
Linear webhook
  -> runtime verified ingest
  -> protocol-owned webhook fact schema
  -> host/app LinearWebhookChannel
  -> planner wait_for(channel)
  -> GitHub or Linear side-effect adapter
  -> observable session trace
```

Sequence:

1. protocol schema first;
2. runtime verified ingest;
3. host/app channel binding;
4. app/cookbook composition;
5. deterministic tiny-firegrid smoke;
6. one live-provider smoke if credentials are available.

Choose one side-effect adapter first: Linear or GitHub, not both.

## Phase 3: Performance And Hardening

Goal: make the beta reliable and measurable.

Work:

- establish `simulate:perf` baselines for the public data-plane tour and factory
  smokes;
- split stream-wait wall time from active self-time in perf output;
- open engine-native `streamWait` / `streamWaitAny` if Firegrid overhead
  approaches a meaningful fraction of provider/model latency, or if another
  workflow-body composition leak appears;
- harden tiny-firegrid runner failure propagation;
- reduce flaky/concurrent test risk on beta-critical paths.

## Explicit Deferrals

Do not block private beta on:

- `session_new_all` unless repeated `session_new` is measured as insufficient;
- engine-native primitives if current workflow-backed waits are correct and
  overhead is acceptable;
- post-beta `@firegrid/agent-tools` package extraction;
- `FiregridRuntimeHostLive` rename.

## Coordinator Dispatch Template

Use this shape for each lane:

```text
READ:
  docs/cannon/architecture/host-sdk-runtime-boundary.md
  docs/handoffs/sprint-to-private-beta/architecture/<relevant concern>.md
  .dependency-cruiser.cjs currentHostSdkSubstrateDebt

SCOPE:
  one spine / one public-surface leak / one projection catalog only

ACCEPTANCE:
  focused tests
  pnpm run lint:deps
  rg proving the old import/export/path is gone
  carveout reduced or finding explaining why not
  no runtime -> host-sdk import
  no client-sdk -> runtime import
```

