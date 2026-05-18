# SDD: Read-Only Runtime-State Query for the Agent Toolkit

Status: draft — framing for coordinator review + Gurdas signoff, NO code
Created: 2026-05-18
Owner: Firegrid Host SDK (sidecar `sidecar/mcp-readonly-query`)

Resolves: `packages/tiny-firegrid/FINDINGS.md` → TFIND-036.

Governing spec: `SDD_FIREGRID_SCHEMA_PROJECTION_CONTRACT.md` (one protocol
operation → tool / client / CLI bindings; an op may bind a *subset* of
surfaces).

Related code (verified on `origin/main`):

- `packages/host-sdk/src/agent-tools/bindings/tools.ts` — `FiregridAgentToolkit`
  allowlist (Sleep, WaitFor, SessionNew/Prompt/Cancel/Close, ScheduleMe,
  Execute)
- `packages/protocol/src/agent-tools/schema.ts` — operation catalog
  (`FiregridAgentToolOperations`), `RuntimeWaitSourceSchema`,
  `RuntimeWaitQuerySchema`, `SessionStatus*Schema`
- `@firegrid/protocol/launch` `RuntimeRunEventRow` (`exitCode`, `signal`,
  `status`, `activityAttempt`) — the durable runtime-run state

---

## 1. Verified state (sharper than the finding)

The finding says "no read/list runtime-state tool; configs work around it
with `sleep durationMs:0`." Code confirms it, with two important nuances:

1. **`wait_for` already accepts `RuntimeRun` as a source.**
   `RuntimeWaitSourceSchema = AgentOutput | RuntimeRun`;
   `RuntimeWaitQuery = { source, whereFields (equality match) }`. An agent
   *can* already block until a `RuntimeRun` row matching e.g.
   `{contextId, status:"exited"}` appears (optionally `timeoutMs`). What it
   **cannot** do: a *non-blocking* read of "the most recent run for this
   context and its exit code". `wait_for` returns `{matched,event}` /
   `{timedOut}` — it is a suspension primitive, not a query; it cannot
   express "latest / ordering / there are none yet" cleanly. The
   `sleep durationMs:0` workaround exists because there is no read at all.

2. **A `session.status` operation already exists — dormant.**
   `FiregridAgentToolOperations.sessionStatus =
   defineFiregridOperation(SessionStatusInputSchema, SessionStatusOutputSchema)`
   exists in the protocol catalog (`operationId: "session.status"`,
   `SessionHandleSchema{ status, terminalState? }`). Its `firegridProjection`
   declares `clientName: "sessions.status"` + `cliName` but **no
   `toolName`**, and grep finds **no live implementation on any surface**
   (client-sdk / CLI / host-sdk all empty). So `session.status` is a
   schema-only, unimplemented, unbound operation (same dormant shape as
   #327's `RuntimeStartRequest`). It is NOT "an existing working op we just
   bind"; realizing it costs roughly the same as a new op.

So the real decision is not merely "add a tool" — it is **what read
contract** (session-status vs raw runtime-runs), **whether agents get it at
all** (tool vs client/CLI-only, which is exactly what `session.status`
currently encodes by omitting `toolName`), and **how a read stays read-only**.

## 2. Schema-projection-contract lens

The contract already anticipates per-operation binding scope: an operation
chooses which of {tool, client, CLI} it projects to. `session.status`
deliberately omits `toolName` today — i.e. "this read is a client/CLI
concern, not an agent capability" is *already an expressed position* in the
codebase. TFIND-036 is the question of whether to **reverse that** for a
runtime-state read (add a `toolName` projection + tool binding + handler), or
add a new read operation, or affirm the current no-agent-read boundary.

## 3. Options (decision to frame — not pre-committing)

- **(A) Realize + tool-bind `session.status`.** Add `toolName` to its
  projection; implement one lowering/handler (read control-plane runs →
  `SessionHandle{status, terminalState}`); add `SessionStatusTool` to the
  `FiregridAgentToolkit` allowlist. Reuses an existing schema. Returns
  *session-level* status + optional `terminalState` — may not literally
  surface `RuntimeRunEventRow.exitCode/signal` the finding asks for unless
  `terminalState` already carries it (to verify in impl). Also implicitly
  realizes the dormant client/CLI op.
- **(B) New dedicated read-only runtime-runs query op.** e.g.
  `runtime.runs.latest` / `runtime.runs.query` over
  `RuntimeControlPlaneTable.runs` → most-recent `RuntimeRunEventRow`
  (`status`, `exitCode`, `signal`, `activityAttempt`). Closest to the
  finding's literal ask; new protocol op + tool binding (+ client/CLI per
  contract). Larger surface, but precise and read-shaped.
- **(C) Affirm no agent read; reads via projection/wait_for.** Document the
  toolkit as intentionally mutation/suspension-only; runtime-state reads are
  a client/CLI/projection concern (the position `session.status` already
  encodes). Configs use `wait_for{RuntimeRun}` for presence; the
  `sleep durationMs:0` workaround is replaced by a documented pattern, not a
  tool. Smallest blast radius; rejects the finding's tool ask on a boundary
  argument.

Recommendation (not a commitment): **(B)** is the most honest match to the
finding (a true read, exit code included, read-only by construction) and
keeps `session.status`'s "client/CLI not agent" stance intact for
session-level status. **(A)** is tempting for schema reuse but conflates
session-status with run-state and forces realizing a dormant op. **(C)** is
the principled minimal if Gurdas holds that agents should not read runtime
state. The choice is a product/boundary call.

## 4. Narrow framing questions (no code until answered)

- **Q1 — read contract:** session-level (`session.status`: status enum +
  `terminalState`) vs runtime-run-level (latest `RuntimeRunEventRow` with
  `exitCode`/`signal`). The finding literally wants the latter.
- **Q2 — agent surface at all:** bind a tool (reverse `session.status`'s
  no-`toolName` stance / give a new op a `toolName`), or keep runtime-state
  reads client/CLI-only and reject the tool (Option C)? This is the core
  product decision.
- **Q3 — read-only guarantee:** a read tool must lower to a *pure* durable
  query (no `DurableClock`, no append, no suspension) — a new lowering
  category in `toolUseToEffect` distinct from sleep/wait/mutation. Acceptable
  to add that category? Any read-side authority/scoping constraints (can an
  agent read only its own context's runs, or arbitrary `contextId`)?
- **Q4 — overlap with `wait_for`:** keep both (wait = block-until; query =
  read-now) with documented distinct semantics, or fold a "poll once" mode
  into `wait_for` (rejected by §1.1 — muddies the suspension primitive)?
- **Q5 — dormant `session.status`:** if Q1=session-level, do we realize
  `session.status` across client/CLI too (its existing projection promises
  them) or tool-only now and track the client/CLI realization separately?

## 5. Scope / non-goals

- No runtime substrate change — runtime-run state is already durable in
  `RuntimeControlPlaneTable.runs`; this is a binding + lowering question.
- Not a streaming/observation surface (that is TFIND-040).
- tiny-firegrid `sleep durationMs:0` workaround removal is a *consequence*
  for the toy maintainer, not in sidecar scope.

## 6. Verification plan (post-signoff, impl PR)

- `pnpm turbo run typecheck`; full CI gate set
  (`lint && lint:dead && lint:dup && lint:deps`) + `turbo run test`,
  CI-confirmed before reporting green.
- Tests: a deterministic read test (seed `RuntimeControlPlaneTable.runs`,
  invoke the tool/op, assert it returns the most-recent run + exit code and
  performs **no** durable mutation — emit-then-read, no suspension), plus the
  read-only-lowering category covered.

## 7. Acceptance gate

This document is the deliverable. No production code until Q1–Q5 are
dispositioned. Implementation lands on `sidecar/mcp-readonly-query` scoped to
the chosen option. FINDINGS.md ledger is coordinator-owned.
