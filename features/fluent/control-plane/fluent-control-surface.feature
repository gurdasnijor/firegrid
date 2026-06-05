@fluent @control-plane
Feature: Fluent control surface
  The external control plane is product spelling over durable stream primitives:
  send, fork, tag, schedule, read, head, and delete.

  Background:
    Given a fluent entity backed by a durable stream

  Scenario: Send appends addressed input
    When a client sends input to entity "session-1"
    Then the input is appended to the entity stream
    And delivery occurs by wake and handler redrive
    And the client does not synchronously call the handler

  Scenario: Fork creates a branch from a named point
    Given entity "session-1" has a tag named "before-risk"
    When a client forks entity "session-2" from that tag
    Then entity "session-2" starts from the tagged stream prefix
    And later writes to either entity do not leak into the other

  Scenario: Schedule creates a future wake
    When a client schedules entity "session-1" for time "T"
    Then a timer intent is durably recorded
    And an adopted scheduled source or Durable Streams wake integration later materializes the wake as an append

  Scenario: Reads are projections over durable state
    When a client reads or heads entity "session-1"
    Then the response is derived from durable stream state
    And it does not mutate the entity

  Scenario: Delete respects substrate terminal rules
    When a client deletes entity "session-1"
    Then the durable substrate records deletion or closure state
    And future writes follow the substrate's closed or deleted stream rules
