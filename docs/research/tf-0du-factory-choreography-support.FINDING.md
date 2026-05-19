# FINDING — tf-0du factory choreography support (3 full-§6 gaps)

Status authority: bead `tf-0du`. Governing contract:
`docs/sdds/SDD_FIREGRID_SCHEMA_PROJECTION_CONTRACT.md` +
`firegrid-typed-wait-source-redesign` feature. Contract treated as
non-negotiable; HALT-RULE applied where additive build would breach it.

## Gap 1 — wait_for caller-owned facts — DELIVERED (load-bearing)

Built additively at the correct layers, full CI gate green
(typecheck 17/17, lint, lint:deps boundary clean, lint:dead, lint:dup,
test 16/16):

- **Protocol (source of truth)** `packages/protocol/src/agent-tools/schema.ts`:
  `RuntimeWaitSourceSchema` gains a third typed variant
  `{ _tag: "CallerFact", stream }`. The expression carries only a stream
  NAME — no DurableTable facade / table-taking helper — so TYPED_SOURCES.4
  holds; CONTEXT.3 (caller-owned, not runtime-authority internal) honored.
  `whereFields` stays on `RuntimeWaitQuerySchema` (unchanged matching).
- **Execution** `packages/runtime/src/durable-tools/internal/`:
  matching `CallerFactWaitSourceSchema` variant in `types.ts`; new
  router-private host-composition capability `CallerOwnedFactStreams`
  (Context.Tag, consumed by `RuntimeWaitStreamsLive` via
  `Effect.serviceOption` — optional, absent ⇒ empty stream ⇒ the wait
  times out, never crashes the router); `RuntimeWaitStreams.callerFact`
  field; one `Match.tag("CallerFact", …)` arm in the wait router
  `streamForWait`. Exported from `@firegrid/runtime/durable-tools`.
- **Agent-tool binding path** (`tool-use-to-effect.ts`): the existing
  `WaitFor.match({ source: input.waitQuery.source, … })` now carries
  `CallerFact` through unchanged; the `contextId`-predicate guard was
  already scoped to `AgentOutput`, so `CallerFact` is correctly unaffected.

This is the path the dark-factory **agent** actually uses (`wait_for` is an
MCP agent tool): protocol → execution → router is wired and validated, so
the factory loop can durably wait on app-owned facts (human approvals, CI
status, PR events, merge decisions) once a host composition binds its
caller-owned collection to `CallerOwnedFactStreams` by name.

### Gap 1 remaining scope (NOT a contract violation — additional binding)

`client-sdk` `session.wait.for` over caller-owned facts (SDD vision) was
NOT added in this slice. It needs a protocol session-facade wait schema +
a browser-safe observation of the caller-owned collection through a
protocol-owned table. It is additive binding surface, lower-leverage than
the agent-tool path (agents use the tool, not the client SDK, to drive the
loop). Deferred to keep this PR validated and reviewable; recommend a
follow-on bead. The host-composition wiring that binds a concrete app
collection (e.g. dark-factory `darkFactory.facts`) to
`CallerOwnedFactStreams` is likewise consumer wiring, not this capability.

## Gap 2 — session.cancel / session.close — HALT-AND-SURFACE

Cannot be built as an additive capability. There is **no existing durable
session-lifecycle cancel/close control intent or reconcile seam**:

- `RuntimeIngressKind` has no cancel/close kind (`"cancelled"` is a
  delivery status, not a lifecycle intent).
- `runtime-context-workflow-core.ts` has no interrupt/cancel/terminal
  transition.
- The engine registry only has host-local `closeActiveEngine` /
  `deregister` (scope close) — not a durable, reconcilable, cross-host
  observable session terminal state.

Implementing real cancel/close requires **new substrate design**: a durable
session-lifecycle intent (protocol), a workflow/engine terminal-transition
+ reconcile path that survives host generations, and terminal-state
propagation observable through snapshot/wait. That is beyond "ADD at the
correct layer respecting the existing split" and shipping a no-op/local-only
cancel would paper the gap. HALTED per the dispatch HALT-RULE. Recommend a
dedicated SDD-scoped bead (durable session-lifecycle intent + reconcile).

## Gap 3 — execute provider side-effects — HALT-AND-SURFACE

Cannot be wired additively at the agent-tool-host seam. `executeSandboxTool`
/ `executeSessionCapability` need `SandboxProvider`, but
`HostRuntimeContextExecutionEnv` (the env captured by the
`agent-tool-host-live.ts` seam) **deliberately excludes** `SandboxProvider`
(TFIND-031 comment in `runtime-substrate.ts`: host-level seams must NOT
capture the wider set; `SandboxProvider` is provided execution-scoped only
inside the workflow support layer). Wiring provider execution at this seam
requires widening a deliberately-narrowed host execution boundary — a
substrate-boundary change, not additive, and it risks the exact boundary
TFIND-031 / the SDD protect. HALTED per the HALT-RULE. Resolution options
for the architect (each non-additive): (a) execute provider side-effects on
the workflow-support-scoped seam where `SandboxProvider` is legitimately
ambient, routing `execute` lowering there instead of the host seam; or
(b) introduce a narrow protocol-owned provider-capability service the host
composition supplies (mirroring the Gap-1 `CallerOwnedFactStreams`
optional-capability shape) so the agent-tool seam never widens its capture.
Agent-tool binding + host execution only — no client `execute` method
(correctly absent from the client catalog).

## Net

Gap 1 (the explicitly load-bearing #1) is delivered, contract-clean, full
CI green, no `lint:deps` boundary violation. Gaps 2 & 3 are surfaced as
findings with the precise blocking boundary and the design each needs —
not papered, not violated. Coordinator/architect holds the gate; no
self-merge. Recommend two follow-on SDD-scoped beads (Gap 2 durable
lifecycle intent; Gap 3 provider-capability seam placement) + one
binding-scope bead (Gap 1 client `session.wait.for`).
