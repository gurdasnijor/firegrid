# Path X PR C Fit Diagnostic

Date: 2026-05-17
Branch: `codex/path-x-pr-c-native-supervisor`
Draft PR: #303

## Context

This diagnostic follows the #303 blocker work. The process-free
`AgentOutputAfter` checks proved that per-context output URL alignment and the
`RuntimeAgentOutputAfterEvents` override can work without starting a process.
A stricter local experiment then exposed the remaining race: when a workflow
wait row is definitely active before the output row is written, live completion
can still miss the output until a later host/router acquire performs initial
reconciliation. That points at router lifecycle/attachment semantics, not
process startup.

Per coordinator direction, this document does not try to make #303 mergeable.
It evaluates the minimum viable supervisor shape and whether the reactive
workflow body is carrying enough durable responsibility to justify Path X.

## Output A: Minimum Supervisor Attempt

### Minimum Shape That Can Possibly Work

The minimum live owner is not a workflow activity and is not the old
`runRuntimeContext` delegate. It is a host-scoped process owner with two short
workflow-facing operations:

- `startOrAttach(context, activityAttempt)`:
  - short `Activity.make` boundary;
  - installs or reattaches a host-owned runtime session;
  - returns `Started` evidence `{ contextId, activityAttempt, supervisorSessionId, startCommandId }`;
  - must not wait for terminal output;
  - must not fork `runRuntimeContext`.
- `send(context, activityAttempt, command)`:
  - short `Activity.make` boundary;
  - emits exactly one typed command to the attached owner;
  - returns `CommandAccepted`;
  - must not wait for output.

The live owner should split adapters:

- Raw adapter:
  - owns local-process spawn, stdin byte encoding, stdout/stderr line capture,
    and synthetic terminal event emission;
  - does not know ACP/JSON-RPC framing.
- Codec adapter:
  - owns `AgentByteStream`, `AgentSession`, ACP/stdio-jsonl framing, and typed
    `AgentInputEvent` sends;
  - does not know raw prompt-to-line encoding.
- Shared core:
  - only session identity, attachment, lifecycle, and command claim metadata;
  - no mixed raw/codec stream pump.

### Can the Registry Be Eliminated?

No, not for production correctness.

Invariant forcing it: `startOrAttach` activity results are durable and may be
replayed without rerunning the activity. After engine restart, the workflow can
resume at `send` with a cached `startOrAttach` result while the host process'
in-memory owner registry is empty. Therefore `send` must locate or rebuild an
owner from durable/session evidence. A registry or equivalent attach index is
required to answer "is this context/attempt already owned in this host scope?"
and to prevent competing process owners.

The registry does not have to be a large mutable map. Minimum acceptable shape:

- key: `{ contextId, activityAttempt }`;
- value: adapter-owned handle plus `supervisorSessionId`;
- `startOrAttach` and `send` both go through the same attach path;
- concurrent starts claim once for the same key;
- stale handles are evicted or replaced only after observed terminal/death.

### Can the Command Queue Be Eliminated?

Probably for the workflow-facing API, yes; not necessarily inside adapters.

`send` can synchronously attach and emit one command through the adapter, using
the command id as the activity name and the stdin/supervisor claim as the
pre-emission fence. That avoids a generic supervisor command queue between the
workflow and owner.

A queue may still be required inside a codec adapter if the underlying
`AgentSession.send` cannot be called concurrently or if ACP turn ordering must
be serialized. If so, the invariant is adapter-local ordering, not workflow
coordination. That queue should not be the shared substrate primitive.

### Can Host SDK Avoid `RuntimeOutputJournalLayer`?

Yes, and it should.

The host-sdk live owner needs a narrow per-context output writer, not the old
runtime output authority layer. Minimum shape:

- `PerContextRuntimeOutputWriter` capability owned by runtime or host-sdk
  composition;
- methods such as `appendEvent(context, activityAttempt, eventOrRaw)` and
  `appendLog(context, activityAttempt, line)`;
- implementation opens `RuntimeOutputTable` at
  `runtimeContextOutputStreamUrl({ baseUrl, prefix: context.host.streamPrefix, contextId })`;
- no dependency on host-owned `runtimeOutput` stream or old
  `RuntimeOutputJournalLayer` composition.

Invariant forcing an output writer: the process owner is the component that
observes stdout/stderr/codec outputs and must persist them for
`AgentOutputAfter` and session snapshots. The writer is required; importing the
old authority layer is not.

### Required State Summary

Required:

- attach registry or equivalent owner index;
- adapter-local lifecycle state;
- per-command durable claim before external byte/JSON-RPC emission;
- narrow per-context output writer;
- lifecycle cleanup on terminal output, sandbox death, and scope close.

Not required as shared substrate:

- one monolithic raw+codec supervisor;
- generic command queue between workflow and owner;
- host-sdk import/provide of `RuntimeOutputJournalLayer`;
- compatibility fallback to `runRuntimeContext` or `runCodecRuntimeEventPipeline`.

## Output B: Workflow-Body Diagnostic

### Minimal Reactive Body

Proposed body, classified by responsibility:

1. Read `RuntimeContext` and allocate activity attempt.
   - Real durable control-plane work.
   - Owns run identity and attempt sequencing.

2. Write `RuntimeRun.started`.
   - Real durable control-plane work.
   - Externally committed run state.

3. `startOrAttach(context, activityAttempt)` activity.
   - Shim over supervisor.
   - Durable only as an activity claim/result; real process ownership is live.

4. Wait for `AgentOutputAfter(contextId, activityAttempt, lastSequence)`.
   - Real durable coordination if the wait router is reliable.
   - Current #303 blocker shows this lifecycle must be proven independently.

5. On `ToolUse`, run `RuntimeToolUseExecutor` activity and send result through
   `send(..., tool-{contextId}-{activityAttempt}-{toolUseId})`.
   - Mixed.
   - Tool execution is real durable activity work; returning the result to the
     process is supervisor shim.

6. On `PermissionRequest`, await `permission-{permissionRequestId}` deferred
   and send response.
   - Mixed.
   - Permission decision is real durable workflow/deferred work; process
     response is supervisor shim.

7. On prompt/input, await/complete content-derived prompt deferred and send
   command.
   - Mixed.
   - Prompt acceptance/dedup belongs in workflow/deferred model; emission is
     supervisor shim.

8. On `Terminated`, write `RuntimeRun.exited`.
   - Real durable control-plane work.
   - Externally committed terminal state.

9. On recoverable failures, suspend with durable cause.
   - Real durable workflow-engine work.

### Is the Workflow Body Earning Its Keep?

Partially, but not as a full process actor.

The body earns its keep for:

- durable run state (`started`, `failed`, `exited`);
- content-derived prompt/permission/tool decisions;
- first-writer-wins deferreds;
- activity-backed tool execution;
- cross-restart recovery of decisions and terminal state;
- removing old ingress/tool-router authority responsibilities.

The body does not earn its keep for:

- owning the live process loop;
- serializing stdin/JSON-RPC emission;
- supervising raw/codec process lifetime;
- maintaining in-memory session attachment;
- output pump lifecycle.

Those are host-scoped live owner responsibilities. For runtime contexts, the
workflow body is mostly valuable as the durable decision/control plane around a
process actor, not as the actor itself.

## Stand Or Retreat

Path X should retreat from "workflow-native process actor" to the §9.3 retreat
shape.

The recommended shape:

- workflow owns durable decisions/deferreds/run state;
- host-scoped live process owner owns raw/codec process loops and output pumps;
- `startOrAttach` and `send` are short activities into that owner;
- old `runRuntimeContext`, `session-runtime`, `tool-router`, and
  `ingress-delivery` are still deleted/made unreachable;
- compatibility shims are not preserved.

This is not a retreat to the legacy substrate. It is the §9.3 suspend-pattern
retreat: keep the durable workflow benefits that fix permission/input/tool
crash semantics, but stop trying to make the workflow body itself be the
long-running process/session owner.

Path X "stands" only for the durable decision layer. It should retreat for
process ownership.

## Immediate Next Slice

Do not expand #303's monolithic supervisor.

The next implementation slice should either:

- add the narrow per-context output writer plus tests and remove host-sdk's
  dependency on `RuntimeOutputJournalLayer`; or
- split raw/codec owner adapters behind `startOrAttach`/`send` and prove the
  cached-start/empty-registry reattach case.

Any non-draft PR must still delete or make unreachable at least one legacy
dependency edge.

