# 012: Agent Ingress Prompt Stream

## Objective

Define the durable prompt ingress model for supplying initial and follow-up
agent inputs over Firegrid's Durable Streams substrate.

The load-bearing claim is:

```txt
client prompt intent
  -> host-owned durable agent ingress fact
  -> runtime adapter consumes ingress by runtime context
  -> adapter translates to provider-specific stdin/ACP/chat protocol
  -> delivery progress is durable
  -> runtime output remains the separate durable response journal
```

This is the input-side counterpart to tracer 001's runtime-output journaling.
Without this tracer, Firegrid has durable output but no coherent durable input
model beyond "whatever the local command happened to start with."

## Why This Is Load Bearing

Prompt ingress sits between launch intent, runtime providers, required actions,
workflow-backed tools, and future agent spawning.

The same model should support:

- initial prompt supplied at launch time;
- follow-up prompts to a running context;
- steering/correction messages;
- required-action resolutions that become runtime input later;
- `spawn(agent, prompt)` using the same input path as external clients.

The runtime provider may speak stdin, ACP, Claude Code stream-json, HTTP, or a
hosted SDK, but Firegrid's durable input authority should be one provider-neutral
ingress stream.

## Current Ground Truth

Current runtime execution starts from a runtime context and sandbox command:

```txt
packages/runtime/src/runtime-host/index.ts
packages/runtime/src/control-plane/runtime-context/workflow.ts
packages/runtime/src/data-plane/execution/sandbox/**
packages/runtime/src/data-plane/runtime-output/writer.ts
```

Tracer 001 proves stdout/stderr become durable runtime-output facts. It does
not prove a durable input stream or follow-up prompt path.

Relevant ACIDs:

- `firegrid-platform-invariants.PRODUCTION_SURFACE.5`
- `firegrid-agent-ingress.PROMPTS.1`
- `firegrid-agent-ingress.PROMPTS.2`
- `firegrid-agent-ingress.PROMPTS.3`
- `firegrid-agent-ingress.PROMPTS.4`
- `firegrid-agent-ingress.DELIVERY.1`
- `firegrid-agent-ingress.DELIVERY.2`
- `firegrid-agent-ingress.DELIVERY.3`
- `firegrid-agent-ingress.DELIVERY.4`
- `firegrid-agent-ingress.HOST.1`
- `firegrid-agent-ingress.HOST.2`
- `firegrid-agent-ingress.HOST.3`
- `firegrid-agent-ingress.BOUNDARY.1`
- `firegrid-agent-ingress.BOUNDARY.2`
- `firegrid-agent-ingress.BOUNDARY.3`
- `firegrid-agent-ingress.BOUNDARY.4`

## Target Shape

Preferred runtime package shape:

```txt
packages/runtime/src/agent-ingress/
  schema.ts
  ids.ts
  service.ts
  source.ts
  delivery.ts
  index.ts
```

If tracer 007 has extracted sandbox packages or renamed runtime namespaces,
follow the current target layout while preserving this boundary.

Minimum durable records:

```txt
agent_input.requested
agent_input.delivered
```

`agent_input.delivered` may be a per-input delivery row or a durable cursor row.
The exact representation is less important than the authority boundary:
delivery progress must not live only in a process-local variable.

## Runtime Surface

The runtime host should own ingress topology and expose a package surface close
to:

```ts
yield* RuntimeHost.prompt({
  contextId,
  inputId,
  content: [{ type: "text", text: "continue with the next step" }],
  metadata,
})
```

Launch with an initial prompt should use the same model:

```txt
launch({ runtime, input })
  -> normalized runtime context row
  -> agent_input.requested row for initial input
```

If the current launch surface is not ready for this exact API, the tracer should
prove the package-level ingress service and one runtime adapter consumption path
without adding client-facing compatibility wrappers.

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

## Non-Goals

- Do not build an HTTP prompt endpoint.
- Do not define product chat/session transcript schemas.
- Do not implement real Claude/ACP provider semantics unless a tiny fixture is
  cheaper than a local stdin harness.
- Do not make required-action resolution part of this tracer.
- Do not add workflow-backed tools.
- Do not let clients pass ingress stream URLs.

## Write Scope

Primary:

```txt
packages/runtime/src/agent-ingress/**
packages/runtime/src/runtime-host/**
packages/runtime/src/control-plane/runtime-context/**
packages/runtime/src/index.ts
features/firegrid/firegrid-agent-ingress.feature.yaml
scenarios/firegrid/src/tracer-012*.test.ts
```

Likely integration touch:

```txt
packages/runtime/src/data-plane/execution/sandbox/**
packages/runtime/src/data-plane/runtime-output/**
```

Avoid:

```txt
packages/runtime/src/data-plane/materialization/**
packages/runtime/src/required-action/**
scenarios/firegrid/src/tracer-002.test.ts
```

## Acceptance Criteria

1. Durable agent input request and delivery/progress schemas exist.
2. Initial and follow-up prompts use the same ingress service or package
   surface.
3. The runtime host owns ingress stream topology; prompt requests do not carry
   stream URLs or host provider configuration.
4. One runtime adapter consumes durable ingress and translates it to a live
   provider input protocol.
5. Delivery/progress is durable enough to prevent duplicate provider delivery
   for the same logical input during retry/replay.
6. Runtime output remains a separate durable journal and continues to be
   observable through tracer 001-style output rows.
7. Scenario proof invokes production package surfaces rather than scenario-only
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

- Is `agent-ingress` the right namespace, or should this be
  `runtime-input` because the runtime context, not the product agent, is the
  durable addressing unit?
- Should delivery progress be one row per input or a compact durable cursor per
  runtime/provider adapter?
- Is durable ingress consumed by the runtime context workflow itself, a sibling
  subscriber workflow, or a provider-owned adapter loop?
- What is the minimal provider-neutral content-block schema needed before real
  ACP/Claude/Codex adapters?
- How does this ingress model interact with required-action resolution without
  merging the two authorities?
