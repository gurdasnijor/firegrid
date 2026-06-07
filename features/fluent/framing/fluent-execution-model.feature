@fluent @framing
Feature: Fluent execution model
  Fluent has two execution models over one Durable Streams coordination core.
  Authored procedures resume by replaying an Effect body with journal hits.
  Managed sessions resume by reconstructing native harness state around an
  external model loop.

  Scenario: Authored procedures resume by replay
    Given Firegrid owns an authored Effect procedure body
    When the procedure parks on a durable primitive and later wakes
    Then fluent-runtime appends the durable resolution fact before continuing
    And the Effect body is re-driven against the same journal
    And completed run steps are served as journal hits rather than re-executed

  Scenario: Managed sessions resume by reconstruction
    Given an external Claude, Codex, ACP, native, or cloud harness is bound to a managed session
    When the session parks on a durable Firegrid tool and later wakes
    Then fluent-runtime materializes the session stream
    And the harness I/O role reconstructs the native resume artifact
    And already-observed Layer 1 side effects are suppressed rather than replayed
    And Firegrid does not re-run the model loop as a deterministic Effect body

  Scenario: Durable tool calls record decisions
    When the model requests a durable tool call
    Then the harness I/O boundary records Layer 1 tool-call evidence
    And fluent-runtime records Layer 2 intent, result, or park facts on the session stream
    And later redrive serves the recorded result instead of re-deciding it
    And redrive does not re-invoke the model to rediscover the same call

  Scenario: Durable tool implementations that are authored procedures run as children
    Given a managed session calls a durable tool whose implementation uses run, sleep, awaitEvent, invoke, retry, or compensation
    When fluent-runtime accepts the tool call
    Then the tool body runs as a child authored-procedure invocation on its own stream
    And the managed session records a Layer 2 child or tool resolution fact
    And the authored procedure body is not replayed inline on the managed-session stream

  Scenario: Host handler is a post-claim redrive boundary
    When Durable Streams delivers or grants work
    Then fluent-runtime materializes stream state from the provided offsets
    And it appends one durable Layer 2 outcome before acking done
    And it continues by replay for authored procedures or reconstruction for managed sessions
    And it returns when the session or procedure parks or completes

  Scenario: External harness owns the reasoning loop
    Given a real agent harness is bound to a fluent session
    When the session progresses
    Then the harness owns model interaction
    And Firegrid adapts durable tools and transport around that loop
    And the raw harness never writes Durable Streams facts directly

  Scenario: Sessions address each other through durable events
    When one session targets another session
    Then it appends an addressed durable event
    And the target session handles that event after waking
    And no session directly calls another session's in-memory handler

  Scenario: One stream is one execution model
    Given a managed-session stream contains Layer 1 observations and Layer 2 coordination facts
    When an authored procedure is needed for multi-step durable work
    Then fluent-runtime creates or addresses a child authored-procedure stream
    And the managed-session stream remains reconstruction-model state
    And the child stream remains replay-model state
