# DELIVERY — tf-ds2 ACP codec: tool-arg + JSON-RPC error propagation

Status authority: bead `tf-ds2`. Substrate-boundary, observability-only,
additive — no behavior change. Makes the §6 demo legible (factory-vision
§7.7) and `sawCallerFactWaitFor` decidable.

## Root cause (from the #398 live §6 investigation)

`packages/runtime/src/agent-event-pipeline/codecs/acp/index.ts`:

1. **Tool args showed as `{}`.** ACP agents commonly send the initial
   `tool_call` notification with status `pending` and **no** `rawInput`,
   then stream the real arguments in subsequent `tool_call_update`
   notifications (`schema/types.gen`: `ToolCallUpdate.rawInput?`,
   `rawOutput?`). The codec collapsed *every* `tool_call_update` to an
   opaque `status(...)`, dropping the arguments — so the trace's
   `observedToolInputs` was `{}`.
2. **JSON-RPC `error.message` dropped.** A failed ACP prompt throws a
   JSON-RPC `{ code, message, data }` error (`jsonrpc.d.ts`). `codecError`
   kept only the static op message ("ACP prompt failed"); the real reason
   (e.g. the provider quota text) was buried in `cause` and never surfaced
   in `AgentCodecError.message` nor the emitted `Error` event — so the
   trace's `agentError` was the generic op string, not the real cause.

## Fix (additive, observability-only)

- `jsonRpcErrorMessage(cause)` extracts `message` (+ `code`/`data`) from a
  thrown JSON-RPC error / `Error`. `codecError` composes it into
  `AgentCodecError.message` as `"<op msg>: <underlying>"` **only when an
  underlying message exists**; `cause` is preserved unchanged.
- The ACP prompt-failure path now emits `recoverableError(error.message,
  error.cause)` — the enriched message reaches the `Error` output event and
  the trace `agentError`.
- `tool_call_update` with `rawInput` now ALSO emits a `ToolUse` (carrying
  `toolCallId`/`title`/`rawInput`) in addition to the status event, so
  `observedToolInputs` is the real arguments. **Observation-only:** the
  runtime-context workflow skips the tool executor for the `acp` protocol
  (ACP tool calls are provider-executed), so nothing changes but the
  trace. Updates with no `rawInput` still flow as the prior opaque status.

## Validation

- `@firegrid/runtime` typecheck green; ACP codec tests 11/11; full
  `@firegrid/runtime` 117/117; `@firegrid/host-sdk` 103/103 (incl. ACP
  tool_call observation + PermissionRequest block/resume) — verified in
  isolation, twice. No regression from the additive change.
- Full repo gate green: turbo typecheck, lint, lint:deps, lint:dead,
  lint:dup 50/50, **lint:effect-quality ratchet OK**.
- The turbo-run `@firegrid/host-sdk#test` failure is a pre-existing
  concurrency flake in timing-heavy durable-workflow tests (same as #397);
  host-sdk passes 103/103 exit 0 in isolation. Reported faithfully, not
  papered; unrelated to this codec change.

Coordinator holds the gate; no self-merge.
