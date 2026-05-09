import type {
  LaunchJournalRule,
  LaunchRuntimeIntent,
  PublicLaunchRuntimeIntent,
  RuntimeConfig,
} from "./schema.ts"

const normalizeRuntimeConfig = (config: RuntimeConfig): RuntimeConfig => ({
  argv: [...config.argv],
  ...(config.cwd === undefined ? {} : { cwd: config.cwd }),
})

export const localJsonlJournal = [
  { source: "stdout", format: "jsonl", stream: "provider-wire" },
  { source: "stderr", format: "text-lines", stream: "diagnostics" },
] satisfies ReadonlyArray<LaunchJournalRule>

export const normalizeRuntimeIntent = (
  runtime: PublicLaunchRuntimeIntent,
): LaunchRuntimeIntent => ({
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
