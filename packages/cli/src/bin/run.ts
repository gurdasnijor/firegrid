const unsupported = [
  "firegrid run/start/acp launchers were removed with the unified host cutover.",
  "Use `pnpm firegrid:host` with DURABLE_STREAMS_BASE_URL and FIREGRID_RUNTIME_NAMESPACE.",
].join(" ")

process.stderr.write(`${unsupported}\n`)
process.exit(1)
