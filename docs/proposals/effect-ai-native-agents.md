# SDD: Effect AI-Native Agent Adapters

**Status:** Draft for review
**Audience:** Firegrid build team
**Related code:** `packages/runtime/src/agent-codecs`, `packages/runtime/src/agent-io`, `packages/runtime/src/providers/sandboxes`, `packages/runtime/src/runtime-host`
**Related upstream references:** `repos/effect/packages/ai/ai/src/LanguageModel.ts`, `repos/effect/packages/ai/ai/src/Model.ts`, `repos/effect/packages/ai/ai/src/Tool.ts`, `repos/effect/packages/ai/ai/src/AiError.ts`, `repos/effect/packages/ai/anthropic/src/AnthropicLanguageModel.ts`
**Related terminology:** `docs/rfc/external/durable-stream-agent-plaform-rfc/concepts/terminology.md`

## Problem

Firegrid now has three adjacent surfaces for "an agent can be talked to":

- `AgentCodec` maps byte-stream protocols such as ACP and stdio-jsonl into
  Firegrid-local lifecycle/control events whose semantic payloads already use
  Effect AI `Prompt` and `Response` parts.
- `SandboxProvider` provisions and runs resources: local processes, byte pipes,
  future containers or remote sandboxes.
- `EffectAiSandboxProvider` exposes an injected `LanguageModel.Service` through
  the process-shaped `SandboxProvider` API, which is useful as a compatibility
  shim but is the wrong long-term abstraction.

The durable-stream agent platform terminology names this boundary directly:
an **Agent Adapter** connects an agent wire format or process shape to the
substrate, while a **Provider** provisions resources needed to run an agent.
Firegrid should adopt that split.

The key decision: the adapter's base model surface is not a new Firegrid
`Agent` or `LanguageModel` interface. It is upstream `@effect/ai`
`LanguageModel.Service`.

## Ground Truth

Effect AI's `LanguageModel.Service` is the canonical prompt/model contract:

- `generateText({ prompt, toolkit?, toolChoice?, concurrency?,
  disableToolCallResolution? })`
- `generateObject({ prompt, schema, ... })`
- `streamText({ prompt, toolkit?, ... })`

`LanguageModel.make` constructs a service from provider implementations that
return `AiError.AiError` failures and encoded `Response` parts. Provider
implementations such as `AnthropicLanguageModel` implement only provider
request/response translation and let Effect AI own:

- `Prompt.RawInput` normalization via `Prompt.make`
- toolkit/tool-call resolution semantics
- `disableToolCallResolution`
- response part decoding
- `AiError` shapes
- telemetry/span handling

Firegrid adapters should follow that pattern. Adapter-specific protocol
failures can be attached as causes to `AiError.UnknownError` or mapped to
`AiError.MalformedInput` / `AiError.MalformedOutput` where appropriate. They
must not widen the `LanguageModel.Service` error channel with Firegrid-local
errors.

Current Firegrid code already points in this direction:

- `agent-io/contract.ts` uses Effect AI `Prompt.UserMessage`,
  `Prompt.ToolCallPart`, `Prompt.ToolResultPart`, `Response.TextDeltaPart`, and
  `Response.FinishReason`.
- `AcpCodec` maps ACP `agent_message_chunk` to `Response.textDeltaPart`, ACP
  `tool_call` to `Prompt.toolCallPart`, ACP stop reasons to
  `Response.FinishReason`, and ACP prompts from Effect AI prompt parts.
- `StdioJsonlCodec` maps text, tool-use, and finish events to the same Effect
  AI payload contracts.
- `EffectAiSandboxProvider` calls an injected `LanguageModel.Service` and maps
  only text deltas into process-shaped stdout chunks.

## Invariants

1. `LanguageModel.Service` is the base prompt/model contract. Firegrid does not
   define a parallel model interface.
2. `AgentAdapter` is not a `SandboxProvider`. An adapter may consume a sandbox,
   byte pipe, websocket, or in-process model, but resource provisioning remains
   a separate provider concern.
3. Adapter capabilities are additive. Capability tags expose protocol-specific
   observation or control surfaces without changing `LanguageModel.Service`
   semantics.
4. Tool behavior follows the underlying protocol honestly. Adapters do not
   invent Firegrid-side tool callbacks or maintain a parallel toolkit registry.
   When a protocol cannot support Effect AI toolkit resolution, the adapter
   fails explicitly instead of pretending the toolkit was installed.
5. Permission requests are never auto-granted by the base view. If an underlying
   protocol requires interactive permission negotiation and no permission
   capability/policy is installed, the base `LanguageModel.Service` fails with
   an `AiError` whose cause is the canonical Firegrid permission error.
6. Runtime-host journaling is not adapter-owned. Adapters expose model streams
   and optional protocol observations; the host workflow decides how to project
   those observations into durable rows.

## Adapter Surface

### Current Turn

`LanguageModel.Service` should not grow Firegrid-specific request parameters.
Correlation belongs in Effect context:

```ts
export interface AgentTurn {
  readonly turnId: string
  readonly contextId?: string
}

export class CurrentAgentTurn extends Context.Tag(
  "firegrid/agent/CurrentAgentTurn",
)<CurrentAgentTurn, AgentTurn>() {}
```

Adapters that need protocol request identity read `CurrentAgentTurn` when the
model call starts. This is adapter-local correlation. It must not rely on the
underlying wire protocol echoing Firegrid identifiers unless that behavior is
part of the protocol contract.

For ACP specifically, correlation does **not** ride on
`PromptRequest.messageId` or `PromptResponse.userMessageId`. The ACP prompt
contract is `sessionId`, `prompt`, and optional `_meta`; `_meta` is an
extensibility field, not an echo contract. The current codec fixtures echo
unknown fields, but that is not portable protocol behavior. The ACP adapter
tags notifications and stream parts with the active `CurrentAgentTurn.turnId`
inside the adapter while the prompt is running.

### AgentAdapter

```ts
import { LanguageModel } from "@effect/ai"
import { Context } from "effect"

export interface AgentAdapterCapabilities {
  readonly streamingText: boolean
  readonly tools: boolean
  readonly multiTurn: boolean
  readonly mayRequestPermissions: boolean
}

export interface AgentAdapterService {
  readonly capabilities: AgentAdapterCapabilities
  readonly languageModel: LanguageModel.Service
}

export class AgentAdapter extends Context.Tag(
  "firegrid/agent/AgentAdapter",
)<AgentAdapter, AgentAdapterService>() {}
```

This is intentionally small. The adapter exposes an Effect AI model view and a
capability summary. Protocol-specific observation and permission surfaces are
separate tags.

### Adapter Registry

Runtime contexts select providers per context. A host-scoped singleton
`AgentAdapter` does not match `RuntimeContext.runtime.provider`. The selection
surface is a registry:

```ts
import type { RuntimeContext } from "@firegrid/protocol/launch"
import { Context, Effect } from "effect"

export class AgentAdapterRegistry extends Context.Tag(
  "firegrid/agent/AgentAdapterRegistry",
)<AgentAdapterRegistry, {
  readonly adapterFor: (
    context: RuntimeContext,
  ) => Effect.Effect<AgentAdapterService, AgentAdapterSelectionError>
}>() {}
```

This SDD defines the shape only. The concrete registry composition rules are a
later runtime-host integration slice. The first implementation can be a closed
switch over `RuntimeContext.runtime.provider`, matching the existing runtime
host's conservative provider stance.

### In-Process LanguageModel Adapter

The trivial adapter wraps an injected upstream model and does not involve a
sandbox:

```ts
import { LanguageModel } from "@effect/ai"
import { Effect, Layer } from "effect"

export const LanguageModelAdapter = {
  layer: (): Layer.Layer<AgentAdapter, never, LanguageModel.LanguageModel> =>
    Layer.effect(
      AgentAdapter,
      Effect.map(LanguageModel.LanguageModel, languageModel => ({
        capabilities: {
          streamingText: true,
          tools: true,
          multiTurn: false,
          mayRequestPermissions: false,
        },
        languageModel,
      })),
    ),
}
```

If Firegrid wants to publish adapter-backed models through Effect AI's provider
ecosystem, it should follow upstream provider modules and wrap the layer with
`Model.make(providerName, layer)`. The adapter itself still exposes
`LanguageModel.Service`; `Model.make` is packaging metadata, not a second model
contract.

## Errors

Firegrid still needs canonical adapter errors for capability surfaces and for
causes attached to `AiError.UnknownError`. Use `Schema.TaggedError` classes, not
manual `_tag` objects:

```ts
import { Schema } from "effect"

export class PermissionRequiredButNotHandled
  extends Schema.TaggedError<PermissionRequiredButNotHandled>()(
    "PermissionRequiredButNotHandled",
    {
      turnId: Schema.optional(Schema.String),
      toolCallId: Schema.optional(Schema.String),
      message: Schema.String,
    },
  )
{}

export class AdapterProtocolError extends Schema.TaggedError<AdapterProtocolError>()(
  "AdapterProtocolError",
  {
    op: Schema.String,
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}

export class AdapterSessionNotPromptable
  extends Schema.TaggedError<AdapterSessionNotPromptable>()(
    "AdapterSessionNotPromptable",
    { message: Schema.String },
  )
{}

export class AdapterCancelled extends Schema.TaggedError<AdapterCancelled>()(
  "AdapterCancelled",
  { message: Schema.String },
) {}

export class AdapterTerminated extends Schema.TaggedError<AdapterTerminated>()(
  "AdapterTerminated",
  { message: Schema.String },
) {}

export class AdapterUnsupportedFeature
  extends Schema.TaggedError<AdapterUnsupportedFeature>()(
    "AdapterUnsupportedFeature",
    {
      feature: Schema.String,
      message: Schema.String,
    },
  )
{}

export class AgentAdapterSelectionError
  extends Schema.TaggedError<AgentAdapterSelectionError>()(
    "AgentAdapterSelectionError",
    {
      provider: Schema.String,
      message: Schema.String,
      cause: Schema.optional(Schema.Unknown),
    },
  )
{}
```

These classes are not added to the `LanguageModel.Service` error channel.
Adapter model implementations map them to Effect AI errors at the boundary,
usually:

- `AiError.MalformedInput` for unsupported prompt/input shapes.
- `AiError.MalformedOutput` for protocol output that cannot be decoded into
  `Response` parts.
- `AiError.UnknownError` with `cause` for protocol, permission, cancellation,
  or session-state failures.

Capability tags may expose the classes directly because those tags are
Firegrid-owned surfaces, not upstream `LanguageModel.Service`.

## Capability Tags

### ACP

ACP has observations that do not belong in `LanguageModel.Service`:

- `tool_call_update`
- plan updates
- mode updates
- available command updates
- permission requests

Expose them through additive tags:

```ts
import * as acp from "@agentclientprotocol/sdk"
import { Context, Stream } from "effect"

export interface AcpAdapterService extends AgentAdapterService {
  readonly acp: {
    readonly sessionNotifications: Stream.Stream<acp.SessionNotification, AdapterProtocolError>
  }
}

export class AcpAdapter extends Context.Tag(
  "firegrid/agent/AcpAdapter",
)<AcpAdapter, AcpAdapterService>() {}
```

### Permissions

```ts
import * as acp from "@agentclientprotocol/sdk"
import { Context, Effect, Stream } from "effect"

export interface PermissionRequestEvent {
  readonly permissionRequestId: string
  readonly toolUseId: string
  readonly options: ReadonlyArray<acp.PermissionOption>
}

export type PermissionDecision =
  | { readonly _tag: "Allow"; readonly optionId?: string }
  | { readonly _tag: "Deny"; readonly reason?: string }
  | { readonly _tag: "Cancelled" }

export interface PermissionedAdapterService extends AgentAdapterService {
  readonly permissions: {
    readonly requests: Stream.Stream<PermissionRequestEvent, AdapterProtocolError>
    readonly respond: (
      permissionRequestId: string,
      decision: PermissionDecision,
    ) => Effect.Effect<void, AdapterProtocolError>
  }
}

export class PermissionedAdapter extends Context.Tag(
  "firegrid/agent/PermissionedAdapter",
)<PermissionedAdapter, PermissionedAdapterService>() {}
```

The base `languageModel` view fails on permission requests when this capability
is not consumed or no policy is installed. It does not auto-allow.

One layer may satisfy several tags backed by one acquired resource:

```ts
const AcpAdapterLayer = Layer.scoped(AcpAdapter, makeAcpAdapter(...)).pipe(
  Layer.merge(Layer.effect(AgentAdapter, Effect.map(AcpAdapter, service => service))),
  Layer.merge(Layer.effect(PermissionedAdapter, Effect.map(AcpAdapter, service => service))),
)
```

Consumers depend on the narrowest tag they need.

## ACP As LanguageModel.Service

The current `AcpCodec` proves most of the mapping already.

| `LanguageModel.Service` concept | ACP/current-code mapping |
| --- | --- |
| Layer acquisition | `acp.ndJsonStream`, `ClientSideConnection.initialize`, `newSession`; ACP sessions are multi-turn, so one adapter session may serve many `streamText` calls |
| Turn correlation | Adapter-local: read `CurrentAgentTurn.turnId` for the duration of `streamText`; do not rely on ACP echoing non-spec fields |
| Prompt input | Effect AI `Prompt.RawInput` normalized to prompt parts; text user parts map to ACP `ContentBlock` text |
| Text deltas | ACP `agent_message_chunk` text maps to `Response.textDeltaPart` |
| Tool calls | ACP `tool_call` maps to `Prompt.toolCallPart` as an observation |
| Tool status | ACP `tool_call_update` is extension observation, not base `LanguageModel` output |
| Finish reason | ACP `stopReason` maps to `Response.FinishReason` using the current codec map |
| `generateText` | Collect `streamText` and construct `LanguageModel.GenerateTextResponse` |
| Toolkit | Unsupported for ACP; `streamText({ toolkit })` fails explicitly because ACP has no client-supplied tool-result path |
| Permissions | Base view fails with `AiError.UnknownError` caused by `PermissionRequiredButNotHandled`; permission-aware consumers use `PermissionedAdapter` |

The proof obligation for implementation is concrete: port the ACP codec mapping
tests to the adapter's `languageModel.streamText` view. Tests that currently
cover byte-stream termination and direct `Cancel` input remain codec/lifecycle
tests until a cancellation SDD lands.

The current `AcpCodec`'s `correlationId -> messageId -> userMessageId` fixture
path should not be copied into the adapter. It depends on non-spec ACP fields
being accepted and echoed by both sides. The adapter is the correlation boundary.

## Relationship To Existing Surfaces

### AgentCodec

`AgentCodec` remains the protocol-clean byte-stream event boundary. It is not
deleted by this SDD. ACP and stdio-jsonl codecs still matter for consumers that
need raw event access or lifecycle/control events rather than an Effect AI model
view.

An ACP adapter can reuse the codec's mapping functions internally, but the
adapter is not a rename of `AgentCodec`: it provides `LanguageModel.Service` and
optional capability tags.

### SandboxProvider

`SandboxProvider` remains resource provisioning:

| Adapter | Uses SandboxProvider? | Why |
| --- | --- | --- |
| `LanguageModelAdapter` | No | In-process `LanguageModel.Service` |
| local ACP adapter | Yes, `openBytePipe` | ACP process needs stdio byte streams |
| remote ACP adapter | No | Transport is remote connection, not sandbox |
| stdio-jsonl adapter | Yes, `openBytePipe` | Process wire format |
| future container-backed adapter | Yes | Sandbox owns container/process resource |

`EffectAiSandboxProvider` is therefore a compatibility shim: it lets current
process-shaped code exercise a `LanguageModel.Service`, but the long-term
in-process model path is `LanguageModelAdapter`, not a fake sandbox.

### ToolCallWorkflow

`ToolCallWorkflow` stays. It supplies `WorkflowInstance`, `DurableClock`,
`Scope`, and child workflow composition for tool execution. Any synthetic
`ToolUse` event cleanup is separate from this adapter work.

### Runtime Host Journaling

The host workflow currently maps `ProcessOutputChunk` to `RuntimeOutputTable`
rows using `context.runtime.journal`. That is host-plane behavior. A future
journaling SDD must decide how `Response.StreamPart` and capability observations
become durable output rows. This SDD does not change runtime-host workflow code.

## Expected Outcomes

When this SDD's first implementation slice lands:

- Firegrid has an Effect-native `AgentAdapter` tag family without cloning
  `LanguageModel`.
- In-process Effect AI model execution has a direct adapter path.
- ACP has a testable path toward `LanguageModel.Service` without deleting
  `AcpCodec`.
- `SandboxProvider` stays focused on resource provisioning.
- Permission negotiation is explicit and cannot silently auto-allow through the
  base model view.
- Runtime-host integration remains blocked on a separate journaling decision,
  not on the adapter contract.

## Slices

### Slice 1: Types And Trivial Adapter

Add:

- `CurrentAgentTurn`
- `AgentAdapter`
- `AgentAdapterRegistry` shape
- adapter error classes
- `LanguageModelAdapter`

Tests use a fake `LanguageModel.Service` and verify no `SandboxProvider` is
required.

### Slice 2: ACP Adapter Proof

Implement an ACP adapter over `AgentByteStream` and port the mapping portions of
`agent-codecs/acp/index.test.ts` to `languageModel.streamText`.

Keep `AcpCodec` exported. Do not touch runtime-host workflow code.

### Slice 3: Journaling SDD

Decide how `Response.StreamPart`, finish parts, errors, permissions, and
protocol observations become host-owned durable rows. This must precede runtime
workflow migration.

### Slice 4: Runtime Host Integration

Wire `AgentAdapterRegistry.adapterFor(context)` into the runtime host and move
the workflow body from process chunks toward adapter output according to the
journaling SDD.

### Slice 5: Compatibility Cleanup

Only after Slice 4 proves production behavior:

- decide whether `EffectAiSandboxProvider` is still needed;
- decide whether `StdioJsonlCodec` remains public or becomes adapter internals;
- clean up redundant code.

## Non-Goals

- No deletion of current codecs/providers in this SDD.
- No runtime-host workflow rewrite.
- No durable output schema change.
- No permission UI or policy implementation.
- No custom Firegrid model interface.
- No custom Firegrid tool registry.
- No MCP changes.

## Open Questions

1. Should `CurrentAgentTurn` carry only `turnId`, or also context/activity
   metadata needed by future journaling?
2. Should `AgentAdapterRegistry.adapterFor(context)` return only a service, or a
   scoped resource handle that can expose release/cancellation hooks later?
3. Which `AiError` variant should be canonical for
   `PermissionRequiredButNotHandled`: `UnknownError` with cause, or
   `MalformedInput` because the call requires a missing permission policy?
4. Should the legacy `AcpCodec` stop sending non-spec `messageId` fields before
   the adapter lands, or should that cleanup ride with Slice 2 where the
   adapter-owned correlation path is tested?
