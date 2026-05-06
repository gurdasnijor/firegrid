# CA3 Fireline / Firepixel Bridge Handoff

Date: 2026-05-06
Owner: CA3 handoff
Scope: Fireline bridge smokes, Firepixel package-consumption reports/docs, and cross-repo package bridge closeout

## Summary

CA3 closed the Fireline bridge proof wave and the Firepixel/Firegrid coverage rollup docs. The key outcome is that Firegrid package consumption is now proven from three directions:

- Firegrid proves its own packed client/substrate/runtime artifacts and external consumers.
- Firepixel proves Firegrid package consumption plus product-shaped terminalization, permission, and tool-result smokes.
- Fireline proves an external Fireline-shaped bridge over packed Firegrid client/runtime/substrate artifacts with permission, prompt chunk, and tool paths.

No implementation work is currently assigned to CA3. All CA3-owned worktrees from this wave were cleaned after coordinator merge confirmations.

## Merged Ledger

### Firegrid PKG1-PKG2C

| PR | Merge | What It Proved |
| --- | --- | --- |
| #100 | `c54ac406` | Packed `@firegrid/client` + `@firegrid/substrate` external client consumer. |
| #101 | `4aa0fb2` | Packed `@firegrid/runtime` + substrate external runtime consumer. |
| #102 | `e6c00e9` | Runtime pack smoke hardening and runtime artifact checks. |
| #103 | `e039e72` | Expanded runtime pack smoke forbidden-token guard. |
| #104 | `b46e9e2` | Firegrid package-consumption coverage rollup in `docs/SDD_FIREGRID_CLIENT_API.md`. |

### Firepixel FPX2-FPX8

| PR | Merge | What It Proved |
| --- | --- | --- |
| #121 | `0fb2150` | Firegrid client package-consumption smoke from Firepixel. |
| #122 | `d04aa48` | Firegrid runtime package-consumption smoke from Firepixel. |
| #123 | `e0b4924` | Runtime terminalization through packed Firegrid client/runtime/substrate. |
| #124 | `de5a53c` | Permission wait terminalization through EventPlane, RunWait, projection-match, and public client result. |
| #125 | `3a90e43` | Public `client.observe(...)->Pending` gate before approval decision writes. |
| #126 | `b894f76` | Rejected permission path terminalizes as typed Firepixel operation failure. |
| #127 | `17b0ffa` | Tool completed/failed result terminalization through smoke-local Firepixel EventPlane schemas. |
| #128 | `95df5de` | Expanded forbidden-token source guards across Firegrid package-consumption smokes. |
| #129 | `4ba3977` | Firepixel package-consumption coverage rollup in `docs/sdds/firegrid-package-consumption.md`. |

### Fireline FLX1-FLX9

| PR | Merge | What It Proved |
| --- | --- | --- |
| #913 | `257a878` | Fireline integration audit and smallest safe bridge direction. |
| #914 | `96dfa21` | Initial `examples/firegrid-bridge-smoke` package-consumption bridge. |
| #915 | `4241163` | Pinned Firegrid SHA checkout verification in the smoke. |
| #916 | `b7dbcf7` | Real `@firegrid/runtime` + `Firegrid.composeRuntime` + `run` bridge. |
| #917 | `38abf12` | Permission approval wait through app-owned EventPlane/RunWait/projection-match. |
| #918 | `462469d` | Permission denial path terminalizes through typed failure/result. |
| #919 | `d900197` | Prompt chunk path through public Firegrid surfaces. |
| #920 | `7599f32` | Tool invocation request/result path through app-owned EventPlane rows. |
| #921 | `d82b5d7` | Tool failure path maps to typed bridge failure output. |
| #922 | `78de5ce` | Public `client.observe(...)->Pending` gate before external permission/tool writes. |
| #923 | `5f3e7d4` | Prompt chunk replay exactness hardening. |
| #924 | `af0c134` | Source-level forbidden-token guard for checked-in bridge smoke. |
| #925 | `c58a9ce` | Expanded forbidden bridge token list. |
| #926 | `c56de5a` | Fireline bridge smoke coverage rollup in `examples/firegrid-bridge-smoke/README.md`. |

## Current Evidence

Fireline bridge coverage now includes:

- packed `@firegrid/client`, `@firegrid/runtime`, and `@firegrid/substrate` from a pinned SHA-checked Firegrid ref;
- local packed `@fireline/client` consumption from an external-style temporary consumer;
- `Firegrid.composeRuntime` and `run({ connection, runtime })`;
- explicit subscribers, handlers, `RunWait.layer`, `triggerMatchersLayer`, and EventPlane/EventStream layers;
- approved and denied permission waits;
- public `Pending` observation before decision/result writes;
- prompt chunk replay for expected session chunk pairs;
- tool invocation success and failure paths;
- pre-run forbidden-token source scanning.

Firepixel coverage now includes:

- packed Firegrid client/runtime/substrate package-consumption smokes;
- runtime terminalization through public Firegrid client/runtime composition;
- permission approval and rejection through Firepixel-owned EventPlane rows and typed operation channels;
- tool completed and failed result paths through smoke-local Firepixel tool EventPlane schemas;
- expanded forbidden-token guards across package-consumption smoke sources;
- SDD coverage rollup documenting explicit deferrals.

## Cleanup Status

Cleaned CA3 worktrees and local branches after merge confirmation:

- Firegrid: `effect-artifact-inventory`, `q3-schema-codec`, `q8-state-machine-shim-removal`, `w2a-invocation-boundary-audit`, `w4c-substrate-execution-services-boundary`, scenario lanes, FL/FP docs lanes, PKG2C.
- Firepixel: FPX7 scope report, FPX7A, FPX8.
- Fireline: FLX1-FLX7D, FLX9, including bridge smoke review/scope worktrees owned by CA3.

Live unrelated PRs at closeout:

- Firegrid: none.
- Firepixel: #119 and #108.
- Fireline: #912.

Local note: do not assume primary checkouts are clean or current. Use fresh worktrees from the requested remote base for any new lane.

## Guardrails

Keep these out of app-facing bridge or smoke code:

- `durable.run`
- `@firegrid/substrate/kernel`
- `Choreography`
- `DurableWaitsLive`
- `WorkProducer`
- `SubstrateProducer`
- `processReadyWorkItem`
- `attemptClaim`
- `completeRun`
- `failRun`
- `blockRun`
- `resolveCompletion`
- `createPendingCompletion`
- `startRun`
- `client.work.declare`
- `FIREGRID_RUNTIME_MODULE`
- `firegrid dev`

Do not introduce:

- local sibling Firegrid dependencies;
- `workspace:` dependencies in external consumers;
- checked-in tarballs;
- unpublished npm assumptions;
- direct terminal row authorship;
- fake terminal rows or raw durable run appends;
- provider lifecycle, browser UI, broad registries, retries, cancellation, credentials, or reusable adapter packages unless the lane explicitly scopes and specs them.

## Next-Wave Advice

Start next integrations as read-only feasibility reports unless the public seam is obvious. The target called out by coordinator is:

```text
https://github.com/smithery-ai/flamecast-agents
```

Recommended `flamecast-agents` first pass:

1. Inspect public package exports, examples, and any CLI/runtime entrypoints.
2. Identify whether the repo exposes typed descriptors or only product-specific process/transport flows.
3. Map public seams to current Firegrid surfaces: `@firegrid/client`, `@firegrid/runtime`, `@firegrid/substrate`, `@firegrid/substrate/event-plane`, `RunWait`, `Firegrid.composeRuntime`, and EventStream/EventPlane descriptors.
4. Propose one smallest smoke: one operation/session, one app-owned event or state row, one typed output or typed error.
5. Stop with a blocker if the only path requires provider lifecycle, credentials, registry discovery, browser UI, dev-server launchers, or direct internals.

Acceptable validation shape:

- temporary external consumer;
- packed Firegrid artifacts;
- no sibling path dependencies;
- smoke-local app schemas;
- `DurableStreamTestServer` if local stream infrastructure is needed;
- public `client.send`, `client.observe`, `client.result`, `client.emit`, and `client.events`;
- explicit runtime composition with `Firegrid.composeRuntime` and `run`;
- public `RunWait`, `projectionMatch`, and EventPlane layers;
- typed success/error assertions through `client.result`;
- source forbidden-token scan if checked-in smoke source is added.

Reviewers should require the same bar as the just-closed bridge wave: green CI, CLEAN merge state, no hidden product semantics, and explicit deferrals in docs when the smoke intentionally avoids broader lifecycle or adapter work.
