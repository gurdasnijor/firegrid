@fluent @framing
Feature: Fluent execution model
  Fluent separates choreography, session handling, and external harness binding.
  The durable unit is the committed tool-call-and-result, not a replayed model
  invocation.

  Scenario: Choreography records durable decisions
    When the model requests a durable tool call
    Then fluent records the tool call and its result as durable facts
    And replay uses the recorded facts
    And replay does not re-invoke the model to rediscover the same call

  Scenario: Handler is a redrive boundary
    When Durable Streams delivers or grants work
    Then a handler materializes stream state and drives product progress
    And the handler returns when the session parks or completes

  Scenario: External harness owns the reasoning loop
    Given a real agent harness is bound to a fluent session
    When the session progresses
    Then the harness owns model interaction
    And Firegrid adapts durable tools and transport only

  Scenario: Sessions address each other through durable events
    When one session targets another session
    Then it appends an addressed durable event
    And the target session handles that event after waking
    And no session directly calls another session's in-memory handler
