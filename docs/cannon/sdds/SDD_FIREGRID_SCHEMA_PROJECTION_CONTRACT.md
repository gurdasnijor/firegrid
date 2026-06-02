# SDD: Firegrid Schema Projection Contract

Status: Living contract — **refreshed for the unified kernel (post-#765)**. The
pre-cutover revision referenced `runtime/src/agent-tools/`, `packages/client`,
`src/run.ts`, and a `RuntimeInputIntent → DurableDeferred → RuntimeContextWorkflowSession.send`
input chain that no longer exist. This revision re-anchors the same contract on
the live tree and leans harder on Effect `Schema`'s native surface.

Related specs:

- `firegrid-schema-projection-contract`
- `firegrid-factory-aligned-agent-tools`
- `firegrid-local-mcp-run`

---

## Mental model (unchanged — this is the durable part)

```txt
protocol operation/observation/channel catalog        ← the product contract
  → bindings  (project the same contract to each surface)
       → agent-tool binding   (Effect AI Tool/Toolkit over MCP)
       → client-sdk binding   (browser/app-safe TypeScript)
       → CLI binding          (@effect/cli)
       → future REST / gRPC / JSON-RPC
  → execution (turns a validated call into Firegrid substrate effects)
```

The schema/channel catalog in `@firegrid/protocol` is the source of truth.
Tools, client APIs, the CLI, and future transports are **bindings** of that
catalog. Bindings may differ in names and transport; they must not define
different contracts. Execution is owned by the unified host, not by any binding.

This is deliberately **not** "agent tools → client API", "client API → agent
tools", or "a new service layer → everything." Every user-facing operation has
**one** schema-owned definition; each binding projects from it.

---

## Current realization (what is actually built)

| Layer | Lives in | State |
| --- | --- | --- |
| Operation/observation schemas | `@firegrid/protocol` — `agent-tools/`, `session-facade/`, `channels/` | source of truth ✓ |
| Projection metadata annotation | `protocol/src/projection/schema.ts` (`firegridProjection` / `getFiregridProjectionMetadata`) | realized ✓ |
| Agent-tool binding | `runtime/src/unified/mcp-host/toolkit.ts` (`Tool.make`/`Toolkit.make` → `ToolDispatch.call`) | realized ✓ |
| Client binding | `client-sdk/src/firegrid.ts` | realized; one boundary leak open (below) |
| Read-side observations | `protocol/src/session-facade/schema.ts` (`RuntimeAgentOutputObservationSchema`, a `Schema.Union`) | realized ✓ |
| Execution substrate | `runtime/src/unified/` — channel-bindings, `RuntimeContextSessionWorkflow`, `signal.ts`, `ToolDispatch` | realized ✓ |
| Boundary enforcement | `.dependency-cruiser.cjs` | largely realized ✓ |

The agent-tool binding already follows the target shape: a tool is **(a)** a
schema in `@firegrid/protocol/agent-tools`, **(b)** a `Tool.make(...)` in
`toolkit.ts` that reads its name/metadata from the schema's projection
annotation, **(c)** an entry in `Toolkit.make(...)`, and **(d)** a handler that
routes through `ToolDispatch.call` — so the binding never imports waits, host,
or workflow execution directly.

---

## Package-boundary graph (enforced)

```text
@firegrid/protocol           ← contract; no client/runtime imports
@firegrid/client-sdk         → protocol only (browser/app-safe)
@firegrid/host-sdk           → public host-composition surface (unified)
@firegrid/runtime            → execution substrate; not a binding
@firegrid/cli                → thin tsx launcher (see CLI SDD)
```

These are not review conventions — they are dep-cruiser rules today:
`client-sdk-no-runtime`, `runtime-no-client-sdk-or-cli`, `runtime-no-host-sdk`,
`host-sdk-public-composition-surface-only-unified`, `protocol-no-client-or-runtime`,
`client-sdk-no-broad-durable-streams-root`. New transports (REST/gRPC/JSON-RPC)
join as projection packages that import **protocol only** and delegate execution
to host/runtime composition — they never clone schemas or import a peer binding.

Note: there is no separate `@firegrid/agent-tools` package. The agent-tool
*schemas* live in `@firegrid/protocol/agent-tools`; the *binding* lives in the
host runtime (`runtime/src/unified/mcp-host`). The invariant that matters is the
import direction (binding ← protocol schemas; execution via `ToolDispatch`), not
the package count.

---

## Schema catalog — use Effect `Schema` natively

The catalog exposes operation-shaped schema entries whose metadata lives on the
**AST annotations**, read by bindings. Lean on `repos/effect/packages/effect/src/Schema.ts`
instead of inventing wrappers:

- **Metadata** — `Schema.annotations` (`Schema.ts:4190`): `identifier`, `title`,
  `description`, `examples`, plus the one Firegrid custom annotation
  (`firegridProjection({ operationId, toolName?, clientName?, cliName? })`).
- **Row → observation / id conversions** — `Schema.transform` /
  `Schema.transformOrFail` (`3940` / `3831`): a durable row → public observation
  is a *transform*, not a hand-written parser.
- **Narrower public views** — `Schema.pick` / `Schema.omit` / `Schema.pluck`
  (`3068` / `3077` / `3112`): derive a public view from a richer durable/provider
  row instead of redefining it.
- **Encoded vs decoded** — `Schema.encodedSchema` / `Schema.typeSchema`
  (`396` / `415`) for transport vs in-memory shapes.
- **Unions / tags** — `Schema.Union` (`1257`), `Schema.TaggedStruct` (`3009`),
  `Schema.TaggedClass` (`8744`) for observation/event families.
- **JSON envelopes** — `Schema.parseJson` (`4845`) for the JSON-encoded signal /
  payload envelopes (already used in `signal.ts` / `runtime-context.ts`).
- **Composition** — `Schema.extend` (`3506`) to compose without copying fields.

Each operation is a plain grouping read from the schemas — **not** a descriptor
object:

```ts
export const SessionCreateOrLoad = {
  input: SessionCreateOrLoadInputSchema,   // carries firegridProjection annotation
  output: SessionHandleReferenceSchema,
} as const
```

Bindings read names/help/examples from `SessionCreateOrLoad.input.ast.annotations`
(Effect's annotation ids + `getFiregridProjectionMetadata`). They do **not**
depend on a `FiregridOperationEntry` / `defineFiregridOperation` wrapper.

> **Open cleanup:** `protocol/src/operations/schema.ts` still exports the
> transitional `FiregridOperationEntry` / `defineFiregridOperation` wrapper. The
> good path (`projection/schema.ts` annotation, read via
> `getFiregridProjectionMetadata`) is already what `toolkit.ts` uses; the wrapper
> should be removed and any callers migrated to plain groupings + annotations.

---

## Agent-tool binding (realized)

`runtime/src/unified/mcp-host/toolkit.ts` projects each
`@firegrid/protocol/agent-tools` schema into a `Tool.make(...)`, collects them in
`Toolkit.make(...)` (`FiregridAgentToolkit`), and routes execution through the
`ToolDispatch` facade (`toolkit-layer.ts` → `ToolDispatchWorkflow`). Keep this
split intact: the `Tool`/`Toolkit` values must not import waits, host, or the
workflow engine — only schemas + the dispatch tag.

---

## Client binding (realized; one leak open)

`client-sdk/src/firegrid.ts` projects protocol session-facade schemas into the
session facade (`firegrid.sessions.createOrLoad`, `session.start`,
`session.prompt`, `session.wait.*`, `session.permissions.respond`). It is
browser-safe (protocol-only imports, enforced by `client-sdk-no-runtime`).

> **Open boundary gap (tf-ll90.8.3):** the client still resolves
> `RuntimeControlPlaneTable` and builds `RuntimeOutputTable.layer(...)` directly
> for reads. That is a durable-table *facade* used as the caller path, which this
> contract forbids ("projection packages do not expose durable table facades or
> workflow/runtime coordinates as the caller-facing way to launch/prompt/wait/
> observe"). Writes already dispatch through protocol-owned channels; the read
> path should likewise route through a protocol-owned read capability/observation
> source rather than the table tags.

---

## Read binding (realized)

Operation schemas project into methods; observation schemas project into
snapshots, streams, and waits. `RuntimeAgentOutputObservationSchema` (a
`Schema.Union` in `protocol/src/session-facade/schema.ts`) is protocol-owned, and
the client projects runtime output rows into it (`runtimeAgentOutputObservationFromRow`).
Prefer expressing that row→observation projection as a `Schema.transform` so the
boundary is a schema, not a bespoke decoder.

No product app should ever `JSON.parse(row.raw)` or decode
`AgentOutputEventSchema` itself; it reads `session.snapshot().agentOutputs` and
`session.wait.forAgentOutput(...)`.

---

## Input boundary (re-anchored on the signal primitive)

The pre-cutover `RuntimeInputIntent → host dispatcher → DurableDeferred
completion → RuntimeContextWorkflowSession.send` chain is **superseded**. The
live path is the signal primitive:

```text
client method (sessions.prompt / createOrLoad / start / cancel)
  → protocol-owned channel call (HostSessions*/SessionPrompt/HostPrompt channels)
  → host channel-binding appends a row to the durable SignalTable + arms the
    RuntimeContextSessionWorkflow (armSession: create-or-resume)
  → the workflow body reads its own signals in order and forwards each to
    adapter.send  (the single writer of runtime input)
```

`SignalTable` is the durable input log; `armSession` is the create-or-resume; the
workflow is the single writer. The client writes **intent over a channel**, never
runtime-owned state.

> **Open cleanup:** `RuntimeIngressTable` / `RuntimeInputIntent` (≈5 files) and
> `DurableDeferred` (≈3 files) still have residual references. The doc asserts
> these are deleted; reconcile by GC-ing the residuals (or, if any are still
> load-bearing, documenting why).

---

## CLI binding

The CLI launchers (`run` / `acp` / `start`) were deleted in #765 and are being
rebuilt — see **`docs/sdds/SDD_FIREGRID_CLI_LAUNCHERS.md`**. This contract adds
one rule to that work: the CLI's *binding* half (`@effect/cli` `Command`/`Options`,
help, examples, defaults, validation) projects from the protocol schema catalog
and the `firegridProjection` `cliName` metadata; the *execution* half (Node,
embedded durable-streams, host composition, MCP startup) stays runtime-side. A
binding file serializes schemas; an execution file performs effects; no file does
both.

---

## Boundary rules

- Protocol schema/observation/channel catalog is the source of truth.
- Agent tools and client APIs are **bindings**, not the programmer contract.
- Client snapshots/waits return normalized protocol observations.
- Common execution is the unified host; introduce shared execution helpers only
  where bindings share identical substrate semantics.
- Projection packages import protocol only — not runtime, not a peer binding
  (enforced by dep-cruiser).
- The client does not write runtime-owned state, nor read durable-table facades,
  as its caller-facing path.
- Do not split `@firegrid/client-sdk` into many packages; do not publish one
  package mixing browser client, Node CLI, MCP/Effect-AI tooling, and runtime.
- Do not reintroduce a `defineFiregridOperation` / `FiregridOperationEntry`
  descriptor as the contract source of truth — annotations + plain groupings only.

---

## Open slices (the gap between this contract and the tree)

1. Remove the `protocol/src/operations/schema.ts` `FiregridOperationEntry` /
   `defineFiregridOperation` wrapper; migrate callers to plain `{ input, output }`
   groupings read via Effect annotations + `getFiregridProjectionMetadata`.
2. Close the client read-path leak (tf-ll90.8.3): route reads through a
   protocol-owned read capability/observation source, not `RuntimeControlPlaneTable`
   / `RuntimeOutputTable.layer` facades.
3. GC the `RuntimeIngressTable` / `RuntimeInputIntent` / `DurableDeferred`
   residuals, or document why any survive.
4. Rebuild the CLI binding per the CLI SDD, projecting flags/help from schema
   metadata.
5. Express row→observation and id conversions as `Schema.transform` projections
   where they are currently hand-written.

Each is independently shippable; none requires the old "transactional, all
bindings at once" cutover, because the binding/execution split already exists.
