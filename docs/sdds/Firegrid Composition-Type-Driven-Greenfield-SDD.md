# Firegrid Composition SDD

Status: mixed, stated per section. §3.1 (cutover), §3.2 (ACP relay crash), and §6
(static enforcement) are **build-ready** — source-grounded, fixes specified. §12
(the composition target: `DurableStreams` floor, read-views, adapter as positional
argument) is a **proposed target** — designed not read, with a validation gate (the
modularity compile-spike in §12) that must pass before it is a committed plan, not
after. The two are not alternatives: §12 *is* the architecture this is driving
toward; §3.1's cutover is the first step of it, not a separate interim. Standalone —
supersedes the prior type-driven draft and the code-reconciliation memo; both are
folded in here.

Created: 2026-06-02

Stance: greenfield discipline applied to an existing codebase. The runtime
(`@firegrid/runtime`) already composes a real system — `FiregridHost` factory,
`RuntimeChannelRouter`, the unified signal/workflow substrate, codec sessions over
a sandbox provider. This SDD does two things at once: (1) describes that
composition as it actually is, and (2) proposes the **type-signature and
interface changes** that turn today's two live defects and several
mis-composition footguns into things that *do not compile*. Every claim is
anchored to a named symbol in the source. Where a fix depends on runtime behavior
inspection can't settle, it is marked **VERIFY**, not asserted.

The governing principle: **the type at each composition seam is the
specification, and `Layer.launch` with `R = never` is the acceptance gate — for
wiring.** `R = never` proves every service is provided and every handler
implemented; it does *not* prove the wired system behaves. The two defects in §3
both type-check and launch today. So this SDD treats "make the footgun
unrepresentable" as the design goal wherever a type can carry the constraint, and
names the residue that types cannot carry as explicit **co-location disciplines**
backed by tests.

---

## 1. The system as it is

Three tiers, composed by `Layer.provide`, plus a host-plane edge:

```
  bin/{acp,host}.ts  —  parse env -> compose -> launch
  ---------------------------------------------------------------------
    FiregridHost({ codec: "acp" | adapter, durableStreamsBaseUrl, namespace })
      provides: RuntimeControlPlaneTable, RuntimeOutputTable, SignalTable,
                UnifiedTable, WorkflowEngine, the channel Tags,
                JournalObserverLive  -- R-channel: never (host.ts Layer.launch-es it)
                                  |
                                  v
  +----------------------------------------------------------------------------+
  | kernel / unified - durable session-coordination                           |
  |   FiregridHost (unified/host.ts) - the composition factory                |
  |   RuntimeContextSessionWorkflow (idempotencyKey ${contextId}:${attempt})  |
  |   signal primitive - JournalObserverLive - UnifiedSignalingChannelBindings |
  |   requires: RuntimeContextSessionAdapter         (the gateway satisfies)   |
  +---------------------------+------------------------------------------------+
                              | RuntimeContextSessionAdapter (startOrAttach/send/deregister)
                              v
  +----------------------------------------------------------------------------+
  | gateway - codec sessions + protocol edges                                 |
  |   ProductionCodecAdapterLive (unified/codec-adapter.ts)                    |
  |   AcpSessionLive / StdioJsonlSessionLive (sources/codecs/*)                |
  |   AcpStdioEdge (sources/codecs/acp/stdio-edge.ts) - the host-plane edge    |
  |   requires: SandboxProvider, IdGenerator, CodecOutputJournal,             |
  |             ContextResolver, RuntimeEnvResolverPolicy                      |
  +---------------------------+------------------------------------------------+
                              | SandboxProvider (create / openBytePipe / lifecycle)
                              v
  +----------------------------------------------------------------------------+
  | sandbox - pluggable process backend                                       |
  |   LocalProcessSandboxProvider (sources/sandbox/local-process.ts)          |
  |     Layer.succeed(SandboxProvider, ...) - provided, scope-tied teardown    |
  +----------------------------------------------------------------------------+
```

Two things are already right and stay: `bin/host.ts` ends on
`Layer.launch(hostLayer)` with **no cast** — the daemon passes the
launchability gate. And `FiregridHost`'s documented R-channel is `never` — the
factory is self-contained, overridable per-Tag via `Layer.provide`.

The agent-facing surface is a separate, deliberately dynamic plane: agents call
MCP tools (`unified/mcp-host/*`) that dispatch through
`RuntimeChannelRouter.dispatch({ target, verb, payload })` resolving channels by
**string name** (`wait_for({ channel })`). This is load-bearing — channel-target
indirection is how the substrate stays hidden from the agent
(`channels/README.md`). It is not, and must not become, a compile-time-typed
client (see Section 7).

---

## 2. The keystone: `R` is the build plan, scoped to wiring

`Layer.provide` discharges requirements; the `R` channel of a partially-composed
system is the list of services not yet provided; `Layer.launch` accepts only
`R = never`. `bin/host.ts` already lives this. The acceptance gate for any
composition in this SDD is: **it `Layer.launch`-es with `R = never`, with no
`as`-cast laundering the `E` or `R` channel along the way.**

What `R = never` proves: every required service provided, every workflow
registered, every channel Tag bound, no substrate symbol escaping into a public
signature. What it does **not** prove: that the wired graph behaves — that two
correctly-typed layers point at the same stream URL (Section 3.1 deletes the
divergent builder outright so the question can't arise), or that a relay the host
generates is one the codec can accept (Section 3.2). Those are
*value-level* agreements the current types do not capture. Section 4 proposes type
changes that pull several of them up into the `R = never` gate; Section 8 names
what stays a discipline.

---

## 3. The two live defects this SDD must design out

*(A third, latent under build-order reordering, is found in §12 Seam 3 — the
`McpEndpoint` `Ref<Option>` race; same class as §3.1/§3.2, sequenced in §10 step 5.)*

Both type-check and launch today. Each is stated as the trace, then as the
type-level correction that makes it unrepresentable.

### 3.1 Dead per-context output topology — one writer, several dead readers; cut it out transactionally

**The corrected diagnosis (source-verified).** This is not "two valid output
topologies, pick one." There is exactly **one live writer** and a set of **dead
readers** pointed at a topology nothing writes:

- **The one writer** is the host-wide codec journal:
  `codec-adapter.ts` `drainOutputsToJournal` via
  `CodecOutputJournalFromRuntimeOutputTableLive`, writing the single
  `RuntimeOutputTable` at `runtimeOutputStreamUrl({ baseUrl, namespace })`.
- **The one live reader that works** is `GlobalSessionAgentOutputChannelLive`
  (`bin/_compose.ts`), reading that same host-wide table — which is why the
  `AcpStdioEdge` observes output at all today.
- **The dead readers**, all pointed at the per-context URL
  `runtimeContextOutputStreamUrl({ prefix, contextId })` that no writer produces:
  the abandoned `SessionAgentOutputChannelLive` (`channels/session-agent-output/live.ts`),
  `makeHostControlSnapshot` (`host-control.ts`), and the client's
  `clientSessionAgentOutputChannel` / `getOutputService` (`firegrid.ts`).

Two gates were resolved against source before settling the shape, and both came
back decisive:

- **Gate A — the snapshot channels have zero callers.**
  `HostContextSnapshotChannelTarget` / `HostSessionSnapshotChannelTarget` are
  *provided* by `HostControlChannelBindingsLive` and *invoked by nothing* — no
  `.call`, no router string-dispatch of the snapshot verb, no test. The snapshot
  is a pull-based aggregate that re-reads streams which already have live
  streaming channels, and nothing reaches it.
- **Gate B — there is no live per-context writer, and the per-context *output*
  builders are output-only.** `makePerContextRuntimeOutputWriter`
  (`tables/per-context-output.ts`) is called nowhere; the
  `PerContextRuntimeOutputWriter` Tag is provided by no Layer and consumed by no
  `yield*`; the module is imported by nothing outside itself. The per-context
  output URL/name/table builders are referenced only by the dead writer module,
  the abandoned Live, the two dead reads above, and two tests — **not** by any log
  path or other live consumer.

Because this is a greenfield app, the fix is **not** to repoint the dead readers
and leave the per-context output builders standing as a permanent invitation to
re-wire them. The comprehensible end state is the one where the per-context
output topology **does not exist as a constructible thing** — there is no builder
that produces a divergent URL, so a future reader *cannot* point at one. This is
the brand argument (§ below) taken to its conclusion: a brand makes a divergent
URL fail to type-check; deletion makes it unwriteable.

**The transactional cutover — one diff, host + client together.**

*Delete (the per-context output path, root and branch):*

- `tables/per-context-output.ts` — the dead writer module.
- The per-context output **stream-URL builder, name schema, and table layer**:
  `runtimeContextOutputStreamUrl`, the matching `...StreamName` /
  `RuntimeContextOutputStreamNameSchema`, and
  `runtimeContextOutputTableLayer(ForContext)`.
- `channels/session-agent-output/live.ts` — the abandoned per-context
  `SessionAgentOutputChannel` Live. **And `channels/runtime-host-config.ts`** —
  imported *only* by that dead Live (zero other inbound edges, per the file-level
  graph), so it is dead-with-it.
- Note `tables/output-table-layer.ts` is **not** a file deletion: live `host-control`
  imports it alongside the dead per-context path, so the per-context table-layer
  export is removed *surgically* from it, leaving what `host-control` needs.
- `HostContextSnapshotChannel` / `HostSessionSnapshotChannel` **and their Lives**
  (Gate A: zero callers). The pull-based aggregate goes away entirely; the
  streaming channels (`HostContextsChannel`, `SessionLifecycleChannel`, the
  host-wide agent-output channel) are the one read model.

*Repoint (onto the host-wide streaming surface):*

- The client's output reads (`clientSessionAgentOutputChannel` /
  `getOutputService`) and tf-0awo.6's `readSnapshot` consume the host-wide
  streaming channels directly. tf-0awo.6 is **no longer** "consume the snapshot
  channel" — the snapshot channel is being deleted in this same diff; it is
  "consume the streaming channels after the cutover removes the dead pull path."

*Update (blast radius, same diff — these are consumers, not authorities):*

- `session-agent-output-route.integration.test.ts`, the per-context-URL cases in
  `authority.test.ts`, the UKV sim driver's `snapshot.events.length` /
  `snapshot.agentOutputs.length` reads, and the misuse-positive test — all
  rewritten onto the new read surface. A sim author's incidental field access is
  something the cutover migrates, not a contract that pins the surface.

**Acceptance gate (the §12 target, *not* a one-builder waypoint).** Because §10
builds §12 directly, the gate is *not* "exactly one surviving
`runtimeOutputStreamUrl` builder" — that interim is the rejected waypoint. After the
diff: stream URLs come only from `DurableStreams.streamOptions(name)` (Seam 1), so
**no `contextId`-parameterized stream builder exists** to call; reads are the typed
view set over the floor (Seam 1b); the client output read returns the host-wide
journaled rows through a view; `grep` for the per-context-output symbols
(`runtimeContextOutputStreamUrl`, `PerContextRuntimeOutputWriter`,
`runtimeContextOutputTableLayer`, `runtime-host-config`, the snapshot channel targets)
returns only the
deletion diff; full preflight + UKV green.

**On the `RuntimeOutputStreamUrl` brand — retired by §12, not merely demoted.** The
brand's job was to make two builders' URLs type-incompatible. In the §12 target there
is no `runtimeOutputStreamUrl` builder at all — URLs come only from
`DurableStreams.streamOptions(name)` over a closed `StreamName` set with no `contextId`
parameter (Seam 1), so a divergent output URL is *unwriteable*, not merely
un-branded. The brand was a transitional idea for the "one surviving builder" waypoint
this SDD no longer lands; it is superseded by Seam 1 and need not be built. (If the
cutover is staged and the floor lands after the deletions, the brand is at most a
scaffold for that window — not part of the target.)

**tf-0awo.6 scope (resolved by §12, not by repointing).** The deleted snapshot was
a *multi-field* aggregate (context, runs, output, logs, status). The wrong instinct
is "confirm a streaming channel exists for each field .6 needs" — that preserves
the per-channel shape. §12's read-views-over-the-floor (§12.1) is the actual answer:
.6 consumes typed views over the `DurableStreams` floor, so "which field has a
channel" stops being the question. The one residual is the logs path — confirm logs
are a stream the floor exposes a view over; if not, that gap is named in the cutover,
not silently created.

**Supersession (name the corrected mistakes, don't silently overwrite them).** Two
prior decisions pointed the other way, and the cutover forecloses both — so they
must be marked superseded with the reason, or the next coordinator trusts a
contradicted plan:

- `SDD_WAIT_ROUTER_PERCONTEXT_OUTPUT` §0 recommended per-context output as the
  *production* contract and called host-wide "residue to remove." That is exactly
  backwards, and Gate B says why: the per-context *writer* was never built
  (`makePerContextRuntimeOutputWriter` is dead), so the recommended contract
  described a topology nothing produces. The old model's failure mode was assuming
  a writer into existence. Mark that SDD historical/superseded.
- The snapshot channel decision ping-ponged: `tf-ll90.8.5` = "delete unused
  snapshot channels"; the .6-corrected handoff reversed it to "keep
  `HostContextSnapshotChannel`, client becomes its consumer"; this cutover
  re-reverses to delete, justified by Gate A (zero callers). This supersedes the
  .6-corrected approach — update the handoff/memory so .6 is "consume the read
  views (§12), not the snapshot channel."

**Public-surface note.** `runtimeContextOutputStreamUrl` and the snapshot channel
targets are exported from `@firegrid/protocol`. Deleting them is a public-API
change, not an internal one; the cutover diff should state that explicitly (in
pre-1.0 greenfield this is "remove the export," but it is named, not silent).

### 3.2 ACP `ToolUse` relay orDies the session — observation-only tools dispatched anyway

**The defect (verified end-to-end in source; spec violation per
`ARCHITECTURE.md`).** ACP reports `toolUseMode: "observation_only"` and emits
`ToolUse` with `providerExecuted: true` (`sources/codecs/acp/index.ts`
`mapSessionUpdate`). The chain:

1. `codec-adapter.ts` `drainOutputsToJournal` — `Stream.tap` over **all** outputs,
   no kind filter -> `ToolUse` row written to `RuntimeOutputTable.events`.
2. `observers.ts` `triggerForObservation` — `case "ToolUse":` forks
   `ToolDispatchWorkflow.execute(...)` with **no provenance check**. It reads a
   journal observation that has dropped `toolUseMode` — but Fix A shows the
   distinguishing bit (`providerExecuted`) is recoverable on the part the observer
   already reads, so this is a missing check, not an impossible one.
3. `permission-and-tool.ts` `toolDispatchBody` — runs the executor (default echo)
   and unconditionally relays `kind: "tool-result"`.
4. `runtime-context.ts` body — `tool-result` is not skipped, so
   `adapter.send(...).pipe(Effect.orDie)`.
5. `codec-adapter.ts` `send` -> `acp/index.ts` `sendToolResult` =
   `Effect.fail("ACP ToolResult input is out-of-band for this codec slice")` ->
   `AdapterError` -> **`orDie` kills the session workflow.**

`ARCHITECTURE.md` says `observation_only` tool output "must not be claimed by the
runtime tool router," and ACP "does not accept subscriber-produced `ToolResult`
input." The observer claims it anyway. So absent a gate not in these files, every
ACP tool-call turn kills the session after the first tool call. **VERIFY against a
live ACP tool-call turn before anything else.** The permission path works because
`acp/index.ts` `send` has a real `sendPermissionResponse` arm but
`sendToolResult` is a hard fail — ACP receives permission responses inbound, never
tool results.

**Type-level correction (two layers, both making the mistake harder to represent).**

Root cause is twofold: (a) the dispatch decision needs `toolUseMode`, which the
journal observation throws away; (b) the codec `send` accepts an `AgentInputEvent`
union that includes variants the codec cannot actually handle, so "unhandleable
input" is only discovered at runtime via `Effect.fail` + `orDie`.

**Fix A — carry tool provenance to the observer, gate on it.** The `ToolUse`
observation originates from a part with `providerExecuted: true`. **VERIFY**
whether that flag survives
`encodeRuntimeAgentOutputEnvelope -> runtimeAgentOutputObservationFromRow` into
`observation.event.part.providerExecuted`. If yes, the gate is one line, no schema
change:

```ts
// observers.ts
case "ToolUse":
  if (observation.event.part.providerExecuted) return Effect.void  // provider owns it
  return Effect.fork(ToolDispatchWorkflow.execute(...))
```

If the flag does not survive, make it survive by typing it onto the observation:
add `providerExecuted: Schema.Boolean` (or a `toolUseMode` echo) to the journaled
`ToolUse` event so the observer *must* read a value distinguishing
host-dispatchable from provider-executed. The point is to make "dispatch a tool"
require evidence the tool is host-dispatchable, rather than defaulting to dispatch.

**Fix B — make codec inbound-capability part of the type, the inbound twin of
`supportsVerb`.** `channels/router.ts` already gates verbs at runtime
(`supportsVerb` -> `ChannelRouteVerbNotSupported`). The codec has no inbound
analogue, so `sendToolResult` is a runtime `Effect.fail`. A `ReadonlySet` of
allowed kinds that callers *may* consult is **not** unrepresentability — with
`send: (event: AgentInputEvent)`, `session.send({ _tag: "ToolResult", … })` still
type-checks for ACP. Make the kind a type parameter so an unsendable kind fails to
compile:

```ts
// sources/codecs/contract.ts -- the accepted-kind set is a TYPE, not a runtime guard
export type AgentInputKind = AgentInputEvent["_tag"]

export interface AgentSessionService<K extends AgentInputKind = AgentInputKind> {
  readonly meta: AgentCodecMeta
  readonly toolUseMode: AgentToolUseMode
  readonly inboundKinds: ReadonlySet<K>                 // runtime witness, kept in sync with K
  // send only accepts the variants this codec parameterizes over:
  readonly send: (event: Extract<AgentInputEvent, { _tag: K }>) =>
    Effect.Effect<void, AgentCodecError>
  readonly outputs: Stream.Stream<AgentOutputEvent, AgentCodecError>
}
```

ACP is an `AgentSessionService<Exclude<AgentInputKind, "ToolResult">>`: a relay
that tries `session.send(toolResult)` against it **does not type-check**, so the
crash path is removed at compile time rather than dropped at runtime. The
`inboundKinds` set survives as the runtime witness for code that erases `K` (e.g.
a registry of heterogeneous sessions), but it is no longer the primary guard.

**Where the gate runs — defer to §12.** In today's structure the relay is produced
in `runtime-context.ts` via the adapter, and the adapter interface exposes no
capability surface (the §9 falsifier notes this). The target resolves it cleanly:
per §12 Seam 2 the adapter owns the live `AgentSession` and its session registry,
so the inbound-kind gate lives **inside `AcpAdapter`'s `send`**, the only place the
typed session is visible. Do not bolt a capability accessor onto the current
adapter to make Fix B work in the old shape — the gate belongs where §12 puts
session ownership.

> Do **not** soften `runtime-context.ts`'s `orDie` to a blanket Skip — `orDie` on
> an unsendable input of an *accepted* kind is a correct loud signal. Fix A stops
> the relay being generated; the typed `send` (above), enforced inside the adapter
> per §12, is the net so future relay kinds can't reintroduce the crash. Together
> they make "host dispatches a provider-owned tool and crashes the session" require
> actively declaring the tool host-dispatchable *and* widening a codec's `K` to
> include `ToolResult` — neither of which ACP does.

**Target framing (per the ACP-owns-dispatch analysis, tf-ll90.17 / CODEC_ADAPTER
§6).** The deeper point is not "patch the observer" — it is that **internal-dispatch
codecs (ACP) own tool execution themselves**, so for those codecs the observer
should never fork `ToolDispatchWorkflow` at all. The crash is the symptom of a
mis-composition: a host-side dispatch path wired in front of a codec that already
dispatches. In the §12 target the observer-forks-dispatch path simply does not
exist for internal-dispatch codecs; Fix A's provenance gate is the minimal form of
that same statement (don't dispatch what the provider executed). This is *not* a
reason to demote §12 to optional hardening — it is the reason §12's adapter-owns-
dispatch boundary is the correct end state, with Fix A as the bridge that stops the
live crash before the restructure lands.

---

## 4. The composition seams, and the type changes that protect each

| Seam | Today | Mis-composition risk | Type-level protection |
|---|---|---|---|
| backend / sandbox | `codec: "acp"` sugar's `defaultProductionAdapterLayer` provides `LocalProcessSandboxProvider` **inside** the bundle | external `Layer.provide(AltSandbox)` silently dropped | the swap unit is the **adapter Layer**, not `SandboxProvider` (Section 5); optionally parameterize the bundle over the sandbox layer |
| adapter <-> kernel | `FiregridHostOptionsWithAdapter.adapter: Layer<..., never, any>` | the `any` R-channel hides what the adapter needs | replace `any` with the real requirement union or `never`; the `any` is itself a latent escape hatch (Section 6) |
| output stream URL | host-wide writer; dead per-context readers + builders still present | Section 3.1 — a reader points at the per-context URL no writer produces | **delete** the per-context output builders so a divergent URL is unwriteable; one builder remains (brand optional over that single surface) |
| codec inbound | `send(AgentInputEvent)` accepts kinds the codec can't deliver | Section 3.2 crash | `AgentSessionService<K>` with `send(Extract<AgentInputEvent, { _tag: K }>)`; `inboundKinds` only as an erased-runtime witness |
| channel verb | `supportsVerb` runtime check | wrong verb -> runtime error | already runtime-gated; acceptable for the dynamic agent face (Section 7), target is a runtime string |
| edge composition | `bin/acp.ts` `Layer.build` + `Context.get`, ending in `as unknown as Layer<AcpStdioEdge, unknown, never>` | the cast launders both `E` (otel `unknown`) and residual `R`; the `R=never` gate never runs | Section 6 — sever the cast, make the edge `Layer.launch`-able |

---

## 5. The adapter is the swap unit — say so in the type

> **Relationship to §12 (read this first).** This section diagnoses the *current*
> code's adapter seam — the `FiregridHostOptions` union and its silently-dropped
> sandbox swap. §12 Seam 2 is the **target** and supersedes the API shape proposed
> here: the adapter is not an options-union member or a parameterized bundle, it is
> a **positional required argument** to `FiregridRuntime(spec, adapter)`, with the
> sandbox as the adapter's own leaf argument. The §12 shape is what lands; §5 stays
> as the description of what is being replaced and *why* (the union hides the swap
> unit, the `any` R-channel hides the requirement). Do not implement both — where
> they differ, §12 wins.

`FiregridHostOptions` is a union: provide an `adapter` Layer
(`FiregridHostOptionsWithAdapter`) or take the `codec: "acp"` sugar
(`FiregridHostOptionsWithCodecSugar`). The supported substitution is **"pass a
different adapter Layer,"** not "provide a different `SandboxProvider`" — because
`defaultProductionAdapterLayer` discharges `SandboxProvider` inside the bundle, so
a root-level `Layer.provide(AltSandbox)` has nothing to satisfy and is silently
dropped.

So swap tests must assert **adapter identity**, and prose about local->remote must
say "provide a different adapter Layer." If a `SandboxProvider`-level swap is
wanted, parameterize the bundle:

```ts
const defaultProductionAdapterLayer = (
  envPolicy: Layer.Layer<RuntimeEnvResolverPolicy> = RuntimeEnvResolverPolicy.denyAll,
  sandbox: Layer.Layer<SandboxProvider, never, never> =
    LocalProcessSandboxProvider.layer().pipe(Layer.provide(NodeContext.layer)),
) => ProductionCodecAdapterLive.pipe(Layer.provide(sandbox), ...)
```

The default is a default *argument*, never internal construction — then both the
adapter-level and sandbox-level swaps hold, and the behavioral test asserts the
active provider's identity rather than expecting a merge conflict (a conflict
never happens; the failure mode is "external provide ignored").

---

## 6. Static enforcement as the spec — close the escape hatches

The single highest-value target is `bin/acp.ts`'s
`) as unknown as Layer.Layer<AcpStdioEdge, unknown, never>`. It launders the otel
layer's `Layer<never, unknown>` error channel **and** whatever `R` remains after
the `provideMerge` chain, and it is why `bin/acp.ts` never gets an `R=never`
proof (it uses `Layer.build` + `Context.get`, not `Layer.launch`). The fix is to
remove the cast and make the edge launchable the way `bin/host.ts` is — which
forces otel's `unknown` `E` to be `orDie`-d at its boundary and the residual `R`
to actually reach `never`.

Lint/type rules, run in `lint` + `typecheck`:

- **Ban the assertion family, not one syntax.** `no-restricted-syntax` on
  `as unknown as`; `no-explicit-any` (kills the `Layer<..., never, any>` adapter
  R-channel in Section 4); ban `@ts-ignore` for `@ts-expect-error` (stale
  suppressions fail the build); `no-non-null-assertion` at tier seams. The
  codebase already uses scoped `eslint-disable` with named rationale (the
  `orDieTable` adapter, the webhook `Layer.scopedDiscard` inference) — that
  pattern stays; the blanket bans make the *unannotated* escape hatch fail.
- **`@effect/language-service` is already on** (`tsconfig.json` plugin). Its
  floating-effect / requirement-leak diagnostics catch an `R` escaping a tier or
  an `E` widening to `unknown` at the editor.
- **Acceptance test = launchability.** An `expectTypeOf` that
  `FiregridHost({...}).pipe(Layer.provide(...edge...))` inhabits
  `Layer<..., never, never>`, plus a `@ts-expect-error` corpus: the un-cast edge
  composition must type-check, and a deliberately-underprovided composition must
  not. This is exactly the gate the `as unknown as` cast currently evades.

Scope note: the earlier "`process.env` only in `config/`, `Config`-as-law"
discipline is **not implemented** — `bin/_compose.ts`, `bin/host.ts`
(`nonEmptyEnv`/`requiredEnv`/`optionalEnv`), `sources/sandbox/secrets.ts` read
`process.env` directly. Treat `Config`-as-law as future work, not a description of
current state. The hand-rolled `value.trim() === ""` checks are fine and the
`Config.option`-empty-string hazard does not arise because `Config` isn't used
here.

---

## 7. The interaction surface is two faces — only one can be typed

The "one spec derives a typed client" idea is **structurally incompatible** with
the agent face and must not be retrofitted onto it:

- **Agent face (dynamic, stays string-dispatched).** Agents call MCP tools
  (`unified/mcp-host/*`) -> `RuntimeChannelRouter.dispatch({ target, verb,
  payload })`, where `target` is agent input (`wait_for({ channel })` ->
  `waitOnChannel(channelName)`). You cannot derive a typed per-channel client
  method when the channel name arrives at runtime. Direction/verb safety is
  runtime-enforced (`supportsVerb` -> `ChannelRouteVerbNotSupported`), and
  channel-target indirection is *load-bearing* for substrate hiding
  (`channels/README.md`). Stays dynamic by design.
- **Host-internal caller face (could be typed).** `stdio-edge.ts` dispatches
  *known* targets (`HostSessionsCreateOrLoadChannelTarget`,
  `SessionPromptChannelTarget`, `HostSessionsStartChannelTarget`,
  `HostPermissionRespondChannelTarget`) and `Schema.decodeUnknown`s the receipt.
  This caller could get a thin typed facade — `client.sessions.createOrLoad(req)`
  returning the decoded response — *over* the same router, without removing the
  dynamic dispatch underneath. That is the only place the typed-client idea
  applies.

So any "one spec -> typed client, `router.dispatch` is gone" claim is retracted:
the typed client can at most wrap the internal callers; the router and its string
dispatch stay.

---

## 8. What stays a co-location discipline (types can't carry it)

- **Output-stream URL agreement (3.1).** Once the per-context output builders are
  deleted, this stops being a co-location discipline at all — there is one builder
  and one table layer, so there is no second URL to keep in agreement. Until the
  cutover lands, keep a behavioral test (write through the codec journal, read
  through the host-wide channel, assert the row arrives) as the standing check
  that the one live path is wired; after it lands, the test guards the single
  remaining path rather than an agreement between two.
- **`E = never` != runtime-error-free.** `Layer<..., never, ...>` means cannot
  fail to *build*; services can still return typed `E` at runtime, and `orDie`-ing
  otel hides a dead telemetry pipeline from the types. otel needs an out-of-band
  liveness signal (the destination resolution in `bin/_compose.ts` `otelLayer` is
  build-time only).
- **Durable interruption/teardown is implemented**, not a gap:
  `codec-adapter.ts` `buildSessionForContext` forks a per-context `Scope`, ties
  the byte pipe / codec build (`Layer.buildWithScope`) / output drain into it, and
  `deregister` `Scope.close`s it; `local-process.ts` `openBytePipe` kills the
  process via `acquireRelease`; the ACP agent-adapter has LIFO per-turn
  finalizers. Contract to keep documented: interrupt/scope-close -> process killed
  + codec released + drain stopped, LIFO.
- **Per-context vs compose-once is resolved.** One host-scoped `WorkflowEngine`
  (`host.ts` `engineLayer`, provided once); per-context-ness lives in **execution
  identity** (`RuntimeContextSessionWorkflow.idempotencyKey =
  ${contextId}:${attempt}`) and the adapter registry `Map`, not in dynamic layer
  construction. Compose-once-then-`launch` holds.
- **Unbounded durable waits.** `channels/router.ts` `runHeadOrNever` and
  `mcp-host/tool-dispatch.ts` `waitOnChannel` park on `Effect.never` when no row
  matches — "no matching row" is indistinguishable from "not yet" by
  construction, bounded only by a caller `timeoutMs` (present at the edge via
  `Stream.timeoutFail`, optional in the agent `wait_*` tools). Document that a
  bare `wait_for` parks forever by design.

---

## 9. Falsifiers

- **The edge can't be made launchable without the cast.** If removing
  `bin/acp.ts`'s `as unknown as` leaves a residual `R` no provide satisfies, the
  cast was hiding a real missing requirement — find and provide it; do not
  re-cast. (Expected residue: otel's `unknown` `E`, dischargeable by `orDie`.)
- **`inboundKinds` can't gate the relay.** The relay producer goes through the
  signal table, not the live session, so it may not see the live `AgentSession`'s
  `inboundKinds`. If so, Fix B needs the capability surfaced on the journaled
  event or the adapter, not just the live session. **VERIFY** relay path access to
  codec capability.
- **`providerExecuted` doesn't survive journaling.** If lost in
  `encodeRuntimeAgentOutputEnvelope`, Fix A's one-liner is impossible and the
  schema must carry the bit explicitly. **VERIFY.**
- **The per-context output builders are load-bearing for something live.**
  *Resolved (Gate B, source-verified):* `makePerContextRuntimeOutputWriter` is
  called nowhere, the `PerContextRuntimeOutputWriter` Tag is provided/consumed by
  nothing, `per-context-output.ts` is imported by nothing outside itself, and the
  per-context output URL/name/table builders are referenced only by the dead
  writer, the abandoned Live, the two dead reads, and two tests. *Residual check
  to run at cutover time:* before deleting `runtimeContextOutputStreamUrl` and the
  per-context table layer, confirm by import graph they are not shared with the
  **logs** path or any other per-context wiring — the delete set is the per-context
  *output* path specifically, and a shared builder would widen it.
- **The snapshot has a caller after all.** *Resolved (Gate A, source-verified):*
  `HostContextSnapshotChannelTarget` / `HostSessionSnapshotChannelTarget` are
  provided by `HostControlChannelBindingsLive` and invoked by nothing. If a caller
  surfaces (e.g. in client SDK code not in the reviewed set), the snapshot is
  repointed host-wide instead of deleted — but nothing in the verified graph reads
  it.
- **The adapter swap merges instead of replaces.** Provide an alternate adapter
  Layer; assert the active adapter is that one (identity), not a merge error.

---

## 10. Build order

Phase by `R` and by risk, not calendar. The sequencing decision: **build the §12
target directly; do not land §3.1's interim "one surviving `runtimeOutputStreamUrl`
builder" end state.** That waypoint is immediately replaced by `DurableStreams.streamOptions`,
so per the greenfield-transactional rule the per-context shape never gets a
"one-builder" milestone to drift back toward. §3.1's deletions *fall out of* the
restructure rather than being a standalone phase with their own acceptance gate.

0. **Validation spike (gates §12 as a committed plan).** Compile the §12 modularity
   test — the two-line `Prod`/`Sim` constructor differing only by adapter + backend.
   It must compile *and launch*. The thing it validates is **provide-order requirement
   closure**, not merely "is the graph a DAG" — a DAG can still fail to compile if a
   requirement is introduced after its satisfier in a plain `provide` chain (Seam 2),
   so the spike pins the exact provide expression (likely a single merged-floor
   provide). If it doesn't compile, §12's signatures or provide-order are wrong and the
   rest of the order waits.
1. **VERIFY the 3.2 crash** against a live ACP tool-call turn, plus `providerExecuted`
   survival through journaling. *(The 3.1 gates — no live per-context writer, zero
   snapshot callers — are resolved against source; the only residual is the
   import-graph check that the per-context output builders aren't shared with the
   logs path, run at cutover time. Fix B's old "relay access to codec capability"
   VERIFY is retired: §12 puts the gate inside the adapter, where the session is
   visible by construction.)*
2. **3.2 Fix A** (observer provenance gate / for internal-dispatch codecs, don't fork
   dispatch at all) — smallest change that stops the live crash before the restructure.
3. **§6** (sever `bin/acp.ts` cast, make the edge launchable, the
   `expectTypeOf`/`@ts-expect-error` launchability gate). **Land the lint bans in
   *this same phase as the violations they remove*, not earlier:** `no-explicit-any`
   cannot turn on while `Layer<…, never, any>` and the `as unknown as` sites in
   `channel-bindings.ts` / `toolkit.ts` / tests still exist. Either this phase fixes
   all known violations with the rule, or the rule is scoped to the target tier with
   a tracked baseline for the rest — it does not ship a phase that fails its own lint.
4. **§12 cutover** — introduce the `DurableStreams` floor + the read-views (§12.1) +
   the adapter-as-positional-argument constructor (§12 Seam 2), collapsing the
   `host.ts` core / `_compose.ts` augment layering (and its two entrypoints) into one
   constructor. §3.1's deletions (`per-context-output.ts`, the per-context URL/name/table
   builders, `runtime-host-config.ts`, the abandoned Live, the zero-caller snapshot
   channels) are removals this restructure performs. **Carry Seam 1b's surface
   classification into the deletion:** dissolve only *read-surface* `*ChannelLive`s into
   views; the lifecycle channel's live agent-router route (`SessionSelfLifecycleChannel`)
   is re-sourced from the `control.runs.rows()` view, **not** swept into the deletion.
   tf-0awo.6's client read repoints onto the views in the same pass. This step provides
   `McpEndpointLive` as a floor leaf — but its internal shape (the `Effect.cached` bind,
   step 5) is swappable behind the Tag, so this step does **not** ship the `Ref<Option>`
   race inside the new constructor; it can land with a placeholder Live and take the
   cached shape in step 5. Gate: the modularity test compiles and launches; no
   `contextId`-parameterized stream builder exists; the read-view set is the only read
   model (lifecycle router route intact); grep-clean for the per-context-output symbols;
   preflight + UKV green (UKV migrated onto the views).
5. **3.2 typed `send`** (the generic `AgentSessionService<K>` witness, enforced inside
   `AcpAdapter.send` per §12) and **McpEndpoint as an `Effect.cached` bind** (§12 Seam 3 — the
   latent third defect; the bind is the resolution and `catchAll → None` is the disable,
   so there is no completer to forget) —
   the structural nets that make the removed footguns unrepresentable rather than
   merely absent.

---

## 11. Sources

All symbols verified against the provided `@firegrid/runtime` source, 2026-06-02:
`bin/{acp,host,_compose,_main,run,firegrid}.ts`; `unified/{host,codec-adapter,
observers,adapter,channel-bindings,signal}.ts`;
`unified/subscribers/{runtime-context,permission-and-tool,scheduled-webhook-peer}.ts`;
`unified/mcp-host/*`; `sources/codecs/{contract,index}.ts` +
`acp/{index,mapping,stdio-edge}.ts` + `stdio-jsonl/index.ts` + `agent-adapters/**`;
`sources/sandbox/{SandboxProvider,local-process,local-process-from-env,secrets,
byte-stream,effect-ai,internal-provider}.ts`;
`channels/{router,host-control,session-agent-output,session-agent-output-route,
session-lifecycle-route}.ts` + `router/live.ts` + `session-agent-output/live.ts` +
`observation-streams/**`; `tables/{runtime-output,per-context-output,
output-table-layer,codec-adapter-providers,codec-adapter-tags}.ts`;
`events/contract.ts`; `transforms/decode-ingress-row.ts`; `ARCHITECTURE.md`,
`README.md`, the folder `README.md`s, `package.json`, `tsconfig.json`.

VERIFY items are read off code paths but depend on runtime behavior inspection
can't settle; confirm them before relying on the corresponding fix.

---

## 12. The greenfield composition target — one backend hole, an adapter in the stack

Sections 3.1 and 5 describe the *current* code: a per-context output path to delete,
and an adapter swap unit hidden inside an options union. This section is their
structural realization as the **build target** — the shape that makes those two
defects (and a third, found below) unconstructible rather than linted against. It
supersedes the reconciliation framing as the thing to build toward; §3.1/§5 remain
the description of what is being replaced.

The target rests on one rule, and the rule is what makes the rest fall out:

> **A composition hole belongs at a leaf of the dependency DAG — a node nothing of
> ours feeds — never at an interior node.** A leaf hole (`DurableStreams`, a sandbox)
> is provided once at the floor and consumed upward. An *interior* hole (the adapter:
> it consumes substrate and is consumed by workflows) forces its providers and
> consumers to meet through the binary, and if any provider is transitively a
> consumer you get a cycle. The cycle is not a wiring accident; it is the signature
> of a hole cut into the middle of the graph.

The live `host.ts` is already acyclic for this reason: the adapter is `Layer.provide`d
*down into* the workflow layer over a substrate floor, one downward chain. The target
keeps that direction and removes only the footguns.

### The honest DAG

```
DurableStreams, Sandbox                      ← leaves; the only legitimate holes
        │
  tables, ContextResolver, engine, McpEndpoint   ← floor (substrate)
        │
     adapter                                  ← interior: consumes floor, drives nothing below
        │
  workflows, router-routes, observer, recovery, MCP host
```

Note "router-routes" on the top layer, not "channels": per Seam 1b the *read*
channels are dissolved into views — pure functions off the floor, not a composed
layer node. What remains as a composed interior layer is only the agent-facing
*router routes* (session-self lifecycle, caller-fact, peer — §7's dynamic plane).
Reads don't appear in this DAG at all; they're functions over `DurableStreams`,
resolved at the edge.

`ContextResolver` and `RuntimeOutputTable` are consumed by *two* layers above the
floor — the adapter and the MCP host. That is a **diamond, not a cycle**: one
provider at the floor, two consumers above, single direction. It only looked like a
cycle when the adapter was modeled as a hole beside the backend; in the stack it is
not.

### Seam 1 — `DurableStreams`: the URL footgun made unconstructible

The backend is a Tag that resolves a **closed set of logical stream names** to
physical options. The URL arithmetic lives in exactly one place, and the resolver
has **no `contextId` parameter** — so a per-context output stream is not a thing
that can be asked for.

```ts
export const StreamName = {
  ControlPlane: "control-plane", Output: "output",
  Signals: "signals", Unified: "unified", Engine: "engine",
} as const
export type StreamName = (typeof StreamName)[keyof typeof StreamName]

export class DurableStreams extends Context.Tag("firegrid/DurableStreams")<
  DurableStreams,
  { readonly streamOptions: (name: StreamName) => StreamOptions } // ← no contextId, ever
>() {}

export const DurableStreamsLive = {
  configured: (cfg: { baseUrl: string; namespace: string; headers?: Headers }) =>
    Layer.succeed(DurableStreams, {
      streamOptions: (name) => ({
        // delegate to the canonical encoder — do NOT inline URL arithmetic.
        // durableStreamUrl handles generic vs Electric service-scoped roots and
        // /v1/stream/ encoding; inlining `${baseUrl}/${ns}.firegrid.${name}`
        // regresses configured Electric Cloud URLs.
        url: durableStreamUrl(cfg.baseUrl, `${cfg.namespace}.firegrid.${name}`),
        contentType: "application/json",
        ...(cfg.headers ? { headers: cfg.headers } : {}),
      }),
    }),
  embedded: Layer.effect(DurableStreams, makeInMemoryBackend), // sims/tests, same seam
}
```

The resolver is the *one place* logical names map to physical streams, but the
physical encoding stays with the canonical `durableStreamUrl` / `DurableStreamUrlSchema`
— the resolver owns the name→stream decision, not the URL grammar.

**The floor is where config should enter — start Config-as-law here.** The
`configured` constructor above takes a plain `{ baseUrl, namespace, headers }` object,
which is the same read-it-by-hand pattern §6 admits isn't Config-as-law. The leaf is
the natural place to fix that, because it's where the host's external configuration
actually enters the graph:

```ts
const DurableStreamsConfig = Config.all({
  baseUrl: Config.string("DURABLE_STREAMS_BASE_URL"),
  namespace: Config.string("FIREGRID_RUNTIME_NAMESPACE"),
  headers: Config.option(/* … */),
})

export const DurableStreamsLive = Layer.effect(
  DurableStreams,
  Effect.map(DurableStreamsConfig, (cfg) => ({
    streamOptions: (name) => ({
      url: durableStreamUrl(cfg.baseUrl, `${cfg.namespace}.firegrid.${name}`),
      contentType: "application/json",
      ...(Option.isSome(cfg.headers) ? { headers: cfg.headers.value } : {}),
    }),
  })),
)
```

This buys the §6 scope-note's whole concern for free: a test or sim that wants the
*real backend with test config* provides a `ConfigProvider` layer instead of mutating
`process.env`. Be precise about what this does and doesn't change for the modularity
claim, though — the `embedded` sim path is **not** a `ConfigProvider` swap; it's a
separate in-memory `DurableStreams` Layer (`makeInMemoryBackend`) with no URL at all.
So the prod/sim axis is: *configured-vs-embedded is which Layer*, and *ConfigProvider*
is how the configured Layer gets its values without env mutation. Don't conflate them
into "prod and sim differ by ConfigProvider" — that's only true within the configured
branch.

This *is* §3.1, resolved structurally: per-context-ness is a row column plus a
`Stream.filter(row => row.contextId === …)`, exactly as the live host-wide read
already works. There is no per-context output builder to delete because the shape
that minted one is no longer expressible. The brand prevented divergent *values*;
this prevents the divergent *shape*.

**Caveat — the closed set must actually be closed (read against code, not inferred).**
The webhook ingest path (`VerifiedWebhookFactTable`, the per-source listeners in
`verified-webhook/source-live.ts`) mints its own stream URLs today
(`${baseUrl}/v1/stream/firegrid.verifiedWebhook`). If those stay outside
`streamOptions`, the enum is closed but the URL-minting surface is not — the §3.1
shape relocated to another folder. Resolve explicitly, do not leave implicit: either
bring caller-owned fact streams under the resolver (a distinct `StreamName` variant
or a sibling Tag), or state that `DurableStreams` governs only the five host-owned
streams and caller-fact streams are a *deliberately separate, open* namespace. The
design must not read as "all URLs flow through one place" while the code keeps a
second mint. **Generalize this rule to every leaf the target introduces:** a leaf
Tag's value is its *entire* surface, so the acceptance bar for any leaf is "one
mint, or a deliberately-separate namespace named as such" — not just for output.

### Seam 1b — channels are views over the floor (the conclusion Seam 1 sets up)

Seam 1's load-bearing move — "per-context-ness is a row column plus
`Stream.filter(row => row.contextId === …)`" — generalizes past output to the
*entire read surface*. `HostContextsChannel`, `SessionLifecycleChannel`, and the
agent-output channel are each a filtered/mapped view over two or three of the five
`DurableStreams`. So the target dissolves the per-channel `*ChannelLive` boilerplate
(a Tag + a `Layer.effect` resolving a table and wrapping a stream, repeated per
channel) into a small set of **typed read views over the `DurableStreams` Tag**:

```ts
// reads are pure functions of a row stream — no service, no per-channel Tag/Live.
// take the Stream, not the DurableStreams Tag: then a view is testable against a
// literal Stream.fromIterable with no service at all. The ONE call site that
// resolves DurableStreams → rowsOf(name) pushes the service dependency to the edge.
export const views = {
  contexts: (rows: Stream.Stream<Row>) => rows.pipe(Stream.filter(isContextRow)),
  lifecycle: (rows: Stream.Stream<Row>, contextId: string) =>
    rows.pipe(Stream.filter(byContext(contextId))),
  agentOutput: (rows: Stream.Stream<Row>, contextId: string) =>
    rows.pipe(Stream.filter(byContext(contextId))),
}
// resolved at the edge: views.agentOutput(rowsOf(ds, StreamName.Output), ctxId)
```

This is strictly simpler than "a Tag + Live per channel," and the temptation under
"more Effect-native" is to make the views into Tags/Layers — which would be *less*
native, not more. Not everything is a service; a derivation over one resolved service
is a plain function, not a second Tag demanding its own Layer. Keeping the views as
functions (and taking the `Stream`, so they need no service to test) is the idiomatic
call.

**One classification the dissolution must carry, or it sweeps a live route into the
deletion.** "Dissolve the `*ChannelLive` sprawl" is safe only for channels that are
*read-surface only*. An audit of the four came back 3-of-4 clean:

- *Snapshot channels* — dead (Gate A), delete.
- *`HostContextsChannel`* — read-surface only (client `watchContexts` + the edge),
  becomes a view. Clean.
- *Agent-output* — read-surface only **now**: its `session-self` route was retired in
  Wave D-E (no production populator post-D-A/D-B, zero successful router dispatches
  across the ACP traces). Becomes a view. This is a second Gate-A-style confirmation
  that strengthens the agent-output→view move — cite it.
- *Lifecycle* — the **exception**. The same `control.runs.rows()` stream feeds *two
  live surfaces*: the read-surface `SessionLifecycleChannel` (client/edge) **and** the
  agent-facing `SessionSelfLifecycleChannel`, which is router-reachable on §7's
  dynamic plane and still alive. The view replaces the *read* binding; the **router
  binding is re-sourced from the same `control.runs.rows()` view, not deleted.**

So the rule the cutover carries: a view replaces a channel's *read* binding; where a
channel also has a live agent-router route, that route is re-pointed at the same view,
not swept into the deletion. This is the "one filtered stream, two surfaces"
reconciliation with a concrete live instance (lifecycle). It does two things the
earlier sections only gestured at:

**It collapses a composition *layering*, not a duplication.** An earlier draft of
this section claimed there were two *rival* host compositions (`bin/_compose.ts` and
`unified/host.ts`) providing different channel sets. The file-level dependency graph
refutes that: `bin/_compose.ts` **imports** `unified/host.ts` — it is a layer *over*
the core, adding the router, mcp-host, tool-dispatch, and observability on top of
`host.ts`'s substrate. The real shape is one core (`host.ts`) + one augmenting layer
(`_compose.ts`) + two entrypoints (`bin/host.ts` uses the core directly;
`bin/acp.ts → _compose.ts → host.ts`). The actual asymmetry behind "which composition
provides the agent-output channel" is that `_compose` adds that channel while the
core does not — so `bin/host.ts`, using the core directly, *lacks* it. §12's single
constructor still simplifies this — it composes the reads as views once, so the core
and its augment stop being two layers a binary picks between — but the thing being
collapsed is a core/augment layering with an entrypoint fork, not a duplicated rival
channel set. A view is a function of `DurableStreams`, not a separately-provided Tag,
so "who provides the channel" stops being askable regardless.

**It is the correct home for the client read path (tf-0awo.6).** The read-source
idea was killed two turns ago as "a third reader duplicating the snapshot channel."
Gate A deletes the snapshot channel and Seam 1b deletes the channel-Live sprawl, so
the duplication argument is gone. The cleanest client read surface is the *same*
protocol-owned views over `DurableStreams` — and `DurableStreams` is a leaf the
**client provides from its own config** while the host provides it from its floor.
Same views, both sides. That:

- structurally answers "who provides the channel to the client" — nobody; the client
  provides the leaf and the views are pure functions over it;
- simplifies the client's *protocol-internal* read path — replacing the
  `session-facade` / `channels/router` read indirection with direct views over the
  floor the client already depends on — **without breaching the
  `client-sdk-no-runtime` boundary** (see the import-graph note below: that boundary
  is already held, and the views keep it held; this is not the move that establishes
  it);
- is the read-source done right: over the floor, not beside/duplicating channels.

So in the target tf-0awo.6 is not "consume `HostContextsChannel` +
`SessionLifecycleChannel` + agent-output channel that the host happens to provide" —
it is "consume the read views over `DurableStreams`," protocol-owned and
browser-safe.

> **Import-graph check (against the file-level runtime + monorepo dependency graph,
> 2026-06-02).** `client-sdk` has *no edge to `runtime`* in any graph; it depends only
> on `protocol` + the durable-streams/operators floor. The runtime-facing SDK is
> `host-sdk` (`host-sdk/index → runtime/unified`, its only edge). So the
> `client-sdk-no-runtime` boundary is *currently held* — the views approach preserves
> it, it does not repair it.
>
> **Confirmed dead at file granularity (Gate B, now graph-grounded not just grep):**
> `tables/per-context-output.ts` and `channels/session-agent-output/live.ts` (the
> abandoned per-context Live) both have *zero inbound edges*. **New:**
> `channels/runtime-host-config.ts` is imported *only* by that dead Live, so it is
> dead-with-it — add it to the §3.1 delete set. Note `tables/output-table-layer.ts`
> is *shared* (live `host-control` imports it alongside the dead per-context path),
> so it is a surgical export-removal, not a file deletion.
>
> **§3.1 logs residual discharged:** runtime `channels/session-log.ts` imports only
> the protocol channel barrel — none of `output-table-layer`, `per-context-output`, or
> `runtime-output`. Logs and the output path are independent; deleting the per-context
> output path cannot break logs. (This upgrades the earlier "confirm at cutover time"
> caveat to confirmed.)
>
> **Seam 2/3 premises confirmed:** `unified/codec-adapter.ts` imports `SandboxProvider`
> and `runtime-context-mcp-base-url` directly — the adapter owns its sandbox and reads
> the MCP base, as Seams 2 and 3 assume.
>
> **Dual composition — now checkable, and the earlier claim was wrong:**
> `bin/_compose.ts → unified/host.ts`. `_compose` is a layer over the core, not a
> rival composition; see the corrected paragraph above.
>
> **Still not dischargeable by import graph / open:** Gate A (snapshot *zero callers*)
> — the graph shows `host-control` is *bound* (via `host.ts` and the channel barrel),
> consistent with "provided but never invoked," but dispatch is runtime string-keyed,
> so zero-callers rests on the agent's grep, not the graph. And
> `tables/runtime-output-public.ts` has *zero inbound edges* (it only imports
> `runtime-output.ts`) — either dead or an uncaptured public entry; grep before
> assuming either.
>
> **A clean import DAG still does not discharge the §10 step-0 spike:** the cycle
> Seam 2 guards against is Layer requirement-closure, a composition property, not a
> static import edge — different graph.

**Package placement — the rule that makes "client consumes views, stays off runtime"
coherent.** This is the one part of the read-view move that's load-bearing *and*
ambiguous until pinned: if `DurableStreams`, `StreamName`, `rowsOf`, and the view
functions live in `runtime`, the client boundary breaks the moment the client imports
them. They must live in **`protocol`** (the browser-safe tier the client already
depends on), with this import contract:

- `protocol` owns the `DurableStreams` Tag, the `StreamName` set, `rowsOf`, and the
  view functions. The views are pure (they take a `Stream`, per above), so this adds
  no transport dependency. `protocol` already transitively depends on
  `effect-durable-streams`/`-operators` (the file graph shows
  `protocol/channels/session-log → durable-operators`), so this placement is
  consistent with the existing dependency direction, not a new edge into a heavier
  tier.
- The `DurableStreams` *Lives* are provided per-package, never by `protocol`: the
  **host** provides the configured Live from its floor; the **client** provides a
  browser-safe Live built from its own config (fetch/`EventSource`-based, the
  durable-streams browser transport); **sims** provide the embedded in-memory Live.
  `protocol` ships the Tag and the views but no transport-specific Live, so it stays
  browser-safe and neither side imports the other's Live.
- The boundary check that must hold post-cutover: `client-sdk → protocol` only (no
  edge to `runtime`), exactly as it is today — the views move keeps it, and the
  placement rule is what guarantees it rather than assumes it.

If `durableStreamUrl` (the canonical encoder Seam 1 delegates to) or `Config` access
turns out not to be browser-safe, the split is: Tag + `StreamName` + pure views in
`protocol`; the *configured* Live (which needs the encoder + `Config`) in a host-side
package. The pure surface the client touches stays in `protocol` regardless.

### Seam 2 — the adapter is a positioned required argument, not a hole

This is the correction to §5 and to an earlier draft of this section that modeled
the adapter as a second parallel hole and thereby manufactured a cycle. The adapter
is interior; per the rule it cannot be a hole. It is a **required argument** to the
runtime constructor, `provide`d into the chain over the substrate floor:

```ts
const FiregridRuntime = (
  spec: HostSpec,
  adapter: Layer.Layer<RuntimeContextSessionAdapter, never, SubstrateDeps | McpEndpoint>,
) =>
  Layer.mergeAll(workflows, channels, observer, recovery, mcpHost).pipe(
    Layer.provide(adapter),               // adapter sits between workflows and floor
    Layer.provideMerge(Substrate(spec)),  // floor discharges the adapter's SubstrateDeps
    Layer.provide(McpEndpointLive),
  )
// R = DurableStreams only.  Layer.launch ⇔ backend provided.
```

A required positional argument is **strictly stronger** than an R-hole for the thing
it guards: you cannot call the constructor without it (failure at the call site, not
deferred to `Layer.launch`), and there is no union for it to be silently satisfied
through — which is precisely the `FiregridHost({ codec })` footgun where
`Layer.provide(AltAdapter)` type-checks and does nothing. The sandbox is the
adapter's *own* leaf argument, encapsulated where its single consumer lives:

```ts
export const AcpAdapter = (opts?: {
  sandbox?: Layer.Layer<SandboxProvider>
  envPolicy?: Layer.Layer<RuntimeEnvResolverPolicy>
}): Layer.Layer<RuntimeContextSessionAdapter, never, DurableStreams | McpEndpoint> =>
  ProductionCodecAdapter.pipe(
    Layer.provide(opts?.sandbox ?? LocalProcessSandboxProvider.layer()),
    Layer.provide(opts?.envPolicy ?? RuntimeEnvResolverPolicy.denyAll),
    Layer.provide(idGeneratorLayer),
  )
```

The adapter requires `DurableStreams` (it builds the output table it writes from the
same backend Tag) and `McpEndpoint` (Seam 3) — both are floor/leaf services the
chain already provides, so the adapter's requirements close downward, acyclically.
Swap the whole adapter: pass `SimAdapter`. Swap only the sandbox under ACP:
`AcpAdapter({ sandbox: E2BSandbox })`. Neither is a host-level provide that can miss.

**The pipe sketch above hides a real subtlety: acyclicity is necessary but not
sufficient — provide-*order* requirement closure also has to hold.** The adapter
introduces a `McpEndpoint` requirement (it's `provide`d early) that's satisfied by
`McpEndpointLive` (`provide`d last); that closes only because `Layer.provide`
accumulates requirements rightward through the pipe. A graph that *is* a DAG can
still fail to compile if a requirement is introduced after its satisfier in a plain
`provide` chain. When everything closes at one floor, the more native and less
order-fragile shape is a single provide of a merged floor:

```ts
const Floor = (spec: HostSpec) => Layer.mergeAll(Substrate(spec), McpEndpointLive)
Layer.mergeAll(workflows, channels, observer, recovery, mcpHost).pipe(
  Layer.provide(adapter),          // adapter's DurableStreams|McpEndpoint propagate outward
  Layer.provideMerge(Floor(spec)), // one floor satisfies upper layers AND the adapter, in one context
)
```

letting Effect resolve the mutual requirements in one context rather than depending on
pipe order. The exact provide expression is the **modularity compile-spike's** job to
pin (§10 step 0) — and the spike is validating *provide-order requirement closure*,
not merely "is it a DAG." Flagging that distinction is the point: a green DAG diagram
is not a passing spike.

### Seam 3 — `McpEndpoint` as a cached bind effect: a third defect, same class as §3

This is a defect of the **same class as §3.1/§3.2** — type-checks and launches today,
wrong at runtime under a wiring change — though *latent*, not live: it misfires only
under a build-order change, where §3.2 crashes every ACP tool turn now. The live
`FiregridRuntimeContextMcpBaseUrlLive` is a `Ref<Option<…>>`; the adapter reads `.get`
when spawning an agent and can read `None` purely because it spawned before the MCP
server bound its port, firing the `requires runtimeContextMcp but no listener bound`
adapter error spuriously.

An earlier draft of this seam reached for a `Deferred` with imperative
`publish`/`disable` methods — and then had to spend a paragraph guaranteeing someone
*calls* one of them on every path, or `Deferred.await` hangs forever (§8's unbounded
park, relocated to startup). **That defensive paragraph was the tell that the
primitive was wrong.** A value that resolves once and is awaited by everyone, where
the resolution *is* an effect that runs at most once, is exactly `Effect.cached`. Make
the bind itself the resolution and the failure path the disable:

```ts
export class McpEndpoint extends Effect.Service<McpEndpoint>()("firegrid/McpEndpoint", {
  effect: Effect.gen(function* () {
    const enabled = yield* Config.boolean("FIREGRID_MCP_ENABLED").pipe(Config.withDefault(false))
    // success → Some(base); bind failure OR disabled → None. No publish, no disable.
    const resolved = enabled
      ? yield* Effect.cached(
          bindMcpServer.pipe(                       // depends on the bound HttpServer
            Effect.map(Option.some),
            Effect.catchAll(() => Effect.succeed(Option.none<McpBase>())), // catchAll IS the disable
          ),
        )
      : Effect.succeed(Option.none<McpBase>())
    return { resolved } // adapter: `yield* (yield* McpEndpoint).resolved`
  }),
}) {}
```

Why this deletes the bug rather than disciplining around it: `Effect.cached`
guarantees the bind runs at most once and every awaiter sees the same result, so
there is no `publish` to forget and no `disable` to remember. `catchAll → None` *is*
the bind-failure path — the await always resolves to a decision, never hangs. The
read-before-bind race is gone too, because the cached effect depends on the bound
`HttpServer`, so it cannot evaluate until the server has bound; the dependency edge
enforces the ordering the `Ref` left to chance. The §8 footgun is structurally
absent, not guarded-by-discipline.

Two honest notes. The failure→`None` is cached *terminally* — a transient bind
failure becomes a permanent "MCP disabled" for the process lifetime. That is correct
for a once-at-startup listener (you don't want per-spawn rebind attempts); if you ever
wanted retry, that is a different primitive (`cachedWithTTL` or an explicit retry
*inside* `bindMcpServer` before the `catchAll`), and naming that boundary is the
point. And `Effect.Service` (the class API generating Tag + `Default` layer +
accessor) is used here deliberately — the three seam services (`DurableStreams`,
`McpEndpoint`, and the adapter's session service) should all use it rather than the
hand-written `Layer.effect(Tag, Effect.map(…))` form the rest of this section sketches;
it's the current idiomatic default and removes a layer of boilerplate without changing
the architecture.

### The §3.2 relay crash lives inside the adapter now

Correctly out of scope as a *composition* seam, but Seam 2 settles *where* it lives.
The §3.2 fix — gate inbound kinds the codec cannot deliver — belongs inside
`AcpAdapter`'s `send`, consulting the registry entry's `inboundKinds`, because that
is the only place the live `AgentSession` is visible. Since the adapter now fully
owns its sandbox and session registry (Seam 2), there is no other layer that could
even attempt the gate. "Not a composition concern" becomes "addressed by Seam 2
putting session ownership where the gate has to run."

### `ContextResolver` / `ToolDispatch` — forced, not free

An earlier draft flagged the MCP host's dependency on these as an open choice
(outward surface vs binary-wired). It is partly forced: `ContextResolver` is consumed
by *both* the MCP host (above the floor) and the adapter (`provide`d into the chain).
It is therefore a floor service with two upward consumers — the diamond above — not
an outward-only re-export. Whichever layer owns context resolution, both consumers
reach it the same way, from the floor. The adapter's dependency on it removes the
freedom; do not present it as a toggle.

### Modularity acceptance test

Prod and sim are the same constructor differing by **which adapter is passed and
which backend Live is provided** — and the spike validates **provide-order
requirement closure** (Seam 2), not merely DAG-ness (a DAG can still fail to compile
if a requirement is introduced after its satisfier in a plain `provide` chain):

```ts
// configured floor reads Config (Seam 1); tests supply a ConfigProvider instead of
// mutating env. Sim uses the embedded in-memory Live. The exact provide expression
// is what the spike pins — likely a single merged-floor provide (Seam 2), not the
// pipe shown, if a plain chain doesn't close.
const Prod = FiregridRuntime(spec, AcpAdapter({ sandbox: LocalProcess }))
  .pipe(Layer.provide(DurableStreamsLive.configured), Layer.launch) // Config-driven, no cfg arg
const Sim  = FiregridRuntime(spec, SimAdapter)
  .pipe(Layer.provide(DurableStreamsLive.embedded), Layer.launch)
```

The moment someone re-models the adapter as a parallel hole, the cycle returns and
`Layer.launch` will not compile. That is the keystone (§2) guarding the *boundary*,
not merely the wiring — which is the property worth carrying to the next seam cut:
holes at leaves, interior dependencies as positioned arguments.

### Epistemic status of this section

Designed, not read: the service shapes (`DurableStreams`, the `Effect.cached`
`McpEndpoint`, the typed session service), the `FiregridRuntime(spec, adapter)`
constructor signature, the read-views, and the leaf-vs-interior rule are a proposed
greenfield target, not transcribed from source. Read against code: the live `host.ts`
downward-chain structure, the `Ref<Option>` MCP base-URL and its spawn-time `.get`,
the `codec`-union adapter footgun, the `_compose.ts`/`host.ts` dual composition, and
the webhook second-mint caveat. Confirm before building, by priority: (1) the
**provide-order requirement closure** of the constructor — the §10 step-0 compile
spike, the one thing most likely to need the exact provide expression reworked; (2)
that `Effect.cached`'s terminal failure→`None` caching is acceptable for the MCP bind
(it is, for a once-at-startup listener — named in Seam 3); (3) `ProductionCodecAdapter`'s
exact substrate R (assumed `DurableStreams`-derivable); (4) whether `ContextResolver`
stays a floor service for both consumers or wants its own small Tag; (5) whether the
floor's `Config` inputs (Seam 1) match the existing env var names the binaries read.