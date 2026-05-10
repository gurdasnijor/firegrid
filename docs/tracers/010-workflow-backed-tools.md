# 010: Workflow-Backed Tools

## Objective

Define workflow-backed runtime tools without introducing a second workflow
launch API or a parallel data plane.

The load-bearing claim is:

```txt
tool call or runtime intent
  -> durable fact, timer, or projection predicate
  -> workflow/subscriber reacts downstream
  -> follow-up facts are appended through existing runtime authority surfaces
```

Workflow-backed tools are reactive durable operators. They are not client-facing
workflow launch endpoints.

## Why This Is Load Bearing

Tools such as `sleep`, `wait_for`, `schedule_me`, and `spawn(agent, prompt)` are
useful only if they share Firegrid's durable coordination model:

- `sleep(durationMs)` should record or rely on durable time and resume when the
  durable timer fires.
- `wait_for(trigger, timeoutMs?)` should wait for a durable event/projection
  predicate and terminalize through a durable timeout if configured.
- `schedule_me(when, prompt)` should append prompt ingress through the same
  host-owned ingress path that clients use once durable time fires.
- `spawn(agent, prompt)` should call the same launch and prompt ingress surfaces
  available to clients, then observe child completion through normal durable
  state.

The tracer must avoid the failure mode where each tool becomes its own private
workflow application with a custom launch endpoint, custom records, and custom
observation model.

## Required Invariant

```txt
correct
  durable fact / timer / projection predicate
    -> workflow or subscriber reacts
    -> follow-up fact is appended through the normal runtime surface

wrong
  client or agent launches a workflow-specific endpoint
    -> private workflow data plane
    -> separate invocation model from launch, ingress, and runtime events
```

Relevant ACIDs:

- `firegrid-platform-invariants.AUTHORITY.8`
- `firegrid-scheduling-tool-bindings.IDENTICAL_DURABLE_LOWERING.1`
- `firegrid-scheduling-tool-bindings.IDENTICAL_DURABLE_LOWERING.2`
- `firegrid-scheduling-tool-bindings.IDENTICAL_DURABLE_LOWERING.4`
- `firegrid-scheduling-tool-bindings.IDENTICAL_DURABLE_LOWERING.5`
- `firegrid-agent-ingress.BOUNDARY.5`
- `firegrid-required-actions.WORKFLOW.7`
- `firegrid-required-actions.BOUNDARY.6`

## Relationship To Other Tracers

Tracer 010 should run after:

- the stabilization wave settles substrate imports, runtime layout, and
  required-action topology;
- tracer 012 defines durable prompt ingress.

It should not run before tracer 012 if `schedule_me` or `spawn(agent, prompt)`
are in scope, because both need the same durable prompt path used by clients.

Required-action semantics from tracer 009 may be reused, but only as reactive
workflow behavior over durable request/resolution facts. Do not preserve a
separate required-action data plane as the pattern for tools.

## Target Shape

Preferred runtime namespace, to be refined after the provider/runtime layout
stabilization lands:

```txt
packages/runtime/src/tools/
  schema.ts
  service.ts
  workflow-backed/
    sleep.ts
    wait-for.ts
    schedule-me.ts
    spawn.ts
  index.ts
```

If providers are consolidated under `packages/runtime/src/providers/**`, tool
providers should follow that accepted layout instead of creating separate
physical packages.

## Minimal Proof

Pick one or two tools, not all four:

1. `sleep(durationMs)` proves durable time reaction without prompt ingress.
2. `schedule_me(when, prompt)` or `spawn(agent, prompt)` proves integration with
   tracer 012 prompt ingress, once available.

The scenario should prove:

```txt
tool call records durable intent
  -> workflow/subscriber observes durable condition
  -> normal runtime surface receives follow-up fact
  -> observable durable output/projection confirms the effect
```

## Non-Goals

- Do not expose `launchWorkflow(...)`, `startToolWorkflow(...)`, or any
  workflow-specific client endpoint.
- Do not build MCP, ACP, OpenAI, Anthropic, or provider-specific tool adapters.
- Do not define product permission policy or UI.
- Do not create a standalone data plane for each tool.
- Do not bypass prompt ingress for tools that produce prompts.

## Acceptance Criteria

1. Workflow-backed tools are invoked through a tool/runtime intent surface, not
   through a workflow launch endpoint.
2. Tool execution records durable intent/facts and reacts to durable facts,
   durable time, or projection predicates.
3. Tool follow-up effects append through existing runtime authority surfaces,
   such as prompt ingress or required-action resolution.
4. Tool records do not introduce product-specific prompt, provider, MCP, ACP,
   permission, or session taxonomies.
5. Scenario proof invokes production package surfaces and observes durable
   outcomes across the tool boundary.

## Validation

Expected validation, refined by implementation scope:

```sh
pnpm --filter @firegrid/runtime run typecheck
pnpm --filter @firegrid/runtime run test
pnpm --filter @firegrid/scenario-firegrid run typecheck
pnpm --filter @firegrid/scenario-firegrid test -- tracer-010
pnpm run check:docs
pnpm run check:specs
pnpm run lint
pnpm run lint:deps
pnpm run lint:dup
pnpm run lint:dead
pnpm run lint:effect-quality
```
