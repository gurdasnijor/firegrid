# Decision: Path X Stands as Durable Control Plane, Retreats Process Ownership

Status: ratified architecture decision. Amends
`docs/sdds/SDD_PATH_X_IMPLEMENTATION.md` (PR B / PR C shape).

Date: 2026-05-17

Provenance: ratified from the #303 diagnostic. The decision content is
extracted here so it lives on `main` independent of #303's mergeability.
Source artifacts (in draft PR #303, branch
`codex/path-x-pr-c-native-supervisor`, not on main):

- `docs/research/path-x-pr-c-fit-diagnostic-2026-05-17.md`
- `docs/research/path-x-pr-c-native-supervisor-blocker-2026-05-17.md`

Retreat target: `docs/research/workflow-native-runtime-substrate-spike-2026-05-16.md`
§9.3 ("Fallback if the path goes wrong" — Path A suspend-pattern retreat).

Related: `docs/research/path-x-legacy-deletion-map.md` (PR C deletion gate),
`docs/sdds/SDD_FIREGRID_HOST_SDK.md`.

## Status of #303

#303 is **diagnostic / proof only**. It is not mergeable and is not the
Path X implementation. Its native-supervisor attempt is explicitly an
*additive substrate*, not a replacement: `startRuntime` does not
complete because the native runtime-context workflow/supervisor path
does not drive wait completion/resume even though per-context terminal
output is written. Treat #303 as evidence that produced this decision,
not as a branch to land.

What #303 *did* prove and is reusable:

- per-context output stream URL alignment and the
  `RuntimeAgentOutputAfterEvents` override work **without** starting a
  process (process-free `AgentOutputAfter` coverage passes);
- `RuntimeWaitStreamsLive` override propagation is sound;
- the remaining failure is router lifecycle/attachment semantics, not
  process startup.

## Ratified Decision

**Path X stands only for the durable decision/control plane. It
retreats from "workflow-native process actor" to the §9.3
suspend-pattern retreat shape.**

This is **not** a retreat to the legacy substrate. The durable workflow
benefits that fix permission/input/tool crash semantics are kept; only
the ambition of making the workflow body itself the long-running
process/session owner is conceded.

### What Path X keeps (the workflow body earns its keep here)

- durable run state: `RuntimeRun.started` / `failed` / `exited`;
- content-derived prompt / permission / tool decisions;
- first-writer-wins `DurableDeferred` for input / permission / tool /
  prompt;
- activity-backed tool execution via `RuntimeToolUseExecutor`;
- cross-restart recovery of decisions and terminal state;
- `Workflow.SuspendOnFailure` with durable cause;
- removal of the old ingress / tool-router / claim authority tier.

### What Path X retreats (host-scoped live owner, not the workflow body)

- owning the live process loop;
- serializing stdin / JSON-RPC emission;
- supervising raw/codec process lifetime;
- maintaining in-memory session attachment;
- output pump lifecycle.

The reactive workflow body coordinates a process actor; it is not the
actor. The live owner is a **host-scoped process owner** with two short
`Activity.make` boundaries:

- `startOrAttach(context, activityAttempt)` — installs/reattaches a
  host-owned runtime session; returns `Started` evidence; must not wait
  for terminal output; must not fork `runRuntimeContext`.
- `send(context, activityAttempt, command)` — emits exactly one typed
  command to the attached owner; returns `CommandAccepted`; must not
  wait for output.

### No second mini-runtime

Explicitly rejected as shared substrate:

- one monolithic raw+codec supervisor (#303's
  `runtime-context-supervisor.ts` is the anti-pattern this decision
  blocks from landing as-is);
- a generic command queue between workflow and owner (a queue, if
  needed, is **adapter-local ordering**, not workflow coordination, and
  must not be the shared substrate primitive);
- host-sdk import/provide of `RuntimeOutputJournalLayer` as an old
  authority layer;
- any compatibility fallback to `runRuntimeContext` or
  `runCodecRuntimeEventPipeline`.

A minimal attach registry / owner index **is** required for production
correctness (cached `startOrAttach` results replay against an empty
in-memory registry after engine restart, so `send` must locate or
rebuild the owner). Minimum shape: key `{ contextId, activityAttempt }`,
value adapter handle + `supervisorSessionId`, single claim path for
`startOrAttach`/`send`, eviction only after observed terminal/death. It
is an attach index, not a mutable mini-runtime.

## Amendment to SDD_PATH_X_IMPLEMENTATION

PR B / PR C are reshaped, not redefined. The deletion gate is unchanged:
`runRuntimeContext`, `session-runtime` (`runCodecRuntimeEventPipeline`),
`tool-router` (`runToolRouter`), and `ingress-delivery`
(`runIngressDelivery`) are still deleted or made unreachable; no
compatibility shims are preserved (consistent with
`docs/research/path-x-legacy-deletion-map.md`).

The replacement owner for the deleted behavior is the split live owner
(below) driven by `startOrAttach` / `send`, **not** the monolithic
supervisor.

## Immediate Next Code Slice

Do not expand #303's monolithic supervisor. The next implementation
slice is, in order:

1. **`PerContextRuntimeOutputWriter` + `AgentOutputAfter` plumbing.**
   A narrow per-context output writer capability owned by runtime or
   host-sdk composition:
   - methods e.g. `appendEvent(context, activityAttempt, eventOrRaw)`
     and `appendLog(context, activityAttempt, line)`;
   - opens `RuntimeOutputTable` at
     `runtimeContextOutputStreamUrl({ baseUrl, prefix: context.host.streamPrefix, contextId })`;
   - no dependency on the host-owned `runtimeOutput` stream or the old
     `RuntimeOutputJournalLayer` composition;
   - removes host-sdk's dependency on `RuntimeOutputJournalLayer` as an
     authority layer;
   - lands with tests and a proven `AgentOutputAfter`
     wait-completion/resume path (closing the #303 router-lifecycle
     blocker independently of process startup).

2. **Split `RawRuntimeOwnerAdapter` / `CodecRuntimeOwnerAdapter`**
   behind `startOrAttach` / `send`:
   - Raw adapter: local-process spawn, stdin byte encoding,
     stdout/stderr line capture, synthetic terminal emission; no
     ACP/JSON-RPC framing.
   - Codec adapter: `AgentByteStream`, `AgentSession`, ACP/stdio-jsonl
     framing, typed `AgentInputEvent` sends; no raw prompt-to-line
     encoding.
   - Shared core: only session identity, attachment, lifecycle, command
     claim metadata; no mixed raw/codec stream pump.
   - Prove the cached-`startOrAttach` / empty-registry reattach case.

Any non-draft PR must still delete or make unreachable at least one
legacy dependency edge.

## Required State (production correctness)

Required:

- attach registry / owner index;
- adapter-local lifecycle state;
- per-command durable claim before external byte / JSON-RPC emission;
- narrow per-context output writer;
- lifecycle cleanup on terminal output, sandbox death, scope close.

Not required as shared substrate: monolithic supervisor; generic
workflow↔owner command queue; host-sdk `RuntimeOutputJournalLayer`
dependency; any `runRuntimeContext` / `runCodecRuntimeEventPipeline`
fallback.

## Legacy Symbol Classification (carried from #303, aligned with the deletion map)

| Symbol | Verdict |
| --- | --- |
| `runRuntimeContext` | DELETE / make unreachable before any non-draft PR |
| `runCodecRuntimeEventPipeline` | DELETE from production reachability |
| `runIngressDelivery` | DELETE once command delivery is workflow/owner-owned |
| `runToolRouter` | DELETE once tool execution is workflow-owned via `RuntimeToolUseExecutor` |
| `appendRuntimeIngress` / `appendRuntimeIngressToOwner` | SUPERSEDED by `RuntimeInputIntent` plus per-context workflow engines. Client/app prompt surfaces append intents; host-local dispatcher completes the active per-context workflow deferred. `appendRuntimeIngressToOwner` is not target architecture. |
| `RuntimeOutputJournalLayer` | RESHAPE/KEEP on the runtime read-side substrate; host-sdk production composition must **not** depend on it as an authority layer |
</content>
