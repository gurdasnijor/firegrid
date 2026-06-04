# tf-yuvd — `session.prompt` operation-registry keystone simulation

Date: 2026-06-03

Simulation: `op-registry-prompt-keystone`

Trace:
`packages/firelab/.simulate/runs/2026-06-03T08-18-49-849Z__op-registry-prompt-keystone/trace.jsonl`

## Finding

`session.prompt` can be authored once as an annotated Effect Schema operation
record, lowered into a generated `SessionPromptChannel` binding, and driven
through the production per-event RuntimeContext path to a real ACP agent.

This is a firelab simulation, not a static textual pass/fail. The driver
completed and observed the marker text from the real agent:
`firegrid.op_registry_prompt.status="marker_observed"` with spawn target
`npx -y @agentclientprotocol/claude-agent-acp@0.36.1`
(`trace.jsonl:121`).

## What Was Generated

The canonical record lives in the simulation host, because the driver is kept on
the public client seam:

- Projection metadata:
  `{ operationId: "session.prompt", toolName: "session_prompt", clientName: "sessions.prompt", cliName: "sessions prompt" }`
  (`packages/firelab/src/simulations/op-registry-prompt-keystone/host.ts:28`).
- Agent-tool input/output schemas:
  `SessionPromptToolInputSchema` and `SessionPromptToolOutputSchema`
  (`host.ts:35`, `host.ts:58`).
- Scoped session-facade input schema:
  `SessionHandlePromptInputSchema`
  (`host.ts:67`).
- Executable lowering metadata:
  durable-event append, target `session.prompt`, verb `send`, kind `egress`,
  durable `true`, session-scoped `true`
  (`host.ts:89`).
- Generated binding:
  `makeDurableEventChannel({ target: session.prompt, schema: scopedInput,
  append })` (`host.ts:177`), provided as `SessionPromptChannel` over the real
  `FiregridRuntime` (`host.ts:190`, `host.ts:218`).

The generated append encodes the prompt as production does: `AgentInputEvent`
`Prompt`, `Prompt.userMessage({ content: [Prompt.textPart({ text })] })`,
`SessionInputPayload.kind = "prompt"`, and JSON-encoded `payloadJson`
(`host.ts:116`). It then executes
`RuntimeContextSessionWorkflow.execute({ contextId, attempt: 1, inputKey,
input }, { discard: true })` (`host.ts:142`).

## Trace Evidence

Primary causal path in the trace:

- Generated surface executed:
  `firelab.op_registry_prompt.generated_session_prompt.append` carried
  `operation.id=session.prompt`, `tool_name=session_prompt`,
  `client_name=sessions.prompt`, `cli_name=sessions prompt`,
  `channel.target=session.prompt`, `verb=send`, `kind=egress`,
  `durable=true` (`trace.jsonl:89`).
- Production per-event body ran for the same context/input:
  `firegrid.unified.session.body` has
  `context.id=session:firelab:op-registry-prompt-keystone`,
  `input.idempotency_key=firelab-op-registry-prompt-turn-1`,
  `unified.input.kind=prompt` (`trace.jsonl:84`).
- The production adapter started/attached a real process:
  `firegrid.unified.adapter.start_or_attach` with adapter kind
  `production-codec` (`trace.jsonl:56`), followed by the real local process
  byte-pipe span `firegrid.agent_event_pipeline.source.local_process.open_byte_pipe`
  for executable `npx` (`trace.jsonl:47`).
- The ACP wire path received a real prompt:
  `firegrid.agent_event_pipeline.source.local_process.stdin_bytes` contains
  JSON-RPC method `session/prompt`, message id
  `firelab-op-registry-prompt-turn-1`, and the marker prompt text
  (`trace.jsonl:80`).
- The codec prompt span ran:
  `firegrid.agent_event_pipeline.acp.prompt` has the same ACP prompt id,
  turn id, and correlation id (`trace.jsonl:126`).
- The real agent responded with the marker:
  stdout carried `OP_REGISTRY_PROMPT_KEYSTONE_ACK` (`trace.jsonl:105`), and the
  driver span recorded `marker_observed=true` (`trace.jsonl:121`).

Production source corresponding to those trace spans:

- `SessionPromptChannel` is the protocol-owned prompt channel Tag whose
  service returns a `DurableEventChannel<typeof SessionHandlePromptInputSchema>`
  (`packages/protocol/src/channels/host-control.ts:73`).
- `DurableEventChannel<P>` is an `EgressChannel<P, EventOffset>` and
  `makeDurableEventChannel` requires an append effect returning `EventOffset`
  with no residual environment (`packages/protocol/src/channels/core.ts:297`).
- Production prompt encoding/execution currently does the same prompt envelope
  plus per-event workflow execute (`packages/runtime/src/unified/channel-bindings.ts:75`,
  `packages/runtime/src/unified/channel-bindings.ts:103`).
- Production `SessionPromptChannelSignalingLive` still uses the placeholder
  `HostSessionsCreateOrLoadRequestSchema as never` for the channel schema
  (`packages/runtime/src/unified/channel-bindings.ts:333`).
- The RuntimeContext per-event body performs `startOrAttach` and then
  `adapter.send` for non-terminal inputs (`packages/runtime/src/unified/subscribers/runtime-context.ts:74`).
- The production codec adapter emits the `start_or_attach` and `send` spans and
  decodes `SessionInputPayload` before sending to the live session
  (`packages/runtime/src/unified/codec-adapter.ts:418`,
  `packages/runtime/src/unified/codec-adapter.ts:462`).
- The local-process and ACP codec spans are real production spans
  (`packages/runtime/src/sources/sandbox/local-process.ts:426`,
  `packages/runtime/src/sources/codecs/acp/index.ts:741`).

## Static Parity Diff

Secondary parity check against committed surfaces:

| Surface | Committed source | Generated source | Parity |
| --- | --- | --- | --- |
| Agent tool input | `packages/protocol/src/agent-tools/schema.ts:516` | `host.ts:35` | Match on fields, requiredness, min-lengths, metadata names, and projection values. |
| Agent tool output | `packages/protocol/src/agent-tools/schema.ts:543` | `host.ts:58` | Match on fields and title/identifier shape. |
| Scoped session facade input | `packages/protocol/src/session-facade/schema.ts:118` | `host.ts:67` | Match on fields, requiredness, metadata record, parse option, and scoped `firegridProjection`. |
| Executable channel binding | `packages/runtime/src/unified/channel-bindings.ts:333` | `host.ts:177` | Divergence exposed: committed production still uses `HostSessionsCreateOrLoadRequestSchema as never`; generated binding uses the real scoped prompt schema and typechecks without that cast. |

The known `as never` stub therefore shows up as a real divergence instead of
silently passing. The sim did not require `as unknown as`, a fake codec, a fake
sandbox, or a Tag swap in the driver; the only host override was the generated
`SessionPromptChannel` binding layered over `FiregridRuntime`.

## Minimal Record Shape

The minimal record that generated all three surfaces is not just
`firegridProjection` metadata. It needs:

- Operation identity: `operationId`.
- Surface names: `toolName`, `clientName`, `cliName`.
- Public input/output Effect Schemas.
- Scoped facade transformation: remove `sessionId`, convert `prompt` to
  `payload`, carry `inputId`/`metadata`, and require `idempotencyKey`.
- Channel route metadata: target `session.prompt`, verb `send`, kind `egress`.
- Executable lowering metadata: durable-event append, primitive
  `append-session-input`, durable `true`, session-scoped `true`.
- Runtime lowering hook: encode prompt payload to `AgentInputEvent` and execute
  `RuntimeContextSessionWorkflow` with `{ discard: true }`.

## Insufficiencies

The model holds for `session.prompt` if the canonical operation record includes
lowering metadata. It does not hold from `firegridProjection` alone.

Projection metadata gives names for generated surfaces; it does not say whether
the operation is CRUD-over-DurableTable, one of the workflow primitives, a
durable-event append, which channel verb/kind to use, whether the operation is
session-scoped, or how to encode runtime input payloads. Those are the fields
that must be added to the record shape before a catalog-wide generator can be
decision-grade.

The executable channel result is stronger than a static parity diff because it
proved the generated binding can replace the committed `session.prompt` binding
at the protocol Tag and still drive the real production per-event runtime path.
