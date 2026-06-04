# Unified Subscriber Kernel — The Concept-Space Collapse

Audience: anyone trying to understand whether the Shape C/Shape D
distinction is permanent or transitional, and what a smaller runtime
kernel looks like.

Status: **synthesis** across already-decided cannon architecture + four
load-bearing firelab simulations. The cannon authority is
`docs/cannon/architecture/kernel-owned-write-arm.md` (active,
dispatchable). This doc is the engineer-facing collapse story tying the
cannon to what shrinks in the codebase.

## TL;DR

- **Shape C is a workaround for a missing engine capability** — durable
  suspend recovery for non-clock waits. Not an irreducible distinction.
- The capability has a name (`kernel-owned-write-arm`), a decided shape
  (cannon doc above), four empirical proofs (the deferred simulations),
  and a work mapping (`tf-c9r9` / `tf-vrz6` / `tf-jpcg` / `tf-vfq9`).
- Once it lands, **every subscriber is a workflow**, the Shape C/D
  decision table dissolves, several subscriber folders collapse, the
  identity-keyed-dedup discipline is no longer a contributor concern
  (the engine owns it), and `subscribers/keyed-dispatch/` (per-key
  mutex helper + fork-per-fact dispatch) deletes entirely — the
  workflow's `idempotencyKey` admission + the engine's single-fiber
  execution model give per-key serialization for free.
- The minimum runtime kernel is **three primitives** —
  `Channel`, `DurableTable<Row>`, `Workflow` (with `kernel-owned-write-arm`).
  Everything else composes from these.

## The asymmetry that creates Shape C

The engine has exactly one durable suspend recovery path:
`recoverPendingClockWakeups` (`packages/runtime/src/engine/internal/engine-runtime.ts`).
On every reconstruction it walks pending clock wakeups and re-arms them.
That's why `DurableClock.sleep` survives crash.

**There is no equivalent for `Workflow.suspend` waiting on a domain-keyed
signal** — input arrival, permission response, tool result,
child-session completion. The engine's `suspended` flag is undifferentiated
(`engine-runtime.ts`); it cannot distinguish a table-row wait from a
`DurableDeferred.await` from an interrupt. A blanket "resume every
suspended workflow on restart" sweep was prototyped and **falsified** —
it races legitimate `deferredDone` paths and corrupts terminality
(`tf-12q9`). Cannon explicitly forbids this sweep.

So today's options for "wait on a domain signal" are:

1. **Manual reimplementation** — fresh handler per fact over a durable
   state row. This is **Shape C**. The handler reads the row on every
   entry, derives the wait state, and either dispatches or returns.
   `eventAlreadyProcessed` / identity-keyed dedup / per-key mutex
   helper / fork-per-fact dispatcher —
   these are the contributor-facing discipline this approach demands.
2. **`DurableClock.sleep` for clock waits only** — the one safely-parked
   binding. This is the only **Shape D** body that survives reconstruction.

Shape C/D is the seam between "what the engine recovers natively" and
"what we have to hand-write." Close the engine gap and the seam
disappears.

## The decided kernel shape

From `docs/cannon/architecture/kernel-owned-write-arm.md`:

```text
edge / channel route
  -> host kernel/controller command       (records intent FIRST)
  -> write the workflow-owned row         (idempotent)
  -> arm or resume the owning execution   (idempotent)
  -> persist enough command state for restart recovery
```

The "host kernel/controller" is **not a generic engine sweep**. It is a
bounded controller that owns specific write+arm facts, recovers only its
own pending commands on restart, and never touches the engine's
undifferentiated `suspended` set.

Three pieces:

| Piece | What it owns |
|---|---|
| **`KernelCommandTable`** | Per-runtime durable table: `{commandKey, executionId, inputKey, inputValue, status}`. Written **first**, as the durable record of intent. |
| **`kernelWriteArm(executionId, inputKey, value)`** | The atomic-from-the-caller's-view command: (1) record kernel fact, (2) write workflow-owned row, (3) `engine.resume(executionId)`. Each step idempotent. |
| **`replayPendingWriteArm`** | Startup sweep over the **kernel's own** command table. For each fact whose execution has no `finalResult`, re-write the row + re-arm. Runs after workflow registration so `resume` has the execute fn. |

The bounded-ownership rule is the load-bearing soundness property: the
kernel recovers what it owns a write+arm fact for, never what it
doesn't. `DurableDeferred.await` suspensions, interrupts, other
table-waits owned by other controllers — all untouched. The
`kernel-owned-write-arm` simulation Probe C is the proof.

## What the simulations together establish

Four sims compose the full collapse story; each closes a specific gap.

| Sim | What it proves | What it unlocks |
|---|---|---|
| `input-suspend-crash-recovery` (S1) | The asymmetry is REAL: clock waits auto-recover; table-waits don't. Engine sweep falsified. | Names the problem precisely. |
| `kernel-owned-write-arm` (KWA) | The bounded-ownership controller pattern recovers parked table-wait bodies on restart with NO driver re-drive and NO generic sweep. Probe C: `DurableDeferred.await` parked separately is left untouched. | The sound fix shape — both for axis-2 durability and for the larger conceptual collapse. |
| `tiny-input-append-wakeup` | Atomic input-append (`appendRuntimeContextWorkflowInput`) over `contexts` + `inputs` + `inputIds` tables; `inputIds` is the idempotency index; consumption by durable cursor with point reads; native row stream as the wakeup primitive. | The workflow-owned input table shape. No bridge table, no `appendRuntimeInputDeferred`, no input intent dispatcher. |
| `runtime-context-session-workflow` (RCSW) | The unified shape applied to RuntimeContext: kills two production races (input-before-start dropped silently; double `claude-agent-acp` PIDs from a TOCTOU). Workflow body parks on `Workflow.suspend`; kernel write+arm re-arms via `Workflow.resume`; `Workflow.idempotencyKey` admits one execution per `(contextId, attempt)`; `Activity.make` memoizes the spawn. | Production-equivalent proof. The new lane is `subscribers/runtime-context-session-workflow/` — a NEW target folder, distinct from the Shape C `runtime-context-session/`. |

`per-key-subscriber-push-restart` was supporting evidence for the
Shape C cutover, NOT for the unified kernel. It establishes that the
DurableTable substrate alone gives "serialization XOR cross-key
concurrency, never both" — i.e., a Shape C fork-per-fact dispatcher
needs a per-key mutex helper. The unified kernel sidesteps this
entirely: the workflow IS the subscriber, `Workflow.idempotencyKey`
admits at-most-one execution per logical key, and the engine runs each
execution body in a single fiber. Per-key serialization is given for
free; no mutex helper is needed.

## The three-primitive kernel

After the kernel lands, the irreducible vocabulary is:

1. **`Channel`** — `name + direction + schema + binding`. Four
   directional shapes (`ingress` / `egress` / `call` / `bidirectional`).
   The only thing agents ever name; host-declared indirection routes
   the name to a backing source. (See
   `docs/recipes/client-sdk-channel-targets.md` and the channel-target
   indirection section in `packages/runtime/src/channels/README.md`.)
2. **`DurableTable<Row>`** — durable rows keyed by domain identity.
   `insertOrGet(factKey)` is the universal idempotent write. Row streams
   are the universal observation primitive.
3. **`Workflow`** — `Workflow.make` body with `Workflow.idempotencyKey`,
   `Workflow.suspend`/`Workflow.resume`, `Activity.make` (memoized side
   effects), `DurableClock.sleep` (timer), and the **kernel-owned
   write+arm controller** that ensures suspends are recovered.

Everything else is a helper or convention:

| Helper | What it composes |
|---|---|
| `makeIngressChannel({target, schema, binding})` | Channel + row stream. |
| `makeVerifiedWebhookSource({source, factSchema, ingest, route})` | Channel + table + HTTP route + HMAC. |
| `kernelWriteArm` | KernelCommandTable + DurableTable write + `Workflow.resume`. |
| `appendRuntimeContextWorkflowInput` | DurableTable atomic insertOrGet over `(contexts, inputs, inputIds)`. |
| `WaitFor.match` (today) → just `Workflow.suspend` (after kernel) | The current wait-router workflow body is what every subscriber body looks like under the kernel. |
| Subscriber | A `Workflow.make` body that consumes channels (via row streams), waits on facts (via `Workflow.suspend` + kernel write+arm), and either writes durable rows or runs bounded `Activity` / `DurableClock` bindings. |

The "Shape C" vs "Shape D" distinction does **not** appear in this
list. It's a transitional concept, not a primitive.

## What collapses in the codebase

Once the kernel lands and the migration runs:

| Today | After kernel |
|---|---|
| `subscribers/runtime-context/` — Shape C handler over input facts | Folder collapses; the workflow body lives in `subscribers/runtime-context-session-workflow/` (the RCSW shape, generalized) |
| `subscribers/runtime-context-session/` — Shape C codec command sink | Collapses into the same workflow body; the two interlocking races RCSW closes go away |
| `subscribers/keyed-dispatch/` — per-key mutex over fact streams | **Deletes entirely.** Per-key serialization is given by `Workflow.idempotencyKey` admission + the engine's single-fiber execution model. There is no subscriber-runtime fork-per-fact pattern under the unified kernel. |
| `subscribers/tool-dispatch/` — Shape D MCP-entry path | Stays, but the `runToolAndSend` in-handler stdio-jsonl path collapses into the workflow body |
| `subscribers/wait-router/` | The `WaitForWorkflow` body becomes the canonical "wait via `Workflow.suspend` + kernel" pattern — every subscriber inherits its shape |
| `tables/runtime-context-input-facts.ts` (live tail of `inputIntents`) | Collapses into the workflow-owned input table (`tiny-input-append-wakeup` shape); `appendRuntimeInputDeferred` deletes |
| `composition/host-public.ts:appendRuntimeIngress` | Becomes a `kernelWriteArm` call against the workflow-owned input table |
| `RuntimeContextWorkflowRuntime` bridge in host-sdk | Already on the deletion path (shape-d-tool-dispatch-mcp-entry finding); kernel lands the last hold-out |
| Identity-keyed dedup discipline | No contributor concern — workflow suspend IS the dedup |
| `eventAlreadyProcessed` gates | Gone |
| Shape C / Shape D / shape distinction | Gone — every subscriber is a workflow |
| The `subscribers/runtime-context/` README's "MUST NOT name `WorkflowEngine`" rule | Gone — every subscriber names it |

## What stays

The collapse does **not** touch:

- `events/` — pure event/row schemas
- `capabilities/` — pure `Context.Tag` declarations
- `tables/` — `DurableTable` definitions (one row family per file)
- `sources/` — emitters (sandbox, codecs)
- `producers/` — topic writers (post PR-M2/M3)
- `transforms/` — pure row/event reducers
- `channels/` — wire-edge live routing
- `engine/` — the workflow engine substrate (gains the kernel primitive)
- `composition/` — Layer wiring
- HMAC verification, JSON decoding, protocol channel constructors, MCP
  exposure, OTel telemetry, output observation, terminal completion
  ordering, channel-target indirection — all unchanged.

The collapse is in the **subscriber tier**. The rest of the
sources→producers→tables→subscribers→composition graph stays.

## Why this isn't just "rewrite everything as a workflow"

The naive answer is "make everything a workflow body, suspend on the
fact, done." The cannon work and the sims explain why that doesn't
work today and why the kernel is the load-bearing piece:

1. **Engine sweep is unsafe** (tf-12q9). The engine cannot distinguish
   suspension kinds, so a generic resume races `deferredDone` /
   interrupt and corrupts terminality.
2. **`DurableDeferred` mailbox is bridge debt**, not the target.
   `appendRuntimeInputDeferred` is what production uses today; the
   migration SDD explicitly retires it.
3. **TOCTOU between dispatcher and subscriber.** The current shape has
   a `Ref.get + check + Ref.update` race that can spawn two
   `claude-agent-acp` PIDs for one logical session
   (`adapter-common.ts:189-192`). RCSW closes this via
   `Workflow.idempotencyKey` + `Activity.make` — both engine primitives
   that only work cleanly under the kernel.
4. **Replay storms** (tf-7kq8 / tf-aseo). The Shape C handler's
   "scan the dense raw output stream" pattern is bridge debt; the target
   is a sparse output transition log written by an appender and read
   point-wise by the body. Same write+arm primitive.

Each of these is a concrete failure mode the current architecture
contains, and each is resolved by the same kernel primitive.

## Sequenced migration (already partly in motion)

The work mapping is in `kernel-owned-write-arm.md` §Work Mapping:

| Bead | Owns | Status |
|---|---|---|
| `tf-c9r9` | Smallest concrete host-kernel/controller path for the runtime-context table input write+arm in the reference path. Reports the concrete production cutover surface. | Open |
| `tf-vrz6` | Consume the resulting write+arm primitive for table-backed input delivery. | Blocked on tf-c9r9 |
| `tf-jpcg` | Same primitive class for tool request/result wakeup. Don't invent a separate wake mechanism. | Open |
| `tf-vfq9` | Delete `ToolCallWorkflow` (only after tf-jpcg seam exists). | Blocked on tf-jpcg |
| `tf-aseo` | Output replay storm fix via sparse transition log + write+arm. | Independent; can proceed in parallel |
| `tf-12q9` | Negative evidence — engine restart sweep shape is unsafe. | Settled; do not redo |

The `runtime-context-session-workflow` simulation is the
production-equivalent shape for tf-c9r9's reference path. Its next-steps
section names the new production target folder
(`subscribers/runtime-context-session-workflow/`) and the cutover
contract.

## Ground Truth

- `docs/cannon/architecture/kernel-owned-write-arm.md` — **the cannon
  authority**. Active, dispatchable.
- `docs/cannon/sdds/SDD_FIREGRID_RUNTIME_CONTEXT_INPUT_WRITE_ARM_MIGRATION.md` —
  migration SDD.
- `docs/architecture/2026-05-22-runtime-rearch-closeout.md` — the
  rearch closeout, including the axis-2 addendum.
- Simulations (load-bearing):
  - `packages/firelab/src/simulations/input-suspend-crash-recovery/`
  - `packages/firelab/src/simulations/kernel-owned-write-arm/`
  - `packages/firelab/src/simulations/tiny-input-append-wakeup/`
  - `packages/firelab/src/simulations/runtime-context-session-workflow/`
- Supporting:
  - `packages/firelab/src/simulations/per-key-subscriber-push-restart/`
- Engine source — the asymmetry:
  - `packages/runtime/src/engine/internal/engine-runtime.ts` —
    `recoverPendingClockWakeups`; no equivalent for non-clock suspends.

## Related Docs (updated to reflect transitional status)

- [`shape-c-vs-shape-d.md`](shape-c-vs-shape-d.md) — the current
  contributor-facing decision table. Reflects the **transitional** state
  before the kernel lands. Every Shape C handler in production today
  expects to collapse into a workflow body under the kernel.
- [`runtime-context-fact-matrix.md`](runtime-context-fact-matrix.md) —
  the fact taxonomy. Stays valid under the kernel; the matrix routing
  keys become the `kernelWriteArm` keys.

## What this is not

- **Not new work.** The architecture is decided in cannon. The
  simulations are landed. The work mapping is sequenced. This doc
  synthesizes the existing material into one engineer-facing reduction
  story.
- **Not a proposal to delete things now.** Each collapse in the table
  above happens when its corresponding bead lands. Doing the deletions
  ahead of the kernel implementation breaks production.
- **Not a complete substrate.** The kernel covers durable suspend
  recovery and per-key serialization. Output observation, channel
  routing, telemetry, transport adapters — all unchanged.
