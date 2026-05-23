// firegrid-remediation-hardening.STATIC_QUALITY.10

// ruleid: firegrid-no-filesystem-in-runtime-package
import { readFileSync } from "node:fs"

// ruleid: firegrid-no-filesystem-in-runtime-package
import { homedir } from "node:os"

// ruleid: firegrid-no-filesystem-in-runtime-package
import { join } from "node:path"

// ruleid: firegrid-no-filesystem-in-runtime-package
import { FileSystem } from "@effect/platform"

// ok: firegrid-no-filesystem-in-runtime-package
import { Command } from "@effect/platform"

// ruleid: firegrid-no-process-env-outside-bin
const url = process.env.DURABLE_STREAMS_URL

// ruleid: firegrid-no-process-env-outside-bin
const port = process.env.PORT ?? "3000"

// ruleid: firegrid-no-process-env-outside-bin
const dynamicEnv = process.env["DURABLE_STREAMS_URL"]

// ruleid: firegrid-no-process-env-outside-bin
const globalEnv = globalThis.process.env.DURABLE_STREAMS_URL

// ruleid: firegrid-no-process-env-outside-bin
const globalDynamicEnv = globalThis.process.env["DURABLE_STREAMS_URL"]

// ok: firegrid-no-process-env-outside-bin
declare const cfg: { readonly streamUrl: string }
const ok1 = cfg.streamUrl

// ok: firegrid-no-process-env-outside-bin
declare const env: Record<string, string>
const ok2 = env.SOME_VAR

// firegrid-remediation-hardening.STATIC_QUALITY.13

declare const Effect: {
  runPromise: (effect: unknown) => Promise<unknown>
  runSync: (effect: unknown) => unknown
  runFork: (effect: unknown) => unknown
  fail: (error: unknown) => unknown
  tryPromise: (options: unknown) => unknown
  gen: (body: unknown) => unknown
  sync: (body: unknown) => unknown
}
declare const Match: {
  value: (value: unknown) => {
    pipe: (...args: ReadonlyArray<unknown>) => unknown
  }
  tag: (tag: string, handler: unknown) => unknown
  exhaustive: unknown
  orElse: (handler: unknown) => unknown
}
declare const Runtime: {
  runPromise: (runtime: unknown) => (effect: unknown) => Promise<unknown>
}
declare const Layer: {
  succeed: (tag: unknown, service: unknown) => unknown
  effect: (tag: unknown, effect: unknown) => unknown
}
declare const Schema: {
  String: {
    pipe: (annotation: unknown) => unknown
  }
}
declare const Context: {
  Tag: (name: string) => unknown
}
declare const runtime: unknown
declare const effect: unknown
declare const durableCapabilityEffect: unknown
declare const promise: Promise<unknown>
declare const ns: string
declare const streamPrefix: string
declare const hostId: string
declare const handleA: (value: unknown) => unknown
declare const fallback: (value: unknown) => unknown
declare const engine: {
  execute: (workflow: unknown, options: unknown) => unknown
}
declare const Workflow: {
  make: (options: unknown) => unknown
}
declare const RuntimeContextWorkflow: unknown
declare const OtherWorkflow: unknown
declare const streamAuthority: unknown
declare const ValidatedStreamAuthoritySchema: unknown
declare const Clock: {
  currentTimeMillis: unknown
}
declare const Config: {
  string: (name: string) => unknown
  option: (config: unknown) => unknown
}
declare const importMeta: {
  env: Record<string, string>
}

// ruleid: firegrid-no-date-now
const wallClockMillis = Date.now()

// ok: firegrid-no-date-now
const clockMillis = Clock.currentTimeMillis

// ruleid: firegrid-no-new-date-iso-in-library
const directIso = new Date().toISOString()

// ruleid: firegrid-no-date-now
const dateNowIso = new Date(Date.now()).toISOString()

// ok: firegrid-no-new-date-iso-in-library
const clockIso = new Date(123).toISOString()

// ruleid: firegrid-no-effect-run-in-library
const detachedRun = Effect.runPromise(effect)

// ok: firegrid-no-effect-run-in-library
const scopedRun = Runtime.runPromise(runtime)(effect)

// ruleid: firegrid-no-manual-tagged-error-type
type ManualTaggedError = {
  readonly _tag: "ManualTaggedError"
  readonly message: string
}

// ruleid: firegrid-no-manual-tagged-error-type
interface ManualTaggedErrorInterface {
  readonly _tag: "ManualTaggedErrorInterface"
  readonly message: string
}

// ok: firegrid-no-manual-tagged-error-type
type PlainMessage = {
  readonly message: string
}

// ruleid: firegrid-no-inline-tagged-error-fail
const inlineTaggedFail = Effect.fail({ _tag: "InlineTaggedError", message: "boom" })

// ok: firegrid-no-inline-tagged-error-fail
class InlineTaggedError {
  readonly message = "boom"
}
const classTaggedFail = Effect.fail(new InlineTaggedError())

declare const taggedEvent: { readonly _tag: "A" | "B" }

// ruleid: firegrid-prefer-match-tag-over-switch
switch (taggedEvent._tag) {
  case "A":
    break
  case "B":
    break
}

// ok: firegrid-prefer-match-tag-over-switch
const matchedTaggedEvent = Match.value(taggedEvent).pipe(
  Match.tag("A", handleA),
  Match.exhaustive,
)

// ruleid: firegrid-no-promise-chain-in-effect-code
const chainedPromise = promise.then(value => value).catch(cause => cause)

// ok: firegrid-no-promise-chain-in-effect-code
const effectPromiseBoundary = Effect.tryPromise({
  try: () => promise,
  catch: cause => cause,
})

// ruleid: firegrid-tryPromise-single-await
const broadTryPromise = Effect.tryPromise({
  try: async () => {
    await promise
    await promise
  },
  catch: cause => cause,
})

// ok: firegrid-tryPromise-single-await
const focusedTryPromise = Effect.tryPromise({
  try: () => promise,
  catch: cause => cause,
})

// ruleid: firegrid-no-inline-stream-url-construction
const inlineRuntimeStream = `${ns}.firegrid.runtime`

// ruleid: firegrid-no-inline-stream-url-construction
const inlineIngressUrl = `${streamPrefix}/v1/stream/${ns}.firegrid.runtimeIngress`

// ruleid: firegrid-no-inline-stream-url-construction
const inlineDurableToolsHostStream = `${ns}.firegrid.host.${hostId}.durableTools`

// ok: firegrid-no-inline-stream-url-construction
const encodedStreamName = encodeURIComponent(ns)

// ruleid: firegrid-no-filesystem-in-runtime-package
const requiredFileSystem = FileSystem.FileSystem

// ok: firegrid-no-filesystem-in-runtime-package
const commandModule = Command

// ruleid: firegrid-no-host-id-env-authority
const hostIdConfig = Config.string("FIREGRID_HOST_ID")

// ruleid: firegrid-no-host-id-env-authority
const optionalHostIdConfig = Config.option(Config.string("FIREGRID_HOST_ID"))

// ruleid: firegrid-no-host-id-env-authority
const viteHostId = import.meta.env["VITE_FIREGRID_HOST_ID"]

// ok: firegrid-no-host-id-env-authority
const runtimeNamespaceConfig = Config.string("FIREGRID_RUNTIME_NAMESPACE")

// ruleid: firegrid-runtime-context-workflow-requires-local-authority
const directRuntimeContextWorkflowExecution = engine.execute(RuntimeContextWorkflow, {
  payload: { contextId: "ctx_123" },
})

// ok: firegrid-runtime-context-workflow-requires-local-authority
const otherWorkflowExecution = engine.execute(OtherWorkflow, {
  payload: {},
})

// ruleid: firegrid-no-unclassified-workflow-make
const operationShapedWorkflow = Workflow.make({
  name: "firegrid.operation-wrapper",
  payload: {},
  success: {},
})

declare const runtimeOutputTable: {
  readonly events: {
    readonly upsert: (row: unknown) => unknown
  }
}
type RuntimeIngressTable = {
  readonly Type: unknown
}
type RuntimeOutputTable = {
  readonly Type: unknown
}
type RuntimeControlPlaneTable = {
  readonly Type: unknown
}
type DurableToolsTable = {
  readonly Type: unknown
}

// ruleid: firegrid-runtime-owned-table-writes-use-authorities
const directRuntimeOutputWrite = runtimeOutputTable.events.upsert({})

type RuntimeSubscriberWithTableFacade = {
  // ruleid: firegrid-runtime-subscribers-transforms-no-table-facades, firegrid-runtime-no-table-type-parameters-outside-authorities
  readonly table: RuntimeIngressTable["Type"]
}

// ruleid: firegrid-no-random-durable-identity
const randomHostId = `host_${crypto.randomUUID()}`

// ruleid: firegrid-no-random-durable-identity
const randomWorkerId = `worker-${crypto.randomUUID()}`

// ok: firegrid-no-random-durable-identity
const randomHostSessionId = `hs_${crypto.randomUUID()}`

// ok: firegrid-no-random-durable-identity
const randomContextId = `ctx_${crypto.randomUUID()}`

// ruleid: firegrid-no-raw-stream-authority-string-schema
const rawStreamAuthoritySchema = Schema.String.pipe(streamAuthority)

// ok: firegrid-no-raw-stream-authority-string-schema
const validatedStreamAuthoritySchema = ValidatedStreamAuthoritySchema

// ruleid: firegrid-no-mutable-identity-let
let contextId = ""

// ok: firegrid-no-mutable-identity-let
const initializedContextId = "ctx_123"

// ruleid: firegrid-fire-and-forget-promise-uses-fork
void promise.then(value => value)

// ok: firegrid-fire-and-forget-promise-uses-fork
void detachedRun

const detachedPromiseInEffectSync = Effect.sync(() => {
  // ruleid: firegrid-no-detached-promise-in-effect-sync
  void promise.then(value => value).catch(cause => cause)
})

// ok: firegrid-no-detached-promise-in-effect-sync
const scopedPromiseBoundary = Effect.tryPromise({
  try: () => promise,
  catch: cause => cause,
})

// ruleid: firegrid-match-should-be-exhaustive
const nonExhaustiveMatch = Match.value(taggedEvent).pipe(
  Match.tag("A", handleA),
)

// ok: firegrid-match-should-be-exhaustive
const exhaustiveMatch = Match.value(taggedEvent).pipe(
  Match.tag("A", handleA),
  Match.exhaustive,
)

// ok: firegrid-match-should-be-exhaustive
const matchWithFallback = Match.value(taggedEvent).pipe(
  Match.tag("A", handleA),
  Match.orElse(fallback),
)

const mutableStateInEffect = Effect.gen(function* () {
  const map = new Map<string, string>()
  // ruleid: firegrid-mutable-state-in-effect-gen
  map.set("key", "value")
})

// ok: firegrid-mutable-state-in-effect-gen
const visibleMutableState = Effect.gen(function* () {
  const map = new Map<string, string>()
  yield* Effect.sync(() => map.set("key", "value"))
})

// ruleid: firegrid-factory-exported-contracts-use-schema
export interface FactoryRunStatusView {
  readonly factoryRunKey: string
}

// ruleid: firegrid-factory-exported-contracts-use-schema
export type FactoryPermissionRequest = {
  readonly permissionRequestId: string
}

// ok: firegrid-factory-exported-contracts-use-schema
interface InternalFactoryLayerOptions {
  readonly streamPrefix: string
}

declare const FactoryRunStatusViewSchema: unknown

// ok: firegrid-factory-exported-contracts-use-schema
export type SchemaBackedFactoryRunStatusView = Schema.Schema.Type<
  typeof FactoryRunStatusViewSchema
>

// firegrid-runtime-agent-event-pipeline.AUTHORITIES.10-.14

// ruleid: firegrid-runtime-no-exported-authority-singletons, firegrid-runtime-no-old-singleton-authority-tag-keys
export class RuntimeOutputJournal extends Context.Tag("@firegrid/runtime/RuntimeOutputJournal")<
  RuntimeOutputJournal,
  never
>() {
  static readonly writeEventTo = () => undefined
}

// ruleid: firegrid-runtime-no-exported-authority-singletons, firegrid-runtime-no-old-singleton-authority-tag-keys
export class RuntimeIngressAppender extends Context.Tag("@firegrid/runtime/RuntimeIngressAppender")<
  RuntimeIngressAppender,
  never
>() {}

// ruleid: firegrid-runtime-no-exported-authority-singletons, firegrid-runtime-no-old-singleton-authority-tag-keys
export class RuntimeIngressDeliveryTracker extends Context.Tag("@firegrid/runtime/RuntimeIngressDeliveryTracker")<
  RuntimeIngressDeliveryTracker,
  never
>() {}

// ruleid: firegrid-runtime-no-exported-authority-singletons, firegrid-runtime-no-old-singleton-authority-tag-keys
export class RuntimeControlPlaneRecorder extends Context.Tag("@firegrid/runtime/RuntimeControlPlaneRecorder")<
  RuntimeControlPlaneRecorder,
  never
>() {}

// ruleid: firegrid-runtime-no-exported-authority-singletons, firegrid-runtime-no-old-singleton-authority-tag-keys
export class DurableWaitStore extends Context.Tag("@firegrid/runtime/DurableWaitStore")<
  DurableWaitStore,
  never
>() {}

// ruleid: firegrid-runtime-no-exported-authority-singletons
export const RuntimeControlPlaneRecorder = {
  recordStartedTo: () => undefined,
} as const

// ok: firegrid-runtime-no-exported-authority-singletons
export class RuntimeEventAppendAndGet extends Context.Tag("@firegrid/runtime/RuntimeEventAppendAndGet")<
  RuntimeEventAppendAndGet,
  { readonly append: (row: unknown) => unknown }
>() {}

// ruleid: firegrid-runtime-no-custom-authority-wrapper-types
type RuntimeAuthorityCommandFixture = RuntimeAuthorityCommand<unknown, unknown>

// ruleid: firegrid-runtime-no-custom-authority-wrapper-types
type RuntimeAuthorityFixture = RuntimeAuthority<unknown, unknown>

// ruleid: firegrid-runtime-no-custom-authority-wrapper-types
type RuntimeAuthorityReadFixture = RuntimeAuthorityRead

// ruleid: firegrid-runtime-no-custom-authority-wrapper-types
type RuntimeAuthoritySinkFixture = RuntimeAuthoritySink<unknown, unknown>

// ok: firegrid-runtime-no-custom-authority-wrapper-types
type RuntimeEventAppendAndGetFixture = { readonly append: (row: unknown) => unknown }

declare const runtimeOutputJournal: {
  readonly append: (row: unknown) => unknown
}
declare const RuntimeOutputJournalStatic: {
  readonly writeEventTo: (table: unknown, row: unknown) => unknown
  readonly sources: (table: unknown) => unknown
}
declare const RuntimeIngressAppenderStatic: {
  readonly appendTo: (table: unknown, request: unknown) => unknown
  readonly sources: (table: unknown) => unknown
}
declare const RuntimeIngressDeliveryTrackerStatic: {
  readonly claimInputTo: (table: unknown, row: unknown) => unknown
}
declare const RuntimeControlPlaneRecorderStatic: {
  readonly recordStartedTo: (table: unknown, row: unknown) => unknown
}
declare const DurableWaitStoreStatic: {
  readonly findWaitIn: (table: unknown, key: unknown) => unknown
}
declare const table: unknown
declare const row: unknown
declare const request: unknown
declare const waitKey: unknown

// ruleid: firegrid-runtime-no-singleton-authority-specifiers
import { RuntimeOutputJournal as ImportedRuntimeOutputJournal } from "./runtime-output-journal.ts"

// ruleid: firegrid-runtime-no-singleton-authority-specifiers
export { RuntimeIngressAppender as ExportedRuntimeIngressAppender } from "./runtime-ingress-appender.ts"

// ruleid: firegrid-runtime-no-singleton-authority-specifiers
export { RuntimeIngressDeliveryTracker }

// ruleid: firegrid-runtime-no-singleton-authority-specifiers
import type { RuntimeControlPlaneRecorder as ImportedRuntimeControlPlaneRecorder } from "./runtime-control-plane-recorder.ts"

// ruleid: firegrid-runtime-no-singleton-authority-specifiers
export type { DurableWaitStore as ExportedDurableWaitStore } from "./durable-wait-store.ts"

// ok: firegrid-runtime-no-singleton-authority-specifiers
export { RuntimeEventAppendAndGet as ExportedRuntimeEventAppendAndGet } from "./runtime-output-journal.ts"

// ruleid: firegrid-runtime-no-second-durable-capability-provider
const duplicateOutputProvider = Layer.succeed(RuntimeAgentOutputSink, {})

// ruleid: firegrid-runtime-no-second-durable-capability-provider
const duplicateIngressProvider = Layer.effect(RuntimeIngressAppendAndGet, durableCapabilityEffect)

// ok: firegrid-runtime-no-second-durable-capability-provider
const nonDurableProvider = Layer.succeed(FiregridAgentToolContext, {})

type StaticSubscriberOptions = {
  // ruleid: firegrid-runtime-no-source-collection-handle-in-static-subscriber-contract
  readonly source: SourceCollectionHandle
}

// ok: firegrid-runtime-no-source-collection-handle-in-static-subscriber-contract
type StaticSubscriberStreamOptions = {
  readonly source: unknown
}

// ruleid: firegrid-runtime-host-no-direct-source-collection-registration
import { SourceCollections as ImportedSourceCollections } from "./source-registration.ts"

declare const SourceCollections: unknown
declare const sourceCollectionStreamHandle: (name: string, stream: unknown) => unknown

function* directHostSourceCollections() {
  // ruleid: firegrid-runtime-host-no-direct-source-collection-registration
  return yield* SourceCollections
}

// ruleid: firegrid-runtime-host-no-direct-source-collection-registration
const directHostSourceHandle = sourceCollectionStreamHandle("firegrid.runtime.events", {})

// ruleid: firegrid-runtime-no-host-internal-imports-outside-host
import { startRuntime as importedHostCommand } from "./host/commands.ts"

// ruleid: firegrid-runtime-no-host-internal-imports-outside-host
export { FiregridRuntimeHostLive as exportedHostLayer } from "./host/layers.ts"

// ruleid: firegrid-runtime-no-host-internal-imports-outside-host
import type { StartRuntimeOptions as ImportedHostInternalType } from "./host/types.ts"

// ok: firegrid-runtime-no-host-internal-imports-outside-host
import { startRuntime as importedHostBarrelCommand } from "./host/index.ts"

// ruleid: firegrid-runtime-no-runtime-errors-imports-outside-runtime
import { RuntimeContextError as ImportedRuntimeContextError } from "./runtime-errors.ts"

// ruleid: firegrid-runtime-no-runtime-errors-imports-outside-runtime
export { RuntimeIngressError as ExportedRuntimeIngressError } from "@firegrid/runtime/internal/runtime-errors"

// ok: firegrid-runtime-no-runtime-errors-imports-outside-runtime
import { RuntimeContextError as PublicRuntimeContextError } from "@firegrid/runtime"

const tableServiceBypass = Effect.gen(function* () {
  // ruleid: firegrid-runtime-no-table-service-yield-outside-providers
  const outputTable = yield* RuntimeOutputTable
  // ruleid: firegrid-runtime-no-table-service-yield-outside-providers
  const ingressTable = yield* RuntimeIngressTable
  // ruleid: firegrid-runtime-no-table-service-yield-outside-providers
  const controlPlaneTable = yield* RuntimeControlPlaneTable
  // ruleid: firegrid-runtime-no-table-service-yield-outside-providers
  const durableToolsTable = yield* DurableToolsTable
  return { outputTable, ingressTable, controlPlaneTable, durableToolsTable }
})

const capabilityServiceAccess = Effect.gen(function* () {
  // ok: firegrid-runtime-no-table-service-yield-outside-providers
  const outputSink = yield* RuntimeAgentOutputSink
  return outputSink
})

// ruleid: firegrid-runtime-no-authority-registry-surface
import { AuthorityRegistry } from "./registry.ts"

// ruleid: firegrid-runtime-no-authority-registry-surface
export { RuntimeAuthorityProviderRegistry }

// ruleid: firegrid-runtime-no-authority-registry-surface
const runtimeAuthorityRegistrySurface = AuthorityRegistry

// ok: firegrid-runtime-no-authority-registry-surface
const ordinaryRegistry = new Map()

// ruleid: firegrid-runtime-no-old-singleton-authority-tag-keys
export class OldRuntimeOutputJournalTag extends Context.Tag("@firegrid/runtime/RuntimeOutputJournal")<
  OldRuntimeOutputJournalTag,
  never
>() {}

// ruleid: firegrid-runtime-no-old-singleton-authority-tag-keys
export class OldIngressAppenderTag extends Context.Tag("@firegrid/runtime/RuntimeIngressAppender")<
  OldIngressAppenderTag,
  never
>() {}

// ok: firegrid-runtime-no-old-singleton-authority-tag-keys
export class NewRuntimeEventAppendAndGetTag extends Context.Tag("@firegrid/runtime/RuntimeEventAppendAndGet")<
  NewRuntimeEventAppendAndGetTag,
  never
>() {}

// ruleid: firegrid-runtime-no-authority-static-helper-calls
const staticOutputWrite = RuntimeOutputJournal.writeEventTo(table, row)

// ruleid: firegrid-runtime-no-authority-static-helper-calls
const staticSourceHandle = RuntimeIngressAppender.sources(table)

// ruleid: firegrid-runtime-no-authority-static-helper-calls
const staticDeliveryClaim = RuntimeIngressDeliveryTracker.claimInputTo(table, row)

// ruleid: firegrid-runtime-no-authority-static-helper-calls
const staticRunAppend = RuntimeControlPlaneRecorder.recordStartedTo(table, row)

// ruleid: firegrid-runtime-no-authority-static-helper-calls
const staticWaitRead = DurableWaitStore.findWaitIn(table, waitKey)

// ok: firegrid-runtime-no-authority-static-helper-calls
const capabilityAppend = runtimeOutputJournal.append(row)

type HostOwnedRuntimeTableOptions = {
  // ruleid: firegrid-runtime-subscribers-transforms-no-table-facades, firegrid-runtime-no-table-type-parameters-outside-authorities
  readonly output: RuntimeOutputTable["Type"]
  // ruleid: firegrid-runtime-subscribers-transforms-no-table-facades, firegrid-runtime-no-table-type-parameters-outside-authorities
  readonly controlPlane: RuntimeControlPlaneTable["Type"]
  // ruleid: firegrid-runtime-subscribers-transforms-no-table-facades, firegrid-runtime-no-table-type-parameters-outside-authorities
  readonly ingress: RuntimeIngressTable["Type"]
  // ruleid: firegrid-runtime-no-table-type-parameters-outside-authorities
  readonly waits: DurableToolsTable["Type"]
}

type HostOwnedRuntimeCapabilities = {
  // ok: firegrid-runtime-no-table-type-parameters-outside-authorities
  readonly outputEvents: unknown
}

// ruleid: firegrid-runtime-no-exported-authority-registry-api, firegrid-runtime-no-authority-registry-surface
export const RuntimeAuthorityRegistry = []

// ruleid: firegrid-runtime-no-exported-authority-registry-api, firegrid-runtime-no-authority-registry-surface
export const RuntimeAuthorityRegistryByCapabilityTag = new Map()

// ruleid: firegrid-runtime-no-exported-authority-registry-api, firegrid-runtime-no-authority-registry-surface
export const RuntimeAuthorityRegistryEntry = { capability: null as unknown }

// ok: firegrid-runtime-no-exported-authority-registry-api
const reviewOnlyProviderMap = []

export {
  broadTryPromise,
  chainedPromise,
  classTaggedFail,
  clockIso,
  clockMillis,
  dateNowIso,
  detachedRun,
  detachedPromiseInEffectSync,
  directIso,
  dynamicEnv,
  effectPromiseBoundary,
  encodedStreamName,
  exhaustiveMatch,
  focusedTryPromise,
  directRuntimeContextWorkflowExecution,
  directRuntimeOutputWrite,
  directHostSourceCollections,
  directHostSourceHandle,
  duplicateIngressProvider,
  duplicateOutputProvider,
  ExportedRuntimeIngressError,
  exportedHostLayer,
  globalDynamicEnv,
  globalEnv,
  inlineIngressUrl,
  inlineDurableToolsHostStream,
  inlineRuntimeStream,
  inlineTaggedFail,
  importedHostBarrelCommand,
  importedHostCommand,
  ImportedSourceCollections,
  ImportedRuntimeContextError,
  initializedContextId,
  matchedTaggedEvent,
  matchWithFallback,
  mutableStateInEffect,
  nonExhaustiveMatch,
  nonDurableProvider,
  ok1,
  ok2,
  otherWorkflowExecution,
  port,
  PublicRuntimeContextError,
  randomContextId,
  randomHostId,
  randomHostSessionId,
  randomWorkerId,
  rawStreamAuthoritySchema,
  scopedRun,
  scopedPromiseBoundary,
  tableServiceBypass,
  capabilityServiceAccess,
  url,
  validatedStreamAuthoritySchema,
  visibleMutableState,
  wallClockMillis,
  capabilityAppend,
  staticDeliveryClaim,
  staticOutputWrite,
  staticRunAppend,
  staticSourceHandle,
  staticWaitRead,
}

export type {
  HostOwnedRuntimeCapabilities,
  HostOwnedRuntimeTableOptions,
  ImportedHostInternalType,
  RuntimeSubscriberWithTableFacade,
  StaticSubscriberOptions,
  StaticSubscriberStreamOptions,
}

// tf-e49h: firegrid-no-replay-path-output-scan — replay-path live table scans.
// These shapes are forbidden inside a workflow body because the body re-runs on
// every @effect/workflow replay (tf-7kq8). Read through the durable output
// cursor or a memoized Activity instead.
function* tfE49hReplayPathOutputScanFixtures(): Generator<unknown, void, unknown> {
  // ruleid: firegrid-no-replay-path-output-scan
  const events = yield* RuntimeAgentOutputAfterEvents
  // ruleid: firegrid-no-replay-path-output-scan
  const materialized = someCollection.toArray
  // ruleid: firegrid-no-replay-path-output-scan
  const next = someTable.events.query((coll) => coll)
  // ok: firegrid-no-replay-path-output-scan
  const cursor = yield* DurableOutputCursor
  // ok: firegrid-no-replay-path-output-scan
  const memoized = yield* someMemoizedActivity
  return void [events, materialized, next, cursor, memoized]
}

// ===========================================================================
// tf-zchu: runtime design constraint guards (C4 / C6 / C7).
// docs/cannon/architecture/runtime-design-constraints.md
// ===========================================================================

// C4 — async waits are durable completions keyed by domain identity, not new
// per-sequence DurableDeferred mailboxes on RuntimeContext input/tool/
// permission/child-session paths. The existing input bridge is baselined.
function* tfZchuC4DurableDeferredFixtures(): Generator<unknown, void, unknown> {
  // ruleid: firegrid-c4-no-new-durable-deferred-runtime-wait
  const inputDeferred = DurableDeferred.make("input:ctx:1", {})
  // ruleid: firegrid-c4-no-new-durable-deferred-runtime-wait
  const arrived = yield* DurableDeferred.await(inputDeferred)
  // ok: firegrid-c4-no-new-durable-deferred-runtime-wait
  const completion = yield* durableCompletionFor("tool:ctx:tool-1")
  return void [inputDeferred, arrived, completion]
}

// C6 — agent-tool protocol schemas must not invent source-specific cursor /
// event-tag taxonomies or a parallel child-output read stack; reuse the
// router-backed SessionAgentOutputChannel schema. (Token literals live only on
// the annotated lines below, so this comment does not self-trigger the rule.)

// ruleid: firegrid-c6-no-source-specific-cursor-event-taxonomy-in-agent-tools
type ChildOutputReadProtocol = { readonly afterSequence: number }

function* tfZchuC6AgentToolSchemaFixtures(): Generator<unknown, void, unknown> {
  // ruleid: firegrid-c6-no-source-specific-cursor-event-taxonomy-in-agent-tools
  const readTool = "session_read"
  // ruleid: firegrid-c6-no-source-specific-cursor-event-taxonomy-in-agent-tools
  const cursorSchema = { cursor: Schema.Number }
  // ruleid: firegrid-c6-no-source-specific-cursor-event-taxonomy-in-agent-tools
  const eventTagSchema = { eventTag: Schema.String }
  // ok: firegrid-c6-no-source-specific-cursor-event-taxonomy-in-agent-tools
  const channelBackedMatch = { sequence: Schema.Number }
  return void [readTool, cursorSchema, eventTagSchema, channelBackedMatch]
}

// C7 — terminal prompt completion is durable runtime result state. A transport
// edge must not synthesize a terminal Done from raw TurnComplete; it observes
// the durable terminal fact or decodes a runtime-produced receipt.
function* tfZchuC7EdgeTerminalFixtures(): Generator<unknown, void, unknown> {
  // ruleid: firegrid-c7-no-edge-local-terminal-synthesis
  const synthesizedTerminal = { _tag: "Done", detail: "end_turn" }
  // ok: firegrid-c7-no-edge-local-terminal-synthesis
  const observedTerminal = someOutput._tag === "TurnComplete"
  return void [synthesizedTerminal, observedTerminal]
}

// ===========================================================================
// tf-1r0o: shape-aware drift guards for the Shape C RuntimeContext subscriber
// landing zone and the transforms purity rule.
// docs/cannon/architecture/runtime-pipeline-type-boundaries.md
// ===========================================================================

declare const Activity: { make: (options: unknown) => unknown }
declare const WorkflowEngineSuspend: { (instance: unknown): unknown }
declare const WorkflowEngineExecute: { (workflow: unknown, payload: unknown): unknown }
declare const instance: unknown
declare const someWorkflow: unknown
declare const somePayload: unknown
declare const store: { load: (k: string) => unknown; save: (k: string, v: unknown) => unknown }
declare const sampleRow: { sequence: number }

// Shape C — RuntimeContext subscriber `R` must not name workflow execution
// machinery. The visible signal is the WorkflowEngine namespace tags (engine
// and instance) appearing in R, typically via Activity construction or
// Workflow suspend or execute calls. A subscriber that grows those tags is a
// (parked, replaying) Shape D body. Move workflow-shaped work to
// tool-execution/ or a justified workflow-engine/workflows/ landing.
function* tfShapeCRuntimeContextNoWorkflowEngineFixtures(): Generator<unknown, void, unknown> {
  // ruleid: firegrid-shape-c-no-workflow-engine-in-runtime-context-subscriber
  const wrapped = Activity.make({ name: "noop", execute: undefined })
  // ruleid: firegrid-shape-c-no-workflow-engine-in-runtime-context-subscriber
  const parked = WorkflowEngineSuspend(instance) // analogue of `Workflow.suspend(instance)`
  // ruleid: firegrid-shape-c-no-workflow-engine-in-runtime-context-subscriber
  yield Workflow.suspend(instance)
  // ruleid: firegrid-shape-c-no-workflow-engine-in-runtime-context-subscriber
  yield Workflow.execute(someWorkflow, somePayload)
  // ruleid: firegrid-shape-c-no-workflow-engine-in-runtime-context-subscriber
  const engineTag = WorkflowEngine.WorkflowEngine
  // ruleid: firegrid-shape-c-no-workflow-engine-in-runtime-context-subscriber
  const instanceTag = WorkflowEngine.WorkflowInstance
  // ok: firegrid-shape-c-no-workflow-engine-in-runtime-context-subscriber
  const loaded = store.load("ctx-1")
  // ok: firegrid-shape-c-no-workflow-engine-in-runtime-context-subscriber
  const saved = store.save("ctx-1", loaded)
  return void [wrapped, parked, engineTag, instanceTag, loaded, saved]
}

