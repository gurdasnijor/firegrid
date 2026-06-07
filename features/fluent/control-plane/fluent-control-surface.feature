@fluent @control-plane
Feature: Fluent control surface
  The external control plane is product spelling over durable stream primitives:
  send, fork, tag, schedule, read, head, and delete.

  Background:
    Given a fluent entity backed by a durable stream
    And an external client reaches the entity through a fluent-runtime host ingress surface

  Scenario: Send appends addressed input
    When a client sends input to entity "session-1"
    Then the client request is accepted by the fluent-runtime host
    And fluent-runtime writes the addressed input through the runtime/store boundary
    And Durable Streams records the input on the entity stream
    And delivery occurs by Durable Streams wake and fluent-runtime redrive
    And the client does not synchronously call the handler
    And the acceptance proof cannot be satisfied by a host self-call that bypasses client ingress

  Scenario: Fork creates a branch from a named point
    Given entity "session-1" has a tag named "before-risk"
    When a client forks entity "session-2" from that tag
    Then the client request is accepted by the fluent-runtime host
    And fluent-runtime resolves the tag to a durable stream offset
    And Durable Streams creates entity "session-2" from the tagged stream prefix
    And later writes to either entity do not leak into the other

  Scenario: Tag names a durable stream offset
    Given entity "session-1" has durable stream history
    When a client tags the current point as "before-risk"
    Then the client request is accepted by the fluent-runtime host
    And fluent-runtime records the tag as product spelling for a Durable Streams offset
    And later fork or read requests can resolve the tag without calling a handler body

  Scenario: Schedule creates a future wake
    When a client schedules entity "session-1" for time "T"
    Then the client request is accepted by the fluent-runtime host
    And a timer intent is durably recorded through the runtime/store boundary
    And an adopted scheduled source or Durable Streams wake integration later materializes the wake as an append
    And the schedule operation does not use a process-local sleep as the durable mechanism

  Scenario: Reads are projections over durable state
    When a client reads or heads entity "session-1"
    Then the client request is accepted by the fluent-runtime host
    And the response is derived from Durable Streams state or projections over that state
    And it does not mutate the entity
    And the read path does not call the handler to reconstruct state

  Scenario: Delete respects substrate terminal rules
    When a client deletes entity "session-1"
    Then the client request is accepted by the fluent-runtime host
    And fluent-runtime lowers deletion to Durable Streams closure or deletion semantics
    And the durable substrate records deletion or closure state
    And future writes follow the substrate's closed or deleted stream rules

  Scenario: Control-plane proof crosses the real ingress boundary
    When the control-plane acceptance witness runs
    Then it observes an external client request entering the fluent-runtime host
    And it observes the host calling fluent-runtime product services
    And it observes runtime/store writes or reads against Durable Streams
    And it rejects evidence that only invokes host internals without a client ingress edge
