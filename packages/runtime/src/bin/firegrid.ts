const usage = "Usage: firegrid <acp|run> [args...]"

const rawArgs = process.argv.slice(2)
const [command, ...args] = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs

switch (command) {
  case "acp": {
    const { runAcpMain } = await import("./acp.ts")
    runAcpMain(args)
    break
  }
  case "run": {
    const { runFiregridRunMain } = await import("./run.ts")
    runFiregridRunMain(args)
    break
  }
  case "--help":
  case "-h":
  case undefined:
    process.stderr.write(`${usage}\n`)
    process.exitCode = command === undefined ? 2 : 0
    break
  default:
    process.stderr.write(`unknown firegrid command: ${command}\n${usage}\n`)
    process.exitCode = 2
}

export {}
