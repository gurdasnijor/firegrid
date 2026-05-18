# Findings Triage Rubric

For the findings-backlog coordinator. Apply to every TFIND surfaced by the
toy agent before routing to a sidecar.

Purpose: distinguish findings that represent real production gaps (must-fix,
sidecar work) from findings that represent toy-internal concerns (toy fix,
not production work).

The toy's discipline is "drive examples through public boundaries." When the
toy can't express something cleanly, that signals one of several possible
things — and they have very different resolutions. The rubric is how to tell
which one.

## The five categories

Every finding fits into one of these. Categorize before routing.

### 1. Real production gap — capability missing

The toy was trying to model a real production use case, and the public
surface genuinely doesn't expose what's needed. A real consumer building on
Firegrid would hit the same wall.

**Signal:** the finding describes a capability that a non-Firegrid-internal
consumer (someone building an app on top of `@firegrid/client-sdk`, an
operator running a host, an agent vendor integrating an adapter) would
reasonably need.

**Resolution:** sidecar SDD, production fix.

**Example:** TFIND-002/038 (client session creation requires host identity).
A real consumer building a client-only frontend hits this wall immediately.

### 2. Real production gap — boundary leak / wrong shape

The public surface technically exposes the capability, but in a way that
leaks an internal plane into a public-facing API, or forces consumers to
reach past a stated boundary.

**Signal:** the toy can do what it needs, but only by importing from a
package whose boundary the architecture says shouldn't be crossed, or by
constructing internal types directly.

**Resolution:** sidecar SDD, production fix (reshape the surface or expose
the right seam).

**Example:** TFIND-007 (host-sdk had layer factories but no named host
surface). Consumers were reaching into implementation to construct what
should have been a named type.

### 3. Toy-internal concern — test fixture awkwardness

The toy needed *some* code to exercise a real production seam (an MCP
bridge, a codec, a tool surface), and reached for a capability that sounds
plausible but doesn't correspond to a real production use case. The
awkwardness is in the test, not in the public surface.

**Signal:** ask "would a real consumer outside Firegrid ever need this exact
capability for a real purpose, not just to write a test?" If the honest
answer is no, this is category 3.

**Resolution:** toy fixes the test (different fixture, different existing
tool, accept the awkwardness as test-shaped). No production change. Close
the finding with a note explaining the reframing.

**Example:** TFIND-036 ("agent reads its own runtime-run exit code"). The
toy wanted something for an agent to call through an MCP bridge and reached
for "read runtime state" as plausible. But the capability itself —
agent-in-current-run inspecting its own exit code — is incoherent (the run
hasn't exited) or host-plane forensic data that no agent has a use for. The
finding was test-fixture awkwardness wearing capability clothes.

### 4. Toy-internal concern — coverage tool artifact

The finding describes "unmodeled" surface, but the unmodeled surface is
either orthogonal to the configuration's purpose, a barrel/re-export
artifact, type-only, or otherwise not a real gap.

**Signal:** the unmodeled item is something the configuration was never
trying to model in the first place, or the coverage tool's measurement is
misleading.

**Resolution:** improve the coverage tooling (better closure measurement,
categorized exclusions) or accept the unmodeled status. No production
change.

**Example:** `verified-webhook-ingest` showing as "unmodeled" by a
runtime-context configuration. The configuration was never trying to model
webhook ingest; the coverage tool's denominator is wrong.

### 5. Production cleanup — not consumer-facing

The finding describes internal production code that's vestigial, orphaned,
or organized awkwardly, but is invisible to consumers. Worth fixing
eventually for code health, but not load-bearing for any consumer.

**Signal:** the finding is about an `internal/` module, a private layer
composition, a dead export, or similar. No public API change implied.

**Resolution:** lower-priority sidecar work, or fold into the next natural
code-touching PR. Not blocking.

**Example:** TFIND-009 (orphaned workflow-engine codec). Nobody outside the
package can see it; deleting or reconnecting it is hygiene, not capability.

## The triage question (apply first)

For every finding, before assigning a category, answer this one question:

> **Would a real consumer outside Firegrid — someone building an app on the
> client SDK, an operator running a host via the CLI, an agent vendor
> integrating an adapter — hit this same wall for a real purpose? Or is this
> only a wall because the toy was trying to write a specific test?**

If real consumer hits it → categories 1, 2, or 5 (production work, scoped
by severity).

If only the toy hits it → categories 3 or 4 (toy work or tooling work).

Apply this question *before* engaging with the finding's stated framing. The
toy agent will frame findings as production gaps because from inside the
toy, every wall feels like a wall. The coordinator's job is to triage from
outside that framing.

## When to push back vs route

| Coordinator action | When |
|---|---|
| Route to sidecar with SDD request | Categories 1, 2 |
| Route to sidecar as low-priority cleanup | Category 5 |
| Push back to toy agent | Categories 3, 4 |
| Halt-and-surface to architect | Any finding the triage question doesn't cleanly resolve, or any finding implying an undecided architectural binary |

For category 3 push-backs specifically: the response to the toy agent should
name what the toy should do instead (different test fixture, accept the
awkwardness, document the workaround). Don't just reject the finding —
redirect it.

For category 4 push-backs: route to coverage-tooling work, not to a
production sidecar.

## Red flags

Stop and apply the triage question harder if the finding has any of these:

- **"The toy can't model this without..."** — the toy not being able to
  model something is signal, but not always production signal. Ask: would a
  real consumer try to do this in the same way?
- **"The configuration needed a workaround for..."** — workarounds are
  test-shaped by default. The workaround being awkward isn't enough; the
  capability being absent has to be a real need.
- **"A read-only / inspection / debug tool for..."** — these requests
  almost always belong on the CLI or to a host-side observation surface, not
  on the agent toolkit or client SDK. If the finding is asking for a
  capability for an "agent" or "client," double-check the capability itself
  is well-formed in those planes (TFIND-036 is the canonical example of
  this going wrong).
- **"The test would be cleaner if..."** — test cleanness is a toy concern.
  Production surface decisions don't get made to clean up tests.
- **The capability sounds plausible in the abstract but you can't name a
  concrete non-Firegrid-internal consumer who'd use it.** — if you can't
  name a real user of the capability, it's not yet a real capability.

## Recording the triage

For each finding, the coordinator records the category and the triage
question's answer in the Beads DB. Read current state with
`bv --robot-triage` using the join key `tfind:NNN`. Historical methodology
should follow this shape:

| TFIND-NNN | open | <area> | <one-line summary> | triage: cat-N (<one-line reason>) |


When pushing back to the toy, the coordinator's response on
`coord-tiny-firegrid` names the category, the triage answer, and what the
toy should do instead.

## When the rubric doesn't fit

If a finding doesn't fit cleanly, the coordinator halts and posts to
`architect-handoff` rather than guessing. Categories should cover ~95% of
findings; the residual ones are the ones the architect needs to disposition.

## Calibration: applied to existing findings

For the coordinator's reference, here's the categorization for the current
findings backlog:

| Finding | Category | Why |
|---|---|---|
| TFIND-002/038 (client session creation needs host identity) | 1 | Real consumer hits this immediately |
| TFIND-007 (host surface) — resolved | 2 | Boundary leak, named-type fix |
| TFIND-009 (orphaned workflow codec) | 5 | Internal hygiene |
| TFIND-036 (agent runtime-state read) | 3 | Test-fixture awkwardness; no real agent use case |
| TFIND-040 (per-event client observation) | 1 | Real consumer pattern; client SDK gap |
| TFIND-041 (ToolUse under-discriminated) | 1 | Real architectural shape question |
| TFIND-005 (Layer<any> precision leak) | 2 | Type-honesty boundary, fixable |
| Codecs/acp/mapping.ts depcruise miss | 4 | Tooling correctness |

The pattern: most current findings are categories 1, 2, or 5. TFIND-036 is
the canonical category 3 — it should have been caught and reframed before
the SDD work.
