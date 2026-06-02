import { Args, Command, Options } from "@effect/cli"
import { NodeContext } from "@effect/platform-node"
import { Effect, Logger, Option } from "effect"
import { acpPermissionPolicies, defaultAcpPermissionPolicy } from "../sources/codecs/acp/stdio-edge.ts"
import { acpProgramFromOptions } from "./acp.ts"
import { hostProgramFromOptions } from "./host.ts"
import { resolveFiregridCliCwd } from "./_compose.ts"
import { runFiregridBinMain } from "./_main.ts"
import { runProgramFromOptions } from "./run.ts"
import type { AgentProcessCliOptions } from "./_agent-cli.ts"
import type { HostCliOptions } from "./host.ts"

const optionalValue = <A>(value: Option.Option<A>): A | undefined =>
  Option.getOrUndefined(value)

const resolveCwd = (cwd: string): string =>
  resolveFiregridCliCwd(cwd) ?? cwd

const agentProcessOptions = (
  input: {
    readonly agent: Option.Option<string>
    readonly agentProtocol: AgentProcessCliOptions["agentProtocol"]
    readonly secretEnv: ReadonlyArray<string>
    readonly cwd: Option.Option<string>
    readonly otelFile: Option.Option<string>
    readonly agentArgv: ReadonlyArray<string>
  },
): AgentProcessCliOptions => {
  const agentValue = optionalValue(input.agent)
  const cwdValue = optionalValue(input.cwd)
  const otelFileValue = optionalValue(input.otelFile)
  return {
    ...(agentValue === undefined ? {} : { agent: agentValue }),
    agentProtocol: input.agentProtocol,
    secretEnv: input.secretEnv,
    ...(cwdValue === undefined ? {} : { cwd: resolveCwd(cwdValue) }),
    ...(otelFileValue === undefined ? {} : { otelFile: otelFileValue }),
    agentArgv: input.agentArgv,
  }
}

const hostOptions = (
  input: {
    readonly namespace: Option.Option<string>
    readonly cwd: Option.Option<string>
    readonly otelFile: Option.Option<string>
    readonly mcpPort: Option.Option<number>
  },
): HostCliOptions => {
  const namespaceValue = optionalValue(input.namespace)
  const cwdValue = optionalValue(input.cwd)
  const otelFileValue = optionalValue(input.otelFile)
  const mcpPortValue = optionalValue(input.mcpPort)
  return {
    ...(namespaceValue === undefined ? {} : { namespace: namespaceValue }),
    ...(cwdValue === undefined ? {} : { cwd: resolveCwd(cwdValue) }),
    ...(otelFileValue === undefined ? {} : { otelFile: otelFileValue }),
    ...(mcpPortValue === undefined ? {} : { mcpPort: mcpPortValue }),
  }
}

const nonEmptyArgv = Args.text({ name: "agent-argv" }).pipe(Args.atLeast(1))

const agentOption = Options.text("agent").pipe(
  Options.withDescription("Opaque agent selector recorded in launch config."),
  Options.optional,
)

const agentProtocolOption = Options.choice("agent-protocol", [
  "raw",
  "stdio-jsonl",
  "acp",
] as const).pipe(
  Options.withDescription("Runtime codec used for the launched agent process."),
  Options.withDefault("acp" as const),
)

const acpAgentProtocolOption = Options.choice("agent-protocol", [
  "acp",
] as const).pipe(
  Options.withDescription("Runtime codec used for the launched agent process."),
  Options.withDefault("acp" as const),
)

const secretEnvOption = Options.text("secret-env").pipe(
  Options.withDescription("Authorize one host env var as NAME or NAME=HOST_ENV_NAME."),
  Options.atLeast(0),
)

const cwdOption = Options.text("cwd").pipe(
  Options.withDescription("Working directory for the launched agent process."),
  Options.optional,
)

const otelFileOption = Options.text("otel-file").pipe(
  Options.withDescription("Write OTel spans to this JSONL file."),
  Options.optional,
)

const promptOption = Options.text("prompt").pipe(
  Options.withDescription("Prompt text to append after starting the session."),
  Options.optional,
)

const permissionOption = Options.choice("permission", acpPermissionPolicies).pipe(
  Options.withDescription("ACP permission policy."),
  Options.withDefault(defaultAcpPermissionPolicy),
)

const namespaceOption = Options.text("namespace").pipe(
  Options.withDescription("Durable-streams namespace for this host."),
  Options.optional,
)

const mcpPortOption = Options.integer("mcp-port").pipe(
  Options.withDescription("Host runtime-context MCP server port; 0 selects an ephemeral port."),
  Options.optional,
)

const runCommand = Command.make(
  "run",
  {
    agent: agentOption,
    agentProtocol: agentProtocolOption,
    secretEnv: secretEnvOption,
    cwd: cwdOption,
    otelFile: otelFileOption,
    prompt: promptOption,
    agentArgv: nonEmptyArgv,
  },
  ({ agent, agentProtocol, secretEnv, cwd, otelFile, prompt, agentArgv }) => {
    const promptValue = optionalValue(prompt)
    return runProgramFromOptions({
      ...agentProcessOptions({ agent, agentProtocol, secretEnv, cwd, otelFile, agentArgv }),
      ...(promptValue === undefined ? {} : { prompt: promptValue }),
    }, true)
  },
)

const acpCommand = Command.make(
  "acp",
  {
    agent: agentOption,
    agentProtocol: acpAgentProtocolOption,
    secretEnv: secretEnvOption,
    cwd: cwdOption,
    otelFile: otelFileOption,
    permission: permissionOption,
    agentArgv: nonEmptyArgv,
  },
  ({ agent, agentProtocol, secretEnv, cwd, otelFile, permission, agentArgv }) => {
    return acpProgramFromOptions({
      ...agentProcessOptions({ agent, agentProtocol, secretEnv, cwd, otelFile, agentArgv }),
      permission,
    }).pipe(
      Effect.provide(Logger.replace(Logger.defaultLogger, Logger.none)),
    )
  },
)

const makeHostCommand = (name: "host" | "start") =>
  Command.make(
    name,
    {
      namespace: namespaceOption,
      cwd: cwdOption,
      otelFile: otelFileOption,
      mcpPort: mcpPortOption,
    },
    input => hostProgramFromOptions(hostOptions(input)),
  )

const hostCommand = makeHostCommand("host")
const startCommand = makeHostCommand("start")

const command = Command.make("firegrid", {}, () => Effect.void).pipe(
  Command.withSubcommands([
    acpCommand,
    hostCommand,
    runCommand,
    startCommand,
  ]),
)

const cli = Command.run(command, {
  name: "Firegrid",
  version: "0.0.0",
})

runFiregridBinMain(
  Effect.suspend(() => cli(process.argv)).pipe(
    Effect.provide(NodeContext.layer),
  ),
)
