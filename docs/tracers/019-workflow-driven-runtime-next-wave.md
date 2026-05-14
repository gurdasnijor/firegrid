# 019: Workflow-Driven Runtime Next Wave

Status: Planning sequence for the next production-shaped tracers after
`firegrid-workflow-driven-runtime` Phase 1 and Phase 2.

This document does not replace
`features/firegrid/firegrid-workflow-driven-runtime.feature.yaml`. The feature
spec remains the source of truth. This tracer plan translates the current ACIDs
into concrete product proofs and shows which work can run in parallel.

## Current Direction

The runtime context lifecycle is owned by workflow execution, not by a
standalone context-status state machine:

```txt
RuntimeContext row
  durable identity and launch intent

RuntimeContextWorkflow(contextId)
  lifecycle authority for starting/resuming one runtime context

runRuntimeContext activity
  external side-effect boundary for one runtime attempt

RuntimeRunEvent / RuntimeOutputTable / RuntimeIngressTable
  durable evidence and input/output facts
```

Do not add `RuntimeContext.status` as the next correctness mechanism. That
proposal is historical unless a future HostWorkflow design proves that workflow
identity and explicit work rows are insufficient.

## Wave Goals

The next work should answer product questions, not retest library primitives:

1. Can two hosts race to start the same runtime context without double-running
   the agent?
2. Can `firegrid:run` drive a real local process with cwd, prompt, and env
   bindings through the same durable planes as ordinary runtime execution?
3. Can the runtime host use DurableClock-backed workflows for delayed behavior
   without a Firegrid-owned timer table?
4. Can a future host supervisor initiate context workflows without becoming the
   side-effect owner?
5. Can agent-facing durable tools expose Firegrid capabilities without making
   products hand-code orchestration state machines?
6. Can inbound webhooks become durable facts without introducing a parallel
   Firegrid HTTP service?

## RFC Alignment Lens

The external stream-first agent substrate RFC under
`docs/rfc/external/durable-stream-agent-plaform-rfc` is an aspirational
conformance lens, not a Firegrid implementation spec. Use it to sharpen tracer
acceptance criteria, but do not copy Fireline-specific implementation shapes
unless a Firegrid product path needs them.

Near-term Firegrid should conform to the RFC in these areas:

- durable facts are the source of truth; projections and live handles are not
  alternate truth;
- prompt/input intent is durable before adapter/provider side effects;
- multi-worker external side effects are fenced before execution;
- replay and retained-state recovery do not re-run side effects;
- secret values stay out of durable rows and out of launched-agent ambient env
  unless explicitly authorized;
- async webhook/mailbox-style inputs become durable facts first and are bridged
  into prompt/session work only through explicit audited logic;
- tool descriptors expose only `{ name, description, inputSchema }`; transport,
  credentials, host ids, provider internals, and Durable Streams URLs remain
  host-side authority;
- provider handles and durable resource identities are not proof of live
  promptability after restart.

RFC areas to defer:

- full session/prompt adapter conformance until Firegrid introduces an ACP or
  session-shaped adapter path;
- required-action/approval middleware until concrete tool-call interception is
  available;
- conductor/middleware topology until a product needs protocol-aware routing;
- provider reattach profiles beyond local-process until the first remote
  `SandboxProvider` lands.

## Tracer A: Duplicate Start Does Not Duplicate Runtime Side Effects

Linked ACIDs:

- `firegrid-workflow-driven-runtime.PHASE_1_CONTEXT_WORKFLOW.1`
- `firegrid-workflow-driven-runtime.PHASE_1_CONTEXT_WORKFLOW.3`
- `firegrid-workflow-driven-runtime.PHASE_1_CONTEXT_WORKFLOW.4`
- `firegrid-workflow-driven-runtime.PHASE_3_ACTIVITY_CLAIMS.1`
- `firegrid-workflow-driven-runtime.PHASE_3_ACTIVITY_CLAIMS.2`
- `firegrid-workflow-driven-runtime.PHASE_3_ACTIVITY_CLAIMS.3`
- `firegrid-workflow-driven-runtime.VALIDATION.1`

Product setup:

1. Create one `RuntimeContext` row for a local process command.
2. The command emits a unique marker and exits.
3. Start two independently acquired runtime-host layers/workers against the same
   namespace.
4. Call `startRuntime(contextId)` concurrently from both workers.

Acceptance evidence:

- Exactly one external child process execution occurs for the context attempt.
- Both callers converge on the same terminal runtime result or durable evidence.
- `RuntimeControlPlaneTable.runs` contains one started event and one terminal
  event for the attempt.
- `RuntimeOutputTable` contains one copy of the unique marker.
- Workflow activity claims are the side-effect fence; there is no separate
  context mutex.
- The activity-claim path does not silently treat the local worker as winner
  when claim materialization cannot be observed.
- The normal claim-observation path does not use fixed sleep polling.
- Replaying or re-invoking a completed context workflow returns retained
  evidence and does not start a second child process.

Implementation notes:

- This tracer may harden `packages/runtime/src/workflow-engine/internal`
  internals.
- This tracer should not add `RuntimeContext.status`.
- This tracer should not add a generic `DurableClaim` public API unless the
  activity-claim migration proves a reusable surface is necessary.

Parallelization:

- Owns `packages/runtime/src/workflow-engine/**` and targeted runtime-host
  tests.
- Should not run in parallel with another branch editing workflow-engine claim
  internals.

## Tracer B: Sync Run Prompt, Cwd, And Env Bindings Use Durable Planes

Linked ACIDs:

- `firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.1`
- `firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.2`
- `firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.3`
- `firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.4`
- `firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.5`
- `firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.6`
- `firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.7`
- `firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.8`
- `firegrid-workflow-driven-runtime.VALIDATION.2`

Product setup:

Run a local agent command through `pnpm firegrid:run` with:

```txt
--cwd <tmp-workdir>
--prompt <prompt-text>
--secret-env CHILD_ENV=PARENT_ENV
-- <agent command...>
```

The child process should:

- verify `process.cwd()`;
- read stdin;
- read the injected env var;
- emit only non-secret markers or digests.

Acceptance evidence:

- A `RuntimeContext` row is created through the sync-run path.
- The row contains `runtime.config.cwd`.
- The row contains env binding refs only, never resolved secret values.
- A `RuntimeIngressTable.inputs` row is created before `startRuntime`.
- The prompt reaches the child through local-process stdin delivery.
- The child output proves cwd, prompt, and env binding behavior without printing
  raw secret values.
- The launched child cannot read host-only secret env vars such as the parent
  env var named by `--secret-env`, or the Durable Streams token used by the
  Firegrid host. Only the authorized child env name is visible.
- `RuntimeOutputTable` records the output through the normal runtime output
  path.
- The sync command exits with the child exit code.

Implementation notes:

- This tracer is now mostly covered by the merged Phase 2 work; the remaining
  useful extension is an opt-in Electric Cloud smoke using the same command
  shape plus the env-containment proof above.
- Do not add a separate sync-run composition root.

Parallelization:

- Can run in parallel with Tracer A if it does not edit workflow-engine internals.
- Owns root `src/run.ts`, sync-run tests, and runbook/smoke docs.

## Tracer C: Electric Cloud Runtime Smoke

Linked ACIDs:

- `firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.3`
- `firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.4`
- `firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.5`
- `firegrid-workflow-driven-runtime.PHASE_2_SYNC_RUN.8`
- `firegrid-workflow-driven-runtime.VALIDATION.2`

Product setup:

Run the same `firegrid:run` command against an Electric Cloud Durable Streams
service URL and token.

Acceptance evidence:

- The runtime provisions or reuses all required streams remotely.
- The control-plane, ingress, workflow, and output streams are all written under
  the configured namespace.
- The command can be run with a stable namespace for retained-state inspection.
- The command can also be run with a fresh smoke namespace for repeatable local
  development.
- No token or secret value is printed by Firegrid.
- The token required to connect the Firegrid host to Electric Cloud is not
  visible to the launched agent process.

Implementation notes:

- This tracer should be opt-in and credential-gated.
- It can be a runbook plus a skipped/conditional scenario.
- It should not introduce Electric-specific code paths in runtime-host logic.

Parallelization:

- Can run in parallel with Tracer A.
- May wait for Tracer B if the desired smoke uses `--prompt` / `--secret-env`.

## Tracer D: Durable Temporal Workflow Behavior

Linked ACIDs:

- `firegrid-workflow-driven-runtime.PHASE_4_TEMPORAL_WORKFLOWS.1`
- `firegrid-workflow-driven-runtime.PHASE_4_TEMPORAL_WORKFLOWS.2`
- `firegrid-workflow-driven-runtime.PHASE_4_TEMPORAL_WORKFLOWS.3`
- `firegrid-workflow-driven-runtime.PHASE_4_TEMPORAL_WORKFLOWS.4`
- `firegrid-workflow-driven-runtime.VALIDATION.3`

Product setup:

Create a small workflow-backed runtime behavior that waits durably before
appending a runtime input or completion row.

Acceptance evidence:

- The delay is expressed with `DurableClock.sleep` inside workflow code.
- The workflow survives engine/layer reconstruction before the delayed behavior
  completes.
- No Firegrid-owned timer table is introduced.
- Effect `Schedule` may calculate recurrence/backoff policy, but DurableClock is
  the durable suspension primitive.

Implementation notes:

- This is a workflow/runtime tracer, not a public `schedule_me` facade yet.
- Do not add temporal behavior to `packages/runtime/src/durable-tools` unless it
  is only bridging workflow deferred completion.

Parallelization:

- Can run after or alongside Tracer A if it only adds isolated workflow tests.
- Should wait for Tracer A if it depends on hardened activity-claim behavior.

## Tracer E: HostWorkflow Initiates Context Work Without Owning Side Effects

Linked ACIDs:

- `firegrid-workflow-driven-runtime.PHASE_5_HOST_WORKFLOW.1`
- `firegrid-workflow-driven-runtime.PHASE_5_HOST_WORKFLOW.2`
- `firegrid-workflow-driven-runtime.PHASE_5_HOST_WORKFLOW.3`
- `firegrid-workflow-driven-runtime.BOUNDARIES.1`
- `firegrid-workflow-driven-runtime.BOUNDARIES.4`

Product setup:

Introduce an explicit eligible-work source for runtime contexts. HostWorkflow
observes that source and initiates or resumes `RuntimeContextWorkflow`.

Acceptance evidence:

- HostWorkflow starts/resumes context workflows.
- HostWorkflow does not run local processes or write runtime output itself.
- HostWorkflow does not use app-local in-memory sets as a correctness fence.
- HostWorkflow does not treat every retained `RuntimeContext` row as fresh work.
- No public `executeByName`, workflow-name registry, DurableConsumer,
  ConsumerSource, ConsumerCheckpointStore, or DurableProjection is introduced.

Implementation notes:

- This tracer should not start until Tracer A clarifies activity-claim hardening
  and child initiation semantics.
- If explicit eligible work is needed, model it deliberately. Do not resurrect
  the deprecated `RuntimeContext.status` proposal by default.

Parallelization:

- Should not run in parallel with Tracer A implementation.
- Can be designed in parallel, but implementation should wait for Tracer A.

## Tracer F: Agent-Facing Durable Tool Catalog

Status: First vertical proof landed as Tracer 023
(`docs/tracers/023-acp-agent-interface.md`). The remaining Tracer F bar
— MCP-mounted neutral catalog, same-name collision policy, follow-up
prompt ingress to a running ACP session, cancellation parity, and the
SandboxProvider byte-pipe vs direct-spawn decision — is enumerated in
that doc as follow-ups.


Linked ACIDs:

- `firegrid-workflow-driven-runtime.PHASE_4_TEMPORAL_WORKFLOWS.1`
- `firegrid-workflow-driven-runtime.PHASE_4_TEMPORAL_WORKFLOWS.2`
- `firegrid-workflow-driven-runtime.BOUNDARIES.3`
- `firegrid-workflow-driven-runtime.BOUNDARIES.4`
- `firegrid-durable-tools.RUNTIME_BOUNDARY.4`

Product setup:

Expose a small Firegrid-owned tool catalog to one launched agent context. The
first catalog can be tiny:

```txt
firegrid_context
  returns context id / namespace metadata

firegrid_wait_for
  delegates to the durable wait_for implementation

firegrid_schedule_self or firegrid_sleep
  proves DurableClock-backed temporal behavior behind an agent-visible tool
```

Acceptance evidence:

- The agent sees tool descriptors with only the agent-visible triple:
  `{ name, description, inputSchema }`.
- Transport details, host authority, credentials, and Durable Streams URLs do
  not appear in the descriptor value.
- Tool descriptors are validated and frozen before agent session/runtime
  initialization completes; the visible tool set does not nondeterministically
  change mid-session.
- Same-name tool collisions have a deterministic replay-stable policy, such as
  first-valid-attach-wins or fail-before-exposure.
- Tool invocation request and result evidence are durable and correlated with
  the runtime context.
- The agent has an authorized way to inspect its own Firegrid tool/choreography
  history through a tool or query surface derived from durable facts.
- Tool execution writes through Firegrid workflow/table primitives; the tool
  handler does not invent a product-local scheduler or consumer framework.
- The catalog can be attached to a protocol-aware agent through MCP or an
  equivalent session initialization channel.

Implementation notes:

- This tracer is informed by external factory-fit analysis, but should not copy
  another product's full middleware model.
- Treat tools as the agent-facing surface over Firegrid primitives. Product
  authors should not hand-code long imperative orchestration when the agent can
  call durable tools from its loop.
- For opaque local-process agents, prefer MCP injection where the harness
  supports it. Ambient Durable Streams URL/schema injection is a fallback, not
  the primary tool story.

Parallelization:

- Can be designed in parallel with Tracer A and Tracer B/C.
- Implementation should wait until Tracer B/C establishes the sync-run surface
  that will host a tool-aware local agent.

## Tracer I: Follow-Up Prompt Ingress To A Running Context

Linked ACIDs:

- `firegrid-agent-ingress.INGRESS.1`
- `firegrid-agent-ingress.INGRESS.2`
- `firegrid-agent-ingress.INGRESS.3`
- `firegrid-agent-ingress.INGRESS.4`
- `firegrid-agent-ingress.INGRESS.6`
- `firegrid-agent-ingress.DELIVERY.1`
- `firegrid-agent-ingress.DELIVERY.3`
- `firegrid-agent-ingress.HOST.1`
- `firegrid-agent-ingress.HOST.3`

Product setup:

1. Launch a long-running local-process agent through the production runtime path.
2. After the child is already running, append a follow-up prompt/input through
   the Firegrid host/client ingress surface.
3. The child reads the follow-up from stdin and emits a marker to stdout.

Acceptance evidence:

- Follow-up prompt intent is a durable `RuntimeIngressTable.inputs` row before
  the provider emits bytes to the child.
- Duplicate follow-up prompt attempts with the same idempotency key do not
  create duplicate logical inputs or duplicate child-visible input.
- Delivery progress is durable in `RuntimeIngressTable.deliveries`.
- `RuntimeOutputTable` contains the child marker caused by the follow-up input.
- The client/app does not open a direct stdin, ACP, WebSocket, HTTP, or provider
  transport to dispatch the prompt.
- If the runtime context is already terminal or not live, the API returns or
  records a typed durable/not-live failure instead of treating a local timeout as
  the normal runtime-unavailable signal.

Implementation notes:

- This tracer is the RFC client-model bridge between today's `--prompt` initial
  input and future session-shaped prompt APIs.
- Do not model per-message input delivery as one workflow activity per input
  row.
- Do not add a Firegrid HTTP/RPC prompt endpoint.

Parallelization:

- Should wait for Tracer B/C env containment and sync-run smoke to be green.
- Can run before agent-facing tools; tools can later call the same ingress
  surface instead of inventing a tool-specific prompt path.

## Tracer G: Verified Webhook Ingest To Durable Facts

Linked ACIDs:

- `firegrid-durable-tools.SUBSCRIPTION.1`
- `firegrid-durable-tools.SUBSCRIPTION.3`
- `firegrid-durable-tools.RUNTIME_BOUNDARY.3`
- `firegrid-workflow-driven-runtime.PHASE_5_HOST_WORKFLOW.1`

Product setup:

Configure one external-style webhook source, initially with a fake Linear-like
payload, to become durable rows that an agent or workflow can wait on.

Acceptance evidence:

- Inbound webhook payloads are authenticated or rejected at the ingest boundary
  using an HMAC-style verifier.
- Accepted payloads are translated into a schema-owned DurableTable row.
- The receiver acknowledges quickly; long-running work is not done in the HTTP
  request path.
- The receiver acknowledges only after the durable fact is accepted, or after it
  intentionally decides no durable side effect should occur.
- At-least-once redelivery with the same external entity key does not launch
  duplicate agent work.
- Webhook payloads are not smuggled into an agent prompt/session as hidden input.
  If a webhook should prompt an agent, an explicit bridge validates origin,
  payload, policy, and current state, derives a distinct prompt idempotency key,
  and appends the chosen durable side effect.
- A workflow or agent-visible `wait_for` tool can wait on the durable row.

Implementation notes:

- Prefer the Durable Streams ingest URL / DurableTable row path. Do not add a
  parallel Firegrid edge service unless the Durable Streams endpoint cannot host
  the verifier/adapter boundary.
- Current Durable Streams does not provide a server-side HMAC verifier and State
  Protocol translator endpoint for arbitrary webhook JSON. Until that exists,
  keep the adapter product-owned and tiny: verify, translate, append one
  schema-owned fact through DurableTable, return.
- This tracer is about inbound event facts, not a generic webhook product.

Parallelization:

- Can run in parallel with Tracer A if it does not touch workflow-engine
  internals.
- Should coordinate with Tracer F if both define tool invocation/event schemas.

## Tracer H: Remote Sandbox Provider

Linked ACIDs:

- `firegrid-workflow-driven-runtime.PHASE_1_CONTEXT_WORKFLOW.3`
- `firegrid-workflow-driven-runtime.BOUNDARIES.1`

Product setup:

Add one non-local `SandboxProvider` implementation and run the same sync-run
shape through it.

Acceptance evidence:

- The provider implements the existing `SandboxProvider` contract without
  changing runtime-context workflow semantics.
- Runtime output still lands in `RuntimeOutputTable`.
- Runtime input still flows through `RuntimeIngressTable` where supported.
- The provider declares a restart/reattach profile for the launched resource:
  no reattach, protocol load, replacement, or supervised reattach.
- A retained durable resource/context row is not treated as proof that Firegrid
  still owns a live promptable handle after restart.
- Provider selection does not make Firegrid call a separate flamecast-like
  service for agent dispatch; Firegrid remains the substrate.

Implementation notes:

- This is additive provider work. It should not reshape the runtime-host or
  workflow-engine contracts.
- Do not start this until local-process sync-run and duplicate-start behavior
  are stable.

Parallelization:

- Can be researched in parallel.
- Implementation should wait until Tracer A and Tracer B/C are green.

## Recommended Dispatch

Immediate parallel work:

```txt
Agent 1
  Tracer A: duplicate start / activity-claim hardening

Agent 2
  Tracer B/C: sync-run local smoke plus Electric Cloud runbook/conditional smoke
```

Deferred until Agent 1 reports:

```txt
Agent 3
  Tracer D: durable temporal workflow behavior

Agent 4
  Tracer E: HostWorkflow initiation
```

Future product-surface work after the runtime wave:

```txt
Agent 5
  Tracer F: agent-facing durable tool catalog

Agent 6
  Tracer G: verified webhook ingest to durable facts

Agent 7
  Tracer H: remote SandboxProvider
```

Do not dispatch `RuntimeContext.status` implementation as part of this wave.
That work is not currently load-bearing under the workflow-driven model.
