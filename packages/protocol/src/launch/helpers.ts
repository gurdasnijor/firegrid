import type {
  PublicLaunchRuntimeIntent,
  RuntimeContextIntent,
  RuntimeConfig,
  RuntimeJournalRule,
} from "./schema.ts"

const normalizeRuntimeConfig = (config: RuntimeConfig): RuntimeConfig => ({
  argv: [...config.argv],
  ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
})

export const localJsonlJournal = [
  { source: "stdout", format: "jsonl", target: "events" },
  { source: "stderr", format: "text-lines", target: "logs" },
] satisfies ReadonlyArray<RuntimeJournalRule>

export const normalizeRuntimeIntent = (
  runtime: PublicLaunchRuntimeIntent,
): RuntimeContextIntent => ({
  provider: runtime.provider,
  config: normalizeRuntimeConfig(runtime.config),
  // firegrid-durable-launch-runtime-operator.LAUNCH_ROWS.8
  journal: [...localJsonlJournal],
})

export const local = {
  jsonl: (config: RuntimeConfig): PublicLaunchRuntimeIntent => ({
    provider: "local-process",
    config: normalizeRuntimeConfig(config),
  }),
}
