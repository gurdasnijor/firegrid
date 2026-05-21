import { Firegrid, local } from "@firegrid/client-sdk/firegrid"
import { Effect } from "effect"
import {
  agenticPatternsExternalKey,
  agenticPatternsPrimitiveToolNames,
} from "./profile.ts"

interface AgenticPatternsPrimitiveProfileArtifact {
  readonly profile: "agentic-patterns.primitive"
  readonly contextId: string
  readonly launchPath: "firegrid.sessions.createOrLoad.prompt.start"
  readonly runtimeContextMcp: "enabled"
  readonly toolAllowlist: ReadonlyArray<string>
}

export const agenticPatternsPrimitiveProfileDriver: Effect.Effect<
  AgenticPatternsPrimitiveProfileArtifact,
  unknown,
  Firegrid
> =
  Effect.gen(function*() {
    const firegrid = yield* Firegrid
    const session = yield* firegrid.sessions.createOrLoad({
      externalKey: agenticPatternsExternalKey("primitive-profile"),
      createdBy: "tf-t47b.agentic-patterns-primitive-profile",
      runtime: local.jsonl({
        argv: [
          globalThis.process.execPath,
          "--version",
        ],
        agentProtocol: "stdio-jsonl",
        runtimeContextMcp: { enabled: true },
      }),
    })

    // tf-2osu: no explicit whenReady — session.prompt/session.start own the
    // bounded reflected-context barrier (tf-1r3h #587).
    yield* session.prompt({
      payload: "tf-t47b primitive profile launch smoke",
      idempotencyKey: "tf-t47b:agentic-patterns-primitive-profile",
    })
    yield* session.start()

    return {
      profile: "agentic-patterns.primitive",
      contextId: session.contextId,
      launchPath: "firegrid.sessions.createOrLoad.prompt.start",
      runtimeContextMcp: "enabled",
      toolAllowlist: agenticPatternsPrimitiveToolNames,
    }
  })
