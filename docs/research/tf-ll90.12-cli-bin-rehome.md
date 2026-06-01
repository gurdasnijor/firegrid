# tf-ll90.12 CLI/bin re-home finding

Status: implementation note for the unified-kernel stabilization branch.

## CLI/bin shape

`docs/architecture/2026-05-31-unified-architecture-mental-model.md` Q3
lists three possible post-`runtime/src/bin` shapes: no bins, minimal
`firegrid host`, or full bin reconstruction. The implementation here chooses
the minimal host shape, aligned with:

- `firegrid-runtime-process.BINARIES.10`
- `firegrid-runtime-process.BINARIES.11`
- `firegrid-runtime-process.BINARIES.12`
- `firegrid-runtime-process.EFFECT_PLATFORM.1`
- `firegrid-runtime-process.EFFECT_PLATFORM.2`
- `firegrid-runtime-process.CONFIG_SURFACE.1`

`packages/runtime/src/bin/host.ts` is the runtime-owned process-composition
entrypoint. It reads `DURABLE_STREAMS_BASE_URL` and
`FIREGRID_RUNTIME_NAMESPACE` at the process edge, composes
`FiregridHost({ codec: "acp", ... })`, launches the Layer, and parks.
`@firegrid/cli` stays a thin subprocess launcher so `cli-no-runtime` remains
load-bearing.

The deleted `run` / `start` / `acp` behavior is not reconstructed in this
slice. `packages/cli/src/bin/run.ts` is fail-loud scaffolding-only, and the
root package exposes `pnpm firegrid:host` as the single live host command.

## Host SDK decision

`packages/host-sdk/src/index.ts` is currently `export {}`. Recommendation:
delete or formally deprecate `@firegrid/host-sdk` rather than refill it in this
slice. The active host composition surface is `@firegrid/runtime/unified`
(`FiregridHost`), and refilling host-sdk risks reintroducing the package
boundary that the delete-first cutover intentionally emptied.

This recommendation is parked for Gurdas; this slice does not delete the
package.

## R10 / R12 confirmation

R10 is confirmed outside this slice: `packages/runtime/src/unified/subscribers/runtime-context.ts`
still uses `Effect.orDie` around signal reads, payload decoding, adapter sends,
deregister, and the workflow Layer composition. That malformed-input fail-fast
behavior is not changed here because it is unified workflow behavior.

R12 is confirmed outside this slice: `RuntimeControlPlaneTable.runs` still has
readers in `packages/runtime/src/channels/host-control.ts`,
`packages/runtime/src/channels/session-self/live.ts`, and
`packages/client-sdk/src/firegrid.ts`; grep found no production writer for the
`runs` family. That half-cutover remains a separate table/read-side decision.
