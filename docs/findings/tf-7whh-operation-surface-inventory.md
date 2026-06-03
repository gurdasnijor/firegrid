# tf-7whh — Operation × surface inventory: findings

**Status:** evidence only. No consolidation, no codegen, no redesign proposed.
**Artifacts (machine-generated, re-run with `pnpm inventory:operations`):**
- `docs/findings/tf-7whh-operation-inventory.md` — the operation × surface matrix + per-surface tables (every cell a `file:line`).
- `docs/findings/tf-7whh-operation-inventory.json` — the same data, machine-readable.
- `scripts/operation-inventory.ts` — the tool.

This note interprets those artifacts. Every claim cites a `file:line` from them. Where a
cross-surface join is an inference rather than a literal equality, it is labelled as such.

## Approach (what the tool actually does)

Hybrid, chosen because the surfaces declare operations two structurally different ways:

1. **Runtime reflection** for the `firegridProjection`-annotated surfaces (agent-tools,
   session-facade). The tool imports the schema catalogs and reads each schema's annotation
   via `getFiregridProjectionMetadata` (`packages/protocol/src/projection/schema.ts:21`).
   This captures the **resolved** `{operationId, toolName, clientName, cliName}` exactly as
   it lands on the AST — the most accurate source, and immune to export-name conventions.
2. **TypeScript-compiler-API AST** for `file:line` anchors and for the **channel** surface,
   which does *not* use `firegridProjection`. Channels author via `makeChannelTarget` +
   `make*Channel({ target, requestSchema, responseSchema, schema })`. Channel-target
   identifiers are resolved to their string values by reflecting the protocol channels barrel.

Cross-surface joins (the matrix rows) are heuristic and carry a `basis`; every unmatched
declaration and orphan target is reported so nothing is silently merged or dropped. No new
dependency was added (the tool uses `typescript`, already present; not `ts-morph`, which #862
removed).

> One reflection finding worth recording about the method itself: a first cut pre-filtered
> agent-tool exports by the name convention `*ToolInputSchema`. That **undercounted** —
> `PermissionRespondInputSchema` (`agent-tools/schema.ts:742`) and `SessionStatusInputSchema`
> (`:557`) carry projection but don't match the convention. The tool now enumerates *all*
> schema-like exports and trusts the annotation, not the name. (The count is not the truth.)

## 1. How many distinct operations

| Surface | Count | Source |
| --- | --- | --- |
| Agent-tool operations (projection-bearing input schemas) | **15** | matrix §2 |
| Session-facade operations (projection `operationId`) | **6** | matrix §3 |
| Agent-output emitted events (`Schema.TaggedStruct`, egress) | **9** | matrix §4 |
| Channel targets declared (`makeChannelTarget`) | **14** | matrix §5 |
| Channel registrations (`make*Channel`) | **23** | matrix §6 |
| **Distinct canonical operations (request/response + facade + channel)** | **19** | matrix §1 |

The 9 agent-output events are a distinct *egress notification* catalog (Ready / TextChunk /
ToolUse / PermissionRequest / TurnComplete / Status / Error / Terminated + the
forward-compat `AgentOutputUnknown`), not request/response operations, so they are inventoried
separately rather than folded into the 19 operation rows.

## 2. Which operations appear in multiple surfaces (duplication)

Six canonical operations are declared independently on more than one surface (matrix §1,
`Surfaces` column). This is the duplication the task set out to make visible — the same
operation authored 2–3× with no shared registry:

| Operation | Agent tool | Session facade | Channel | Surfaces |
| --- | --- | --- | --- | --- |
| `session.prompt` | `session_prompt` / `sessions.prompt` / `sessions prompt` (`agent-tools/schema.ts:516`) | `session.prompt.scoped` (`session-facade/schema.ts:118`) | `host.prompt` **+** `session.prompt` (two registrations) | **3** |
| `permission.respond` | `permissions.respond` (`agent-tools/schema.ts:742`) | `permission.respond.scoped` (`session-facade/schema.ts:190`) | `host.permissions.respond` | **3** |
| `session.cancel` | `session_cancel` (`agent-tools/schema.ts:578`) | — | `session.cancel` | 2 |
| `session.close` | `session_close` (`agent-tools/schema.ts:608`) | — | `session.close` | 2 |
| `session.createOrLoad` | — | `session.createOrLoad` (`session-facade/schema.ts:54`) | `host.sessions.create_or_load` | 2 |
| `session.wait.forAgentOutput` | — | `session.wait.forAgentOutput` (`session-facade/schema.ts:171`) | `session.agent_output` | 2 |

Notes on the inferred joins (these are equalities the tool asserts, not literal string matches):
- `permission.respond` ↔ `permission.respond.scoped` ↔ channel `host.permissions.respond`:
  the facade strips the `.scoped` suffix; the channel target is aliased. **High confidence.**
- `session.wait.forAgentOutput` ↔ channel `session.agent_output`: the facade wait operation
  reads the agent-output channel. **Inference** (named differently; same operation by intent).
- `session.prompt` aggregates **two** channel registrations against **different** targets
  (`host.prompt`, `session.prompt`) — see §4 below; both are self-labelled *stub* channels.

## 3. Which operations are surface-orphans (drift)

**Agent-tool-only** (no facade, no channel): `sleep`, `wait.for`, `wait.until`, `wait.any`,
`channel.send`, `channel.call`, `capability.execute`, `session.spawn`, `session.spawnAll`,
`session.create`, `session.status`. (matrix §1, "single-surface (agent-tool)")

**Session-facade-only**: `session.attach` (`session-facade/schema.ts:76`),
`session.wait.forPermissionRequest` (`:152`). (matrix §1, "single-surface (session-facade)")

**Channel-only** (a target/registration with no agent-tool or facade counterpart — matrix §7):
`host.contexts.create` (callable, `host-control.ts:77`), `host.sessions.start`
(`channel-bindings.ts:170`), `session.lifecycle` (`host-control.ts:139`),
`session.self.lifecycle` (`session-self/live.ts:60`), plus the dynamic-target ingress channels
(`state-changes`, `event-channel`, `session-log`, two `verified-webhook` source bindings).

**Orphan channel target — declared, never registered** (matrix §8):
`session.permissions.respond` / `SessionPermissionChannelTarget`
(`packages/protocol/src/channels/session-permission.ts:12`). A target const exists but no
`make*Channel` binds it. Note that `permission.respond` *is* served by a different target
(`host.permissions.respond`), so this is a second, unbound spelling of the same concept.

**Schema diagnostics** (matrix §9): `LegacyExecuteToolInputSchema` and
`SessionExecuteToolInputSchema` are named like input ops but carry no projection — either
intentionally un-surfaced shims or a gap; flagged for a human, not asserted as either.

## 4. Drift signal in the unified channel bindings (`as never` stub channels)

The two `session.prompt` channel registrations are **self-labelled stub channels** that bind
the *wrong* request schema via `as never`:

- `host.prompt` durable-event channel → `schema: HostContextsCreateRequestSchema as never`
  (`packages/runtime/src/unified/channel-bindings.ts:130` and again at `:311`).
- `session.prompt` durable-event channel → `schema: HostSessionsCreateOrLoadRequestSchema as never`
  (`channel-bindings.ts:152` and again at `:339`).

The inline comments at `channel-bindings.ts:127` and `:149` say "stub channel: the generic
`makeDurableEventChannel` return cannot be narrowed". So a *prompt* channel is typed against a
*create* / *create-or-load* request schema. Several targets are also registered **twice**
(e.g. `host.permissions.respond` at `:212` and `:413`; `session.cancel` at `:184` and `:365`;
`session.close` at `:198` and `:384`). This is concrete evidence that the unified bindings are
templated placeholders rather than per-operation-typed routes.

## 5. Is `firegridProjection` the consolidation seam?

Ground-truth observation (not a recommendation):

- `firegridProjection` **already reaches 2 of the 3 operation-declaring surfaces.** Both
  agent-tools and session-facade annotate through it, and a single reflection pass enumerates
  every operation on both with resolved tool/client/CLI names. As a registry seam for those
  two surfaces, it is functional **today** — this tool *is* that enumeration.
- The **channel surface does not participate at all.** It declares operations through a
  disjoint mechanism (`makeChannelTarget` + `make*Channel`), keyed by a free-form target
  string with no `operationId` back-reference. Joining channels to operations required a
  hand-maintained alias map in the tool (`CHANNEL_ALIAS`) precisely because nothing in the
  source links `host.permissions.respond` to `permission.respond`.

So: `firegridProjection` is the seam **for agent-tools + session-facade**; the channel layer
is the unreconciled third surface. Any future single registry would either need the channel
targets to adopt a projection-style `operationId` back-reference, or a cross-reference table
mapping targets ↔ operationIds. That is a design decision and is **out of scope here** — this
note records only that the channel surface is currently disjoint from the projection seam,
with the orphan target and the `as never` stub channels as the sharpest evidence of the drift
that the absence of a single registry permits.
