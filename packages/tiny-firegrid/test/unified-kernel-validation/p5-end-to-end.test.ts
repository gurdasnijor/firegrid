/**
 * P5 — End-to-end + collapse-invariant assertions.
 *
 * Two halves:
 *
 *   1. An end-to-end driver that walks a realistic product flow
 *      through the unified kernel, exercising every capability:
 *      spawn → input → tool dispatch (Shape D) → permission roundtrip
 *      → scheduled prompt → webhook → peer event → terminal completion.
 *      Asserts each step lands a durable row in the appropriate
 *      UnifiedTable family.
 *
 *   2. Collapse-invariant assertions: read the simulation source to
 *      confirm none of the retired primitives appear. The simulation
 *      IS the empirical proof that the rebuild base needs only the
 *      three primitives.
 */

import { DurableStreamTestServer } from "@durable-streams/server"
import { durableStreamUrl } from "@firegrid/protocol/launch"
import type { WorkflowEngine } from "@effect/workflow"
import { Effect, Option, Ref } from "effect"
import { readFileSync, readdirSync, statSync } from "node:fs"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { appendInputIntent, ensureContext } from "../../src/simulations/unified-kernel-validation/input-append.ts"
import { kernelWriteArm } from "../../src/simulations/unified-kernel-validation/kernel.ts"
import {
  type GenerationUrls,
  makeCatalog,
  runGeneration,
} from "../../src/simulations/unified-kernel-validation/substrate.ts"
import {
  buildRuntimeContextSessionLayer,
  makeRuntimeContextRecorder,
  RuntimeContextSessionWorkflow,
} from "../../src/simulations/unified-kernel-validation/subscribers/runtime-context.ts"
import {
  buildPermissionRoundtripLayer,
  buildToolDispatchLayer,
  buildWaitForFactLayer,
  makeToolExecutor,
  PermissionRoundtripWorkflow,
  ToolDispatchWorkflow,
  WaitForFactWorkflow,
} from "../../src/simulations/unified-kernel-validation/subscribers/wait-permission-tool.ts"
import {
  buildScheduledPromptLayer,
  emitPeerEvent,
  ScheduledPromptWorkflow,
  verifyAndIngestWebhook,
} from "../../src/simulations/unified-kernel-validation/subscribers/scheduled-webhook-peer.ts"
import {
  peerEventKey,
  permissionKey,
  runKey,
  toolKey,
  webhookFactKey,
} from "../../src/simulations/unified-kernel-validation/tables.ts"

let server: DurableStreamTestServer | undefined
let baseUrl: string | undefined

beforeEach(async () => {
  server = new DurableStreamTestServer({ port: 0, host: "127.0.0.1" })
  baseUrl = await server.start()
})

afterEach(async () => {
  await server?.stop()
  server = undefined
  baseUrl = undefined
})

const buildUrls = (namespace: string): GenerationUrls => ({
  engineStreamUrl: durableStreamUrl(baseUrl!, `${namespace}.engine`),
  unifiedTableStreamUrl: durableStreamUrl(baseUrl!, `${namespace}.tables`),
  kernelTableStreamUrl: durableStreamUrl(baseUrl!, `${namespace}.kernel`),
})

const encoder = new TextEncoder()

const bytesToArrayBuffer = (bytes: Uint8Array): ArrayBuffer => {
  const copy = new Uint8Array(bytes.byteLength)
  copy.set(bytes)
  return copy.buffer
}

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")

const hmacSign = async (secret: string, rawBody: Uint8Array): Promise<string> => {
  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    bytesToArrayBuffer(encoder.encode(secret)),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const digest = await globalThis.crypto.subtle.sign("HMAC", key, bytesToArrayBuffer(rawBody))
  return bytesToHex(new Uint8Array(digest))
}

describe("P5 — end-to-end product flow over the unified kernel", () => {
  it("complete product surface in one driver: spawn → input → tool → permission → schedule → webhook → peer → terminal", async () => {
    const ns = `p5-e2e-${crypto.randomUUID()}`
    const urls = buildUrls(ns)
    const contextId = "ctx-e2e"
    const attempt = 1

    const outcome = await Effect.runPromise(
      Effect.gen(function*() {
        const recorder = yield* makeRuntimeContextRecorder()
        const toolExecutor = yield* makeToolExecutor(
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          (p) => JSON.stringify({ tool: p.toolName, echoed: JSON.parse(p.inputJson) }),
        )
        return yield* runGeneration(
          {
            urls,
            workflowLayers: [
              buildRuntimeContextSessionLayer(recorder),
              buildWaitForFactLayer(),
              buildPermissionRoundtripLayer(),
              buildToolDispatchLayer(toolExecutor),
              buildScheduledPromptLayer(),
            ],
            catalog: makeCatalog([
              RuntimeContextSessionWorkflow,
              WaitForFactWorkflow,
              PermissionRoundtripWorkflow,
              ToolDispatchWorkflow,
              ScheduledPromptWorkflow,
            ]),
          },
          (services) =>
            Effect.gen(function*() {
              // ── 1. Spawn the RuntimeContext session ──────────────
              yield* ensureContext({
                table: services.unified,
                contextId,
                agent: "e2e-agent",
              })
              const sessionExecutionId = yield* RuntimeContextSessionWorkflow.executionId({
                contextId,
                attempt,
                expectedInputs: 4,
              })
              const sessionFiber = yield* Effect.fork(
                RuntimeContextSessionWorkflow.execute({
                  contextId,
                  attempt,
                  expectedInputs: 4,
                }),
              )

              // ── 2. Input #1: prompt ─────────────────────────────
              yield* Effect.sleep("50 millis")
              const in1 = yield* appendInputIntent({
                table: services.unified,
                contextId,
                inputId: "prompt-1",
                kind: "prompt",
                payloadJson: JSON.stringify({ text: "hello" }),
              })
              yield* kernelWriteArm({
                kernel: services.kernel,
                workflow: RuntimeContextSessionWorkflow,
                executionId: sessionExecutionId,
                inputTable: "inputs",
                inputKey: in1.inputKey,
                write: () => Effect.void,
                value: { sequence: in1.sequence },
                serializeValue: (v) => JSON.stringify(v),
              })

              // ── 3. Tool dispatch (Shape D MCP-entry path) ───────
              const toolUseId = "tu-1"
              const toolResult = yield* (ToolDispatchWorkflow.execute({
                contextId,
                toolUseId,
                toolName: "echo",
                inputJson: JSON.stringify({ word: "hi" }),
              }) as Effect.Effect<unknown, unknown, WorkflowEngine.WorkflowEngine>) as Effect.Effect<
                { readonly toolUseId: string; readonly resultJson: string },
                unknown,
                WorkflowEngine.WorkflowEngine
              >
              const toolInvocations = yield* Ref.get(toolExecutor.state.invocationCount)

              // ── 4. Permission roundtrip ─────────────────────────
              const permissionRequestId = "perm-1"
              const permKey = permissionKey(contextId, permissionRequestId)
              const permExec = yield* PermissionRoundtripWorkflow.executionId({
                contextId,
                permissionRequestId,
                toolUseId,
              })
              const permFiber = yield* Effect.fork(
                PermissionRoundtripWorkflow.execute({
                  contextId,
                  permissionRequestId,
                  toolUseId,
                }),
              )
              yield* Effect.sleep("100 millis")
              const requestRow = yield* services.unified.permissions.get(permKey).pipe(
                Effect.map(Option.getOrUndefined),
              )
              yield* kernelWriteArm({
                kernel: services.kernel,
                workflow: PermissionRoundtripWorkflow,
                executionId: permExec,
                inputTable: "permissions",
                inputKey: permKey,
                write: () =>
                  services.unified.permissions.upsert({
                    permissionKey: permKey,
                    contextId,
                    permissionRequestId,
                    toolUseId,
                    status: "responded",
                    decisionJson: JSON.stringify("allow"),
                    requestedAt: requestRow!.requestedAt,
                    respondedAt: new Date().toISOString(),
                  }).pipe(Effect.orDie, Effect.asVoid),
                value: { decision: "allow" },
                serializeValue: (v) => JSON.stringify(v),
              })
              const permExit = yield* permFiber.await
              if (permExit._tag === "Failure") return yield* Effect.failCause(permExit.cause)
              const permResult = permExit.value as { readonly decision: string }

              // ── 5. Input #2: permission-response feeds back ─────
              const in2 = yield* appendInputIntent({
                table: services.unified,
                contextId,
                inputId: "perm-response-1",
                kind: "permission-response",
                payloadJson: JSON.stringify({ permissionRequestId, decision: permResult.decision }),
              })
              yield* kernelWriteArm({
                kernel: services.kernel,
                workflow: RuntimeContextSessionWorkflow,
                executionId: sessionExecutionId,
                inputTable: "inputs",
                inputKey: in2.inputKey,
                write: () => Effect.void,
                value: { sequence: in2.sequence },
                serializeValue: (v) => JSON.stringify(v),
              })

              // ── 6. Scheduled prompt (Shape D DurableClock) ──────
              const scheduleId = "sched-1"
              const schedResult = yield* (ScheduledPromptWorkflow.execute({
                contextId,
                scheduleId,
                fireAtMs: Date.now() + 100,
                payloadJson: JSON.stringify({ self_prompt: "wake" }),
              }) as Effect.Effect<unknown, unknown, WorkflowEngine.WorkflowEngine>) as Effect.Effect<
                { readonly firedAt: string },
                unknown,
                WorkflowEngine.WorkflowEngine
              >

              // ── 7. Webhook ingest (external adapter) ────────────
              const webhookSecret = "e2e-webhook-secret"
              const webhookSource = "linear"
              const deliveryId = "delivery-1"
              const webhookBody = encoder.encode(JSON.stringify({
                action: "create",
                type: "Issue",
                webhookId: deliveryId,
              }))
              const webhookSig = yield* Effect.promise(() =>
                hmacSign(webhookSecret, webhookBody))
              yield* verifyAndIngestWebhook({
                unified: services.unified,
                verify: {
                  source: webhookSource,
                  deliveryId,
                  eventType: "Issue.create",
                  secret: webhookSecret,
                  rawBody: webhookBody,
                  receivedSignatureHex: webhookSig,
                },
              })

              // ── 8. Peer event emit ──────────────────────────────
              const eventName = "plan.ready"
              const eventId = "ev-1"
              yield* emitPeerEvent({
                unified: services.unified,
                name: eventName,
                eventId,
                emitterContextId: contextId,
                payloadJson: JSON.stringify({ phase: "done" }),
              })

              // ── 9. Input #3: terminal ───────────────────────────
              const in3 = yield* appendInputIntent({
                table: services.unified,
                contextId,
                inputId: "terminal",
                kind: "terminal",
                payloadJson: JSON.stringify({ reason: "done" }),
              })
              // Need expectedInputs(4) inputs to terminate via count;
              // we have prompts 1,2 + terminal = 3. Add one more to fill.
              const in4 = yield* appendInputIntent({
                table: services.unified,
                contextId,
                inputId: "filler",
                kind: "prompt",
                payloadJson: JSON.stringify({ text: "filler" }),
              })
              yield* kernelWriteArm({
                kernel: services.kernel,
                workflow: RuntimeContextSessionWorkflow,
                executionId: sessionExecutionId,
                inputTable: "inputs",
                inputKey: in3.inputKey,
                write: () => Effect.void,
                value: { sequence: in3.sequence },
                serializeValue: (v) => JSON.stringify(v),
              })
              // Body terminates on first kind==="terminal"; filler not consumed.
              void in4

              const sessionExit = yield* sessionFiber.await
              if (sessionExit._tag === "Failure") return yield* Effect.failCause(sessionExit.cause)
              const sessionResult = sessionExit.value as {
                readonly inputsConsumed: number
                readonly reachedTerminal: boolean
              }

              // ── Final observations ──────────────────────────────
              const recordingSnapshot = yield* recorder.snapshot
              const runRow = yield* services.unified.runs.get(runKey(contextId, attempt)).pipe(
                Effect.map(Option.getOrUndefined),
              )
              const toolRow = yield* services.unified.toolResults.get(toolKey(contextId, toolUseId)).pipe(
                Effect.map(Option.getOrUndefined),
              )
              const webhookRow = yield* services.unified.webhookFacts.get(
                webhookFactKey(webhookSource, deliveryId),
              ).pipe(Effect.map(Option.getOrUndefined))
              const peerRow = yield* services.unified.peerEvents.get(
                peerEventKey(eventName, eventId),
              ).pipe(Effect.map(Option.getOrUndefined))

              return {
                runStatus: runRow?.status,
                spawnCount: recordingSnapshot.spawns.length,
                sendCount: recordingSnapshot.sends.length,
                toolResult: toolResult.resultJson,
                toolInvocations,
                permDecision: permResult.decision,
                scheduleFiredAt: schedResult.firedAt,
                webhookFactWritten: webhookRow !== undefined,
                peerFactWritten: peerRow !== undefined,
                sessionConsumed: sessionResult.inputsConsumed,
                sessionTerminal: sessionResult.reachedTerminal,
                toolRowExists: toolRow !== undefined,
              }
            }),
        )
      }),
    )

    // ── Assertions: every product surface settled durably ────────
    expect(outcome.runStatus).toBe("exited")
    expect(outcome.spawnCount).toBe(1)
    expect(outcome.sendCount).toBeGreaterThanOrEqual(3)
    expect(outcome.toolInvocations).toBe(1)
    expect(outcome.toolRowExists).toBe(true)
    expect(outcome.permDecision).toBe("allow")
    expect(outcome.scheduleFiredAt).toBeDefined()
    expect(outcome.webhookFactWritten).toBe(true)
    expect(outcome.peerFactWritten).toBe(true)
    expect(outcome.sessionTerminal).toBe(true)
  }, 30_000)
})

describe("P5 — collapse invariants (the simulation IS the proof)", () => {
  const simRoot = join(
    __dirname,
    "..",
    "..",
    "src",
    "simulations",
    "unified-kernel-validation",
  )

  /**
   * Strip line + block comments so the invariant assertions only flag
   * actual code uses (not "we don't do X" doc text).
   */
  const stripComments = (source: string): string => {
    // Remove /* ... */ block comments first (non-greedy).
    const noBlock = source.replace(/\/\*[\s\S]*?\*\//g, "")
    // Remove // line comments.
    return noBlock
      .split("\n")
      .map((line) => {
        const idx = line.indexOf("//")
        return idx === -1 ? line : line.slice(0, idx)
      })
      .join("\n")
  }

  const readAllSimFiles = (): ReadonlyArray<{ readonly path: string; readonly text: string }> => {
    const acc: Array<{ readonly path: string; readonly text: string }> = []
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry)
        const s = statSync(full)
        if (s.isDirectory()) walk(full)
        else if (entry.endsWith(".ts")) {
          acc.push({ path: full, text: stripComments(readFileSync(full, "utf8")) })
        }
      }
    }
    walk(simRoot)
    return acc
  }

  it("no Shape C `eventAlreadyProcessed` / sequence-gate dedup pattern", () => {
    const files = readAllSimFiles()
    const offenders = files.filter((f) =>
      /eventAlreadyProcessed/.test(f.text) ||
      /lastProcessedInputSequence/.test(f.text),
    )
    expect(offenders.map((f) => f.path)).toEqual([])
  })

  it("no `DurableDeferred` mailbox: subscribers don't park on engine deferreds for domain signals", () => {
    const files = readAllSimFiles()
    // DurableDeferred is allowed in the simulation only for test-contrast
    // workflows (none in production subscribers). The simulation source
    // tree under `subscribers/` MUST NOT reference it.
    const offenders = files.filter((f) =>
      f.path.includes("/subscribers/") && /DurableDeferred/.test(f.text),
    )
    expect(offenders.map((f) => f.path)).toEqual([])
  })

  it("no `appendRuntimeInputDeferred` / `RuntimeContextWorkflowRuntime` bridge", () => {
    const files = readAllSimFiles()
    const offenders = files.filter((f) =>
      /appendRuntimeInputDeferred/.test(f.text) ||
      /RuntimeContextWorkflowRuntime/.test(f.text),
    )
    expect(offenders.map((f) => f.path)).toEqual([])
  })

  it("no parallel `connectors/` or `ConnectorAdapter` primitive", () => {
    const files = readAllSimFiles()
    const offenders = files.filter((f) =>
      /ConnectorAdapter/.test(f.text) ||
      /\/connectors\//.test(f.text),
    )
    expect(offenders.map((f) => f.path)).toEqual([])
  })

  it("every subscriber body uses `Workflow.suspend` OR `DurableClock.sleep` to park — never a custom mailbox", () => {
    const files = readAllSimFiles().filter((f) => f.path.includes("/subscribers/"))
    for (const f of files) {
      const hasSuspendOrSleep =
        /Workflow\.suspend/.test(f.text) || /DurableClock\.sleep/.test(f.text)
      // Some subscriber files are pure helpers (no workflow body); skip those.
      const hasWorkflowMake = /Workflow\.make/.test(f.text)
      if (hasWorkflowMake) {
        expect.soft(hasSuspendOrSleep, `${f.path} should park via Workflow.suspend or DurableClock.sleep`).toBe(true)
      }
    }
  })

  it("idempotency for tool dispatch is via `Workflow.idempotencyKey`, not a separate result table", () => {
    const files = readAllSimFiles()
    const toolDispatch = files.find((f) => f.path.includes("wait-permission-tool.ts"))
    expect(toolDispatch).toBeDefined()
    expect(/idempotencyKey:\s*\(p\)\s*=>\s*p\.toolUseId/.test(toolDispatch!.text)).toBe(true)
    // No separate `RuntimeToolResultTable` / `runtimeToolResultAtMostOnce`.
    const offenders = files.filter((f) =>
      /RuntimeToolResultTable/.test(f.text) ||
      /runtimeToolResultAtMostOnce/.test(f.text),
    )
    expect(offenders.map((f) => f.path)).toEqual([])
  })

  it("the kernel is the ONLY wake authority: kernelWriteArm + replayPendingWriteArm are the surface", () => {
    const files = readAllSimFiles().filter((f) => f.path.includes("/subscribers/"))
    // Subscribers never call `engine.resume` or `Workflow.resume` directly —
    // only the kernel does.
    const offenders = files.filter((f) =>
      /engine\.resume/.test(f.text) || /Workflow\.resume/.test(f.text),
    )
    expect(offenders.map((f) => f.path)).toEqual([])
  })
})
