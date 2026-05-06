# Effect-TS Observability Review — Firegrid

Date: 2026-05-05
Scope: production source under `packages/{substrate,runtime,client}/src` (tests, scripts, docs, and `apps/lab` UI excluded). Skill reference: `claude-skill-effect-ts/skills/observability/SKILL.md`.

## Summary

Firegrid currently has a deliberately minimal observability surface. There are exactly **six** `Effect.logError` call sites in the runtime, **four** `Effect.withSpan` annotations in the choreography facade, and **zero** uses of `Metric.*`, `Effect.annotateLogs`, `Effect.annotateCurrentSpan`, `Effect.withLogSpan`, custom `Logger`/`Tracer`, or `@effect/opentelemetry`. The `TraceValue` schema in `packages/substrate/src/schema/rows.ts:111-116` is durable trace-row scaffolding that is defined, exported, and asserted by tests but is **not produced anywhere in production code** — no append site emits `durable.trace` rows.

This review is an instrumentation **gap analysis**, not a regression review. The strict-baseline R0 work intentionally focused on terminal-error visibility (the runner, materializer, and operation-handler all log loudly when their forked fibers die) and on tracing the four substrate choreography suspension verbs. Every other concept in the observability skill — counters, gauges, histograms, structured log annotations, log spans, OTel export — is unimplemented.

The good news is that the kernel/runtime split makes future instrumentation cheap. The substrate already owns one consistent suspension boundary (`choreography/service.ts`), the runtime owns three loop boundaries (subscriber, operation handler, event-stream materializer), and the operator owns the claim/terminalize boundary. Each is a single function-shaped pipe whose argument list is the exact set of attributes the skill recommends emitting.

---

## Findings by Concept

### 1. Logging Coverage — `Effect.logError`-only, terminal-fiber posture

Catalog of every `Effect.log*` call site in production source:

- `packages/runtime/src/runtime/internal/runner.ts:183` — subscriber-loop terminal failure (`"firegrid subscriber loop failed"`).
- `packages/runtime/src/runtime/internal/event-stream-materializer.ts:186-189` — materializer-loop terminal failure, name interpolated.
- `packages/runtime/src/runtime/internal/operation-handler.ts:125-128` — input decode failure (per-run, name+runId interpolated).
- `packages/runtime/src/runtime/internal/operation-handler.ts:139-142` — output encode failure (per-run).
- `packages/runtime/src/runtime/internal/operation-handler.ts:149-152` — completeRun append failure (per-run).
- `packages/runtime/src/runtime/internal/operation-handler.ts:180-183` — failRun append failure (per-run).
- `packages/runtime/src/runtime/internal/operation-handler.ts:212-215` — dispatch-loop terminal failure.

**Observations.**

1. **Level uniformity.** Every call uses `Effect.logError`. There is no `Effect.logInfo`, `Effect.logWarning`, `Effect.logDebug`, or `Effect.logFatal` anywhere. The skill recommends using levels to distinguish operational events (Info), recoverable concerns (Warning), and faults (Error). The current posture conflates "fiber is about to die" (genuinely Error) with "this run's input could not be decoded but the loop survives" (better fit for Warning per skill guidance).

2. **Per-run decode/encode failures are *recoverable* in the dispatch loop.** Lines 125, 139 are inside a `catchTag("ParseError", …)` that returns `undefined` so the loop continues. The skill's recommendation maps these to `Effect.logWarning`, leaving `Effect.logError` for the fiber-killing causes at lines 183, 212.

3. **String interpolation everywhere.** Every message embeds runtime values as template literals: `` `firegrid handler ${input.op.name}: input decode failed for run ${run.runId}` ``. The skill's structured-logging API takes the second argument as a structured payload that the default logger renders as key=value pairs and that any JSON logger can serialize natively. The idiomatic conversion is:

   ```
   Effect.logWarning("firegrid.handler.decode_failed", cause).pipe(
     Effect.annotateLogs({ op: input.op.name, runId: run.runId, phase: "input" })
   )
   ```

   This makes log messages searchable by exact string (`firegrid.handler.decode_failed`), facets queryable by annotation (`op`, `runId`, `phase`), and removes ad-hoc parsing of interpolated strings in log pipelines.

4. **`Cause.pretty` usage.** The cause arguments at lines 183, 142, 152, 183, 215 are all `Cause<unknown>` values passed positionally — Effect's default logger renders these via `Cause.pretty` automatically, so the current code is correct on that axis. The one explicit `Cause.pretty(cause)` call at line 174 is a *fallback payload value* (when error encoding fails, the pretty-printed cause is what gets durably written into the failRun event), which is a different concern from log rendering.

5. **No coverage at non-terminal boundaries.** There is no log line for: subscriber wake (entry), scan invocation (entry/exit/duration), operation-handler claim attempt, eventStream envelope filter rejections, choreography suspension verification success/failure. For production debugging, the absence of "I woke up at T, scanned N completions, scheduled next deadline at T+Δ" makes it hard to distinguish "subscriber is healthy and idle" from "subscriber is wedged and never woke."

### 2. Tracing — Choreography Verbs Only

`Effect.withSpan` is applied at exactly four sites, all in `packages/substrate/src/choreography/service.ts`:

- Line 256: `substrate.choreography.sleep`
- Line 292: `substrate.choreography.wait_for`
- Line 315: `substrate.choreography.schedule_at`
- Line 343: `substrate.choreography.awakeable`

These spans wrap the public choreography facade methods and follow the skill's "verb-noun" naming guidance. They do not carry attributes (no `attributes:` option, no `Effect.annotateCurrentSpan` inside the gen blocks). For four suspension verbs whose interesting attributes are highly knowable (`durationMs` for sleep, `whenMs` for scheduleAt, `name` for awakeable, `matcherId`/`timeoutMs` for waitFor), this is the cheapest possible win the next observability commit can take.

**Major gaps:**

- **Per-operation trace.** The natural top-level span for an operator dispatch — `firegrid.operation.dispatch` covering `claim → handle → encode → terminalize` — does not exist. `packages/runtime/src/runtime/internal/operation-handler.ts:121` (`processRun`) is the exact function that should be `Effect.withSpan("firegrid.operation.dispatch", { attributes: { op, runId } })`. Sub-spans for `claim`, `handle`, `encode-output`, `append-terminal` would make claim contention and handler latency directly readable from a trace.
- **Subscriber wake cycle.** `packages/runtime/src/runtime/internal/runner.ts:170-178` (the per-wake `mapEffect` body) is the natural span boundary for subscriber wakes — currently nothing.
- **EventStream materializer per-event.** `packages/runtime/src/runtime/internal/event-stream-materializer.ts:178-179` (`Stream.runForEach((event) => input.materialize(event))`) — wrapping the user's materialize in a `firegrid.eventStream.materialize` span with `stream` and `event.kind` annotations would surface materializer latency without changing user code.
- **Operator claim arbitration.** `packages/substrate/src/internal-claim.ts:46-83` (`attemptClaim`) is the canonical cross-process race. `firegrid.claim.attempt` with attributes `{ workId, ownerId, claimId, observedCursor, won: boolean }` is the single most valuable span this codebase could add.

### 3. `TraceValue` Schema Scaffolding

`packages/substrate/src/schema/rows.ts:111-116` defines `TraceValue` as `{ traceId, kind, data? }` and `TraceRowType = "durable.trace"` at line 11. A grep across all production sources finds **zero** call sites that emit `appendChange(stream, …, durable.trace)`. The only references are:

- The schema definition itself (rows.ts).
- A test helper at `packages/substrate/src/__tests__/helpers.ts:8` that constructs `durable.trace` rows for round-trip schema tests.
- An export-surface test at `packages/runtime/src/__tests__/runtime-foundations.test.ts:95,114,119` that asserts `TraceValue` is re-exported from `@firegrid/substrate/kernel` but **not** leaked through the public root.

This is acknowledged in the schema comment at `rows.ts:110` (`durable-records-and-projections.RECORDS.8 — observability only.`) but the wiring is absent. The architectural question for a future commit is whether `Effect.withSpan` should produce `durable.trace` rows on the substrate stream as a side effect (a substrate-native tracer), or whether `TraceValue` is exclusively for end-of-run audit trails written by operators. The skill's `Tracer.make` example shows exactly how a custom tracer would emit these. Until that wiring exists, the schema is dead weight in the type system: it's exported, blessed, and doing nothing.

### 4. Metrics — Zero Coverage

`Metric.*` does not appear anywhere in production source. The skill's three core types map cleanly onto firegrid's hot paths:

| Metric (skill type) | Site | Why |
|---|---|---|
| `Metric.counter("firegrid.subscriber.wakes")` tagged by `kind` (timer / scheduled-work / eventStream / operation-handler) | `runner.ts:170` | Distinguishes timer-driven, edge-driven, and projection-match wakes. Spike in `kind=projection_match` correlates with completion churn. |
| `Metric.counter("firegrid.claim.attempts")` tagged by `outcome` (won / lost / cursor_missing / winner_missing) | `internal-claim.ts:69-82` | Direct cross-process contention signal; today contention is invisible. |
| `Metric.counter("firegrid.run.terminalized")` tagged by `state` (completed / failed) | `operator.ts:188` and `operation-handler.ts:146,177` | Operator throughput. |
| `Metric.histogram("firegrid.operation.handler_duration_ms")` | `operation-handler.ts:133` (`Effect.exit(input.run(matched.input))`) | P50/P95/P99 handler latency, the single most actionable SRE metric. |
| `Metric.histogram("firegrid.subscriber.scan_duration_ms")` | `runner.ts:172-177` | Snapshot scan cost; would prove "no rebuild on hot path" empirically. |
| `Metric.counter("firegrid.eventStream.emit")` tagged by `stream` | `event-stream-materializer.ts:179` | Per-stream emit volume — cheap to add with `Metric.taggedWithLabels(["stream"])`. |
| `Metric.counter("firegrid.projection.rebuild")` | The substrate `db.preload()` site (`acquireDb` boundary) | Should be ≥1 per fiber lifetime and zero on the hot wake path post-R1. A counter that observably stays at the fiber count *proves* the no-rebuild claim. |
| `Metric.histogram("firegrid.choreography.suspension_to_resume_ms")` | choreography service + operator post-claim | Substrate-level liveness. |

`Metric.trackDuration` and `Metric.trackAll` (skill p. 4) wrap effects without touching their bodies, so all of these can be added without disturbing existing pipes.

### 5. OpenTelemetry Integration — Absent

There is no dependency on `@effect/opentelemetry`, no `NodeSdk.layer`, no `Tracer.layer(...)`, and no exporter wiring. This is appropriate for v1: a Firegrid host application is what should choose its OTel exporter (OTLP/HTTP, OTLP/gRPC, console, Jaeger, etc.), not the library. The library's job is to *emit* spans and metrics through `Effect.withSpan`/`Metric.*` so that *any* host providing an OTel layer picks them up automatically.

The forward-looking guidance is therefore: **broaden span/metric coverage in firegrid; defer OTel layer wiring to the host**. The lab and any future demo apps can provide a `NodeSdk.layer` exporter, and that's where end-to-end tracing comes online without the library taking the dependency.

### 6. `Effect.orDie` in Choreography — Logging Implications

`packages/substrate/src/choreography/service.ts` calls `Effect.orDie` at lines 258, 294, 317, 345 — one per suspension verb. This is intentional per `choreography-facade.ERRORS.4` (internal failures are defects) but it has an observability consequence: the `ChoreographyVerificationError` typed errors collapse into the defect channel before they reach any caller. The default logger *will* render the underlying cause when the host fiber dies, but there is no per-verb log line at the moment the verification fails.

If any production triage scenario needs to distinguish "block-row append failed" from "post-write read failed" from "matcher missing," adding `Effect.tapError` before `Effect.orDie` (with `Effect.logError("substrate.choreography.verification_failed", cause)` carrying `Effect.annotateLogs({ verb, completionId, reason })`) preserves the defect posture while making the failure mode observable. This is a one-line change at each site.

### 7. Log Spans (`Effect.withLogSpan`)

`Effect.withLogSpan` does not appear anywhere. Skill p. 3 uses log spans for "request-handler 45ms" timing context that prefixes every log line inside the span. This pairs naturally with the per-operation, per-wake, and per-materialize boundaries listed above and is strictly cheaper than `Effect.withSpan` (no tracer required). For an observability bootstrap that needs to ship before OTel wiring lands, `Effect.withLogSpan("firegrid.operation.dispatch")` at `operation-handler.ts:121` would deliver "this run took N ms in the dispatch loop" in plain logs immediately.

---

## Out of Scope

- `apps/lab/` React rendering: browser application, not Effect-instrumented by design.
- `__tests__/`, `scripts/`, `docs/`, `semgrep-tests/`: assertion-based tests do not need `Metric`/`Tracer`; scripts and docs are not runtime.
- `packages/runtime/bin/firegrid.ts`: the Terminal CLI uses `Terminal.Terminal` for user-visible I/O, which is the correct boundary.
- Effect's default logger format: this is a host concern, not a library concern. Firegrid should emit through `Effect.log*` and let hosts replace the logger.
- The user-supplied `materialize` and operation handler `run` Effects: those bodies are user code; instrumenting them is the *user's* responsibility. The library's job is to give them spans/log spans they can nest into.

---

## Top 5 Highest-Leverage Improvements

1. **Add `firegrid.claim.attempt` span + `firegrid.claim.attempts` counter at `packages/substrate/src/internal-claim.ts:46-83`.** Cross-process contention is currently invisible. One span with `{ workId, ownerId, claimId, observedCursor, outcome }` attributes and one counter tagged on `outcome` make every claim race directly observable.
2. **Wrap `processRun` at `packages/runtime/src/runtime/internal/operation-handler.ts:121` in `Effect.withSpan("firegrid.operation.dispatch", { attributes: { op, runId } })` plus `Metric.trackDuration(handlerDurationMs)` on the `Effect.exit(input.run(matched.input))` at line 133.** Operation latency is the single most actionable production metric. This is a strictly additive wrap.
3. **Convert per-run `Effect.logError` at `operation-handler.ts:125-128, 139-142` to `Effect.logWarning` with structured annotations (`Effect.annotateLogs({ op, runId, phase, kind })`) and demote the message to a stable identifier (`firegrid.handler.decode_failed`).** Per-run decode/encode failures are *recoverable*, not fatal, and every interpolated message becomes a stable, queryable event identifier.
4. **Add `Effect.withSpan` attribute payloads to the four existing choreography spans at `service.ts:256,292,315,343`.** Sleep gets `durationMs`; scheduleAt gets `whenMs`; awakeable gets `name`; waitFor gets `matcherId` and (when present) `timeoutMs`. Zero new spans, four new attribute lists, immediate readability.
5. **Decide and document the `TraceValue` direction at `packages/substrate/src/schema/rows.ts:111-116`.** Either wire a substrate `Tracer.make` that emits `durable.trace` rows from `Effect.withSpan` (delivering the audit-stream story), or remove `TraceValue` from the schema until it is needed. Live scaffolding that nothing produces is an attractive nuisance.

---

## What Strict-Baseline Already Enforces

R0-R-STRICT-BASELINE has the following observability properties baked in and protected by detectors:

- Every long-running fiber (`runScopedSubscriberLoop`, `runOperationDispatchLoop`, `runMaterializerLoop`) terminates non-interruption causes with `Effect.tapErrorCause + Effect.logError` (`runner.ts:180-184`, `operation-handler.ts:209-216`, `event-stream-materializer.ts:182-190`). A dying fiber will *always* emit a logged cause; it cannot disappear silently.
- All four choreography suspension verbs are span-wrapped (`service.ts:256,292,315,343`).
- The operation-handler fallback at `operation-handler.ts:170-176` uses `Cause.pretty(cause)` so the durable failRun event always carries a human-readable error string when typed-error encoding is unavailable.
- Public re-exports keep `TraceValue` reachable through `@firegrid/substrate/kernel` but never leak it through the package root (verified by `runtime-foundations.test.ts:114-119`), preserving the "kernel is durable scaffolding, root is the contract" boundary.

These are real, defended invariants. Everything else listed above is additive opportunity, not regression.

---

Word count: ~1900.
