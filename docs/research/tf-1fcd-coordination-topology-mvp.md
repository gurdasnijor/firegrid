# tf-1fcd Coordination Topology MVP

This tiny-firegrid simulation shows the same deterministic item bench through
three coordination shapes:

- `monolithic`: one participant waits on item events, calls the worker action
  tool, emits reports, and writes the score row.
- `orchestrated`: a supervisor participant observes item events and sends
  dispatch rows; worker participants observe only their dispatch rows and
  report; a supervisor scoring participant gathers reports and writes the
  score row.
- `choreographed`: peer participants watch shared item-event and claim channels
  with `wait_for_any`, emit claim/observed rows from local decisions, call the
  worker action tool for claimed items, and report. A peer scoring participant
  gathers claimed rows and reports before writing the score row.

The host defines one DurableTable-backed bench substrate and exposes typed
channels for item events, dispatches, claims, reports, scores, and worker
actions. The driver does not read or write channel bindings; it launches bounded
participant sessions, uses one seed participant per arm to publish external item
events, and observes participant-produced done markers.

Participant behavior is implemented by deterministic stdio-jsonl agents that
interact through the locked primitive runtime-context MCP profile from tf-t47b:
`wait_for`, `wait_for_any`, `send`, and `call`. This keeps the simulation
agent-agnostic while exercising the same public client/session and tool surface
that a provider-backed tool-use agent would use.

Current MVP finding: long-running mutually blocking participants are not a good
fit for this tiny-firegrid runner path yet, so the scenario is phase-bounded
(seed, act, score) rather than fully concurrent. The coordination semantics
still live inside participant sessions; the harness only sequences launch
phases and waits for final artifacts.
