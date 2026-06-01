/**
 * Adapter divergence spike (RFC Phase 0 / docs/spikes/2026-05-31-adapter-divergence-spike.md).
 *
 * Drives a REAL foreign ACP adapter through Firegrid's EXISTING production codec
 * (`AcpSessionLive`) over the REAL `LocalProcessSandboxProvider` — the same two
 * Layers `ProductionCodecAdapterLive.buildSessionForContext` composes
 * (packages/runtime/src/unified/codec-adapter.ts:264-317). This is the airtight
 * "an acpx adapter is just an ACP subprocess Firegrid already speaks to" proof:
 * no hand-rolled ACP client, the actual codec maps the wire to AgentOutputEvent.
 *
 *   FIREGRID_SPIKE_ADAPTER=claude-agent-acp|codex-acp  node/tsx this file
 *
 * Requires ANTHROPIC_API_KEY (claude) / OPENAI_API_KEY (codex) in the host env;
 * the key is injected into the subprocess via SandboxCommand.envVars (the same
 * channel envBindings resolve onto).
 */
import { NodeContext } from "@effect/platform-node"
import { IdGenerator } from "@effect/ai"
import { Prompt } from "@effect/ai"
import { AcpSessionLive, AgentSession } from "@firegrid/runtime/sources/codecs"
import {
  LocalProcessSandboxProvider,
  SandboxProvider,
} from "@firegrid/runtime/sources/sandbox"
import type { AgentInputEvent, AgentOutputEvent } from "@firegrid/runtime/events"
import { Effect, Layer, Ref, Stream } from "effect"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const WT = "/Users/gnijor/gurdasnijor/firegrid/firegrid-worktrees/pr765-adapter-spike"
const ADAPTERS: Record<string, { argv: ReadonlyArray<string>; envKey: string }> = {
  "claude-agent-acp": {
    argv: [
      process.execPath,
      join(WT, "node_modules/.pnpm/@agentclientprotocol+claude-agent-acp@0.36.1_@anthropic-ai+sdk@0.97.1_zod@4.4.3__@model_b6d2333e11a1d0858a199bb549333483/node_modules/@agentclientprotocol/claude-agent-acp/dist/index.js"),
    ],
    envKey: "ANTHROPIC_API_KEY",
  },
  "codex-acp": {
    argv: [process.execPath, "/tmp/acp-adapters/node_modules/@agentclientprotocol/codex-acp/dist/index.js"],
    envKey: "OPENAI_API_KEY",
  },
}

const name = process.env["FIREGRID_SPIKE_ADAPTER"] ?? "claude-agent-acp"
const spec = ADAPTERS[name]
if (spec === undefined) throw new Error(`unknown adapter ${name}`)
const work = mkdtempSync(join(tmpdir(), "acp-spike-"))
const envVars: Record<string, string> = {
  PATH: process.env["PATH"] ?? "",
  HOME: process.env["HOME"] ?? "",
  [spec.envKey]: process.env[spec.envKey] ?? "",
}

const program = Effect.gen(function*() {
  const provider = yield* SandboxProvider
  const sandbox = yield* provider.create({ workingDir: work, envVars })
  const bytes = yield* provider.openBytePipe(sandbox, { argv: spec.argv, cwd: work, envVars })

  // The REAL production codec, bound to the REAL subprocess byte pipe.
  const codecCtx = yield* Layer.buildWithScope(
    AcpSessionLive(bytes, { cwd: work }).pipe(
      Layer.provide(Layer.succeed(IdGenerator.IdGenerator, IdGenerator.defaultIdGenerator)),
    ),
    yield* Effect.scope,
  )
  const session = codecCtx.unsafeMap.get(AgentSession.key) as AgentSession["Type"]

  yield* Effect.logInfo(`codec.meta.kind=${session.meta.kind} toolUseMode=${session.toolUseMode}`)

  const collected: Array<string> = []
  const consumer = yield* session.outputs.pipe(
    Stream.tap((e: AgentOutputEvent) =>
      Effect.sync(() => {
        const tag = e._tag
        const extra = tag === "TextChunk"
          ? ((e as { part?: { delta?: string } }).part?.delta ?? "")
          : tag === "TurnComplete"
            ? `finishReason=${(e as { finishReason?: string }).finishReason}`
            : ""
        collected.push(tag)
        process.stderr.write(`[out] ${tag} ${JSON.stringify(extra)}\n`)
      })
    ),
    Stream.takeUntil((e: AgentOutputEvent) => e._tag === "TurnComplete" || e._tag === "Terminated"),
    Stream.runDrain,
    Effect.timeout("90 seconds"),
    Effect.fork,
  )

  const prompt: AgentInputEvent = {
    _tag: "Prompt",
    prompt: Prompt.userMessage({ content: [Prompt.textPart({ text: "Reply with exactly the single word: PONG. Do not use any tools." })] }),
    correlationId: "spike-1",
  }
  yield* session.send(prompt)
  yield* consumer.await.pipe(Effect.ignore)

  // Cancellation probe through the codec's typed Cancel input.
  yield* session.send({ _tag: "Cancel" } as AgentInputEvent).pipe(Effect.ignore)

  yield* Effect.logInfo(`RESULT adapter=${name} sawTurnComplete=${collected.includes("TurnComplete")} tags=${JSON.stringify(collected)}`)
  return collected
})

const sandboxLayer = LocalProcessSandboxProvider.layer().pipe(Layer.provide(NodeContext.layer))

Effect.runPromise(
  program.pipe(Effect.scoped, Effect.provide(sandboxLayer)) as Effect.Effect<ReadonlyArray<string>, unknown, never>,
).then(
  (tags) => { console.log("OK", JSON.stringify(tags)); process.exit(0) },
  (err) => { console.error("FAIL", err?.message ?? err); process.exit(1) },
)
