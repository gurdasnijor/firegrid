# Delegated Session Architecture Synthesis (2026-05-22)

**Bead:** `tf-8hwy`
**Purpose:** synthesize the live ACP/Zed findings and STOP reports into one
architecture alignment note for delegated child sessions.

## 0. Executive Finding

The parent-child delegation failures are not one missing channel name. They are
the same missing architecture boundary showing up in three places:

1. `session_new` can create a child context before the child process has proven
   it started, so an immediate `running` status was false.
2. `session_prompt` can durably append/queue input to a child, but that ack is
   not the same as "the child read it, processed it, or can ever reply."
3. The parent has no authorized, cursored, agent-visible way to observe the
   child output or terminal result.

The aligned architecture should model delegation as a durable parent-child
relationship owned by the host kernel/runtime lifecycle, with observation as an
authorized cursored read over child output. It should not be implemented as
agent-guessed channel strings, ad hoc dynamic router entries, or optimistic
status/result acks.

## 1. Source Findings

### 1.1 Live parent-child output gap

The live Zed investigation in
`docs/investigations/2026-05-21-acp-parent-child-output-channel-gap.md` showed a
parent agent could use `session_new` and `session_prompt`, then had no declared
channel to observe the child's reply. The agent guessed channel names such as
`session.output`, `session.child.output`, and `agent.output`; all failed with
`ToolInvalidInput: unknown channel`.

Source verification in PR #641 showed why this is structural:

- `wait_for` input is `{ channel, match }`, with no `sessionId` and no cursor.
- The router resolves static compose-time targets by exact string.
- The `wait_for` lowering always builds `CallerFact { stream: target }`; it
  never builds the existing cursored `AgentOutputAfter` source.
- `session_new` returns a child `sessionId`/`contextId` handle, but no output
  binding and no durable parent-child observation authority.

### 1.2 `session_new` startup honesty gap

PR #643 fixed the immediate lie by returning `created` instead of `running` from
the live child spawn seam. That is the right narrow fix: the child workflow is
started fire-and-forget, and the actual process spawn succeeds or fails later.

The STOP boundary remains:

- confirmed `running` requires observing durable child run-start lifecycle
  evidence;
- immediate `failed` on ENOENT requires the same lifecycle evidence;
- `session_prompt` must not claim more than "durably enqueued" unless it is
  gated by child lifecycle/ingress processing state.

So status is not a local property of `session_new`; it is a projection of
runtime lifecycle state.

### 1.3 Prior delegation sim gap

`docs/research/tf-39b-delegation-parent-child.FINDING.md` proved the public
surface can create a child and preserve parent correlation, but it did not prove
child result delivery. The child did not produce `TextChunk`; the localized gap
was in the child handoff prompt delivery path from workflow-authored ingress to
child agent stdin.

That finding is compatible with the live Zed gap: even after a child exists, we
need distinct evidence for input delivery, child process lifecycle, and child
output/result observation.

### 1.4 Output cursor and edge findings

The Phase 0B/0C findings matter here because child observation cannot be a
from-zero scan:

- `2026-05-22-tf-aseo-output-cursor-cutover-blocker.md` found that true
  O(outputs) replay behavior requires durable loop state, not just an output
  read swap.
- `2026-05-22-phase0c-acp-edge-output-consumption.md` says the ACP edge should
  consume one cursor-seeded output subscription per turn and keep terminal
  completion as an output fact.
- `SDD_WAIT_ROUTER_PERCONTEXT_OUTPUT.md` establishes per-context output streams
  as the production observation target.

Delegated child observation should reuse that direction: context-keyed,
cursor-seeded, terminal facts from output, not route receipt metadata.

## 2. Architecture Diagnosis

Today the delegation path crosses five boundaries without a single owner:

| Boundary | Current shape | Problem |
| --- | --- | --- |
| Child creation | `session_new` creates a child context and starts the child workflow fire-and-forget | Return status can only be pre-confirmation unless lifecycle evidence is observed |
| Input delivery | `session_prompt` appends/queues child ingress | Ack means durable enqueue, not child read/process/reply |
| Observation source | Runtime can read `AgentOutputAfter{contextId, afterSequence}` | Agent `wait_for` cannot select that source for a child |
| Routing | Static channel router and string `channel` input | Runtime-created child ids do not fit static exact-match channel names |
| Authority/result ownership | No durable parent-child observation link | Arbitrary context output reads would be an authority hole; child result ownership is undecided |

The recurring smell is "client predicts host facts." The parent agent should not
guess a channel, infer a child lifecycle from `session_new`, or treat an append
ack as a result. The host should declare the child handle, lifecycle state,
observation cursor, and result semantics.

## 3. Alignment Proposal

### 3.1 Host kernel owns the parent-child relationship

Create a durable parent-child session relationship owned by the host kernel or
runtime lifecycle owner, not by the agent tool call frame:

```txt
DelegatedSessionLink {
  parentContextId
  childContextId
  createdByToolUseId
  createdAt
  observationScope
  lifecycleState
}
```

This link is the authority record for later observation and prompting. A parent
can observe only children it spawned, unless a future explicit sharing contract
extends that authority.

This aligns with the HostKernelWorkflow direction from PR #602: long-running
control/lifecycle ownership belongs in workflow state, while routers and edges
remain system-call/transport boundaries.

### 3.2 `session_new` returns a handle, not proof of liveness

`session_new` should return a durable handle with a pre-confirmation status until
the child run lifecycle proves otherwise. The narrow `created` fix is consistent
with this.

The target contract should distinguish:

- `created` / `starting`: context and child workflow exist; process liveness is
  not confirmed.
- `running`: child process/run-start evidence is durable.
- `failed`: child startup or runtime terminal failure is durable.
- `done` / `aborted`: terminal lifecycle evidence is durable.

If callers need confirmed startup, add an explicit wait/status operation rather
than making `session_new` block indefinitely.

### 3.3 `session_prompt` returns enqueue semantics

`session_prompt` should be explicit that `appended: true` means the prompt was
accepted into durable child ingress. It should not imply child delivery,
processing, or reply.

Future richer statuses can be layered:

- `enqueued`: durable ingress row exists.
- `delivered`: child workflow/codec accepted the row for the active child run.
- `processed`: child emitted output or terminal evidence causally after the
  input.

Only `enqueued` is a narrow append contract. The latter two require lifecycle
and input/output correlation owned by runtime/host kernel state.

### 3.4 Prefer a typed child observation operation over dynamic channel names

Do not solve this by registering per-child string channels like
`session.child.output.<id>`. That preserves the stringly router model and makes
runtime-created authority look like a channel namespace problem.

Prefer a typed operation, either as a dedicated tool or as a redesigned typed
wait source:

```txt
session_wait({
  sessionId,
  afterSequence,
  until?: { tag?: "TextChunk" | "ToolUse" | "TurnComplete" | "Terminated" }
})

-> {
  observations,
  cursor: { afterSequence },
  terminal?: ...
}
```

Internally this lowers to:

```txt
authorize(parentContextId, childContextId)
  -> RuntimeObservationSource.AgentOutputAfter {
       contextId: childContextId,
       activityAttempt,
       afterSequence
     }
```

`wait_for(channel, match)` can later become sugar over typed sources, but the
architectural primitive should be a schema-backed source, not an arbitrary
channel string. This is consistent with the historical typed wait-source SDD:
runtime wait sources are discriminators over known durable observations.

### 3.5 Separate two observation surfaces

There are two related but distinct needs:

1. **Read child output:** parent consumes the child's output stream with a
   cursor, useful for interactive delegation and debugging.
2. **Await child result:** parent awaits the child terminal result as a
   delegation outcome.

The first is an authorized `AgentOutputAfter` read. The second is a host-kernel
result ownership question. They can share the same output facts, but should not
be collapsed accidentally. In particular, route-completion metadata should not
be treated as child terminal result; terminal facts come from the child output
and lifecycle log.

## 4. Proposed Decision Set

These are the decisions that unblock implementation:

1. **Authority:** accept `DelegatedSessionLink(parentContextId, childContextId)`
   as the durable authority for parent observation and prompting.
2. **Status:** define `session_new` as a handle-creation operation with
   pre-confirmation status; confirmed `running`/`failed` comes from lifecycle
   observation.
3. **Prompt ack:** define `session_prompt.appended` as durable enqueue only.
4. **Observation contract:** add a typed child-output read/wait contract with
   `sessionId` and mandatory cursor/`afterSequence`.
5. **Result ownership:** HostKernelWorkflow/runtime lifecycle owns child result
   delivery; the parent read surface observes facts, it does not invent terminal
   state.
6. **Router boundary:** avoid dynamic per-child channel strings as the primary
   contract. The router may dispatch the typed operation, but it should not be
   the authority store.

## 5. Implementation Slices After Alignment

1. **Spec/protocol slice:** define the child observation contract:
   `session_wait`/`session_read` or a typed `wait_for` source variant carrying
   `sessionId` and `afterSequence`.
2. **Authority slice:** record `DelegatedSessionLink` at child creation and
   enforce it before child output reads or prompts.
3. **Lifecycle/status slice:** derive session status from runtime run lifecycle
   evidence; keep `session_new` non-blocking unless an explicit confirmed-start
   option is designed.
4. **Observation slice:** lower authorized child observation to
   `AgentOutputAfter` over the child's per-context output stream; return the
   next cursor with every response.
5. **Prompt semantics slice:** rename/document `session_prompt` result semantics
   as enqueue-only; add tests that a failed/non-running child does not masquerade
   as delivered work once lifecycle status is available.
6. **Result slice:** decide how HostKernelWorkflow exposes child terminal result
   to the parent: either as a result row/signal or as a documented convention
   over the child output terminal observation.

## 6. What Not To Do

- Do not add guessed or undocumented channel names.
- Do not let a parent read arbitrary `contextId` output without a durable
  parent-child authority link.
- Do not report `running` until lifecycle evidence exists.
- Do not claim `session_prompt` delivery when only durable enqueue is proven.
- Do not make route receipts or router metadata the source of child terminal
  truth.
- Do not add a second output/result state beside the workflow-owned output log.

## 7. Recommended Next Step

Use this synthesis as the input to a short SDD that commits the six decisions in
§4. Once those are accepted, `tf-1ymw` can implement the protocol shape and
`tf-br1w` can resume as an implementation task instead of another boundary
investigation.

If a smaller near-term UX improvement is needed before the full result contract,
ship only the authorized cursored read (`session_read`/`session_wait`) and leave
child terminal-result delivery explicitly pending. That would unblock parent
agents from observing child output without pretending that delegated results are
fully modeled.

## 8. Source Index

- PR #641 / `tf-br1w`: delegated child-output STOP report.
- PR #643 / `tf-kllj`: `session_new` startup status honesty and lifecycle
  boundary.
- `docs/investigations/2026-05-21-acp-parent-child-output-channel-gap.md`
  (`feat/acp-dev-tooling`): live Zed parent-child output gap.
- `docs/research/tf-39b-delegation-parent-child.FINDING.md`: public-surface
  delegation sim and child handoff delivery gap.
- `docs/investigations/2026-05-22-tf-aseo-output-cursor-cutover-blocker.md`:
  durable loop-state requirement for true output cursor behavior.
- `docs/investigations/2026-05-22-phase0c-acp-edge-output-consumption.md`:
  cursor-seeded edge output consumption and terminal-output ownership.
- `docs/sdds/SDD_WAIT_ROUTER_PERCONTEXT_OUTPUT.md`: per-context output routing.
- `docs/sdds/SDD_FIREGRID_TYPED_WAIT_SOURCE_REDESIGN.md`: typed wait-source
  rationale; retained as historical reference for why string source registries
  are not the target architecture.
