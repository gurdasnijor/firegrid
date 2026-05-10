# 012: Runtime Ingress Event Stream

## Objective

Define the durable runtime ingress model for supplying client, workflow, tool, and system-authored inputs over Firegrid's Durable Streams substrate.

The load-bearing claim is:

```txt
client or workflow ingress intent
  -> host-owned durable runtime ingress fact
  -> runtime adapter consumes ingress by runtime context
  -> adapter translates to provider-specific stdin/ACP/chat protocol
  -> delivery progress is durable
  -> runtime output remains the separate durable response journal
```

This is the input-side counterpart to tracer 001's runtime-output journaling.
Without this tracer, Firegrid has durable output but no coherent durable input
model beyond "whatever the local command happened to start with."

## Why This Is Load Bearing

Runtime ingress sits between launch intent, runtime providers, required actions,
workflow-backed tools, and future agent spawning.

The same model should support multiple author classes:

- client-authored initial prompts and follow-up prompts;
- client-authored steering/correction messages;
- workflow-authored scheduled prompts;
- workflow-authored required-action results that become runtime input later;
- tool-authored `spawn(agent, prompt)` requests using the same input path as
  external clients;
- system-authored retry, recovery, or reattach inputs if a later tracer earns
  them.

The runtime provider may speak stdin, ACP, Claude Code stream-json, HTTP, or a
hosted SDK, but Firegrid's durable input authority should be one provider-neutral
ingress stream with multiple subscriber classes.

## Current Ground Truth

Current runtime execution starts from a runtime context and sandbox command:

```txt
packages/runtime/src/runtime-host/index.ts
packages/runtime/src/runtime-context/workflow.ts
packages/runtime/src/providers/sandboxes/**
packages/runtime/src/runtime-output/writer.ts
```

Tracer 001 proves stdout/stderr become durable runtime-output facts. It does
not prove a durable input stream or follow-up prompt path.

Relevant ACIDs:

- `firegrid-platform-invariants.PRODUCTION_SURFACE.5`
- `firegrid-agent-ingress.INGRESS.1`
- `firegrid-agent-ingress.INGRESS.2`
- `firegrid-agent-ingress.INGRESS.3`
- `firegrid-agent-ingress.INGRESS.4`
- `firegrid-agent-ingress.INGRESS.5`
- `firegrid-agent-ingress.DELIVERY.1`
- `firegrid-agent-ingress.DELIVERY.2`
- `firegrid-agent-ingress.DELIVERY.3`
- `firegrid-agent-ingress.DELIVERY.4`
- `firegrid-agent-ingress.HOST.1`
- `firegrid-agent-ingress.HOST.2`
- `firegrid-agent-ingress.HOST.3`
- `firegrid-agent-ingress.SUBSCRIBERS.1`
- `firegrid-agent-ingress.SUBSCRIBERS.2`
- `firegrid-agent-ingress.SUBSCRIBERS.3`
- `firegrid-agent-ingress.BOUNDARY.1`
- `firegrid-agent-ingress.BOUNDARY.2`
- `firegrid-agent-ingress.BOUNDARY.3`
- `firegrid-agent-ingress.BOUNDARY.4`
- `firegrid-agent-ingress.BOUNDARY.5`

## Target Shape

Preferred runtime package shape after the runtime layout stabilization:

```txt
packages/runtime/src/runtime-ingress/
  schema.ts
  ids.ts
  service.ts
  subscriber.ts
  delivery.ts
  index.ts
```

If implementation keeps `agent-ingress` as the physical path for compatibility
with prior docs, it must document why the runtime addressing unit is still clear
and not product-agent-specific.

Minimum durable records:

```txt
runtime_ingress.requested
runtime_ingress.delivered
```

`runtime_ingress.delivered` may be a per-input delivery row or a durable cursor
row. The exact representation is less important than the authority boundary:
delivery progress must not live only in a process-local variable.

The requested row should include at least:

```ts
type RuntimeIngressRequested = {
  readonly ingressId: string
  readonly contextId: string
  readonly kind: "message" | "control" | "tool_result" | "required_action_result"
  readonly authoredBy: "client" | "workflow" | "tool" | "system"
  readonly payload: unknown
  readonly idempotencyKey?: string
  readonly createdAt: string
  readonly metadata?: Record<string, string>
}
```

## Runtime Surface

The runtime host should own ingress topology and expose a package surface close
to:

```ts
yield* RuntimeHost.ingress({
  contextId,
  ingressId,
  kind: "message",
  authoredBy: "client",
  payload: [{ type: "text", text: "continue with the next step" }],
  metadata,
})
```

Launch with an initial prompt should use the same model:

```txt
launch({ runtime, input })
  -> normalized runtime context row
  -> runtime_ingress.requested row for initial input
```

If the current launch surface is not ready for this exact API, the tracer should
prove the package-level ingress service and one runtime adapter consumption path
without adding client-facing compatibility wrappers.

## Subscriber Model

Ingress is a durable event stream with multiple subscriber classes:

- provider adapters consume message/control ingress and translate it to provider
  protocol input;
- required-action workflows may append ingress after a durable resolution fact;
- scheduled workflow operators may append ingress after durable time fires;
- workflow-backed tools may append ingress for `schedule_me` or
  `spawn(agent, prompt)`;
- future system operators may append recovery or reattach ingress if a later
  tracer earns that behavior.

Subscribers track durable progress when repeated delivery would be visible to a
provider or downstream runtime. Subscribers do not create workflow-specific
launch endpoints.

## Minimal Proof

Use one provider path that can accept input, preferably the simplest local
process/stdio or ACP-like harness available after tracer 007.

The scenario should prove:

```txt
append prompt input
  -> runtime adapter consumes it
  -> adapter writes it to the live provider protocol
  -> provider output is captured in runtime-output journal
  -> duplicate prompt append with same idempotency key is not delivered twice
```

For a local process, a small stdin echo harness is enough. For ACP, a tiny stdio
agent fixture is enough. Do not make the fixture own the ingress architecture.
The first proof may use `kind: "message"` and `authoredBy: "client"`, but the
schema/service should not be prompt-only.

## Non-Goals

- Do not build an HTTP prompt endpoint.
- Do not define product chat/session transcript schemas.
- Do not implement real Claude/ACP provider semantics unless a tiny fixture is
  cheaper than a local stdin harness.
- Do not make required-action resolution part of this tracer.
- Do not add workflow-backed tools.
- Do not let clients pass ingress stream URLs.
- Do not introduce workflow-specific launch endpoints for subscribers.

## Write Scope

Primary:

```txt
packages/runtime/src/agent-ingress/**
packages/runtime/src/runtime-ingress/**
packages/runtime/src/runtime-host/**
packages/runtime/src/runtime-context/**
packages/runtime/src/index.ts
features/firegrid/firegrid-agent-ingress.feature.yaml
scenarios/firegrid/src/tracer-012*.test.ts
```

Likely integration touch:

```txt
packages/runtime/src/providers/sandboxes/**
packages/runtime/src/runtime-output/**
```

Avoid:

```txt
packages/runtime/src/materialization/**
packages/runtime/src/required-action/**
scenarios/firegrid/src/tracer-002.test.ts
```

## Acceptance Criteria

1. Durable runtime ingress request and delivery/progress schemas exist.
2. Initial prompts, follow-up prompts, scheduled prompts, required-action
   results, and tool-authored spawn inputs can share the same ingress service
   and durable schema.
3. The runtime host owns ingress stream topology; ingress requests do not carry
   stream URLs or host provider configuration.
4. One runtime adapter consumes durable ingress and translates it to a live
   provider input protocol.
5. Delivery/progress is durable enough to prevent duplicate provider delivery
   for the same logical input during retry/replay.
6. Runtime output remains a separate durable journal and continues to be
   observable through tracer 001-style output rows.
7. Ingress subscribers are reactive operators over durable facts, time, or
   projection predicates and do not launch private workflow endpoints.
8. Scenario proof invokes production package surfaces rather than scenario-only
   stream wiring.

## Validation

Run the relevant checks for the implementation scope:

```sh
pnpm --filter @firegrid/runtime run typecheck
pnpm --filter @firegrid/runtime run test
pnpm --filter @firegrid/scenario-firegrid run typecheck
pnpm --filter @firegrid/scenario-firegrid test -- tracer-012
pnpm run check:docs
pnpm run check:specs
pnpm run lint
pnpm run lint:deps
pnpm run lint:dup
pnpm run lint:dead
pnpm run lint:effect-quality
```

## Questions To Answer

- Is `runtime-ingress` the right namespace, or should the code keep
  `agent-ingress` while making the runtime context addressing unit explicit?
- Should delivery progress be one row per input or a compact durable cursor per
  runtime/provider adapter?
- Is durable ingress consumed by the runtime context workflow itself, a sibling
  subscriber workflow, or a provider-owned adapter loop?
- What is the minimal provider-neutral content-block schema needed before real
  ACP/Claude/Codex adapters?
- How does this ingress model interact with required-action resolution without
  merging the two authorities?
- Which subscriber classes need durable progress in tracer 012 versus future
  workflow-backed tool tracers?
