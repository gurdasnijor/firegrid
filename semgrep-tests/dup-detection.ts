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
declare const Schema: {
  String: {
    pipe: (annotation: unknown) => unknown
  }
}
declare const runtime: unknown
declare const effect: unknown
declare const promise: Promise<unknown>
declare const ns: string
declare const streamPrefix: string
declare const hostId: string
declare const handleA: (value: unknown) => unknown
declare const fallback: (value: unknown) => unknown
declare const engine: {
  execute: (workflow: unknown, options: unknown) => unknown
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

declare const runtimeOutputTable: {
  readonly events: {
    readonly upsert: (row: unknown) => unknown
  }
}
type RuntimeIngressTable = {
  readonly Type: unknown
}

// ruleid: firegrid-runtime-owned-table-writes-use-authorities
const directRuntimeOutputWrite = runtimeOutputTable.events.upsert({})

type RuntimeSubscriberWithTableFacade = {
  // ruleid: firegrid-runtime-subscribers-transforms-no-table-facades
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
  globalDynamicEnv,
  globalEnv,
  inlineIngressUrl,
  inlineDurableToolsHostStream,
  inlineRuntimeStream,
  inlineTaggedFail,
  initializedContextId,
  matchedTaggedEvent,
  matchWithFallback,
  mutableStateInEffect,
  nonExhaustiveMatch,
  ok1,
  ok2,
  otherWorkflowExecution,
  port,
  randomContextId,
  randomHostId,
  randomHostSessionId,
  randomWorkerId,
  rawStreamAuthoritySchema,
  scopedRun,
  scopedPromiseBoundary,
  url,
  validatedStreamAuthoritySchema,
  visibleMutableState,
  wallClockMillis,
}

export type {
  RuntimeSubscriberWithTableFacade,
}
