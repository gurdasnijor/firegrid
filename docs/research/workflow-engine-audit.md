# Workflow Engine Audit (Upstream + Downstream)

Date: 2026-05-16

Scope: read-only reference material for the Firegrid Runtime Substrate
Architecture Design Exploration. This document enumerates what
`@effect/workflow` provides upstream, what `@effect/cluster`'s
`ClusterWorkflowEngine` does as the reference implementation, and the feature
parity status of Firegrid's `DurableStreamsWorkflowEngine`.

This is neutral reference material. It makes **no architectural
recommendations** and does **not** advocate for any substrate path. Where a
method is unimplemented or weaker than the reference, the gap is quantified
(LOC estimate + required Durable Streams operations) without judging whether
Firegrid should close it.

Conventions:

- Every claim cites `file:line`. Paths under `repos/effect/packages/` are the
  vendored upstream sources; paths under `packages/` are Firegrid.
- **Documented** = stated in README/JSDoc. **Verified** = confirmed from
  source or a cited test. Divergences between the two are called out
  explicitly.
- Source inputs to this audit deliberately excluded
  `docs/research/workflow-native-runtime-substrate.md` and
  `docs/sdds/MIGRATION_SKETCH_WORKFLOW_NATIVE_SUBSTRATE.md` per the brief, to
  keep the upstream audit unprejudiced.

Required-reading files actually consulted:

- `repos/effect/packages/workflow/src/{Workflow,Activity,DurableDeferred,DurableClock,WorkflowEngine}.ts`, `index.ts`, `internal/*`
- `repos/effect/packages/workflow/test/WorkflowEngine.test.ts`, `README.md`, `CHANGELOG.md`
- `repos/effect/packages/cluster/src/ClusterWorkflowEngine.ts`, `internal/entityManager.ts`, `Sharding.ts`, `Runners.ts`, `MessageStorage.ts`, `Envelope.ts`
- `repos/effect/packages/cluster/test/ClusterWorkflowEngine.test.ts`
- `packages/runtime/src/workflow-engine/DurableStreamsWorkflowEngine.ts`, `internal/{engine-runtime,table,codec}.ts`, `DurableStreamsWorkflowEngine.test.ts`
- `packages/runtime/src/host/layers.ts`, `packages/effect-durable-operators/src/DurableTable.ts`

---

## Section 1: `@effect/workflow` public API surface

### 1.1 Module `Workflow` (`repos/effect/packages/workflow/src/Workflow.ts`)

| Member | Signature (file:line) | Documented | Verified | Divergence |
|---|---|---|---|---|
| `TypeId` | `Workflow.ts:27,68` | — | `Symbol.for("@effect/workflow/Workflow")` | none |
| `Workflow.Payload/Success/Error` (type utils) | `Workflow.ts:32-62` | "Extracts the type of the X of a `Workflow`" (`:34,44,54`) | type-level only | none |
| `interface Workflow` | `Workflow.ts:74-189` | fields `name`, `payloadSchema`, `successSchema`, `errorSchema`, `annotations` (`:80-85`) | same | none |
| `annotate(tag,value)` | `Workflow.ts:90-95` | "Add an annotation to the workflow." (`:88`) | rebuilds via `make` with `Context.add` (`:289-294`) | none |
| `annotateContext(ctx)` | `Workflow.ts:100-105` | "Add the annotations from a Context object" (`:98`) | `Context.merge` (`:295-300`) | none |
| `execute(payload,options?)` | `Workflow.ts:110-120` | "Execute the workflow with the given payload." (`:108`) | resolves engine, computes `executionId` via `makeExecutionId`, delegates to `engine.execute` (`:301-315`); `discard:true` returns the executionId string | `suspendedRetrySchedule` comes from `make` options closure (`:277,311`), not per-call options; not stated in the `execute` JSDoc |
| `poll(executionId)` | `Workflow.ts:128-132` | returns `undefined` if not run, else current `Workflow.Result` (`:122-127`) | delegates to `engine.poll` (`:316-326`); undefined-when-unrun is engine behavior (memory: `WorkflowEngine.ts:603-611`) | none in upstream contract; engine implementations vary (see §5 C4) |
| `interrupt(executionId)` | `Workflow.ts:137` | "Interrupt a workflow execution" (`:135`) | delegates to `engine.interrupt` (`:327-337`) | none |
| `resume(executionId)` | `Workflow.ts:142` | "Manually resume a workflow execution" (`:139-141`) | delegates to `engine.resume` (`:338-348`) | none |
| `toLayer(execute)` | `Workflow.ts:148-161` | "Create a layer that registers the workflow…" (`:144-147`) | `Layer.scopedDiscard` → `engine.register` (`:349-353`) | none |
| `executionId(payload)` | `Workflow.ts:166-168` | "compute the deterministic execution ID" (`:163-165`) | `makeExecutionId = makeHashDigest(`${name}-${idempotencyKey(payload)}`)` (`:281,354`) | none — confirms determinism (see §2) |
| `withCompensation` | inst. `Workflow.ts:178-188`; impl `:656-675` | compensation finalizer called "if the entire workflow fails"; "will not work for nested activities" (`:170-177`,`:645-655`) | `uninterruptibleMask` → run effect → `addFinalizer(exit => isSuccess ? void : compensation(value, exit.cause))` (`:666-675`) | instance type uses `Cause<Error["Type"]>`, standalone uses `Cause<unknown>` (`:180` vs `:658`) — typing only |
| `make(options)` | `Workflow.ts:263-359` | category "Constructors" only | success default `Schema.Void` (`:286`), error default `Schema.Never` (`:287`), annotations default `Context.empty()` (`:288`) | no prose JSDoc |
| `fromTaggedRequest(schema,opts?)` | `Workflow.ts:365-375` | "Constructors" | `idempotencyKey: PrimaryKey.value`, name = `schema._tag` (`:373`) | no prose JSDoc |
| `isResult` / `Result` / `Complete` / `Suspended` | `Workflow.ts:393-505` | `@since` only | `Result = Complete \| Suspended`; `Complete` holds `exit: Exit`; `Suspended` carries optional `cause` (`:400,412-490`) | none |
| `intoResult(effect)` | `Workflow.ts:511-555` | "Result" category, no prose | forks/joins; on `SuspendOnFailure` sets `instance.suspended`/`instance.cause`; maps success→`Complete`, suspend→`Suspended`, else re-fail (`:516-543`); closes `instance.scope` on terminal exit (`:545-552`) | none; behavior test-verified `test/WorkflowEngine.test.ts:42-64` |
| `wrapActivityResult` | `Workflow.ts:566-596` | "Result" category, no prose | maintains `instance.activityState.count/latch`; aggregates `Suspended` cause into `instance.cause` (`:578-580`) | no prose JSDoc |
| `scope` / `provideScope` | `Workflow.ts:607-625` | "scope only closed when the workflow execution fully completes" (`:598-606,613-621`) | `InstanceTag.scope` / `Scope.extend` | none |
| `addFinalizer(f)` | `Workflow.ts:631-643` | "Scope", no prose | `Scope.addFinalizerExit` on the instance scope (`:642`) | no prose JSDoc |
| `suspend(instance)` | `Workflow.ts:680-685` | `@since` only | sets `instance.suspended=true`, self-interrupts the fiber as fork (`:684`) | no prose JSDoc |
| `CaptureDefects` | `Workflow.ts:696-698` | "captures defects… By default `true`" (`:687-695`) | `Context.Reference` `defaultValue: constTrue`; consumed `:516,540` | none |
| `SuspendOnFailure` | `Workflow.ts:710-714` | suspend on any error; resume via `Workflow.resume` (`:700-709`) | `Context.Reference` `defaultValue: constFalse`; consumed `:517,523-531` | none |

### 1.2 Module `Activity` (`repos/effect/packages/workflow/src/Activity.ts`)

| Member | Signature (file:line) | Documented | Verified | Divergence |
|---|---|---|---|---|
| `interface Activity` | `Activity.ts:36-66` | — | extends `Effect.Effect`; an Activity *is* an effect; fields `name`, schemas, `execute`, `executeEncoded` | no prose JSDoc |
| `make(options)` | `Activity.ts:85-126` | README "unit of work… executed only once unless `Activity.retry`" (`README.md:49-50`) | wraps `execute` in `retryOnInterrupt(name, interruptRetryPolicy)`; default success `Void` (`:96`), error `Never` (`:97`) | no prose JSDoc |
| default `interruptRetryPolicy` (internal) | `Activity.ts:128-132` | — | `exponential(100,1.5) ∪ spaced("10 seconds") ∪ recurs(10)`, `whileInput(Cause.isInterrupted)` | not exported |
| `retry(options)` | `Activity.ts:152-169` | README `Activity.retry({times:5})` (`README.md:70`) | provides incremented `CurrentAttempt` then `Effect.retry(options)` (`:163-168`); `schedule` option removed (`CHANGELOG.md:74`) | no prose JSDoc |
| `CurrentAttempt` | `Activity.ts:175-177` | README `yield* Activity.CurrentAttempt` (`README.md:54-55`) | `Context.Reference` `defaultValue: () => 1` | none |
| `idempotencyKey(name,opts?)` | `Activity.ts:183-199` | "Idempotency", no prose | `makeHashDigest(${executionId}[-attempt]-${name})` (`:191-198`) | no prose JSDoc |
| `raceAll(name,activities)` | `Activity.ts:205-226` | "Racing", no prose | delegates to `DurableDeferred.raceAll` named `Activity/${name}` (`:217-226`) | no prose JSDoc |

### 1.3 Module `DurableDeferred` (`repos/effect/packages/workflow/src/DurableDeferred.ts`)

| Member | Signature (file:line) | Documented | Verified | Divergence |
|---|---|---|---|---|
| `make(name,opts?)` | `DurableDeferred.ts:62-85` | "Constructors", no prose | success default `Void`, error `Never` (`:71-72`); `withActivityAttempt` re-scopes name to `${name}/${attempt}` (`:78-84`, `CHANGELOG.md:354`) | no prose JSDoc |
| `await` (`await_`) | `DurableDeferred.ts:102-130` | "Combinators" | `wrapActivityResult(engine.deferredResult(self), isUndefined)`; `undefined`→`Workflow.suspend`; else yield exit (`:112-121`) | no prose JSDoc |
| `into` (dual) | `DurableDeferred.ts:136-183` | "Combinators", no prose | clones parent instance; on completion calls `engine.deferredDone` unless interrupt-only-suspend (`:163-182`); test-verified `test/WorkflowEngine.test.ts:66-120` | no prose JSDoc |
| `raceAll(options)` | `DurableDeferred.ts:189-229` | "Racing" | makes `raceAll/${name}`; flattens existing exit else `into(raceAll(effects))` (`:217-228`) | no prose JSDoc |
| `Token` / `TokenParsed` | `DurableDeferred.ts:247-304` | — | branded string; `asToken = base64url(JSON.stringify([workflowName,executionId,deferredName]))` (`:272-274`) | **not documented anywhere**; only discoverable from source (see §2) |
| `token(self)` | `DurableDeferred.ts:310-318` | README `DurableDeferred.token` (`README.md:98-100`) | derives from in-context `WorkflowInstance` (`:316-317`) | none |
| `tokenFromExecutionId` | `DurableDeferred.ts:324-349` | "Token" | `new TokenParsed({workflowName, executionId, deferredName}).asToken` (`:344-348`) | no prose JSDoc |
| `tokenFromPayload` | `DurableDeferred.ts:355-383` | "Token" | maps `workflow.executionId(payload)` then `tokenFromExecutionId` (`:378-382`) | no prose JSDoc |
| `done` / `succeed` / `fail` / `failCause` | `DurableDeferred.ts:389-524` | README `DurableDeferred.succeed(D,{token,value})` (`README.md:106-109`) | `succeed/fail/failCause` → `done` → `TokenParsed.fromString` → `engine.deferredDone` (`:416-423,454-457,487-490,520-523`) | no prose JSDoc; **no error channel** (`never`) and no token-existence validation in `done` itself (only base64 parse) |

### 1.4 Module `DurableClock` (`repos/effect/packages/workflow/src/DurableClock.ts`)

| Member | Signature (file:line) | Documented | Verified | Divergence |
|---|---|---|---|---|
| `make(options)` | `DurableClock.ts:39-47` | "Constructors", no prose | `duration = Duration.decode(input)`, `deferred = DurableDeferred.make(DurableClock/${name})` (`:42-47`) | no prose JSDoc |
| `sleep(options)` | `DurableClock.ts:61-106` | `inMemoryThreshold`: "≤ threshold → executed in memory. Defaults to 60 seconds." (`:64-71`) | zero duration returns immediately (`:83-85`); ≤ threshold runs an in-memory `Activity` sleeping (`:91-96`); else `engine.scheduleClock` then `DurableDeferred.await(clock.deferred)` (`:98-105`) | none (`CHANGELOG.md:171`) |

### 1.5 Module `WorkflowEngine` (`repos/effect/packages/workflow/src/WorkflowEngine.ts`)

The typed `WorkflowEngine` Context.Tag (`:24-183`) is the facade; the
implementation contract is the `Encoded` interface (`:252-311`) consumed by
`makeUnsafe` (`:317-458`). `Encoded` members are exactly: `register`,
`execute`, `poll`, `interrupt`, `resume`, `activityExecute`, `deferredResult`,
`deferredDone`, `scheduleClock` (`:253-310`). Full method enumeration with
core/optional classification is in **Section 4**.

`WorkflowInstance` (`:189-246`) is per-execution runtime state: `executionId`,
`workflow`, `scope`, `suspended`, `interrupted`, `cause`, `activityState`,
static `initial` (`:229-245`). `makeUnsafe` (`:317-458`) bridges typed↔encoded
and houses the top-level suspended-retry loop (default schedule
`exponential(200,1.5) either spaced(30000)`, `:460-462`). `layerMemory`
(`:468-639`) is the in-process reference used throughout this document where
upstream behavior must be pinned to running code.

### 1.6 Documented-vs-verified divergences found in upstream

1. `Workflow.execute` JSDoc omits that `suspendedRetrySchedule` is sourced
   from `make` options, not per-call options (`Workflow.ts:108-120` vs
   `:277,311`).
2. `WorkflowEngine.poll` JSDoc is **wrong**: it reads "Execute a registered
   workflow." (`WorkflowEngine.ts:85-87`) — copy-pasted from `execute`. True
   behavior (return `Result | undefined`) is in `Workflow.ts:122-132` and
   memory impl `WorkflowEngine.ts:603-611`.
3. `withCompensation` instance vs standalone type narrowing
   (`Workflow.ts:180` vs `:658`) — typing only.
4. `@since` tags in `WorkflowEngine.ts` mix `1.0.0` (`:466`) and `4.0.0`
   (`:21,186,248,314`) — doc-metadata only.
5. The `DurableDeferred` token format is documented nowhere; it is only
   discoverable from `TokenParsed.asToken` source (`DurableDeferred.ts:272-274`).

---

## Section 2: `DurableDeferred` deep dive

### 2.1 Token format — deterministic, not opaque

The token is a **base64url-encoded JSON 3-tuple
`[workflowName, executionId, deferredName]`**, deterministically derivable
without the workflow ever having run:

- `TokenParsed.asToken = Encoding.encodeBase64Url(JSON.stringify([workflowName, executionId, deferredName]))` (`DurableDeferred.ts:272-274`).
- `tokenFromExecutionId` builds it from `(workflow.name, executionId, self.name)` (`DurableDeferred.ts:344-348`).
- `executionId` is itself deterministic:
  `executionId = hex(SHA-256(`${workflowName}-${idempotencyKey(payload)}`)[0..16])`
  (`Workflow.ts:281`, `internal/crypto.ts:10-14`).
- `tokenFromPayload` composes both, so an external caller can compute a valid
  token from `(workflow definition, payload, deferred name)` alone
  (`DurableDeferred.ts:355-383`).

Full derivation:
`token = base64url(JSON.stringify([workflowName, hex(SHA-256(workflowName + "-" + idempotencyKey(payload))[0..16]), deferredName]))`.

There is **no engine query API and no published registry** required — token
acquisition is pure computation from public inputs. (`deferredName` is the
`name` passed to `DurableDeferred.make`, `DurableDeferred.ts:68`.)

### 2.2 Failure semantics of `succeed`/`fail`/`done`

`succeed`/`fail`/`failCause` all funnel to `done` → `engine.deferredDone`
(`DurableDeferred.ts:416-423,454-457,487-490,520-523`). The neutral interface
returns `Effect<void, never>` (`WorkflowEngine.ts:155-170`) — **no typed error
channel**. The only non-engine failure mode is a malformed token string
failing `TokenParsed.fromString` decode (a defect, not a typed error)
(`DurableDeferred.ts:298,417`). Concrete edge behavior is **engine-defined**;
pinned to the in-tree `layerMemory`:

| Scenario | `layerMemory` behavior (verified) |
|---|---|
| Deferred doesn't exist / workflow not started | `deferredDone` records `deferredResults.set(id, exit)` then calls `resume`, which early-returns (no execution) (`WorkflowEngine.ts:617-623,501-502`). **Silent record, no error**; value picked up if the workflow later awaits it. |
| Already completed | Idempotent / one-shot: `if (deferredResults.has(id)) return Effect.void` (`WorkflowEngine.ts:620`). First write wins, second ignored. |
| Suspended workflow | Records result then `resume(executionId)` re-creates the instance and re-runs `state.execute` (`WorkflowEngine.ts:622,510-533`). No error. |
| Terminated/completed workflow | `resume` checks `state.fiber?.unsafePoll()`; if `Success(Complete)` returns without re-running (`WorkflowEngine.ts:503-508`). Result still recorded; no restart, no error. |

Behavior for non-memory engines (e.g. `ClusterWorkflowEngine`,
`DurableStreamsWorkflowEngine`) is implementation-defined and covered in §4/§5.

### 2.3 Replay semantics of `await`

`await` = `wrapActivityResult(engine.deferredResult(self), isUndefined)`;
`undefined` → `Workflow.suspend`, else yield the stored exit
(`DurableDeferred.ts:112-121`).

- **Completed before crash**: on replay `deferredResult` returns the stored
  exit; `await` returns immediately, no suspension. The completion is
  **fetched from the engine's storage layer**, decoded via
  `deferred.exitSchema` (`WorkflowEngine.ts:428-434`) — not from an in-memory
  Effect `Deferred` tied to the awaiting fiber.
- **Not completed before crash**: `deferredResult` returns `undefined` →
  workflow suspends and only resumes when `deferredDone` later records a value
  and triggers `resume` (`WorkflowEngine.ts:622`).

### 2.4 One-shot and sharing

- **One-shot**: verified. The memory engine ignores subsequent completions
  once the id exists (`WorkflowEngine.ts:620`); no source path overwrites.
- **Cross-workflow sharing**: a `DurableDeferred` is keyed by
  `(workflowName, executionId, deferredName)` in the token
  (`DurableDeferred.ts:272-274`) and `${executionId}/${deferredName}` in
  storage (`WorkflowEngine.ts:614,619`). The same `DurableDeferred`
  *definition* can be reused across executions, but each execution gets an
  independent completion slot keyed by its `executionId`. There is no global
  shared keyspace; two executions cannot share one completion. Completing
  requires a token, which embeds a specific `executionId`. Verified from
  source.

---

## Section 3: `Activity` semantics

- **Granularity**: README frames an Activity as "an unit of work… executed
  only once, unless you use `Activity.retry`" (`README.md:49-50`). No source
  comment constrains long-running vs atomic; activities may wrap long effects
  (e.g. `DurableClock.sleep` wraps `Effect.sleep` in an Activity for
  sub-threshold durations, `DurableClock.ts:91-96`). *Not further specified in
  source beyond the README.*
- **Interrupt mid-execution**: every Activity's execute is wrapped by
  `retryOnInterrupt` (`Activity.ts:100-103,134-146`):
  `Effect.sandbox` → `Effect.retry(interruptRetryPolicy)` →
  `catchAll(cause => isInterrupted ? Effect.die("Activity \"<name>\"
  interrupted and retry attempts exhausted") : failCause)`. So an interrupted
  Activity is **retried** under the policy while the cause is an interrupt; if
  exhausted it becomes a defect (`Activity.ts:144`). On memory-engine replay an
  already-recorded non-suspended activity exit is returned without
  re-execution (`WorkflowEngine.ts:581-587`); a `Suspended` exit clears stored
  state so it re-runs (`:583-584`).
- **`interruptRetryPolicy` effect**: passed directly to `Effect.retry` after
  `Effect.sandbox` (`Activity.ts:140-141`); default is
  `exponential(100,1.5) ∪ spaced("10 seconds") ∪ recurs(10)`,
  `whileInput(Cause.isInterrupted)` (`Activity.ts:128-132`). It governs only
  interrupt retries; non-interrupt failures are re-failed unchanged
  (`Activity.ts:143`).
- **Shared in-memory state**: activities run under a *fresh isolated*
  `WorkflowInstance` (`WorkflowEngine.ts:592-596`), only `interrupted` copied;
  they do **not** share the parent's `activityState` latch/scope. The only
  cross-construct shared mutable state in source is `instance.suspended`/
  `instance.cause` propagation via `wrapActivityResult`
  (`Workflow.ts:578-581`) and `Activity.CurrentAttempt` (a `Context.Reference`,
  `Activity.ts:175-177`). There is no general mechanism for activities to hold
  shared in-process channels/refs with other workflow constructs.
- **Retry mechanics**: `Activity.retry` provides an incremented
  `CurrentAttempt` (starting 1) then `Effect.retry(options)`
  (`Activity.ts:163-168`). The README example exercises this with
  `Activity.retry({times:5})` (`README.md:50-70`). **Note**:
  `repos/effect/packages/workflow/test/WorkflowEngine.test.ts` contains **no**
  test asserting Activity retry counts; retry-count behavior is documented
  (README) and source-derivable but not test-asserted in the workflow package.
  It *is* test-asserted in cluster tests indirectly (see §4.4).
- **Compensation** (`withCompensation`, `Workflow.ts:656-675`): documented as
  "called if the entire workflow fails", with success value and failure cause,
  and "will not work for nested activities" (`Workflow.ts:170-177`,
  `README.md:71-80`). Verified:
  - **When**: runs when the workflow instance scope closes with a *failing*
    exit (`Workflow.ts:673,545-551`). Not on per-effect failure; not on
    workflow success. Only registered if the wrapped effect itself produced a
    value (registered inside the success `tap`, `:673`).
  - **Order**: `Scope` finalizer order — LIFO, reverse registration order
    (`Workflow.ts:642`).
  - **State available**: the wrapped effect's success `value` and the workflow
    failure `Cause` (`exit.cause`, `:673`).
  - **Nested-activity limitation confirmed in code**: finalizers attach to the
    top-level instance scope (`:640-642`); nested activities run under
    separate instances/scopes (`WorkflowEngine.ts:592-596`).
  - **Tests**: the workflow package has no `withCompensation` test;
    compensation is test-verified only in cluster tests (§4.4,
    `cluster/test/ClusterWorkflowEngine.test.ts:82-153`).

---

## Section 4: `WorkflowEngine` interface and `ClusterWorkflowEngine`

### 4.1 Interface method enumeration with core/optional classification

Service `WorkflowEngine` (`repos/effect/packages/workflow/src/WorkflowEngine.ts:24-183`);
implementation contract `Encoded` (`:252-311`). "Core" = required for
`@effect/workflow` to function at all; "Optional" = only needed for a specific
feature. Justification is the invocation evidence.

| Method | Signature (file:line) | JSDoc | Core/Optional + justification |
|---|---|---|---|
| `register` | `:30-56` | "Register a workflow with the engine." (`:27`) | **Core** — called by `Workflow.toLayer` (`Workflow.ts:351-352`); without it no workflow can run. |
| `execute` | `:61-83` | "Execute a registered workflow." (`:58`) | **Core** — called by `Workflow.execute` (`Workflow.ts:307`) and recursively for nested workflows (`WorkflowEngine.ts:366,374`). |
| `poll` | `:88-100` | wrong JSDoc ("Execute…", copy-paste) | **Core/observability** — called by `Workflow.poll` (`Workflow.ts:318`); part of base contract, used by tests, not required to merely execute. |
| `interrupt` | `:105-108` | "Interrupt a registered workflow." (`:102`) | **Core** — called by `Workflow.interrupt` (`Workflow.ts:330`) and `makeUnsafe.execute` parent-interrupt finalizer (`WorkflowEngine.ts:361`). |
| `resume` | `:113-116` | "Resume a registered workflow." (`:110`) | **Core** — called by `Workflow.resume` (`Workflow.ts:341`); the mechanism that wakes any suspended workflow (memory `resume` invoked by `deferredDone`, `WorkflowEngine.ts:622`). Required for any suspend/resume (DurableClock, DurableDeferred). |
| `activityExecute` | `:121-135` | "Execute an activity from a workflow." (`:118`) | **Optional (feature: Activity)** — only from `Activity.makeExecute` (`Activity.ts:249`). A workflow with no activities never calls it. |
| `deferredResult` | `:140-149` | "Try to retrieve the result of an DurableDeferred" (`:137`) | **Optional (feature: DurableDeferred/DurableClock/raceAll)** — from `DurableDeferred.await` (`DurableDeferred.ts:114`), `raceAll` (`:223`). |
| `deferredDone` | `:155-170` | "Set the result of a DurableDeferred, and then resume any waiting workflows." (`:151`) | **Optional (feature: DurableDeferred/DurableClock)** — from `DurableDeferred.into`/`done` (`DurableDeferred.ts:176,418`) and memory `scheduleClock` (`WorkflowEngine.ts:625`). |
| `scheduleClock` | `:175-181` | "Schedule a wake up for a DurableClock" (`:172`) | **Optional (feature: DurableClock)** — only from `DurableClock.sleep` for above-threshold durations (`DurableClock.ts:101-104`); sub-threshold sleeps never call it. |

There is no separate `Execution` service; `Workflow.Execution<Name>`
(`Workflow.ts:220-223`) is a phantom requirement marker, not a runtime
service. `Encoded.execute` carries an extra optional
`parent?: WorkflowInstance` for nested-workflow interruption linking
(`WorkflowEngine.ts:266,374-389`).

### 4.2 What `ClusterWorkflowEngine` does (`repos/effect/packages/cluster/src/ClusterWorkflowEngine.ts`)

Entry `make` (`:46-523`) wraps `WorkflowEngine.makeUnsafe`. Public layer
`ClusterWorkflowEngine.layer` (`:653-659`) requires `Sharding | MessageStorage`
(`:653-657`). Each workflow becomes a cluster `Entity` `Workflow/<name>`
(`:552-574`) with four persisted+uninterruptible RPCs: `run` (PK `""`),
`deferred` (PK = deferred name), `resume` (PK `""`), `activity`
(PK `${name}/${attempt}`) (`:562-609`).

| Method | What ClusterWorkflowEngine does (file:line) |
|---|---|
| `register` | `ensureEntity` builds/caches a per-workflow entity, `sharding.registerEntity` with the four RPC handlers; `run` handler creates a fresh `WorkflowInstance` per invocation, extracts `parent`, runs `execute` through `Workflow.intoResult`, parks on `InterruptSignal` deferred when suspended (`:257-356,278-291,647`). |
| `execute` | `ensureEntity`; RcMap RPC client (`:116-125`); `make(executionId).run(payload,{discard})`, injecting `payload["~@effect/workflow/parent"]` when nested (`:358-375,550`). Dedup key reduces to `(Workflow/<name>, executionId)` since `run` PK is `""`. |
| `poll` | `requestReply` for `run` reply via `storage.requestIdForPrimaryKey` + `repliesForUnfiltered`, last `WithExit`; decode with run exit schema or `undefined` (`:377-393,154-176`). Read-only against `MessageStorage`. |
| `interrupt` | If latest `run` reply is non-`Suspended`, no-op; else `deferredDone(InterruptSignal, Exit.void)`; retry `PersistenceError` ×3 then `orDie` (`:395-425`). |
| `resume` | Filter `run` reply for `Success(Suspended)`; `sharding.reset(requestId)` (= `clearReplies` → request becomes unprocessed) then `sharding.pollStorage`; idempotent if not suspended (`:219-234`, `Sharding.ts:856-860`, `MessageStorage.ts:797-804`). |
| `activityExecute` | Partial-entity client; register activity def+runtime into shared `activities` map keyed `${executionId}/${activity.name}` with latch handshake; `client.activity({name,attempt})`; suspended-and-pending → `sharding.reset` of that attempt's request id + loop; server handler converts client-interrupt to `Suspended` (`:298-345,429-463`). Dedup keyed `…/activity/${name}/${attempt}`. |
| `deferredResult` | `requestReply` for `deferred` reply by name; decode via `Reply.WithExit.schema`; retry `PersistenceError` ×3 (`:465-492`). Read-only. |
| `deferredDone` | Partial-entity client `deferred({name,exit},{discard:true})`; server handler `ensureSuccess(resume)` then returns `exit` → persists the deferred reply AND resumes the run (`:347-350,494-505`). Idempotent via storage duplicate. |
| `scheduleClock` | Persisted `run` on singleton `Workflow/-/DurableClock` entity with `wakeUp = now + duration`; `ClockPayload` implements `DeliverAt` so storage withholds until `deliverAt ≤ now`; on fire the clock handler calls `deferredDone(clockDeferred, Exit.void)` (`:507-519,611-645`, `MessageStorage.ts:828-832`). |

### 4.3 Routing / idempotency / replay (reference behavior to replicate)

- **Dedup key** is the storage primary key
  `${entityType}/${entityId}/${tag}/${id}` (`Envelope.ts:362-368`). Re-issuing
  the same key returns the original stored terminal `WithExit` reply rather
  than re-executing (`Runners.ts:163-193`; test-verified, §4.4).
- **Replay is reply-lookup-based, not log-based**: there is no event journal.
  Re-running a `run` re-executes the body top-to-bottom, but each
  Activity/DurableDeferred/DurableClock step short-circuits to its stored
  `WithExit` reply (`ClusterWorkflowEngine.ts:465-492`,
  `workflow/src/DurableDeferred.ts:112-122`).
- **Suspension** = a stored `Success(Workflow.Suspended)` reply
  (`workflow/src/Workflow.ts:533-543`); **resume** = clear that reply
  (request → unprocessed) + re-deliver (`ClusterWorkflowEngine.ts:219-234`).
- **DurableDeferred completion** = persist exit under deferred-name key **and**
  resume the run (`:347-350`).
- **DurableClock** = deliver-at-delayed scheduled message that converts to a
  `deferredDone(Exit.void)` on fire (`:507-519,630-645`).
- **Interrupt** delivered via reserved `Workflow/InterruptSignal` deferred
  observed by the parked `run` handler (`:278-291,412-417,647`).
- **At-least-once / shutdown safety**: persisted+uninterruptible requests are
  re-written for retry rather than turned into a reply on shutdown/shard move
  (`internal/entityManager.ts:188-210`). Concurrency guard:
  `AlreadyProcessingMessage` if a request id is already active/processed
  (`:386-394,224-225`).

### 4.4 Cluster test coverage (`repos/effect/packages/cluster/test/ClusterWorkflowEngine.test.ts`)

Single-runner `MessageStorage.layerMemory` + `Runners.layerNoop` +
`TestClock` (`:258-265`). Test-verified behaviors:

- `execute`/`poll`/dedup/suspension/`DurableDeferred`/`DurableClock`/
  finalizers — "should run a workflow" (`:12-80`): exact persisted request
  count (`:31-36`), executionId recovery from `journal[0].address.entityId`
  (`:37`), finalizer-but-not-compensation after suspension (`:39-45`),
  completion via `DurableDeferred.token`+`done` (`:47-59`), dedup re-run no new
  requests (`:71-76`), `poll` equals `Complete{Exit.void}` (`:78-79`).
- `interrupt` + compensation + clock clearing — "interrupt" (`:82-131`).
- compensation on direct failure — "Workflow.withCompensation" (`:133-153`).
- `activityExecute`+`raceAll` (in-memory and durable) — (`:155-191`).
- nested/parent-child + parent suspend + `deferredDone` resume — (`:193-219`).
- `SuspendOnFailure` (`:221-233`); activity `catchAllCause` (`:235-247`).

Not test-verified in cluster tests: direct `Workflow.resume(...)`,
`suspendedRetrySchedule` exhaustion `dieMessage`, the persisted-uninterruptible
shutdown retry path, and any multi-runner / SQL-storage workflow behavior
(only `MessageStorage.layerMemory` single-runner is exercised).

---

## Section 5: `DurableStreamsWorkflowEngine` implementation status

Firegrid builds its engine via `WorkflowEngine.makeUnsafe({...})`
(`packages/runtime/src/workflow-engine/internal/engine-runtime.ts:134`), so it
must provide all nine `Encoded` members. Compensation, `SuspendOnFailure`, and
the `suspendedRetrySchedule` retry loop are **inherited from upstream**
(`Workflow.intoResult`/`makeUnsafe.execute`), not re-implemented or stubbed by
Firegrid: Firegrid runs the registered execute through `Workflow.intoResult`
(`engine-runtime.ts:110,229`) and its `Encoded.execute` returns
`Workflow.Suspended` (`:172`) for the upstream wrapper to drive.

**No interface member is stubbed or not-implemented.** All nine `Encoded`
members have real Durable Streams persistence. The gaps are test-coverage gaps
and behavioral divergences (Section 7), not missing code.

| Method | Status | Impl (file:line) | Test (file:line) |
|---|---|---|---|
| `register` | Implemented, tested indirectly | `engine-runtime.ts:135-141` | `DurableStreamsWorkflowEngine.test.ts:441-487` (deferred-registration assertion via VALIDATION.5) |
| `execute` | **Implemented and tested** | `engine-runtime.ts:142-173` | `test:79-102` (runs to completion), `:148-182`/`:257-296` (idempotent + activity replay), `:221-255` (fresh-layer replay) |
| `poll` | **Implemented, untested** | `engine-runtime.ts:174-182` | none (grep-confirmed) |
| `interrupt` | **Implemented, untested** | `engine-runtime.ts:183-191` | none (grep-confirmed) |
| `resume` | **Implemented and tested** | `engine-runtime.ts:92-132,192` | `test:441-487` (register-gated resume no-op until registration) |
| `activityExecute` | **Implemented and tested** | `engine-runtime.ts:193-243` | `test:257-296` (replay, runs==1), `:489-537` (concurrent claim race, PHASE_3_ACTIVITY_CLAIMS) |
| `deferredResult` | Implemented, tested indirectly | `engine-runtime.ts:244-251` | `test:298-332` (transitive via `DurableDeferred.await`) |
| `deferredDone` | **Implemented and tested** | `engine-runtime.ts:252-266` | `test:298-332` (resolve suspended), `:376-439` (typed exit round-trip) |
| `scheduleClock` | **Implemented and tested** | `engine-runtime.ts:267-290` | `test:334-374` (persist + reconstruct timer after teardown, no external driver) |

### 5.1 Behavior of the untested methods when called (quoted source)

- `poll` — `return row?.finalResult === undefined ? undefined : yield*
  decodeWorkflowResult(_workflow, row.finalResult)` (`engine-runtime.ts:179-181`).
  Never throws; only ever returns a *completed* decoded result or `undefined`;
  never reflects in-flight/suspended fiber state (contrast `layerMemory.poll`
  reading `state.fiber?.unsafePoll()`, `WorkflowEngine.ts:603-611`).
- `interrupt` — `if (!row) return` … `table.executions.upsert({...row,
  interrupted:true})` … `resume(executionId)` (`engine-runtime.ts:188-190`).
  Only persists the flag and re-resumes; does **not** cancel an in-flight
  `activityExecute` fiber (contrast cluster's `InterruptSignal` deferred +
  `interruptedActivities`, `ClusterWorkflowEngine.ts:412-416,447-465`).

### 5.2 Cost to close coverage / behavioral gaps

These are **not** missing implementations; estimates are for tests + the
Section 7 behavioral hardening, with Durable Streams operations noted.

| Gap | Required Durable Streams ops | LOC estimate (confidence) |
|---|---|---|
| `poll` test (in-flight `undefined` + post-completion) | none new; reuse `runWith`/`inspectTable` (`test:53,360`) | ~25–40 LOC (high, ±10) |
| `interrupt` test (assert persisted flag + fresh-resume observes it; running-activity cancel/not) | none new; needs a blocking workflow + deterministic blocked-pending observation point | ~40–70 LOC (medium, ±25) |
| In-flight activity interruption parity with cluster | reuse existing `deferreds` collection (no new row type) as an `InterruptSignal`-style record; add `interruptedActivities` tracking against `engine-runtime.ts:39` `running` Map | ~60–110 LOC engine (low–medium, ±40) |
| `poll` live-state parity (read `running` fiber `unsafePoll()` like `layerMemory.poll`) | none new | ~10–20 LOC (high, ±8) |
| Persist `instance.cause` across restart (Section 7 C6) | add a `cause` column to `WorkflowExecutionRow` (`table.ts:17-26`); write at `engine-runtime.ts:121-126`; restore at `:106-107` | ~15–30 LOC + 1 schema field (medium, ±15) |

---

## Section 6: Feature parity matrix

| `WorkflowEngine` method | `ClusterWorkflowEngine` | `DurableStreamsWorkflowEngine` | Gap |
|---|---|---|---|
| `register` | per-workflow cluster entity + RPC handlers (`ClusterWorkflowEngine.ts:257-356`) | name→`{workflow,execute,scope}` Map (`engine-runtime.ts:135-141`) | None functional. Firegrid resume is *gated* on registration (`engine-runtime.ts:97-98`) — extension, not a gap (§7 C3). |
| `execute` | entity `run` RPC, dedup per `(name,executionId)`, persisted (`:358-375`) | read/insert `WorkflowExecutionRow`, call `resume`, join fiber or return `Suspended` (`engine-runtime.ts:142-173`) | None. Both idempotent via deterministic executionId; Firegrid keys on `executions` PK (`table.ts:18`). |
| `poll` | reads stored `run` `WithExit` reply, can return any `Result` (`:377-393`) | returns persisted `finalResult` or `undefined` only (`engine-runtime.ts:174-182`) | **Behavioral**: Firegrid never reports in-flight/suspended state. ~10–20 LOC for parity (§5.2). Untested both as gap and behavior. |
| `interrupt` | no-op if non-suspended; else `deferredDone(InterruptSignal)` into parked run handler (`:395-425`) | persist `interrupted:true` + `resume` (`engine-runtime.ts:183-191`) | **Behavioral**: no in-flight activity cancellation. ~60–110 LOC engine for parity (§5.2). Untested. |
| `resume` | clear `run` reply (→unprocessed) + `pollStorage` (`:219-234`) | re-read row, double-run guard via `running` Map + `unsafePoll`, re-run `execute` through `intoResult` (`engine-runtime.ts:92-132`) | None functional; mechanism differs (no shard reset; in-process fiber re-fork). Firegrid adds register-gating (§7 C3). |
| `activityExecute` | entity `activity` RPC, attempt PK, sharded ownership (`:429-463`) | activity-key replay + durable **claim row** + run through `intoResult` (`engine-runtime.ts:193-243`) | None. Firegrid replaces shard-ownership with an explicit `activityClaims` collection (§7 C1). Tested for the concurrent race (`test:489-537`). |
| `deferredResult` | reads stored `deferred` reply by name (`:465-492`) | read `WorkflowDeferredRow`, `reviveExit` (`engine-runtime.ts:244-251`) | None functional. `reviveExit` only special-cases `Success`; failure exits pass through and rely on upstream `exitSchema` re-decode (§7 note). |
| `deferredDone` | persist exit + resume run, idempotent via storage dup (`:494-505,347-350`) | idempotent upsert of `WorkflowDeferredRow` (`Option.isNone` guard) + `resume` (`engine-runtime.ts:252-266`) | None. Parity; Firegrid's idempotency is durable (survives restart) vs cluster's storage-dup. |
| `scheduleClock` | deliver-at-delayed message on singleton clock entity → `deferredDone(Exit.void)` (`:507-519,630-645`) | persist `WorkflowClockWakeupRow`, in-process delayed fiber, **`recoverPendingClockWakeups` on construction** (`engine-runtime.ts:267-290,83-90`) | None functional; Firegrid self-reconstructs timers on restart with no external driver (§7 C2). Tested `test:334-374`. |

Every row: implementation cited for both engines above. The "Gap" column
contains no "blocker" framing per the no-path-advocacy constraint; gaps are
behavioral/coverage with LOC quantified in §5.2.

---

## Section 7: Firegrid-specific extensions and divergences

Durable row shapes (all on one `DurableTable("firegrid.workflow", …)`,
`table.ts:75-78`; five collections share one Durable Stream URL,
`table.ts:85-89`; each is a distinct durable type
`firegrid.workflow.<collection>` per `DurableTable.ts:329`):

1. `WorkflowExecutionRow` — PK `executionId`; cols `workflowName`, `payload`,
   `parentExecutionId?`, `interrupted`, `suspended`, `finalResult?`
   (`table.ts:17-26`); collection `executions`.
2. `WorkflowActivityRow` — PK `activityKey`
   (`${executionId}/${name}/${attempt}`); `executionId`, `activityName`,
   `attempt`, `result` (`table.ts:28-35`); `activities`.
3. `WorkflowActivityClaimRow` — PK `claimKey` (== activityKey);
   `executionId`, `activityName`, `attempt`, `workerId`, `claimedAtMs`
   (`table.ts:37-45`); `activityClaims`.
4. `WorkflowDeferredRow` — PK `deferredKey`
   (`${executionId}/${deferredName}`); `workflowName`, `executionId`,
   `deferredName`, `exit` (`table.ts:47-54`); `deferreds`.
5. `WorkflowClockWakeupRow` — PK `clockKey` (`${executionId}/${clock.name}`);
   `workflowName`, `executionId`, `clockName`, `deferredName`, `deadlineMs`,
   `status: "pending"|"fired"` (`table.ts:56-65`); `clockWakeups`.

Codec (`internal/codec.ts`) — there is **no opaque journal/event-log
encoding**. The "journal" is the typed rows above, round-tripped through
upstream workflow schemas: `decodeWorkflowResult`/`encodeWorkflowResult` use
`Workflow.Result({success,error})` (`codec.ts:5-21`); `reviveExit` hand-rolls
revival, special-casing only `_tag === "Success"` and passing other exits
through unchanged (`codec.ts:23-27`); `reviveEncodedResult` rebuilds
`Suspended`/`Complete` (`codec.ts:29-38`).

Extensions / divergences:

- **C1 — Activity claim layer** (extension; Firegrid-specific need).
  `activityClaims` + `claimActivity` (`engine-runtime.ts:41-55,204-211`).
  `layerMemory` has no claim concept (`WorkflowEngine.ts:577-602`); cluster
  uses shard/entity ownership instead (`ClusterWorkflowEngine.ts:429-465`).
  Firegrid adds a durable claim row because multiple independent workers can
  point at one stream URL with no shard coordinator. Rationale: in-source
  requirement IDs `workflow-engine-durable-state.VALIDATION.6`,
  `RUNTIME_BOUNDARY.5`,
  `firegrid-workflow-driven-runtime.PHASE_3_ACTIVITY_CLAIMS.1/.2/.3`
  (`engine-runtime.ts:43-47`); hardened in commit `8c935a646`
  ("Harden workflow activity claims (#185)"). Tested `test:489-537`.
- **C2 — Durable self-reconstructing clock** (divergence; Firegrid-specific
  need). `clockWakeups` + `recoverPendingClockWakeups` (`engine-runtime.ts:83-90,293`).
  `layerMemory` uses an in-process `FiberMap` (`WorkflowEngine.ts:624-634`);
  cluster delegates to a clock entity over RPC
  (`ClusterWorkflowEngine.ts:507-518`). Firegrid persists `deadlineMs`/`status`
  and rebuilds the delayed fiber on construction so a wakeup survives process
  restart "without an external clock driver" (`test:334`). Rationale
  `workflow-engine-durable-state.VALIDATION.3` (`engine-runtime.ts:269`);
  commit `d489d0037`. An overdue clock fires with zero delay
  (`Math.max(0, deadlineMs - now)`, `:77`).
- **C3 — Register-gated resume** (divergence; Firegrid-specific need).
  `resume` bails when the workflow is not yet registered:
  `const entry = workflows.get(row.workflowName); if (!entry) return`
  (`engine-runtime.ts:97-98`). `layerMemory.resume` assumes the entry exists
  (`WorkflowEngine.ts:510`). Required because persisted executions outlive a
  process and resume/clock recovery can fire before the host registers
  workflows. Rationale `workflow-engine-durable-state.VALIDATION.5`; tested
  `test:441-487`.
- **C4 — `poll` returns only persisted terminal state** (divergence;
  behavioral; §5.1). Interface-conformant (`Result | undefined`,
  `WorkflowEngine.ts:271-274`) but functionally weaker than `layerMemory`. No
  in-source rationale. Untested.
- **C5 — No in-flight activity/execution interruption** (divergence;
  simplification; §5.1). Relies on upstream `Workflow.intoResult`'s
  interruption-to-suspension on the *next* resume via the persisted
  `interrupted` flag (`engine-runtime.ts:107`). Interface-conformant. No
  in-source rationale. Untested.
- **C6 — `instance.cause` not persisted** (divergence; behavioral; inherited
  gap). Upstream sets `instance.cause` on suspend-on-failure
  (`Workflow.ts:517-540`); Firegrid's execution row has only `interrupted`/
  `suspended` booleans (`table.ts:22-23`), no `cause` column.
  `WorkflowInstance.initial` resets `cause` to `undefined`
  (`WorkflowEngine.ts:239`) and Firegrid restores only `interrupted`
  (`engine-runtime.ts:107`), so a suspend-on-failure cause is not durable
  across process restarts. No in-source rationale. Untested. Cost ~15–30 LOC +
  1 schema field (§5.2).
- **C7 — Idempotent `deferredDone` / write-once activity** (extension;
  parity-with-durability). `deferredDone` skips upsert if a row exists
  (`engine-runtime.ts:256` `Option.isNone`); `activities.upsert` guarded by an
  existence check (`:232-241`). Durable analog of `layerMemory`'s in-process
  de-dup (`WorkflowEngine.ts:620`); required for the at-least-once Durable
  Streams substrate.
- **C8 — Error erasure at the table boundary** (extension; documented;
  interface-mandated). `orDieTable` converts every `DurableTableError` to a
  defect (`engine-runtime.ts:17-23`) because `Encoded` signatures return
  `Effect<…, never>`. Rationale `workflow-engine-durable-state.ENGINE.5`,
  `RUNTIME_BOUNDARY.4` (`engine-runtime.ts:20-22`). Construction still types
  the error as `DurableTableError` (`DurableStreamsWorkflowEngine.ts:17-19,35`);
  runtime table failures during method calls become defects.

Runtime wiring (for completeness, not a divergence): export
`DurableStreamsWorkflowEngine = {make, layer}`
(`DurableStreamsWorkflowEngine.ts:54-57`). Production host builds it per
session via `hostOwnedWorkflowEngineLayer` →
`DurableStreamsWorkflowEngine.layer({streamUrl: hostOwnedStreamUrl(...segment:"workflow")})`
(`packages/runtime/src/host/layers.ts:166-179`), merged into `hostScopedLayer`
and passed to the agent-tool/control-plane host (`layers.ts:181-199`). Tests
wire the same `layer(options)` against a real `DurableStreamTestServer`
(`DurableStreamsWorkflowEngine.test.ts:7,20-23,40-44`).

---

## Section 8: Open questions and uncertainties

| # | Question | What was tried | What would resolve it | Affects substrate decisions? |
|---|---|---|---|---|
| 1 | Failure semantics of `succeed`/`fail`/`done` against terminated/not-started/nonexistent deferreds for **non-memory** engines | Read all of `repos/effect/packages/workflow/src`, `internal`, `test` — only `layerMemory`/`makeUnsafe` exist there | Read/exercise `ClusterWorkflowEngine` (covered in §4 from cluster source) and `DurableStreamsWorkflowEngine` (covered in §5/§7) for their specific behavior; memory-engine behavior is fully resolved (§2.2) | Partially resolved; remaining unknowns are per-engine edge behavior already enumerated |
| 2 | Activity retry counts and `withCompensation` ordering as observed at runtime in the **workflow package** | Read `repos/effect/packages/workflow/test/WorkflowEngine.test.ts` (one file) | Run/inspect cluster tests (which *do* assert compensation & raceAll, §4.4); workflow-package suite has no such test | No — behavior is source-derivable and cluster-test-verified |
| 3 | `reviveExit` failure-exit fidelity in Firegrid (`codec.ts:25-26` passthrough) | Read `codec.ts`; grep Firegrid tests — all deferred/activity tests use success values (`test:301,386,493`) | A Firegrid test storing/replaying a *failed* deferred or activity exit | Possibly — affects correctness of failure replay; currently relies on upstream `exitSchema` re-decode (`WorkflowEngine.ts:432-434`), unverified by present tests |
| 4 | No isolated `poll`/`interrupt` Firegrid tests | grep over `packages/runtime/test` for `poll`/`interrupt` against the Firegrid engine | Add the §5.2 tests | Yes for confidence in `poll`/`interrupt` parity claims; the implementations themselves are present and source-verified |
| 5 | Multi-runner / SQL-storage workflow behavior for `ClusterWorkflowEngine` | `grep -rln Workflow repos/effect/packages/cluster/test` → only single-runner `MessageStorage.layerMemory` test | A distributed/SQL cluster workflow test (none exists in-tree) | Yes if a path depends on cluster behavior under real network/SQL; source-derived in §4.3 but not test-verified |
| 6 | `suspendedRetrySchedule` exhaustion `dieMessage` behavior | Read `WorkflowEngine.ts:391-401`; no test exercises it upstream or in Firegrid | A test that exhausts the schedule | Low — inherited from upstream `makeUnsafe`, not Firegrid-customized |

---

## Summary of highest-impact engine findings (neutral)

1. **`DurableDeferred` tokens are pure-computation deterministic** from
   `(workflowName, payload, deferredName)` with no engine query or registry
   needed (`DurableDeferred.ts:272-274`, `Workflow.ts:281`). The format is
   undocumented (only in source).
2. **No interface member is stubbed or missing in Firegrid.** All nine
   `Encoded` members have real Durable Streams persistence
   (`engine-runtime.ts:135-290`). The real gaps are (a) `poll`/`interrupt`
   have no tests, and (b) two behavioral divergences: `poll` never reports
   in-flight state (§7 C4) and `interrupt` does not cancel in-flight activities
   (§7 C5). Parity LOC quantified in §5.2 (≈10–110 LOC per item).
3. **Replay is reply/row-lookup-based, not event-log-based** in both the
   cluster reference and Firegrid; there is no opaque journal — Firegrid's
   "journal" is five typed `DurableTable` collections (`table.ts:17-65`).
4. **Firegrid's substantive divergences are durability extensions**: an
   explicit activity-claim row replacing shard ownership (§7 C1), and a
   self-reconstructing durable clock replacing in-process timers / RPC clock
   entities (§7 C2). Both are tested.
5. **`instance.cause` is not durable across restart** in Firegrid (§7 C6) and
   `reviveExit` only special-cases success exits (§8 #3) — two
   correctness-adjacent items currently unverified by tests.
