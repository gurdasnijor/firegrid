# SDD: Read-Only Runtime-State Query for the Agent Toolkit

Status: draft — framing for coordinator review + Gurdas signoff, NO code
Created: 2026-05-18
Revised: 2026-05-18 (Gurdas architect direction — two-plane boundary is the
load-bearing question; reframed from tool-binding mechanics)
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

## 0. The load-bearing question (read this first)

TFIND-036 *looks* like "add a read/list runtime-state tool." It is not. The
real question, which is **bigger than the tool-binding question**, is:

> **Do we want any session-plane public API whose answer requires reading
> host-plane state?**

If the answer is **no**, then the schema-reuse-driven option (realize the
dormant `session.status`) is **off the table regardless of the savings**,
because *reusing that schema is exactly what locks the boundary leak into the
public surface.* Everything below is framed around this question; the
tool-binding mechanics are downstream of it.

### The two planes (name them explicitly)

| | Session plane | Host plane |
|---|---|---|
| What it is | Conversational identity | Execution lifecycle |
| Vocabulary / durable home | `client-sdk` (`SessionHandle`) | `host-sdk` (`RuntimeRunEventRow`) |
| Truth source | client/app domain | `RuntimeControlPlaneTable.runs` |
| Example surface | `SessionHandle` | `RuntimeRunEventRow{exitCode,signal,status,activityAttempt}` |

A session-plane name (`session.status`, `sessions.status`,
`Firegrid.runs.latest` on the client SDK) whose **truth is host-plane
execution state** is a boundary leak: it presents host-plane lifecycle data
on a session-shaped facade. `session.status` is **dormant on purpose** — see
§1.2 — and binding it is what would bake that conflation into the public API.

## 1. Verified state (sharper than the finding)

The finding says "no read/list runtime-state tool; configs work around it
with `sleep durationMs:0`." Code confirms it, with two important nuances:

1. **`wait_for` already accepts `RuntimeRun` as a source — and it is a
   host-plane primitive already available to agents.**
   `RuntimeWaitSourceSchema = AgentOutput | RuntimeRun`;
   `RuntimeWaitQuery = { source, whereFields (equality match) }`. An agent
   *can* already block until a `RuntimeRun` row matching e.g.
   `{contextId, status:"exited"}` appears (optionally `timeoutMs`). It is a
   host-plane suspension primitive, exposed to agents, over the same durable
   data a query would read. What it **cannot** do: a *non-blocking* read of
   "the most recent run for this context and its exit code". `wait_for`
   returns `{matched,event}` / `{timedOut}` — a suspension primitive, not a
   query; it cannot express "latest / ordering / there are none yet" cleanly.
   The `sleep durationMs:0` workaround exists because there is no read at all.

2. **`session.status` is dormant *because its name is session-plane but its
   truth is host-plane.*** `FiregridAgentToolOperations.sessionStatus =
   defineFiregridOperation(SessionStatusInputSchema, SessionStatusOutputSchema)`
   exists in the protocol catalog (`operationId: "session.status"`,
   `SessionHandleSchema{ status, terminalState? }`). Its `firegridProjection`
   declares `clientName: "sessions.status"` + `cliName` but **no `toolName`**,
   and grep finds **no live implementation on any surface** (client-sdk / CLI
   / host-sdk all empty). This is **not** the same as #327's
   `RuntimeStartRequest` (a not-yet-built op). Someone deliberately did not
   ship `session.status`: its answer can only come from host-plane runtime-run
   state, but its name and `SessionHandle` shape are session-plane. Shipping
   it commits the public surface to a session-plane API backed by host-plane
   truth — the exact leak in §0. Schema reuse is the *mechanism* of the leak,
   not a saving.

## 2. Schema-projection-contract lens

The contract anticipates per-operation binding scope: an operation chooses
which of {tool, client, CLI} it projects to. `session.status` omitting
`toolName` is **not merely** "this read is client/CLI not agent" — combined
with §1.2 it is "this session-plane-named op was never realized *anywhere*
because its truth is host-plane." TFIND-036 must therefore not be framed as
"reverse the `toolName` omission." It is framed as: *if* we expose a
read-now of host-plane runtime-run state, it must be **named and shaped in
host-plane vocabulary on every surface it touches**, and the question of
*which* surfaces (agent tool / client SDK / CLI) is decided per the boundary
rule in §0 — not by schema convenience.

## 3. Options (reconsidered with the boundary in mind)

- **(A) Realize + tool-bind `session.status`. — OFF THE TABLE.** It ships the
  leak. A session-plane-named, `SessionHandle`-shaped op whose only possible
  truth is host-plane `RuntimeControlPlaneTable.runs` bakes the
  session/host conflation into the public surface, and realizing the dormant
  client/CLI projection propagates it further. The schema reuse is precisely
  what makes this worse, not cheaper. Rejected on the boundary argument
  independent of cost.

- **(B) New dedicated read-only runtime-runs query op — host-plane named.**
  e.g. `runtime.runs.latest` / `runtime.runs.query` over
  `RuntimeControlPlaneTable.runs` → most-recent `RuntimeRunEventRow`
  (`status`, `exitCode`, `signal`, `activityAttempt`). Host-plane vocabulary,
  no `SessionHandle` facade. Splits by surface scope:

  - **(B-tool-only)** — bind it as an agent tool **only**. Defensible: the
    agent executes *inside the runtime/host plane*; giving it a host-plane
    read of host-plane state introduces no cross-plane facade. Mirrors that
    `wait_for{RuntimeRun}` (§1.1) is already a host-plane agent primitive.
  - **(B-all-surfaces)** — also project to the client SDK
    (`Firegrid.runs.latest`-style). **Reintroduces the §0 leak in different
    vocabulary**: the client SDK is the session-plane / app-facing surface;
    exposing host-plane run state there is the same conflation as (A) wearing
    a host-plane name. Not recommended without an explicit decision that the
    client SDK *should* carry host-plane reads.

- **(C) Affirm no agent read; reads via existing host-plane primitives.**
  Document the toolkit as intentionally mutation/suspension-only.
  `wait_for{RuntimeRun}` (§1.1) already gives agents a host-plane way to
  observe run presence/terminal state; external clients already have
  projection subscriptions over the same data. The `sleep durationMs:0`
  workaround is replaced by a documented `wait_for{RuntimeRun}` pattern, not a
  new tool. Smallest blast radius; conservative answer that holds the line.

Recommendation (not a commitment; the boundary call is Gurdas's):
**(B-tool-only)** if agents should get a non-blocking host-plane read —
honest to the finding, no cross-plane facade, no dormant-op resurrection.
**(C)** if the position is that `wait_for{RuntimeRun}` + projections are
sufficient and the toolkit stays mutation/suspension-only. **(A)** is
rejected. **(B-all-surfaces)** only with an explicit, separate decision to
put host-plane reads on the client SDK.

## 3a. The CLI is a separate question

Operators *legitimately* inspect host-plane execution state — that is an
operator concern, not a boundary leak. A CLI subcommand exposing
runtime-runs is fine **provided it is named in host-plane vocabulary**:

- ✅ `firegrid runtime runs …` (host-plane name, host-plane truth)
- ❌ `firegrid sessions status …` (session-plane name over host-plane truth —
  the same leak as (A), just on the CLI)

This is decided independently of Q on the agent/client surfaces and does not
depend on realizing `session.status`.

## 4. Narrow framing questions (no code until answered)

- **Q0 — the boundary (load-bearing, decide first):** Do we want *any*
  session-plane public API whose answer requires reading host-plane state? If
  **no** → (A) is dead and (B-all-surfaces) needs separate justification; if
  **yes** → say where and why, because that reverses §0.
- **Q1 — agent surface:** (B-tool-only) host-plane read tool for agents, or
  (C) no agent read (rely on `wait_for{RuntimeRun}` + projections)? This is
  the core product decision once Q0 is settled.
- **Q2 — client SDK surface:** does the client SDK carry a host-plane
  runtime-run read at all (B-all-surfaces), or stay session-plane only?
  Default per §0: no, unless Q0 says otherwise.
- **Q3 — CLI:** approve `firegrid runtime runs …` (host-plane named) as an
  operator surface, decided independently (§3a)? Yes/no.
- **Q4 — read-only guarantee (if any read tool/op ships):** the read must
  lower to a *pure* durable query (no `DurableClock`, no append, no
  suspension) — a new lowering category in `toolUseToEffect` distinct from
  sleep/wait/mutation. Acceptable to add that category? Read-side
  authority/scoping: agent reads only its own context's runs, or arbitrary
  `contextId`?
- **Q5 — overlap with `wait_for`:** if (B*), keep both with documented
  distinct semantics (wait = block-until, host-plane; query = read-now,
  host-plane); folding a "poll once" mode into `wait_for` stays rejected by
  §1.1 (muddies the suspension primitive).
- **Q6 — `session.status` disposition:** regardless of Q1–Q3, the dormant
  session-plane `session.status` op is **not** the vehicle. Decide: leave it
  dormant with a doc-comment recording *why* (name/truth plane mismatch), or
  remove the schema-only op entirely so it cannot be casually realized later.

## 5. Scope / non-goals

- No runtime substrate change — runtime-run state is already durable in
  `RuntimeControlPlaneTable.runs`; this is a boundary + binding + lowering
  question.
- Not a streaming/observation surface (that is TFIND-040).
- `session.status` realization is explicitly **not** a path here (§3 A
  rejected); Q6 only decides dormant-with-doc vs remove.
- tiny-firegrid `sleep durationMs:0` workaround removal is a *consequence*
  for the toy maintainer, not in sidecar scope.

## 6. Verification plan (post-signoff, impl PR)

- `pnpm turbo run typecheck`; full CI gate set
  (`lint && lint:dead && lint:dup && lint:deps`) + `turbo run test`,
  CI-confirmed before reporting green.
- Tests (only if a read ships): a deterministic read test (seed
  `RuntimeControlPlaneTable.runs`, invoke the tool/op, assert it returns the
  most-recent run + exit code and performs **no** durable mutation —
  emit-then-read, no suspension), plus the read-only-lowering category
  covered. Plus a boundary assertion: no session-plane-named surface resolves
  host-plane runtime-run state.

## 7. Acceptance gate

This document is the deliverable. **No production code, no dispatch** until
Q0–Q6 are dispositioned by Gurdas. Q0 is load-bearing and decided first;
(A) is recorded as rejected on the boundary argument. Implementation lands on
`sidecar/mcp-readonly-query` scoped to the chosen option. FINDINGS.md ledger
is coordinator-owned.
