import { Effect } from "effect"
import { SubstrateHost, SubstrateHostBoot } from "../src/index.ts"

// launchable-substrate-host.PACKAGING.4
// launchable-substrate-host.HOST_PROCESS.8
// launchable-substrate-host.HOST_CONFIGURATION.1
// launchable-substrate-host.HOST_CONFIGURATION.5
// launchable-substrate-host.NO_CONTROL_PLANE.1
//
// Read-only embedded Durable Streams attach point for dev / lab
// inspection. Boots an embedded DurableStreamTestServer through
// SubstrateHostBoot.embeddedDev with no Host Program Graph, prints
// the resolved stream URL, and blocks on Effect.never until the
// process is signalled.
//
// This is intentionally NOT a scenario runner:
//   - no `program: HostProgramGraph` is supplied;
//   - no client writes happen;
//   - no DurableWaits / blockRun / substrate row writes are
//     issued beyond the host pre-creating the substrate stream so
//     the lab inspector finds a valid endpoint.
//
// The fixed port (4437) and stream name ("lab") match the lab's
// browser default (`http://127.0.0.1:4437/substrate/lab`) so
// `pnpm --filter @durable-agent-substrate/lab dev` attaches with
// no env or query-string ceremony.
//
//   terminal 1: pnpm --filter @durable-agent-substrate/host dev:embedded
//   terminal 2: pnpm --filter @durable-agent-substrate/lab dev

const program = Effect.scoped(
  Effect.gen(function* () {
    const host = yield* SubstrateHost
    process.stdout.write(`${host.streamIdentity.streamUrl}\n`)
    process.stdout.write(
      "embedded Durable Streams ready; ctrl-c to stop\n",
    )
    yield* Effect.never
  }).pipe(
    Effect.provide(
      SubstrateHostBoot.embeddedDev({
        streamName: "lab",
        durableStreamsHost: "127.0.0.1",
        durableStreamsPort: 4437,
      }),
    ),
  ),
)

Effect.runPromise(program).catch((cause: unknown) => {
  process.stderr.write(
    `dev:embedded failed:\n${cause instanceof Error ? cause.stack ?? cause.message : String(cause)}\n`,
  )
  process.exit(1)
})
